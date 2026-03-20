import React, { useCallback } from 'react';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import TypingIndicator from './TypingIndicator';
import { useChannelStore } from '../../stores/channelStore';
import { useChatStore } from '../../stores/chatStore';
import { getWebSocketService } from '../../services/websocketService';
import { useUserStore } from '../../stores/userStore';
import { useChannelSubscription } from '../../hooks/useChannelSubscription';
import { useMessageFetch } from '../../hooks/useMessageFetch';
import { useMessaging } from '../../hooks/useMessaging';
import { useUnreadStore } from '../../stores/unreadStore';
import { useServerStore } from '../../stores/serverStore';
import { apiFetch, safeJson } from '../../services/apiClient';
import { e2eeService } from '../../services/e2eeService';
import type { MessageWithStatus } from '../../types/chat';
import './ChatView.css';

const ChatView: React.FC = () => {
  const activeChannelId = useChannelStore((s) => s.activeChannelId);
  const channels = useChannelStore((s) => s.channels);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const user = useUserStore((s) => s.user);

  // Subscribe to active channel for full message delivery
  useChannelSubscription(activeChannelId);

  // Shared fetch/decrypt/paginate logic
  const { messages, isLoading, hasMore, error, handleLoadMore } = useMessageFetch(activeChannelId, {
    type: 'channel',
  });

  // Called by MessageList on unmount when the user left with unseen messages
  const handleUnseenOnLeave = useCallback(
    (count: number) => {
      const channelId = activeChannelId;
      if (!channelId || count <= 0) return;
      useUnreadStore.getState().setUnreadCount(channelId, count);
      const serverId = useServerStore.getState().activeServerId;
      if (serverId) {
        useUnreadStore.getState().markServerUnread(serverId);
      }
    },
    [activeChannelId]
  );

  // Optimistic messaging hook
  const { sendMessage } = useMessaging();

  // Active channel info
  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const currentUserId = user?.id || '';

  // Send message (optimistic via useMessaging — E2EE handled internally)
  const handleSendMessage = useCallback(
    (content: string, mentionMeta?: string) => {
      if (!activeChannelId) return;
      sendMessage(
        activeChannelId,
        content,
        user?.username || 'You',
        user?.avatar_url,
        user?.display_name,
        mentionMeta
      );
    },
    [activeChannelId, sendMessage, user?.username, user?.avatar_url, user?.display_name]
  );

  // Edit message via REST
  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!activeChannelId) return;

      try {
        // Encrypt if channel is E2EE
        let sendContent = newContent;
        const channel = useChannelStore.getState().channels.find((c) => c.id === activeChannelId);
        if (channel?.is_encrypted && e2eeService.isInitialized) {
          sendContent = await e2eeService.encryptForChannel(activeChannelId, newContent);
        }

        const res = await apiFetch(`/api/v1/messages/${messageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: sendContent }),
        });

        if (!res.ok) {
          const data = await safeJson<{ error?: string }>(res);
          throw new Error(data.error || 'Failed to edit message');
        }

        const data = await safeJson<{ message: MessageWithStatus }>(res);
        updateMessage(activeChannelId, messageId, {
          content: channel?.is_encrypted ? newContent : data.message.content,
          is_encrypted: data.message.is_encrypted,
          key_version: data.message.key_version,
          edited_at: data.message.edited_at,
          updated_at: data.message.updated_at,
        });
      } catch (err) {
        console.error('Failed to edit message:', err);
      }
    },
    [activeChannelId, updateMessage]
  );

  // Delete message via REST
  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!activeChannelId) return;

      try {
        const res = await apiFetch(`/api/v1/messages/${messageId}`, {
          method: 'DELETE',
        });

        if (!res.ok) {
          const data = await safeJson<{ error?: string }>(res);
          throw new Error(data.error || 'Failed to delete message');
        }

        deleteMessage(activeChannelId, messageId);
      } catch (err) {
        console.error('Failed to delete message:', err);
      }
    },
    [activeChannelId, deleteMessage]
  );

  // Send typing indicator via WebSocket
  const handleTyping = useCallback(
    (isTyping: boolean) => {
      if (activeChannelId) {
        getWebSocketService()?.sendTypingIndicator(activeChannelId, isTyping);
      }
    },
    [activeChannelId]
  );

  if (!activeChannelId) {
    return null;
  }

  return (
    <div className="chat-view">
      <div className="chat-header">
        {activeChannel?.emoji ? (
          <span className="chat-header-emoji">{activeChannel.emoji}</span>
        ) : (
          <svg
            className="chat-header-icon"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="4" y1="15" x2="20" y2="15" />
            <line x1="10" y1="3" x2="8" y2="21" />
            <line x1="16" y1="3" x2="14" y2="21" />
          </svg>
        )}
        <span className="chat-header-name">{activeChannel?.name || 'Channel'}</span>
      </div>

      {error && <div className="chat-error">{error}</div>}

      <div className="chat-messages">
        <MessageList
          key={activeChannelId}
          messages={messages}
          currentUserId={currentUserId}
          channelName={activeChannel?.name}
          isLoading={isLoading}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteMessage}
          onUnseenOnLeave={handleUnseenOnLeave}
        />
      </div>

      <TypingIndicator channelId={activeChannelId} />

      <div className="chat-input">
        <MessageInput
          onSendMessage={handleSendMessage}
          onTyping={handleTyping}
          channelName={activeChannel?.name}
          disabled={!currentUserId}
          isChannelEncrypted={activeChannel?.is_encrypted ?? false}
          serverId={activeChannel?.server_id}
          channelId={activeChannelId || undefined}
        />
      </div>
    </div>
  );
};

export default ChatView;
