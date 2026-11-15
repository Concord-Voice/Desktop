import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useVoiceStore } from '../../stores/voice/voiceStore';
import {
  CAPTURE_LEASE_COPY,
  isAcquirePending,
  subscribeAcquirePending,
} from '../../services/voice/captureLeaseClient';
// The visually hidden class lives with the banner, the other capture-lease surface.
import './CaptureMovedBanner.css';

/**
 * The last decline this module announced. Module-level, so a remount (an App error
 * boundary reset, a test harness) does not speak the same decline twice. `reset()` wipes
 * `captureDeclinedSeq` to 0, which re-arms the guard.
 */
let lastAnnouncedSeq = 0;

type Spoken = { kind: 'pending' } | { kind: 'declined'; seq: number } | null;

/**
 * Screen-reader line for a voice join waiting on main's capture prompt, and for a
 * declined prompt (#87 §3.8). The #3394 live-region pattern: the polite region mounts
 * empty when there is something to say and its text is set one frame later. It is
 * deliberately separate from MediaPolicyNotice's region in VoiceControls.
 */
const CaptureLeaseAnnouncer: React.FC = () => {
  const declinedSeq = useVoiceStore((s) => s.captureDeclinedSeq);
  const pending = useSyncExternalStore(subscribeAcquirePending, isAcquirePending);
  const [spoken, setSpoken] = useState<Spoken>(null);

  useEffect(() => {
    if (declinedSeq === 0) {
      lastAnnouncedSeq = 0;
      return undefined;
    }
    let cancelled = false;
    requestAnimationFrame(() => {
      if (cancelled || declinedSeq === lastAnnouncedSeq) return;
      lastAnnouncedSeq = declinedSeq;
      setSpoken({ kind: 'declined', seq: declinedSeq });
    });
    return () => {
      cancelled = true;
    };
  }, [declinedSeq]);

  useEffect(() => {
    if (!pending) return undefined;
    let cancelled = false;
    requestAnimationFrame(() => {
      if (!cancelled) setSpoken({ kind: 'pending' });
    });
    return () => {
      cancelled = true;
    };
  }, [pending]);

  if (!pending && declinedSeq === 0) return null;

  let text = '';
  if (spoken?.kind === 'pending' && pending) text = CAPTURE_LEASE_COPY.pending;
  else if (spoken?.kind === 'declined' && spoken.seq === declinedSeq) {
    text = CAPTURE_LEASE_COPY.declined;
  }

  return (
    <div className="capture-lease-sr-only" role="status" aria-live="polite">
      {text}
    </div>
  );
};

interface CaptureLeaseHintProps {
  id: string;
}

/**
 * The join controls' description while the microphone is in a call on another
 * connection. Referenced by `aria-describedby`, never a `title` (#87 §3.8).
 */
export const CaptureLeaseHint: React.FC<CaptureLeaseHintProps> = ({ id }) => (
  <span id={id} className="capture-lease-sr-only">
    {CAPTURE_LEASE_COPY.hint}
  </span>
);

export default CaptureLeaseAnnouncer;
