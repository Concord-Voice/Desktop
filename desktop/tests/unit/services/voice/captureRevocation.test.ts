import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureLeaseRevoked, CaptureLeaseState } from '@/shared/captureLease';

const log: string[] = [];

vi.mock('@/renderer/services/voice/voiceService', () => ({
  voiceService: {
    emergencyCleanup: vi.fn(() => log.push('emergencyCleanup')),
    joinChannel: vi.fn(),
  },
}));

vi.mock('@/renderer/services/voice/voiceActionGeneration', () => ({
  advanceVoiceActionGeneration: vi.fn(() => {
    log.push('advanceVoiceActionGeneration');
    return 1;
  }),
  getVoiceActionGeneration: vi.fn(() => 0),
}));

import { voiceService } from '@/renderer/services/voice/voiceService';
import { installCaptureRevocationHandler } from '@/renderer/services/voice/captureRevocation';
import { captureRevokedEvents } from '@/renderer/services/voice/captureLeaseClient';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { useConnectionStore } from '@/renderer/stores/ui/connectionStore';
import { resetAllStores } from '../../../helpers/store-helpers';

let revoke: (r: CaptureLeaseRevoked) => void = () => undefined;
let pushLease: (s: CaptureLeaseState) => void = () => undefined;
let dispose: () => void = () => undefined;
const releaseFn = vi.fn((input: { intent: string }) => {
  log.push(`release:${input.intent}`);
  return Promise.resolve(true);
});

function setBridge(bridge: Record<string, unknown> | undefined): void {
  const host = globalThis.electron as unknown as Record<string, unknown>;
  if (bridge === undefined) delete host.capture;
  else host.capture = bridge;
}

const onRevoked = (e: Event): void => {
  log.push(`capture-revoked:${String((e as CustomEvent<string>).detail)}`);
};

beforeEach(() => {
  resetAllStores();
  log.length = 0;
  vi.clearAllMocks();
  setBridge({
    acquire: vi.fn(),
    release: releaseFn,
    onLeaseChanged: vi.fn((cb: (s: CaptureLeaseState) => void) => {
      pushLease = cb;
      return () => undefined;
    }),
    onLeaseRevoked: vi.fn((cb: (r: CaptureLeaseRevoked) => void) => {
      revoke = cb;
      return () => undefined;
    }),
  });
  const voice = useVoiceStore.getState();
  vi.spyOn(voice, 'setCaptureMovedNotice').mockImplementation((v) => {
    log.push(`setCaptureMovedNotice:${String(v)}`);
    useVoiceStore.setState({ captureMovedNotice: v });
  });
  vi.spyOn(voice, 'setCaptureLease').mockImplementation((v) => {
    log.push(`setCaptureLease:${v}`);
    useVoiceStore.setState({ captureLease: v });
  });
  vi.spyOn(useConnectionStore.getState(), 'setPendingVoiceRejoin').mockImplementation((t) => {
    log.push(`setPendingVoiceRejoin:${String(t)}`);
  });
  captureRevokedEvents.addEventListener('capture-revoked', onRevoked);
  dispose = installCaptureRevocationHandler();
});

afterEach(() => {
  dispose();
  captureRevokedEvents.removeEventListener('capture-revoked', onRevoked);
  vi.restoreAllMocks();
  setBridge(undefined);
});

describe('installCaptureRevocationHandler', () => {
  it('moved: notice first, then supersede, cleanup, revoke event, releases, lease cleared', async () => {
    log.length = 0; // drop the install-time lease mirroring
    revoke({ reason: 'moved' });
    await vi.waitFor(() => expect(log).toContain('setCaptureLease:none'));
    expect(log).toEqual([
      'setCaptureMovedNotice:true',
      'advanceVoiceActionGeneration',
      'setPendingVoiceRejoin:null',
      'emergencyCleanup',
      'capture-revoked:moved',
      'release:voice-join',
      'release:device-test',
      'setCaptureLease:none',
    ]);
    expect(useVoiceStore.getState().captureMovedNotice).toBe(true);
    expect(voiceService.joinChannel).not.toHaveBeenCalled();
    // The cleanup must not release by itself: the acknowledgement follows the device-test stop.
    expect(voiceService.emergencyCleanup).toHaveBeenCalledWith({ keepCaptureLease: true });
  });

  it('backgrounded: no call teardown, revoke event, device-test release only, lease cleared', async () => {
    log.length = 0;
    revoke({ reason: 'backgrounded' });
    await vi.waitFor(() => expect(log).toContain('setCaptureLease:none'));
    expect(log).toEqual([
      'capture-revoked:backgrounded',
      'release:device-test',
      'setCaptureLease:none',
    ]);
    expect(voiceService.emergencyCleanup).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().captureMovedNotice).toBe(false);
  });

  it('mirrors lease pushes into voiceStore.captureLease', () => {
    pushLease({ held: true, mine: false });
    expect(useVoiceStore.getState().captureLease).toBe('other');
    pushLease({ held: true, mine: true });
    expect(useVoiceStore.getState().captureLease).toBe('mine');
  });

  it('a free-lease push with no prior moved leaves captureMovedNotice false (Review Focus 3)', () => {
    pushLease({ held: true, mine: false });
    pushLease({ held: false, mine: false });
    expect(useVoiceStore.getState().captureLease).toBe('none');
    expect(useVoiceStore.getState().captureMovedNotice).toBe(false);
  });

  it('withholds every release from the first line, through the teardown import, and the lease push does not lift it', async () => {
    const { release } = await import('@/renderer/services/voice/captureLeaseClient');
    log.length = 0;
    revoke({ reason: 'moved' });
    // The handler is now awaiting its dynamic import: a stopping device test releases here.
    await release('device-test');
    // And the lease push that follows the revocation arrives before the teardown ends.
    pushLease({ held: false, mine: false });
    await release('device-test');
    expect(log).not.toContain('release:device-test');
    // Once the teardown finished cleanly the acknowledgement does leave.
    await vi.waitFor(() => expect(log).toContain('release:voice-join'));
  });

  it('a throwing emergencyCleanup withholds every release (any release is the ack), then a lease push lifts it', async () => {
    vi.mocked(voiceService.emergencyCleanup).mockImplementationOnce(() => {
      throw new Error('cleanup failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    log.length = 0;
    revoke({ reason: 'moved' });
    await vi.waitFor(() => expect(log).toContain('setCaptureLease:none'));
    expect(log).toContain('capture-revoked:moved');
    // The release is the ack main reads: without a clean teardown the 5 s crash must run.
    expect(log).not.toContain('release:voice-join');
    expect(log).not.toContain('release:device-test');
    // Message-only log: never the error object.
    for (const call of warn.mock.calls) {
      for (const arg of call) expect(arg).not.toBeInstanceOf(Error);
    }
    // The handoff ended (a lease push arrived): releases are allowed again.
    pushLease({ held: false, mine: false });
    log.length = 0;
    const { release } = await import('@/renderer/services/voice/captureLeaseClient');
    await release('voice-join');
    expect(log).toContain('release:voice-join');
  });
});
