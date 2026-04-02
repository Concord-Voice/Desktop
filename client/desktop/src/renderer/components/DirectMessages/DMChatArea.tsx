import React, { useCallback } from 'react';
import { MessageSquare } from 'lucide-react';
import MessageList from '../Chat/MessageList';
import MessageInput from '../Chat/MessageInput';
import TypingIndicator from '../Chat/TypingIndicator';
import { useDMStore, type DMConversation } from '../../stores/dmStore';
import { useChatStore } from '../../stores/chatStore';
import { useUserStore } from '../../stores/userStore';
import { useDMSubscription } from '../../hooks/useDMSubscription';
import { useMessageFetch } from '../../hooks/useMessageFetch';
import { apiFetch, safeJson } from '../../services/apiClient';
import { e2eeService } from '../../services/e2eeService';
import { getWebSocketService, ConnectionState } from '../../services/websocketService';
import { getMessageQueue } from '../../services/messageQueue';
import type { MessageWithStatus } from '../../types/chat';
import { usePrivacyStore } from '../../stores/privacyStore';
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
  const conversations = useDMStore((s) => s.conversations);
  const clearUnread = useDMStore((s) => s.clearUnread);
  const addMessage = useChatStore((s) => s.addMessage);
  const updateMessageStatus = useChatStore((s) => s.updateMessageStatus);
  const user = useUserStore((s) => s.user);
  const dmPrivacyLevel = usePrivacyStore((s) => s.settings.dmPrivacyLevel);

  // Subscribe to active DM conversation for real-time messages
  useDMSubscription(selectedThreadId);

  const activeConv = conversations.find((c) => c.id === selectedThreadId);
  const currentUserId = user?.id || '';
  const threadName = getThreadName(activeConv, currentUserId);

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

  // Send DM message
  const handleSendMessage = useCallback(
    (
      content: string,
      mentionMeta?: string,
      _replyToId?: string,
      attachmentIds?: string[],
      attachments?: import('../../types/chat').AttachmentSummary[]
    ) => {
      if (!selectedThreadId || !user) return;

      const wsService = getWebSocketService();
      const messageQueue = getMessageQueue({});
      const isEncrypted = activeConv?.isEncrypted ?? false;

      const clientMessageId = messageQueue.enqueue(selectedThreadId, content, 'message');

      // Optimistic UI
      const optimisticMessage: MessageWithStatus = {
        id: clientMessageId,
        clientMessageId,
        channel_id: selectedThreadId,
        user_id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        content,
        is_encrypted: isEncrypted,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'pending',
        attachments,
      };

      addMessage(selectedThreadId, optimisticMessage);

      if (wsService.getState() === ConnectionState.CONNECTED) {
        const doSend = async () => {
          try {
            let sendContent = content;
            if (isEncrypted) {
              sendContent = await e2eeService.encryptForChannel(selectedThreadId, content);
              if (!sendContent || sendContent.length < 40) {
                throw new Error('Encryption produced invalid output');
              }
            }
            wsService.sendDMMessage(
              selectedThreadId,
              sendContent,
              clientMessageId,
              isEncrypted,
              undefined,
              mentionMeta,
              attachmentIds
            );
            messageQueue.markAsSent(clientMessageId);
            messageQueue.remove(clientMessageId);
            updateMessageStatus(selectedThreadId, clientMessageId, 'sent');
          } catch (error) {
            console.error('[DMChatArea] Failed to send DM message:', error);
            const errMsg = isEncrypted ? 'Encryption failed — message not sent' : String(error);
            messageQueue.markAsFailed(clientMessageId, errMsg);
            updateMessageStatus(selectedThreadId, clientMessageId, 'failed', undefined, errMsg);
          }
        };
        doSend();
      }

      return clientMessageId;
    },
    [selectedThreadId, user, activeConv, addMessage, updateMessageStatus]
  );

  // Edit DM message via REST
  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!selectedThreadId) return;
      try {
        // Encrypt if conversation is E2EE
        let sendContent = newContent;
        const isEncrypted = activeConv?.isEncrypted ?? false;
        if (isEncrypted && e2eeService.isInitialized) {
          sendContent = await e2eeService.encryptForChannel(selectedThreadId, newContent);
        }

        const res = await apiFetch(
          `/api/v1/dm/conversations/${selectedThreadId}/messages/${messageId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: sendContent }),
          }
        );
        if (!res.ok) {
          const data = await safeJson<{ error?: string }>(res);
          throw new Error(data.error || 'Failed to edit message');
        }
        const data = await safeJson<{
          message: {
            content: string;
            is_encrypted: boolean;
            key_version?: number;
            edited_at: string;
          };
        }>(res);
        const updateMessage = useChatStore.getState().updateMessage;
        updateMessage(selectedThreadId, messageId, {
          content: isEncrypted ? newContent : data.message.content,
          is_encrypted: data.message.is_encrypted,
          key_version: data.message.key_version,
          edited_at: data.message.edited_at,
        });
      } catch (err) {
        console.error('Failed to edit DM message:', err);
      }
    },
    [selectedThreadId, activeConv]
  );

  // Delete DM message via REST
  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!selectedThreadId) return;
      try {
        const res = await apiFetch(
          `/api/v1/dm/conversations/${selectedThreadId}/messages/${messageId}`,
          { method: 'DELETE' }
        );
        if (!res.ok) {
          const data = await safeJson<{ error?: string }>(res);
          throw new Error(data.error || 'Failed to delete message');
        }
        const deleteMessage = useChatStore.getState().deleteMessage;
        deleteMessage(selectedThreadId, messageId);
      } catch (err) {
        console.error('Failed to delete DM message:', err);
      }
    },
    [selectedThreadId]
  );

  // Unseen count on leave
  const handleUnseenOnLeave = useCallback(
    (count: number) => {
      if (!selectedThreadId || count <= 0) return;
      useDMStore.getState().incrementUnread(selectedThreadId);
    },
    [selectedThreadId]
  );

  // Send DM typing indicator via WebSocket
  const handleTyping = useCallback(
    (isTyping: boolean) => {
      if (selectedThreadId) {
        getWebSocketService()?.sendDMTypingIndicator(selectedThreadId, isTyping);
      }
    },
    [selectedThreadId]
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
    <div
      className="dm-chat-placeholder"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div className="dm-chat-header">
        <div className="conversation-avatar" style={{ width: 28, height: 28 }}>
          <span className="conversation-avatar-initial" style={{ fontSize: 12 }}>
            {threadName.charAt(0).toUpperCase()}
          </span>
        </div>
        <div>
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
      </div>

      {error && <div className="chat-error">{error}</div>}

      <div className="chat-messages" style={{ flex: 1, minHeight: 0 }}>
        <MessageList
          key={selectedThreadId}
          messages={messages}
          currentUserId={currentUserId}
          channelName={threadName}
          isLoading={isLoading}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteMessage}
          onUnseenOnLeave={handleUnseenOnLeave}
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
            onTyping={handleTyping}
            channelName={threadName}
            disabled={!currentUserId}
            isChannelEncrypted={activeConv?.isEncrypted ?? false}
            conversationId={selectedThreadId || undefined}
          />
        </div>
      )}
    </div>
  );
};

export default DMChatArea;
