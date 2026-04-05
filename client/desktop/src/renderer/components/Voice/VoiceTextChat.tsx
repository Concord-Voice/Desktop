import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { MessageSquare, Volume2, PanelBottom, PanelRight } from 'lucide-react';
import MessageList from '../Chat/MessageList';
import MessageInput from '../Chat/MessageInput';
import { useChannelStore } from '../../stores/channelStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUserStore } from '../../stores/userStore';
import { useTTSSettingsStore } from '../../stores/ttsSettingsStore';
import { usePermissionStore } from '../../stores/permissionStore';
import { useServerStore } from '../../stores/serverStore';
import { PIN_MESSAGES } from '../../utils/permissions';
import { pinMessage, unpinMessage } from '../../services/pinService';
import { useChannelSubscription } from '../../hooks/useChannelSubscription';
import { useMessageFetch } from '../../hooks/useMessageFetch';
import { useMessaging } from '../../hooks/useMessaging';
import { apiFetch, safeJson } from '../../services/apiClient';
import { e2eeService } from '../../services/e2eeService';
import type { MessageWithStatus } from '../../types/chat';
import './VoiceTextChat.css';

const VoiceTextChat: React.FC = () => {
  const activeChannelId = useVoiceStore((s) => s.activeChannelId);
  const voiceTextChatLayout = useVoiceStore((s) => s.voiceTextChatLayout);
  const toggleVoiceTextChatLayout = useVoiceStore((s) => s.toggleVoiceTextChatLayout);
  const getLinkedTextChannel = useChannelStore((s) => s.getLinkedTextChannel);

  const linkedChannel = activeChannelId ? getLinkedTextChannel(activeChannelId) : undefined;
  const channelId = linkedChannel?.id ?? null;

  const updateMessage = useChatStore((s) => s.updateMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const user = useUserStore((s) => s.user);
  const hasServerPermission = usePermissionStore((s) => s.hasServerPermission);
  const activeServerId = useServerStore((s) => s.activeServerId);

  const [replyingTo, setReplyingTo] = useState<MessageWithStatus | null>(null);
  const handleReply = useCallback((msg: MessageWithStatus) => setReplyingTo(msg), []);
  const handleCancelReply = useCallback(() => setReplyingTo(null), []);

  const canPin = useMemo(() => {
    if (!activeServerId) return false;
    return hasServerPermission(activeServerId, PIN_MESSAGES);
  }, [activeServerId, hasServerPermission]);

  const handlePinToggle = useCallback(async (message: MessageWithStatus) => {
    try {
      if (message.pinned_at) {
        await unpinMessage(message.id);
      } else {
        await pinMessage(message.id);
      }
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    }
  }, []);

  const ttsEnabled = useTTSSettingsStore((s) => s.ttsEnabled);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Poll speechSynthesis.speaking for TTS indicator
  useEffect(() => {
    if (!ttsEnabled || !globalThis.speechSynthesis) return;
    const interval = setInterval(() => {
      setIsSpeaking(globalThis.speechSynthesis.speaking);
    }, 250);
    return () => clearInterval(interval);
  }, [ttsEnabled]);

  // Subscribe to the linked text channel for real-time messages
  useChannelSubscription(channelId);

  // Shared fetch/decrypt/paginate logic
  const { messages, isLoading, hasMore, error, handleLoadMore } = useMessageFetch(channelId, {
    type: 'channel',
  });

  const { sendMessage } = useMessaging();

  const currentUserId = user?.id || '';

  const handleSendMessage = useCallback(
    (
      content: string,
      mentionMeta?: string,
      replyToId?: string,
      attachmentIds?: string[],
      attachments?: import('../../types/chat').AttachmentSummary[]
    ) => {
      if (!channelId) return;
      sendMessage(channelId, content, user?.username || 'You', {
        avatarUrl: user?.avatar_url,
        displayName: user?.display_name,
        mentionMeta,
        replyToId,
        attachmentIds,
        attachments,
      });
      setReplyingTo(null);
    },
    [channelId, sendMessage, user?.username, user?.avatar_url, user?.display_name]
  );

  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!channelId) return;
      try {
        // Encrypt if channel is E2EE
        let sendContent = newContent;
        const channel = useChannelStore.getState().channels.find((c) => c.id === channelId);
        if (channel?.is_encrypted && e2eeService.isInitialized) {
          sendContent = await e2eeService.encryptForChannel(channelId, newContent);
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
        updateMessage(channelId, messageId, {
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
          const data = await safeJson<{ error?: string }>(res);
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
          chatContext="voice"
          channelName={linkedChannel.name}
          isLoading={isLoading}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteMessage}
          onReply={handleReply}
          onPinToggle={handlePinToggle}
          canPin={canPin}
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
          replyingTo={replyingTo}
          onCancelReply={handleCancelReply}
        />
      </div>
    </div>
  );
};

export default VoiceTextChat;
