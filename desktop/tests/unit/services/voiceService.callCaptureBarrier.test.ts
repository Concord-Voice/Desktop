/**
 * #87 (Codex P2): a call's own getUserMedia is part of the moved-revocation settlement
 * barrier. Without it, `releaseAll()` acknowledges while the call's capture is still
 * unresolved, and the stale stream it later resolves with outlives the lease.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { voiceService } from '@/renderer/services/voice/voiceService';
import {
  settleDeviceCaptures,
  trackDeviceCapture,
  beginVoiceJoinClaim,
  releaseVoiceJoinWhenCapturesSettle,
  _resetDeviceCapturesForTesting,
} from '@/renderer/services/voice/captureLeaseClient';

// The real client runs; only the main-process bridge is faked, so the release the deferral
// finally sends is observable.
const release = vi.fn().mockResolvedValue(true);

interface Internals {
  sendTransport: unknown;
  device: unknown;
  produceAudio: (deviceId?: string) => Promise<void>;
  awaitMicrophonePermission: (...args: unknown[]) => Promise<void>;
  acquireCurrentMicrophone: (...args: unknown[]) => Promise<unknown>;
  produceAudioCapture: (...args: unknown[]) => Promise<boolean>;
  requireCurrentMicCapture: (...args: unknown[]) => void;
  microphoneSettingsChanged: (...args: unknown[]) => boolean;
  videoReproduceSessionActive: boolean;
  produceVideo: (deviceId?: string) => Promise<void>;
  produceVideoQueued: (...args: unknown[]) => Promise<void>;
  liveReproduceCamera: () => Promise<void>;
  liveReproduceCameraQueued: (...args: unknown[]) => Promise<void>;
  produceScreen: (...args: unknown[]) => Promise<unknown>;
  produceScreenOperation: (...args: unknown[]) => Promise<unknown>;
  switchScreenSourceQueued: (...args: unknown[]) => Promise<unknown>;
  switchScreenSourceOperation: (...args: unknown[]) => Promise<unknown>;
}
const internals = voiceService as unknown as Internals;

beforeEach(() => {
  release.mockClear();
  (globalThis.electron as unknown as Record<string, unknown>).capture = { release };
});

afterEach(() => {
  delete (globalThis.electron as unknown as Record<string, unknown>).capture;
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

  it('the call-end release waits for a pending call capture before giving the claim back (Codex P2)', async () => {
    let settle: () => void = () => undefined;
    void trackDeviceCapture(
      new Promise<void>((resolve) => {
        settle = resolve;
      })
    );
    releaseVoiceJoinWhenCapturesSettle();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    settle();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith({ intent: 'voice-join' }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a newer join claim cancels the deferred release (it would end the new call)', async () => {
    let settle: () => void = () => undefined;
    void trackDeviceCapture(
      new Promise<void>((resolve) => {
        settle = resolve;
      })
    );
    releaseVoiceJoinWhenCapturesSettle();
    beginVoiceJoinClaim(); // a new join was granted meanwhile
    settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(release).not.toHaveBeenCalled();
  });

  it('with nothing pending it releases at once', () => {
    releaseVoiceJoinWhenCapturesSettle();
    expect(release).toHaveBeenCalledWith({ intent: 'voice-join' });
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

  it('a screen capture not yet adopted by a producer keeps the barrier unsettled (Codex P2)', async () => {
    let finish: () => void = () => undefined;
    vi.spyOn(internals, 'produceScreenOperation').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const done = internals.produceScreen('screen:1:0');
    await expect(settleDeviceCaptures(20)).resolves.toBe(false);
    finish();
    await done;
    await expect(settleDeviceCaptures(20)).resolves.toBe(true);
  });

  it('a screen source switch is tracked the same way', async () => {
    let finish: () => void = () => undefined;
    vi.spyOn(internals, 'switchScreenSourceOperation').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const done = internals.switchScreenSourceQueued('screen:2:0', 1, {});
    await expect(settleDeviceCaptures(20)).resolves.toBe(false);
    finish();
    await done;
    await expect(settleDeviceCaptures(20)).resolves.toBe(true);
  });

  it.each([
    ['publishing the camera', 'produceVideo', 'produceVideoQueued'],
    ['replacing the camera (live re-produce)', 'liveReproduceCamera', 'liveReproduceCameraQueued'],
  ] as const)(
    'a camera operation %s holds the barrier through adoption (Codex Security P2)',
    async (_name, entry, queued) => {
      internals.videoReproduceSessionActive = true;
      let finish: () => void = () => undefined;
      vi.spyOn(internals, queued).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      const done = internals[entry]();
      await vi.waitFor(() => expect(internals[queued]).toHaveBeenCalled());
      await expect(settleDeviceCaptures(20)).resolves.toBe(false);
      finish();
      await done;
      await expect(settleDeviceCaptures(20)).resolves.toBe(true);
    }
  );
});
