/**
 * #87 (Codex P2): a call's own getUserMedia is part of the moved-revocation settlement
 * barrier. Without it, `releaseAll()` acknowledges while the call's capture is still
 * unresolved, and the stale stream it later resolves with outlives the lease.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { voiceService } from '@/renderer/services/voice/voiceService';
import {
  settleDeviceCaptures,
  _resetDeviceCapturesForTesting,
} from '@/renderer/services/voice/captureLeaseClient';

interface Internals {
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
});
