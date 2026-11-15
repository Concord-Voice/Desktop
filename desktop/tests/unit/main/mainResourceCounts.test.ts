// @vitest-environment node
//
// `mainResourceCounts()` (#87 spec R9, plan Task 6): a read-only view over the maps that
// already own each resource, never a second ledger. The capture lease and the tray map
// are real here; the SSO loopback map and the audiocap session are mocked at their
// count functions, because their modules start network and child-process machinery.
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoopbackCount, mockAudiocapCaptureActive } = vi.hoisted(() => ({
  mockLoopbackCount: vi.fn(() => 0),
  mockAudiocapCaptureActive: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../src/main/tray', () => ({ applyTraySnapshot: vi.fn() }));
vi.mock('../../../src/main/ipc/sso', () => ({ loopbackCount: mockLoopbackCount }));
vi.mock('../../../src/main/audiocapHost', () => ({
  audiocapCaptureActive: mockAudiocapCaptureActive,
}));

import {
  _resetCaptureLeaseForTesting,
  acquire,
  initCaptureLease,
  release,
  type CaptureLeaseDeps,
} from '../../../src/main/captureLease';
import {
  _resetConnectionRegistryForTesting,
  MAX_LIVE_CONNECTIONS,
  bindSender,
  foreground,
  openConnection,
  recordFor,
  refOf,
  registerService,
  setForeground,
} from '../../../src/main/connectionRegistry';
import type { ConnectionSender } from '../../../src/main/ipc/connectionSender';
import { mainResourceCounts } from '../../../src/main/mainResourceCounts';

const FRAME_URL = 'app://concord/index.html';
const VOICE = { intent: 'voice-join' } as const;
const BASELINE = {
  captureHolder: 0,
  handoffPending: 0,
  loopbacks: 0,
  traySnapshots: 0,
  audiocapCapture: 0,
};

function deps(): CaptureLeaseDeps {
  return {
    foreground: () => foreground(),
    recordFor: (id) => recordFor(id),
    sendToConnection: () => true,
    setTrayOwner: () => {},
    revokeAudiocapShare: () => {},
    serviceMediaCapability: () => undefined,
    isQuitting: () => false,
    runCeremony: () => Promise.resolve('stay'),
    tryAcquireModal: () => () => {},
    consumeCeremonyToken: () => true,
    crashAndReload: () => {},
  };
}

function connectForeground(): { sender: ConnectionSender; event: IpcMainInvokeEvent } {
  const r = registerService(new URL('https://a.example').origin, {
    makeSession: () => ({}) as never,
    makeCustody: () => ({}) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  const wc = { id: 3, mainFrame: { frameTreeNodeId: 3 } };
  const o = openConnection(r.service.serviceId, wc as never, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc as never, o.record.connectionId, 'primary');
  setForeground(o.record.connectionId);
  const sender: ConnectionSender = Object.freeze({
    record: o.record,
    service: r.service,
    custody: r.service.custody,
    ref: refOf(o.record),
    frame: { url: FRAME_URL } as never,
    role: 'primary',
  });
  const event = {
    sender: wc,
    senderFrame: { frameTreeNodeId: 3, url: FRAME_URL, parent: null },
  } as unknown as IpcMainInvokeEvent;
  return { sender, event };
}

beforeEach(() => {
  _resetConnectionRegistryForTesting();
  _resetCaptureLeaseForTesting();
  initCaptureLease(deps());
  mockLoopbackCount.mockReturnValue(0);
  mockAudiocapCaptureActive.mockReturnValue(false);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  _resetCaptureLeaseForTesting();
});

describe('mainResourceCounts', () => {
  it('reads all zero at baseline', () => {
    expect(mainResourceCounts()).toEqual(BASELINE);
  });

  it('counts the lease holder after one acquire and returns to baseline after release', async () => {
    const { sender, event } = connectForeground();
    await expect(acquire(sender, VOICE)).resolves.toEqual({ status: 'granted' });
    expect(mainResourceCounts()).toEqual({ ...BASELINE, captureHolder: 1 });

    expect(release(sender, event, VOICE)).toBe(true);
    expect(mainResourceCounts()).toEqual(BASELINE);
  });

  it('reads the loopback and audiocap owners through their own count functions', () => {
    mockLoopbackCount.mockReturnValue(2);
    mockAudiocapCaptureActive.mockReturnValue(true);
    expect(mainResourceCounts()).toEqual({ ...BASELINE, loopbacks: 2, audiocapCapture: 1 });
  });

  it('keeps every field within MAX_LIVE_CONNECTIONS while one connection holds', async () => {
    const { sender } = connectForeground();
    await acquire(sender, VOICE);
    for (const value of Object.values(mainResourceCounts())) {
      expect(value).toBeLessThanOrEqual(MAX_LIVE_CONNECTIONS);
    }
  });

  it('is read-only: reading twice changes nothing', async () => {
    const { sender } = connectForeground();
    await acquire(sender, VOICE);
    const first = mainResourceCounts();
    expect(mainResourceCounts()).toEqual(first);
  });
});
