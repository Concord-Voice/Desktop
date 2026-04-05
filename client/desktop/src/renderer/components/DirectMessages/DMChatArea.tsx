import React, { useState, useCallback, useMemo } from 'react';
import { MessageSquare, Users } from 'lucide-react';
import MessageList from '../Chat/MessageList';
import MessageInput from '../Chat/MessageInput';
import TypingIndicator from '../Chat/TypingIndicator';
import { useDMStore, type DMConversation } from '../../stores/dmStore';
import { useUserStore } from '../../stores/userStore';
import { useDMSubscription } from '../../hooks/useDMSubscription';
import { useMessageFetch } from '../../hooks/useMessageFetch';
import { useChatController } from '../../hooks/useChatController';
import { apiFetch } from '../../services/apiClient';
import { usePrivacyStore } from '../../stores/privacyStore';
import { resolveUserAccentColors } from '../../utils/schemeColors';
import GroupInfoPanel from './GroupInfoPanel';
import type { ChatContext } from '../../types/chat';
import './DirectMessages.css';

/*
 * Split view concept (future implementation):
 * When an active voice call is in progress within a DM, the chat area splits:
 *   - Top half: voice/video/screen-share view (reuse VoiceView/ParticipantGrid)
 *   - Bottom half: text chat (reuse MessageList + MessageInput)
 * If no active call, the text chat takes the full height.
 */

interface DMChatAreaProps {
  selectedThreadId: string | null;
}

/** Get display name for the header */
function getThreadName(conv: DMConversation | undefined, currentUserId: string): string {
  if (!conv) return 'Conversation';
  if (conv.isPersonal) return 'Personal Thread';
  if (conv.isGroup) {
    return conv.name || conv.participants.map((p) => p.displayName || p.username).join(', ');
  }
  const other = conv.participants.find((p) => p.userId !== currentUserId);
  return other?.displayName || other?.username || 'Unknown';
}

const DMChatArea: React.FC<DMChatAreaProps> = ({ selectedThreadId }) => {
  const [showGroupInfo, setShowGroupInfo] = useState(false);

  const conversations = useDMStore((s) => s.conversations);
  const clearUnread = useDMStore((s) => s.clearUnread);
  const user = useUserStore((s) => s.user);
  const dmPrivacyLevel = usePrivacyStore((s) => s.settings.dmPrivacyLevel);

  // Subscribe to active DM conversation for real-time messages
  useDMSubscription(selectedThreadId);

  const activeConv = conversations.find((c) => c.id === selectedThreadId);
  const currentUserId = user?.id || '';
  const threadName = getThreadName(activeConv, currentUserId);

  // Chat controller — unified send/edit/delete/reply/pin/typing
  const ctx: ChatContext = useMemo(
    () => ({
      type: 'dm' as const,
      id: selectedThreadId || '',
      isEncrypted: activeConv?.isEncrypted ?? false,
    }),
    [selectedThreadId, activeConv?.isEncrypted]
  );

  const {
    sendMessage,
    editMessage,
    deleteMessage,
    replyingTo,
    handleReply,
    cancelReply,
    handlePinToggle,
    sendTyping,
    chatContext,
  } = useChatController(ctx);

  // Mark conversation as read after messages are fetched
  const handleFetchComplete = useCallback(() => {
    if (!selectedThreadId) return;
    apiFetch(`/api/v1/dm/conversations/${selectedThreadId}/read`, { method: 'POST' }).catch(
      () => {}
    );
    clearUnread(selectedThreadId);
  }, [selectedThreadId, clearUnread]);

  // Shared fetch/decrypt/paginate logic
  const { messages, isLoading, hasMore, error, handleLoadMore } = useMessageFetch(
    selectedThreadId,
    { type: 'dm', onFetchComplete: handleFetchComplete }
  );

  // Unseen count on leave (DM-specific: uses dmStore, not unreadStore)
  const handleUnseenOnLeave = useCallback(
    (count: number) => {
      if (!selectedThreadId || count <= 0) return;
      useDMStore.getState().incrementUnread(selectedThreadId);
    },
    [selectedThreadId]
  );

  // Send message adapter (MessageInput callback signature)
  const handleSendMessage = useCallback(
    (
      content: string,
      mentionMeta?: string,
      replyToId?: string,
      attachmentIds?: string[],
      attachments?: import('../../types/chat').AttachmentSummary[]
    ) => {
      if (!selectedThreadId) return;
      sendMessage(content, { mentionMeta, replyToId, attachmentIds, attachments });
    },
    [selectedThreadId, sendMessage]
  );

  if (!selectedThreadId) {
    return (
      <div className="dm-chat-empty">
        <div className="dm-chat-empty-icon">
          <MessageSquare size={48} />
        </div>
        <h3>Welcome to Concord Voice</h3>
        <p>Select a message thread or server to get started</p>
      </div>
    );
  }

  return (
    <div className="dm-chat-area-wrapper">
      <div
        className="dm-chat-placeholder"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minWidth: 0 }}
      >
        <div className="dm-chat-header">
          <div className="conversation-avatar" style={{ width: 28, height: 28 }}>
            <span
              className="conversation-avatar-initial"
              style={(() => {
                const other =
                  activeConv && !activeConv.isGroup && !activeConv.isPersonal
                    ? activeConv.participants.find((p) => p.userId !== currentUserId)
                    : null;
                const colors = resolveUserAccentColors(other?.colorScheme);
                return colors ? { fontSize: 12, background: colors.gradient } : { fontSize: 12 };
              })()}
            >
              {threadName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div style={{ flex: 1 }}>
            <div className="dm-chat-header-name">{threadName}</div>
            <div className="dm-chat-header-status">
              {(() => {
                if (activeConv?.isPersonal) return 'Your personal notes';
                if (activeConv && !activeConv.isGroup) {
                  return (
                    activeConv.participants.find((p) => p.userId !== currentUserId)?.status ||
                    'offline'
                  );
                }
                return `${activeConv?.participants.length || 0} members`;
              })()}
            </div>
          </div>
          {activeConv?.isGroup && (
            <button
              type="button"
              className="dm-chat-header-group-info-btn"
              onClick={() => setShowGroupInfo((v) => !v)}
              aria-label="Toggle group info"
              title="Group Info"
            >
              <Users size={18} />
            </button>
          )}
        </div>

        {error && <div className="chat-error">{error}</div>}

        <div className="chat-messages" style={{ flex: 1, minHeight: 0 }}>
          <MessageList
            key={selectedThreadId}
            messages={messages}
            currentUserId={currentUserId}
            chatContext={chatContext}
            channelName={threadName}
            isLoading={isLoading}
            hasMore={hasMore}
            onLoadMore={handleLoadMore}
            onEditMessage={editMessage}
            onDeleteMessage={deleteMessage}
            onUnseenOnLeave={handleUnseenOnLeave}
            onReply={handleReply}
            onPinToggle={handlePinToggle}
            canPin={true}
          />
        </div>

        <TypingIndicator channelId={selectedThreadId} />

        {dmPrivacyLevel === 0 ? (
          <div className="dm-disabled-notice">
            All DMs have been disabled. Change your privacy settings to restore DMs.
          </div>
        ) : (
          <div className="chat-input">
            <MessageInput
              onSendMessage={handleSendMessage}
              onTyping={sendTyping}
              channelName={threadName}
              disabled={!currentUserId}
              isChannelEncrypted={activeConv?.isEncrypted ?? false}
              conversationId={selectedThreadId || undefined}
              replyingTo={replyingTo}
              onCancelReply={cancelReply}
            />
          </div>
        )}
      </div>

      {showGroupInfo && activeConv?.isGroup && (
        <GroupInfoPanel conversation={activeConv} onClose={() => setShowGroupInfo(false)} />
      )}
    </div>
  );
};

export default DMChatArea;
