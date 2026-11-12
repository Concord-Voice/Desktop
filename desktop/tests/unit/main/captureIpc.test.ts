// @vitest-environment node
//
// `capture:acquire` / `capture:release` admission (#87 spec §3.9, plan Task 6, RC-13).
// Both are `connection-bound`, registered through `registerIpc` with an EXPLICIT refusal:
// the preload's exact-key guard knows only `CaptureRejectReason`, so a default
// `{ status: 'rejected', reason: SenderRefusal }` carrying `wrong-owner`, `not-saas` or
// `not-primary` would be dropped. The handlers' own behaviour is captureLease.test.ts's.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const { handlers, mockAcquire, mockRelease } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: {
    handle: vi.fn((channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock('../../../src/main/captureLease', () => ({
  acquire: mockAcquire,
  release: mockRelease,
}));

import { bindSender } from '../../../src/main/connectionRegistry';
import { captureAcquireRefusal, registerCaptureIpc } from '../../../src/main/ipc/capture';
import { CHANNEL_CLASSES } from '../../../src/main/ipc/channelClassification';
import type { SenderRefusal } from '../../../src/main/ipc/connectionSender';
import { registeredChannels } from '../../../src/main/ipc/registry';
import {
  CAPTURE_ACQUIRE,
  CAPTURE_RELEASE,
  isCaptureAcquireResult,
} from '../../../src/shared/captureLease';
import { bindTestSender } from './ipc/boundSenderFixture';

const VOICE = { intent: 'voice-join' };

function handlerFor(channel: string): Handler {
  const h = handlers.get(channel);
  if (h === undefined) throw new Error(`no handler for ${channel}`);
  return h;
}

/** An unbound webContents: no connection binding, so admission refuses it. */
function unboundEvent(): unknown {
  return {
    sender: { id: 99, mainFrame: { frameTreeNodeId: 99 } },
    senderFrame: {
      url: 'app://concord/index.html',
      parent: null,
      frameTreeNodeId: 99,
      detached: false,
    },
  };
}

/** A PiP of the fixture's connection, on its own webContents. */
function pipEvent(connectionId: string): unknown {
  const wc = { id: 41, mainFrame: { frameTreeNodeId: 41 } };
  bindSender(wc as never, connectionId, 'pip');
  return {
    sender: wc,
    senderFrame: {
      url: 'app://concord/index.html',
      parent: null,
      frameTreeNodeId: 41,
      detached: false,
    },
  };
}

beforeEach(() => {
  handlers.clear();
  mockAcquire.mockReset();
  mockRelease.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('capture IPC classification', () => {
  it('classifies both channels connection-bound and registers both through registerIpc', () => {
    bindTestSender();
    expect(CHANNEL_CLASSES[CAPTURE_ACQUIRE]).toBe('connection-bound');
    expect(CHANNEL_CLASSES[CAPTURE_RELEASE]).toBe('connection-bound');
    registerCaptureIpc();
    const registered = registeredChannels();
    expect(registered.get(CAPTURE_ACQUIRE)).toBe('connection-bound');
    expect(registered.get(CAPTURE_RELEASE)).toBe('connection-bound');
  });
});

describe('capture:acquire admission', () => {
  it('refuses an unbound sender as untrusted-sender without running the handler', async () => {
    bindTestSender();
    registerCaptureIpc();
    await expect(handlerFor(CAPTURE_ACQUIRE)(unboundEvent(), VOICE)).resolves.toEqual({
      status: 'rejected',
      reason: 'untrusted-sender',
    });
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('refuses a PiP as untrusted-sender (connection-bound admits primaries only)', async () => {
    const fx = bindTestSender();
    registerCaptureIpc();
    await expect(handlerFor(CAPTURE_ACQUIRE)(pipEvent(fx.connectionId), VOICE)).resolves.toEqual({
      status: 'rejected',
      reason: 'untrusted-sender',
    });
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('hands a bound primary’s admitted sender and raw input to acquire', async () => {
    const fx = bindTestSender();
    registerCaptureIpc();
    mockAcquire.mockResolvedValue({ status: 'granted' });
    const input = { intent: 'device-test' };

    await expect(handlerFor(CAPTURE_ACQUIRE)(fx.event(), input)).resolves.toEqual({
      status: 'granted',
    });

    expect(mockAcquire).toHaveBeenCalledTimes(1);
    const [sender, forwarded] = mockAcquire.mock.calls[0] ?? [];
    expect((sender as { ref: { connectionId: string } }).ref.connectionId).toBe(fx.connectionId);
    expect((sender as { role: string }).role).toBe('primary');
    expect(forwarded).toBe(input);
  });
});

describe('captureAcquireRefusal (RC-13)', () => {
  const EXPECTED: Record<SenderRefusal, string> = {
    'untrusted-sender': 'untrusted-sender',
    'not-foreground': 'not-foreground',
    'wrong-owner': 'untrusted-sender',
    'not-saas': 'untrusted-sender',
    'not-primary': 'untrusted-sender',
  };

  for (const [refusal, reason] of Object.entries(EXPECTED)) {
    it(`maps ${refusal} → rejected ${reason}, a shape the preload guard admits`, () => {
      const result = captureAcquireRefusal(refusal as SenderRefusal);
      expect(result).toEqual({ status: 'rejected', reason });
      expect(isCaptureAcquireResult(result)).toBe(true);
    });
  }

  it('maps an out-of-vocabulary value to untrusted-sender (fail closed)', () => {
    const result = captureAcquireRefusal('something-new' as SenderRefusal);
    expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
  });
});

describe('capture:release admission', () => {
  it('refuses an unbound sender with false without running the handler', async () => {
    bindTestSender();
    registerCaptureIpc();
    expect(await handlerFor(CAPTURE_RELEASE)(unboundEvent(), VOICE)).toBe(false);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('refuses a PiP with false', async () => {
    const fx = bindTestSender();
    registerCaptureIpc();
    expect(await handlerFor(CAPTURE_RELEASE)(pipEvent(fx.connectionId), VOICE)).toBe(false);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('hands a bound primary’s sender, the event and raw input to release', async () => {
    const fx = bindTestSender();
    registerCaptureIpc();
    mockRelease.mockReturnValue(true);
    const event = fx.event();

    expect(await handlerFor(CAPTURE_RELEASE)(event, VOICE)).toBe(true);

    expect(mockRelease).toHaveBeenCalledTimes(1);
    const [sender, passedEvent, input] = mockRelease.mock.calls[0] ?? [];
    expect((sender as { ref: { connectionId: string } }).ref.connectionId).toBe(fx.connectionId);
    expect(passedEvent).toBe(event);
    expect(input).toBe(VOICE);
  });
});
