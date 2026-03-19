import React, { useEffect, useState, useCallback } from 'react';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import TypingIndicator from './TypingIndicator';
import { useChannelStore } from '../../stores/channelStore';
import { useChatStore } from '../../stores/chatStore';
import { getWebSocketService } from '../../services/websocketService';
import { useUserStore } from '../../stores/userStore';
import { useChannelSubscription } from '../../hooks/useChannelSubscription';
import { useMessaging } from '../../hooks/useMessaging';
import { useUnreadStore } from '../../stores/unreadStore';
import { useServerStore } from '../../stores/serverStore';
import { apiFetch, safeJson } from '../../services/apiClient';
import { e2eeService } from '../../services/e2eeService';
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

  // Subscribe to active channel for full message delivery
  useChannelSubscription(activeChannelId);

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
  const messages: MessageWithStatus[] =
    (activeChannelId && messagesByChannel.get(activeChannelId)) || [];
  const currentUserId = user?.id || '';

  // Track fetch trigger — incremented when keys are delivered to re-decrypt messages
  const [fetchTrigger, setFetchTrigger] = useState(0);

  // Listen for key delivery events to re-fetch and decrypt messages
  useEffect(() => {
    const handler = (e: Event) => {
      const { channelId } = (e as CustomEvent).detail;
      if (channelId === activeChannelId) {
        setFetchTrigger((prev) => prev + 1);
      }
    };
    window.addEventListener('e2ee-key-delivered', handler);
    return () => window.removeEventListener('e2ee-key-delivered', handler);
  }, [activeChannelId]);

  // Retry key fetch when messages are stuck in pending state
  const hasPendingKeys = messages.some((m) => m.pendingKeys);
  useEffect(() => {
    if (!hasPendingKeys || !activeChannelId) return;

    const interval = setInterval(() => {
      // Try to fetch the key — if it's now available, trigger a re-fetch
      e2eeService
        .getChannelKey(activeChannelId)
        .then(() => {
          // Key is now available — re-fetch messages to decrypt
          e2eeService.invalidateChannelKey(activeChannelId);
          setFetchTrigger((prev) => prev + 1);
        })
        .catch(() => {
          // Still pending — will retry
        });
    }, 5000);

    return () => clearInterval(interval);
  }, [activeChannelId, hasPendingKeys]);

  // Fetch message history when channel changes — always re-fetch to catch up
  // on messages sent while the user was viewing another channel
  useEffect(() => {
    if (!activeChannelId) return;

    let aborted = false;

    const fetchMessages = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await apiFetch(
          `/api/v1/channels/${activeChannelId}/messages?limit=${MESSAGES_LIMIT}`
        );
        if (aborted) return;

        if (!res.ok) {
          const data = await safeJson<{ error?: string }>(res);
          throw new Error(data.error || 'Failed to load messages');
        }

        const data = await safeJson<{ messages?: MessageWithStatus[] }>(res);
        if (aborted) return;
        const rawMsgs: MessageWithStatus[] = (data.messages || []).map((m: MessageWithStatus) => ({
          ...m,
          status: 'delivered' as const,
        }));

        // Pre-fetch channel key ONCE to prevent N concurrent getChannelKey() calls
        let channelKey: CryptoKey | null = null;
        if (rawMsgs.some((m) => m.is_encrypted) && e2eeService.isInitialized) {
          try {
            channelKey = await e2eeService.getChannelKey(activeChannelId);
          } catch {
            // Key not available yet — individual messages will show pending/failed state
          }
        }
        if (aborted) return;

        // Decrypt encrypted messages (fail-closed: show placeholder, never raw ciphertext)
        const msgs = await Promise.all(
          rawMsgs.map(async (m) => {
            if (m.is_encrypted && activeChannelId && e2eeService.isInitialized) {
              try {
                const plaintext =
                  m.key_version && m.key_version > 1
                    ? await e2eeService.decryptForChannelWithVersion(
                        activeChannelId,
                        m.content,
                        m.key_version
                      )
                    : channelKey
                      ? await e2eeService.decryptWithKey(m.content, channelKey)
                      : await e2eeService.decryptForChannel(activeChannelId, m.content);
                return { ...m, content: plaintext };
              } catch (err) {
                const isPending = err instanceof Error && err.message === 'PENDING_KEY';
                return { ...m, content: '', decryptFailed: !isPending, pendingKeys: isPending };
              }
            }
            return m;
          })
        );
        if (aborted) return;

        // Merge with any optimistic messages the user sent while the fetch
        // was in flight (e.g. during React StrictMode double-mount or reconnect).
        const existing = useChatStore.getState().messagesByChannel.get(activeChannelId) || [];
        const optimistic = existing.filter(
          (m) => m.clientMessageId && (m.status === 'pending' || m.status === 'sent')
        );
        const fetchedIds = new Set(msgs.map((m) => m.id));
        const kept = optimistic.filter(
          (m) => !fetchedIds.has(m.id) && !fetchedIds.has(m.clientMessageId!)
        );
        // Server returns DESC (newest first); reverse to ASC for chronological display
        msgs.reverse();
        setMessages(activeChannelId, kept.length > 0 ? [...msgs, ...kept] : msgs);
        setHasMore(msgs.length === MESSAGES_LIMIT);
      } catch (err) {
        if (!aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load messages');
        }
      } finally {
        if (!aborted) {
          setIsLoading(false);
        }
      }
    };

    fetchMessages();

    return () => {
      aborted = true;
    };
  }, [activeChannelId, setMessages, fetchTrigger]);

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
        const data = await safeJson<{ error?: string }>(res);
        throw new Error(data.error || 'Failed to load more messages');
      }

      const data = await safeJson<{ messages?: MessageWithStatus[] }>(res);
      const rawMsgs: MessageWithStatus[] = (data.messages || []).map((m: MessageWithStatus) => ({
        ...m,
        status: 'delivered' as const,
      }));

      // Pre-fetch channel key ONCE for batch decryption
      let channelKey: CryptoKey | null = null;
      if (rawMsgs.some((m) => m.is_encrypted) && e2eeService.isInitialized) {
        try {
          channelKey = await e2eeService.getChannelKey(activeChannelId);
        } catch {
          // Key not available — individual messages will show pending/failed
        }
      }

      // Decrypt encrypted messages (same as initial fetch)
      const msgs = await Promise.all(
        rawMsgs.map(async (m) => {
          if (m.is_encrypted && activeChannelId && e2eeService.isInitialized) {
            try {
              const plaintext =
                m.key_version && m.key_version > 1
                  ? await e2eeService.decryptForChannelWithVersion(
                      activeChannelId,
                      m.content,
                      m.key_version
                    )
                  : channelKey
                    ? await e2eeService.decryptWithKey(m.content, channelKey)
                    : await e2eeService.decryptForChannel(activeChannelId, m.content);
              return { ...m, content: plaintext };
            } catch (err) {
              const isPending = err instanceof Error && err.message === 'PENDING_KEY';
              return { ...m, content: '', decryptFailed: !isPending, pendingKeys: isPending };
            }
          }
          return m;
        })
      );

      // Server returns DESC; reverse to ASC so oldest-first prepends correctly
      msgs.reverse();
      prependMessages(activeChannelId, msgs);
      setHasMore(msgs.length === MESSAGES_LIMIT);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeChannelId, isLoading, hasMore, messagesByChannel, prependMessages]);

  // Send message (optimistic via useMessaging — E2EE handled internally)
  const handleSendMessage = useCallback(
    (content: string) => {
      if (!activeChannelId) return;
      sendMessage(
        activeChannelId,
        content,
        user?.username || 'You',
        user?.avatar_url,
        user?.display_name
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
          const data = await res.json();
          throw new Error(data.error || 'Failed to edit message');
        }

        const data = await res.json();
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
        />
      </div>
    </div>
  );
};

export default ChatView;
