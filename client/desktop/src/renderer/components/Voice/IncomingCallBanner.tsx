// IncomingCallBanner — root-mounted corner banner for incoming DM voice
// calls (#1209 plan task F1). Per spec §7.7: non-blocking, persistent
// until accepted/declined/timed out, paired with ringtone audio.
//
// Mounted at the application root (App.tsx) so it's visible regardless
// of current navigation — incoming calls shouldn't be hidden by which
// view the user is currently looking at.

import { useVoiceStore } from '../../stores/voiceStore';
import {
  acceptIncomingCall,
  declineIncomingCall,
} from '../../services/voiceService/callStateMachine';
import './IncomingCallBanner.css';

export function IncomingCallBanner() {
  const callState = useVoiceStore((s) => s.callState);

  if (callState.kind !== 'incoming-ringing') {
    return null;
  }

  const { caller } = callState;
  const displayName = caller.displayName ?? caller.username;
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <div className="incoming-call-banner" role="alert" aria-live="polite">
      <div className="incoming-call-banner__avatar">
        {caller.avatarUrl ? (
          <img src={caller.avatarUrl} alt={displayName} />
        ) : (
          <span className="incoming-call-banner__initials" aria-hidden="true">
            {initials}
          </span>
        )}
      </div>
      <div className="incoming-call-banner__text">
        <div className="incoming-call-banner__name">{displayName}</div>
        <div className="incoming-call-banner__subtitle">Incoming voice call…</div>
      </div>
      <div className="incoming-call-banner__actions">
        <button
          type="button"
          className="incoming-call-banner__btn incoming-call-banner__btn--accept"
          aria-label="Accept call"
          onClick={() => {
            void acceptIncomingCall().catch((err: unknown) => {
              // acceptIncomingCall already resets state to idle on failure
              // (see callStateMachine); .catch here just prevents the
              // unhandled-rejection warning at the click boundary
              // (Copilot #1231 finding C9).
              console.error(
                'Accept-call button handler:',
                err instanceof Error ? err.message : 'non-Error thrown'
              );
            });
          }}
        >
          Accept
        </button>
        <button
          type="button"
          className="incoming-call-banner__btn incoming-call-banner__btn--decline"
          aria-label="Decline call"
          onClick={() => {
            void declineIncomingCall().catch((err: unknown) => {
              // declineIncomingCall swallows POST errors internally and still
              // transitions to idle. This .catch is defense-in-depth for any
              // future code path that rethrows (Copilot #1231 finding C10).
              console.error(
                'Decline-call button handler:',
                err instanceof Error ? err.message : 'non-Error thrown'
              );
            });
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
