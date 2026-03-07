import React, { useEffect, useState, useCallback } from 'react';
import { MessageSquare, Volume2, PanelBottom, PanelRight } from 'lucide-react';
import MessageList from '../Chat/MessageList';
import MessageInput from '../Chat/MessageInput';
import { useChannelStore } from '../../stores/channelStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUserStore } from '../../stores/userStore';
import { useTTSSettingsStore } from '../../stores/ttsSettingsStore';
import { useChannelSubscription } from '../../hooks/useChannelSubscription';
import { useMessaging } from '../../hooks/useMessaging';
import { apiFetch } from '../../services/apiClient';
import { e2eeService } from '../../services/e2eeService';
import type { MessageWithStatus } from '../../types/chat';
import './VoiceTextChat.css';

const MESSAGES_LIMIT = 50;

const VoiceTextChat: React.FC = () => {
  const activeChannelId = useVoiceStore((s) => s.activeChannelId);
  const voiceTextChatLayout = useVoiceStore((s) => s.voiceTextChatLayout);
  const toggleVoiceTextChatLayout = useVoiceStore((s) => s.toggleVoiceTextChatLayout);
  const getLinkedTextChannel = useChannelStore((s) => s.getLinkedTextChannel);

  const linkedChannel = activeChannelId ? getLinkedTextChannel(activeChannelId) : undefined;
  const channelId = linkedChannel?.id ?? null;

  const messagesByChannel = useChatStore((s) => s.messagesByChannel);
  const setMessages = useChatStore((s) => s.setMessages);
  const prependMessages = useChatStore((s) => s.prependMessages);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const user = useUserStore((s) => s.user);

  const ttsEnabled = useTTSSettingsStore((s) => s.ttsEnabled);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll speechSynthesis.speaking for TTS indicator
  useEffect(() => {
    if (!ttsEnabled || !window.speechSynthesis) return;
    const interval = setInterval(() => {
      setIsSpeaking(window.speechSynthesis.speaking);
    }, 250);
    return () => clearInterval(interval);
  }, [ttsEnabled]);

  // Subscribe to the linked text channel for real-time messages
  useChannelSubscription(channelId);

  const { sendMessage } = useMessaging();

  const messages: MessageWithStatus[] = (channelId && messagesByChannel.get(channelId)) || [];
  const currentUserId = user?.id || '';

  // Fetch messages when linked channel becomes available
  useEffect(() => {
    if (!channelId) return;

    let aborted = false;

    const fetchMessages = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await apiFetch(
          `/api/v1/channels/${channelId}/messages?limit=${MESSAGES_LIMIT}`
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

        // Decrypt if encrypted
        const msgs = await Promise.all(
          rawMsgs.map(async (m) => {
            if (m.is_encrypted && channelId && e2eeService.isInitialized) {
              try {
                const plaintext =
                  m.key_version && m.key_version > 1
                    ? await e2eeService.decryptForChannelWithVersion(
                        channelId,
                        m.content,
                        m.key_version
                      )
                    : await e2eeService.decryptForChannel(channelId, m.content);
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
        const existing = useChatStore.getState().messagesByChannel.get(channelId) || [];
        const optimistic = existing.filter(
          (m) => m.clientMessageId && (m.status === 'pending' || m.status === 'sent')
        );
        const fetchedIds = new Set(msgs.map((m) => m.id));
        const kept = optimistic.filter(
          (m) => !fetchedIds.has(m.id) && !fetchedIds.has(m.clientMessageId!)
        );
        // Sort ASC (oldest first) for chronological display — defensive against server order
        msgs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        const merged = kept.length > 0 ? [...msgs, ...kept] : msgs;
        merged.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        setMessages(channelId, merged);
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
  }, [channelId, setMessages]);

  const handleLoadMore = useCallback(async () => {
    if (!channelId || isLoading || !hasMore) return;

    const channelMessages = messagesByChannel.get(channelId);
    if (!channelMessages || channelMessages.length === 0) return;

    const oldestMessage = channelMessages[0];
    setIsLoading(true);

    try {
      const res = await apiFetch(
        `/api/v1/channels/${channelId}/messages?limit=${MESSAGES_LIMIT}&before=${oldestMessage.id}`
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
          if (m.is_encrypted && channelId && e2eeService.isInitialized) {
            try {
              const plaintext =
                m.key_version && m.key_version > 1
                  ? await e2eeService.decryptForChannelWithVersion(
                      channelId,
                      m.content,
                      m.key_version
                    )
                  : await e2eeService.decryptForChannel(channelId, m.content);
              return { ...m, content: plaintext };
            } catch (err) {
              const isPending = err instanceof Error && err.message === 'PENDING_KEY';
              return { ...m, content: '', decryptFailed: !isPending, pendingKeys: isPending };
            }
          }
          return m;
        })
      );

      // Sort ASC (oldest first) for chronological display — defensive against server order
      msgs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      prependMessages(channelId, msgs);
      setHasMore(msgs.length === MESSAGES_LIMIT);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      setIsLoading(false);
    }
  }, [channelId, isLoading, hasMore, messagesByChannel, prependMessages]);

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!channelId) return;
      sendMessage(
        channelId,
        content,
        user?.username || 'You',
        user?.avatar_url,
        user?.display_name
      );
    },
    [channelId, sendMessage, user?.username, user?.avatar_url, user?.display_name]
  );

  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!channelId) return;
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
        updateMessage(channelId, messageId, {
          content: data.message.content,
          is_encrypted: data.message.is_encrypted,
          key_version: data.message.key_version,
          edited_at: data.message.edited_at,
          updated_at: data.message.updated_at,
        });
      } catch (err) {
        console.error('Failed to edit message:', err);
      }
    },
    [channelId, updateMessage]
  );

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!channelId) return;
      try {
        const res = await apiFetch(`/api/v1/messages/${messageId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to delete message');
        }
        deleteMessage(channelId, messageId);
      } catch (err) {
        console.error('Failed to delete message:', err);
      }
    },
    [channelId, deleteMessage]
  );

  if (!channelId || !linkedChannel) {
    return (
      <div className="voice-text-chat voice-text-chat--empty">
        <MessageSquare size={20} />
        <span>No text channel linked</span>
      </div>
    );
  }

  return (
    <div className="voice-text-chat">
      <div className="voice-text-chat__header">
        <MessageSquare size={14} />
        <span className="voice-text-chat__title">{linkedChannel.name} Text Chat</span>
        <button
          type="button"
          className="voice-text-chat__layout-toggle"
          onClick={toggleVoiceTextChatLayout}
          title={
            voiceTextChatLayout === 'horizontal'
              ? 'Switch to side layout'
              : 'Switch to bottom layout'
          }
        >
          {voiceTextChatLayout === 'horizontal' ? (
            <PanelRight size={14} />
          ) : (
            <PanelBottom size={14} />
          )}
        </button>
      </div>

      {error && <div className="voice-text-chat__error">{error}</div>}

      <div className="voice-text-chat__messages">
        <MessageList
          key={channelId}
          messages={messages}
          currentUserId={currentUserId}
          channelName={linkedChannel.name}
          isLoading={isLoading}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteMessage}
        />
      </div>

      {isSpeaking && (
        <div className="voice-text-chat__tts-indicator">
          <Volume2 size={12} />
          <span>Speaking...</span>
        </div>
      )}

      <div className="voice-text-chat__input">
        <MessageInput
          onSendMessage={handleSendMessage}
          channelName={linkedChannel.name}
          disabled={!currentUserId}
          isChannelEncrypted={linkedChannel.is_encrypted ?? false}
          placeholder={`Message ${linkedChannel.name} text chat...`}
        />
      </div>
    </div>
  );
};

export default VoiceTextChat;
