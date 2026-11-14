import { useState, useRef, useCallback, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voice/voiceStore';
import {
  acquire,
  currentDeviceTestEpoch,
  trackDeviceCapture,
  release,
  captureLeaseMessage,
  captureRevokedEvents,
  CAPTURE_REVOKED_EVENT,
} from '../../services/voice/captureLeaseClient';
import type { DeviceTestStoppedReason } from './useMicTest';

const VOICE_CALL_CONNECTION_STATES = new Set(['connected', 'connecting', 'reconnecting']);

function isInVoiceCall(connectionState: string): boolean {
  return VOICE_CALL_CONNECTION_STATES.has(connectionState);
}

interface UseCameraTestReturn {
  isTesting: boolean;
  error: string | null;
  stoppedReason: DeviceTestStoppedReason;
  stream: MediaStream | null;
  toggleTest: () => Promise<void>;
  stopTest: () => void;
}

interface LeaseAttempt {
  /** The revocation epoch read right after the claim was granted (see release()). */
  epoch: number;
  released: boolean;
  capturing: boolean;
  cancelled: boolean;
}

function releaseAttempt(attempt: LeaseAttempt): void {
  if (attempt.released) return;
  attempt.released = true;
  void release('device-test', attempt.epoch);
}

/**
 * Toggles a live camera preview for the Settings device panel. Acquires a
 * MediaStream from the currently-selected video input via getUserMedia and
 * exposes it for inline <video> rendering. Guarantees all tracks are stopped
 * on toggle-off and on unmount so no MediaStreamTracks leak.
 *
 * #87: the `device-test` capture lease is acquired before getUserMedia and
 * released when the preview stops; a revoked lease stops the preview.
 */
export function useCameraTest(): UseCameraTestReturn {
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stoppedReason, setStoppedReason] = useState<DeviceTestStoppedReason>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);
  // The live claim attempt. A stop while its getUserMedia is still pending cannot release yet:
  // the late stream is stopped by the continuation, and only then may the claim go.
  const attemptRef = useRef<LeaseAttempt | null>(null);

  const stopTest = useCallback(() => {
    generationRef.current++;
    pendingRef.current = false;
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    const attempt = attemptRef.current;
    attemptRef.current = null;
    if (attempt) {
      attempt.cancelled = true;
      if (!attempt.capturing) releaseAttempt(attempt);
    }
    setStream(null);
    setIsTesting(false);
    setStoppedReason(null);
  }, []);

  const startTest = useCallback(
    async (generation: number) => {
      setError(null);
      setStoppedReason(null);
      const lease = await acquire('device-test');
      // After the reply: it and a revoke push are ordered (see currentDeviceTestEpoch).
      const leaseEpoch = currentDeviceTestEpoch();
      if (generation !== generationRef.current) {
        // Stopped while main answered. This grant owns nothing: give its count back. A
        // successor's own acquire is already counted, so the claim survives for it.
        if (lease.status === 'granted') void release('device-test', leaseEpoch);
        return;
      }
      if (lease.status !== 'granted') {
        pendingRef.current = false;
        if (lease.status === 'held') setStoppedReason('held');
        else setError(captureLeaseMessage(lease.status === 'rejected' ? lease.reason : 'unknown'));
        return;
      }
      const attempt: LeaseAttempt = {
        epoch: leaseEpoch,
        released: false,
        capturing: true,
        cancelled: false,
      };
      attemptRef.current = attempt;
      try {
        const deviceId = useVoiceStore.getState().videoDeviceId;
        const next = await trackDeviceCapture(
          navigator.mediaDevices.getUserMedia({
            video: deviceId ? { deviceId: { exact: deviceId } } : true,
          })
        );
        if (generation !== generationRef.current) {
          attempt.cancelled = true;
          for (const track of next.getTracks()) track.stop();
          return;
        }
        streamRef.current = next;
        setStream(next);
        setIsTesting(true);
      } catch (err) {
        if (generation !== generationRef.current) {
          attempt.cancelled = true;
          return;
        }
        attemptRef.current = null;
        releaseAttempt(attempt);
        const msg =
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera access denied'
            : 'Failed to access camera';
        setError(msg);
        setIsTesting(false);
      } finally {
        attempt.capturing = false;
        // Cancelled while the capture was pending: its stream is stopped now, so release.
        if (attempt.cancelled) releaseAttempt(attempt);
        if (generation === generationRef.current) pendingRef.current = false;
      }
    },
    []
  );

  const toggleTest = useCallback(async () => {
    if (streamRef.current || pendingRef.current) {
      stopTest();
      return;
    }
    const generation = ++generationRef.current;
    pendingRef.current = true;
    await startTest(generation);
  }, [startTest, stopTest]);

  useEffect(() => {
    const unsubscribe = useVoiceStore.subscribe((state, prev) => {
      const callStarted =
        !isInVoiceCall(prev.connectionState) && isInVoiceCall(state.connectionState);
      if (state.videoDeviceId !== prev.videoDeviceId || callStarted) stopTest();
    });
    const onCaptureRevoked = (event: Event) => {
      if (!streamRef.current && !pendingRef.current) return;
      const reason: unknown = event instanceof CustomEvent ? event.detail : undefined;
      stopTest();
      if (reason === 'backgrounded') setStoppedReason('backgrounded');
    };
    captureRevokedEvents.addEventListener(CAPTURE_REVOKED_EVENT, onCaptureRevoked);
    return () => {
      unsubscribe();
      captureRevokedEvents.removeEventListener(CAPTURE_REVOKED_EVENT, onCaptureRevoked);
      stopTest();
    };
  }, [stopTest]);

  return { isTesting, error, stoppedReason, stream, toggleTest, stopTest };
}
