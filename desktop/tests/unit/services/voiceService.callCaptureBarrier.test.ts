/**
 * #87 (Codex P2): a call's own getUserMedia is part of the moved-revocation settlement
 * barrier. Without it, `releaseAll()` acknowledges while the call's capture is still
 * unresolved, and the stale stream it later resolves with outlives the lease.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { voiceService } from '@/renderer/services/voice/voiceService';
import {
  settleDeviceCaptures,
  trackDeviceCapture,
  release,
  _resetDeviceCapturesForTesting,
} from '@/renderer/services/voice/captureLeaseClient';

vi.mock('@/renderer/services/voice/captureLeaseClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/services/voice/captureLeaseClient')>()),
  release: vi.fn().mockResolvedValue(true),
}));

interface Internals {
  sendTransport: unknown;
  device: unknown;
  produceAudio: (deviceId?: string) => Promise<void>;
  awaitMicrophonePermission: (...args: unknown[]) => Promise<void>;
  acquireCurrentMicrophone: (...args: unknown[]) => Promise<unknown>;
  produceAudioCapture: (...args: unknown[]) => Promise<boolean>;
  releaseVoiceLease: () => void;
  voiceLeaseClaim: number;
  requireCurrentMicCapture: (...args: unknown[]) => void;
  microphoneSettingsChanged: (...args: unknown[]) => boolean;
}
const internals = voiceService as unknown as Internals;

afterEach(() => {
  _resetDeviceCapturesForTesting();
  vi.restoreAllMocks();
});

describe('call-owned capture joins the settlement barrier', () => {
  it('a pending call microphone capture keeps the barrier unsettled until it resolves', async () => {
    vi.spyOn(internals, 'requireCurrentMicCapture').mockImplementation(() => undefined);
    vi.spyOn(internals, 'microphoneSettingsChanged').mockReturnValue(false);
    let resolveCapture: (s: MediaStream) => void = () => undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveCapture = resolve;
        })
    );
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    const pending = internals.acquireCurrentMicrophone(1, {});
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await expect(settleDeviceCaptures(20)).resolves.toBe(false);

    resolveCapture({ getTracks: () => [] } as unknown as MediaStream);
    await pending;
    await expect(settleDeviceCaptures(20)).resolves.toBe(true);
  });

  it('releaseVoiceLease waits for a pending call capture before giving the claim back (Codex P2)', async () => {
    vi.mocked(release).mockClear();
    let settle: () => void = () => undefined;
    void trackDeviceCapture(
      new Promise<void>((resolve) => {
        settle = resolve;
      })
    );
    internals.releaseVoiceLease();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    settle();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith('voice-join'));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a newer join claim cancels the deferred release (it would end the new call)', async () => {
    vi.mocked(release).mockClear();
    let settle: () => void = () => undefined;
    void trackDeviceCapture(
      new Promise<void>((resolve) => {
        settle = resolve;
      })
    );
    internals.releaseVoiceLease();
    internals.voiceLeaseClaim += 1; // a new join was granted meanwhile
    settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(release).not.toHaveBeenCalled();
  });

  it('with nothing pending it releases at once', () => {
    vi.mocked(release).mockClear();
    internals.releaseVoiceLease();
    expect(release).toHaveBeenCalledWith('voice-join');
  });

  it('the barrier covers graph build and publication after the capture resolved (Codex P2)', async () => {
    internals.sendTransport = { closed: false };
    internals.device = {};
    vi.spyOn(internals, 'awaitMicrophonePermission').mockResolvedValue(undefined);
    vi.spyOn(internals, 'acquireCurrentMicrophone').mockResolvedValue({});
    let finish: (v: boolean) => void = () => undefined;
    vi.spyOn(internals, 'produceAudioCapture').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    try {
      const done = internals.produceAudio();
      await vi.waitFor(() => expect(internals.produceAudioCapture).toHaveBeenCalled());
      // getUserMedia is long resolved; the stream is still unadopted, so the barrier holds.
      await expect(settleDeviceCaptures(20)).resolves.toBe(false);
      finish(true);
      await done;
      await expect(settleDeviceCaptures(20)).resolves.toBe(true);
    } finally {
      internals.sendTransport = null;
      internals.device = null;
    }
  });
});
