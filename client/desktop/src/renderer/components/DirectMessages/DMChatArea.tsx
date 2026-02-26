import { MessageSquare } from 'lucide-react';
import './DirectMessages.css';

/*
 * Split view concept (future implementation):
 * When an active voice call is in progress within a DM, the chat area splits:
 *   - Top half: voice/video/screen-share view (reuse VoiceView/ParticipantGrid)
 *   - Bottom half: text chat (reuse MessageList + MessageInput)
 * If no active call, the text chat takes the full height.
 * This differs from server voice channels which spawn a separate text channel
 * beneath them — in DMs the split is inline within the same view.
 */

interface DMChatAreaProps {
  selectedThreadId: string | null;
  /** Display name for the selected thread (for the header) */
  threadName?: string;
}

const DMChatArea: React.FC<DMChatAreaProps> = ({ selectedThreadId, threadName }) => {
  if (!selectedThreadId) {
    return (
      <div className="dm-chat-empty">
        <div className="dm-chat-empty-icon">
          <MessageSquare size={48} />
        </div>
        <h3>Welcome to Concord</h3>
        <p>Select a message thread or server to get started</p>
      </div>
    );
  }

  return (
    <div className="dm-chat-placeholder">
      <div className="dm-chat-header">
        <div className="conversation-avatar" style={{ width: 28, height: 28 }}>
          <span className="conversation-avatar-initial" style={{ fontSize: 12 }}>
            {(threadName ?? '?').charAt(0).toUpperCase()}
          </span>
        </div>
        <div>
          <div className="dm-chat-header-name">{threadName ?? 'Conversation'}</div>
          <div className="dm-chat-header-status">Online</div>
        </div>
      </div>

      <div className="dm-chat-placeholder-body">
        Messages will appear here
      </div>

      <div className="dm-chat-placeholder-input">
        <input
          type="text"
          placeholder={`Message ${threadName ?? 'conversation'}...`}
          disabled
        />
      </div>
    </div>
  );
};

export default DMChatArea;
