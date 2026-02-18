import React, { useEffect, useState, useCallback, useRef } from 'react';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import { useChannelStore } from '../../stores/channelStore';
import { useChatStore } from '../../stores/chatStore';
import { useUserStore } from '../../stores/userStore';
import { useChannelSubscription } from '../../hooks/useChannelSubscription';
import { useMessaging } from '../../hooks/useMessaging';
import { apiFetch } from '../../services/apiClient';
import type { MessageWithStatus } from '../../types/chat';
import './ChatView.css';

const MESSAGES_LIMIT = 50;

const ChatView: React.FC = () => {
  const activeChannelId = useChannelStore((s) => s.activeChannelId);
  const channels = useChannelStore((s) => s.channels);
  const messagesByChannel = useChatStore((s) => s.messagesByChannel);
  const setMessages = useChatStore((s) => s.setMessages);
  const prependMessages = useChatStore((s) => s.prependMessages);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const user = useUserStore((s) => s.user);

  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedChannels = useRef<Set<string>>(new Set());

  // Auto-subscribe/unsubscribe to active channel
  useChannelSubscription(activeChannelId);

  // Optimistic messaging hook
  const { sendMessage } = useMessaging();

  // Active channel info
  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const messages: MessageWithStatus[] =
    (activeChannelId && messagesByChannel.get(activeChannelId)) || [];
  const currentUserId = user?.id || '';

  // Fetch message history when channel changes
  useEffect(() => {
    if (!activeChannelId) return;

    // Skip if already fetched for this channel
    if (fetchedChannels.current.has(activeChannelId)) return;

    const fetchMessages = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await apiFetch(
          `/api/v1/channels/${activeChannelId}/messages?limit=${MESSAGES_LIMIT}`
        );

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to load messages');
        }

        const data = await res.json();
        const msgs: MessageWithStatus[] = (data.messages || []).map(
          (m: MessageWithStatus) => ({ ...m, status: 'delivered' as const })
        );

        setMessages(activeChannelId, msgs);
        setHasMore(msgs.length === MESSAGES_LIMIT);
        fetchedChannels.current.add(activeChannelId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        setIsLoading(false);
      }
    };

    fetchMessages();
  }, [activeChannelId, setMessages]);

  // Load older messages (pagination)
  const handleLoadMore = useCallback(async () => {
    if (!activeChannelId || isLoading || !hasMore) return;

    const channelMessages = messagesByChannel.get(activeChannelId);
    if (!channelMessages || channelMessages.length === 0) return;

    const oldestMessage = channelMessages[0];

    setIsLoading(true);
    try {
      const res = await apiFetch(
        `/api/v1/channels/${activeChannelId}/messages?limit=${MESSAGES_LIMIT}&before=${oldestMessage.id}`
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to load more messages');
      }

      const data = await res.json();
      const msgs: MessageWithStatus[] = (data.messages || []).map(
        (m: MessageWithStatus) => ({ ...m, status: 'delivered' as const })
      );

      prependMessages(activeChannelId, msgs);
      setHasMore(msgs.length === MESSAGES_LIMIT);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeChannelId, isLoading, hasMore, messagesByChannel, prependMessages]);

  // Send message (optimistic via useMessaging)
  const handleSendMessage = useCallback(
    (content: string, _isEncrypted: boolean) => {
      if (!activeChannelId) return;
      sendMessage(activeChannelId, content, user?.username || 'You', user?.avatar_url, user?.display_name);
    },
    [activeChannelId, sendMessage, user?.username, user?.avatar_url, user?.display_name]
  );

  // Edit message via REST
  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!activeChannelId) return;

      try {
        const res = await apiFetch(`/api/v1/messages/${messageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: newContent }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to edit message');
        }

        const data = await res.json();
        updateMessage(activeChannelId, messageId, {
          content: data.message.content,
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
          const data = await res.json();
          throw new Error(data.error || 'Failed to delete message');
        }

        deleteMessage(activeChannelId, messageId);
      } catch (err) {
        console.error('Failed to delete message:', err);
      }
    },
    [activeChannelId, deleteMessage]
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
          <svg className="chat-header-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M7 2l-1.5 6H2l1 2h3l-1 4H2l1 2h2.5L4 22h2l1.5-6H11L9.5 22h2L13 16h3.5l-1-2H12l1-4h3.5l-1-2H13L14.5 2h-2L11 8H7.5L9 2H7z"
              fill="currentColor"
              transform="scale(0.83)"
            />
          </svg>
        )}
        <span className="chat-header-name">
          {activeChannel?.name || 'Channel'}
        </span>
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
        />
      </div>

      <div className="chat-input">
        <MessageInput
          onSendMessage={handleSendMessage}
          channelName={activeChannel?.name}
          disabled={!currentUserId}
        />
      </div>
    </div>
  );
};

export default ChatView;
