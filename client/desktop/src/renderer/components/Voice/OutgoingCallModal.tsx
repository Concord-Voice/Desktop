// OutgoingCallModal — caller-side centered modal showing outgoing-ring
// state with peer name + Cancel button (#1209 plan task F2). Per spec
// §7.8: deliberately asymmetric with IncomingCallBanner — caller initiated
// the action and wants to see their call's progress; the centered modal
// gives that visual weight.
//
// DM 1:1 only for #1209. Group follow-up (#1219) will extend with the
// per-decliner tally UI ("Ringing Bob, Charlie — Bob accepted").

import { useVoiceStore } from '../../stores/voiceStore';
import { useDMStore } from '../../stores/dmStore';
import { useUserStore } from '../../stores/userStore';
import { cancelOutgoingCall } from '../../services/voiceService/callStateMachine';
import { peerName } from '../../utils/dm';
import './OutgoingCallModal.css';

export function OutgoingCallModal() {
  const callState = useVoiceStore((s) => s.callState);
  const myUserId = useUserStore((s) => s.user?.id);

  // Subscribe to conversations array so the modal re-renders if the peer's
  // displayName updates mid-ring (rare but possible if a presence event
  // arrives during the outgoing ring window).
  const conversations = useDMStore((s) => s.conversations);

  if (callState.kind !== 'outgoing-ringing') {
    return null;
  }

  const conversation = conversations.find((c) => c.id === callState.conversationId);
  if (!conversation) {
    // Shouldn't happen — initiateDMCall validates this. Defensive null
    // render to avoid crash if the store evicted the conv mid-ring.
    return null;
  }

  // DM 1:1: pick the OTHER participant (peer). Group rendering (#1219)
  // would show the group name + tally instead.
  const displayName = myUserId ? peerName(conversation.participants, myUserId) : 'Unknown';

  return (
    <dialog className="outgoing-call-modal__backdrop" open aria-modal="true">
      <div className="outgoing-call-modal">
        <div className="outgoing-call-modal__avatar">
          <span className="outgoing-call-modal__initials" aria-hidden="true">
            {displayName.slice(0, 2).toUpperCase()}
          </span>
        </div>
        <div className="outgoing-call-modal__text">
          <div className="outgoing-call-modal__name">Calling {displayName}</div>
          <div className="outgoing-call-modal__subtitle">Ringing…</div>
        </div>
        <button
          type="button"
          className="outgoing-call-modal__cancel"
          aria-label="Cancel call"
          onClick={() => {
            void cancelOutgoingCall().catch((err: unknown) => {
              // cancelOutgoingCall swallows POST errors internally; .catch
              // here just prevents the unhandled-rejection warning at the
              // click boundary (Copilot #1231 finding C11).
              console.error(
                'Cancel-call button handler:',
                err instanceof Error ? err.message : 'non-Error thrown'
              );
            });
          }}
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
}
