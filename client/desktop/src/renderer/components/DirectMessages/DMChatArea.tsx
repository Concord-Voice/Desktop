import React, { useEffect, useState, useCallback } from 'react';
import { MessageSquare } from 'lucide-react';
import MessageList from '../Chat/MessageList';
import MessageInput from '../Chat/MessageInput';
import { useDMStore, type DMConversation } from '../../stores/dmStore';
import { useChatStore } from '../../stores/chatStore';
import { useUserStore } from '../../stores/userStore';
import { useDMSubscription } from '../../hooks/useDMSubscription';
import { apiFetch } from '../../services/apiClient';
import { e2eeService } from '../../services/e2eeService';
import { getWebSocketService, ConnectionState } from '../../services/websocketService';
import { getMessageQueue } from '../../services/messageQueue';
import type { MessageWithStatus } from '../../types/chat';
import './DirectMessages.css';

/*
 * Split view concept (future implementation):
 * When an active voice call is in progress within a DM, the chat area splits:
 *   - Top half: voice/video/screen-share view (reuse VoiceView/ParticipantGrid)
 *   - Bottom half: text chat (reuse MessageList + MessageInput)
 * If no active call, the text chat takes the full height.
 */

const MESSAGES_LIMIT = 50;

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
  const messagesByChannel = useChatStore((s) => s.messagesByChannel);
  const setMessages = useChatStore((s) => s.setMessages);
  const prependMessages = useChatStore((s) => s.prependMessages);
  const addMessage = useChatStore((s) => s.addMessage);
  const updateMessageStatus = useChatStore((s) => s.updateMessageStatus);
  const user = useUserStore((s) => s.user);

  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  // Subscribe to active DM conversation for real-time messages
  useDMSubscription(selectedThreadId);

  const activeConv = conversations.find((c) => c.id === selectedThreadId);
  const messages: MessageWithStatus[] =
    (selectedThreadId && messagesByChannel.get(selectedThreadId)) || [];
  const currentUserId = user?.id || '';
  const threadName = getThreadName(activeConv, currentUserId);

  // Listen for key delivery events to re-decrypt messages
  useEffect(() => {
    const handler = (e: Event) => {
      const { channelId } = (e as CustomEvent).detail;
      if (channelId === selectedThreadId) {
        setFetchTrigger((prev) => prev + 1);
      }
    };
    window.addEventListener('e2ee-key-delivered', handler);
    return () => window.removeEventListener('e2ee-key-delivered', handler);
  }, [selectedThreadId]);

  // Fetch message history when conversation changes
  useEffect(() => {
    if (!selectedThreadId) return;

    let aborted = false;

    const fetchMessages = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await apiFetch(
          `/api/v1/dm/conversations/${selectedThreadId}/messages?limit=${MESSAGES_LIMIT}`
        );
        if (aborted) return;

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to load messages');
        }

        const data = await res.json();
        if (aborted) return;
        const rawMsgs: MessageWithStatus[] = (data.messages || []).map((m: MessageWithStatus) => ({
          ...m,
          status: 'delivered' as const,
        }));

        // Decrypt encrypted messages
        const msgs = await Promise.all(
          rawMsgs.map(async (m) => {
            if (m.is_encrypted && selectedThreadId && e2eeService.isInitialized) {
              try {
                const plaintext = await e2eeService.decryptForChannel(selectedThreadId, m.content);
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

        setMessages(selectedThreadId, msgs);
        setHasMore(msgs.length === MESSAGES_LIMIT);

        // Mark conversation as read
        apiFetch(`/api/v1/dm/conversations/${selectedThreadId}/read`, { method: 'POST' }).catch(() => {});
        clearUnread(selectedThreadId);
      } catch (err) {
        if (!aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load messages');
        }
      } finally {
        if (!aborted) setIsLoading(false);
      }
    };

    fetchMessages();
    return () => { aborted = true; };
  }, [selectedThreadId, setMessages, clearUnread, fetchTrigger]);

  // Load older messages (pagination)
  const handleLoadMore = useCallback(async () => {
    if (!selectedThreadId || isLoading || !hasMore) return;

    const channelMessages = messagesByChannel.get(selectedThreadId);
    if (!channelMessages || channelMessages.length === 0) return;

    const oldestMessage = channelMessages[0];

    setIsLoading(true);
    try {
      const res = await apiFetch(
        `/api/v1/dm/conversations/${selectedThreadId}/messages?limit=${MESSAGES_LIMIT}&before=${oldestMessage.id}`
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to load more messages');
      }

      const data = await res.json();
      const rawMsgs: MessageWithStatus[] = (data.messages || []).map((m: MessageWithStatus) => ({
        ...m,
        status: 'delivered' as const,
      }));

      const msgs = await Promise.all(
        rawMsgs.map(async (m) => {
          if (m.is_encrypted && selectedThreadId && e2eeService.isInitialized) {
            try {
              const plaintext = await e2eeService.decryptForChannel(selectedThreadId, m.content);
              return { ...m, content: plaintext };
            } catch (err) {
              const isPending = err instanceof Error && err.message === 'PENDING_KEY';
              return { ...m, content: '', decryptFailed: !isPending, pendingKeys: isPending };
            }
          }
          return m;
        })
      );

      prependMessages(selectedThreadId, msgs);
      setHasMore(msgs.length === MESSAGES_LIMIT);
    } catch (err) {
      console.error('Failed to load more DM messages:', err);
    } finally {
      setIsLoading(false);
    }
  }, [selectedThreadId, isLoading, hasMore, messagesByChannel, prependMessages]);

  // Send DM message
  const handleSendMessage = useCallback(
    (content: string) => {
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
            wsService.sendDMMessage(selectedThreadId, sendContent, clientMessageId, isEncrypted);
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

  // Unseen count on leave
  const handleUnseenOnLeave = useCallback(
    (count: number) => {
      if (!selectedThreadId || count <= 0) return;
      useDMStore.getState().incrementUnread(selectedThreadId);
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
    <div className="dm-chat-placeholder" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="dm-chat-header">
        <div className="conversation-avatar" style={{ width: 28, height: 28 }}>
          <span className="conversation-avatar-initial" style={{ fontSize: 12 }}>
            {threadName.charAt(0).toUpperCase()}
          </span>
        </div>
        <div>
          <div className="dm-chat-header-name">{threadName}</div>
          <div className="dm-chat-header-status">
            {activeConv?.isPersonal
              ? 'Your personal notes'
              : activeConv && !activeConv.isGroup
                ? (activeConv.participants.find((p) => p.userId !== currentUserId)?.status || 'offline')
                : `${activeConv?.participants.length || 0} members`}
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
          onUnseenOnLeave={handleUnseenOnLeave}
        />
      </div>

      <div className="chat-input">
        <MessageInput
          onSendMessage={handleSendMessage}
          channelName={threadName}
          disabled={!currentUserId}
          isChannelEncrypted={activeConv?.isEncrypted ?? false}
        />
      </div>
    </div>
  );
};

export default DMChatArea;
