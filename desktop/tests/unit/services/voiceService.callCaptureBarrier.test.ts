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
  releaseVoiceLease: () => void;
  voiceLeaseClaim: number;
  acquireCurrentMicrophone: (gen: number, transport: unknown) => Promise<unknown>;
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
});
