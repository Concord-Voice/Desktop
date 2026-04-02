/**
 * useMessaging - Enhanced hook for sending messages with delivery tracking
 *
 * Features:
 * - Message queue for offline mode
 * - Delivery status tracking (pending → sent → delivered)
 * - Auto-retry failed messages
 * - Optimistic UI updates
 * - Persistent queue across app restarts
 *
 * Integrates with useWebSocket and MessageQueue
 */

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useUserStore } from '../stores/userStore';
import { useChannelStore } from '../stores/channelStore';
import { getWebSocketService, ConnectionState } from '../services/websocketService';
import { getMessageQueue, type QueuedMessage } from '../services/messageQueue';
import { e2eeService } from '../services/e2eeService';
import type { AttachmentSummary, MessageWithStatus } from '../types/chat';

interface SendMessageOptions {
  avatarUrl?: string;
  displayName?: string;
  mentionMeta?: string;
  replyToId?: string;
  attachmentIds?: string[];
  attachments?: AttachmentSummary[];
}

export function useMessaging() {
  const wsService = useRef(getWebSocketService()).current;
  const messageQueue = useRef(
    getMessageQueue({
      onMessageSent: (messageId) => {
        console.debug(`[useMessaging] Message ${messageId} sent`);
      },
      onMessageDelivered: (messageId, serverMessageId) => {
        console.debug(`[useMessaging] Message ${messageId} delivered (${serverMessageId})`);
      },
      onMessageFailed: (messageId, error) => {
        console.warn(`[useMessaging] Message ${messageId} failed: ${error}`);
      },
    })
  ).current;

  const { updateMessageStatus, addMessage } = useChatStore();
  const userId = useUserStore((s) => s.user?.id);

  // Process a single queued message: encrypt if needed, then send
  const processQueuedMessage = useCallback(
    async (msg: QueuedMessage) => {
      if (!wsService.isSubscribed(msg.channelId)) {
        return; // Skip — will retry on next cycle once subscribed
      }
      const channel = useChannelStore.getState().channels.find((c) => c.id === msg.channelId);
      const isEncrypted = channel?.is_encrypted ?? false;
      let content = msg.content;
      let keyVersion: number | undefined;
      if (isEncrypted && e2eeService.isInitialized) {
        content = await e2eeService.encryptForChannel(msg.channelId, msg.content);
        keyVersion = e2eeService.getCurrentKeyVersion(msg.channelId);
      }
      wsService.sendMessage(msg.channelId, content, {
        nonce: msg.id,
        isEncrypted,
        keyVersion,
        mentionMeta: msg.mentionMeta,
        replyToId: msg.replyToId,
      });
    },
    [wsService]
  );

  // Start/stop queue processing based on connection state
  useEffect(() => {
    const unsubscribe = wsService.onConnectionChange((state) => {
      if (state === ConnectionState.CONNECTED) {
        messageQueue.startProcessing(processQueuedMessage);
      } else {
        messageQueue.stopProcessing();
      }
    });

    return () => {
      unsubscribe();
      messageQueue.stopProcessing();
    };
  }, [wsService, messageQueue]);

  /**
   * Send a message with delivery tracking.
   * If the channel is E2EE, encrypts before sending (fail-closed: won't send if encryption fails).
   */
  const sendMessage = useCallback(
    (
      channelId: string,
      content: string,
      username: string = 'You',
      opts?: SendMessageOptions
    ): string => {
      const { avatarUrl, displayName, mentionMeta, replyToId, attachmentIds, attachments } =
        opts ?? {};
      // Check if channel is encrypted
      const channel = useChannelStore.getState().channels.find((c) => c.id === channelId);
      const isEncrypted = channel?.is_encrypted ?? false;

      // Generate client-side message ID
      const clientMessageId = messageQueue.enqueue(
        channelId,
        content,
        'message',
        mentionMeta,
        replyToId
      );

      // Build replied_to summary from store for optimistic display
      // (prevents "Original message was deleted" flash before WS ack)
      let repliedTo: MessageWithStatus['replied_to'];
      if (replyToId) {
        const storeMessages = useChatStore.getState().messagesByChannel.get(channelId);
        const target = storeMessages?.find((m) => m.id === replyToId);
        if (target) {
          repliedTo = {
            id: target.id,
            user_id: target.user_id,
            username: target.username,
            display_name: target.display_name,
            content: target.content,
            is_encrypted: target.is_encrypted,
          };
        }
      }

      // Optimistically add message to UI with "pending" status
      // Always show plaintext locally for the sender
      const optimisticMessage: MessageWithStatus = {
        id: clientMessageId, // Temporary ID
        clientMessageId,
        channel_id: channelId,
        user_id: userId || 'unknown',
        username,
        display_name: displayName,
        avatar_url: avatarUrl,
        content,
        is_encrypted: isEncrypted,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'pending',
        reply_to_id: replyToId,
        replied_to: repliedTo,
        attachments,
      };

      addMessage(channelId, optimisticMessage);

      // If connected, send immediately (with encryption if needed)
      if (wsService.getState() === ConnectionState.CONNECTED) {
        const doSend = async () => {
          try {
            let sendContent = content;
            let keyVersion: number | undefined;
            if (isEncrypted) {
              // Fail-closed: if encryption fails, do NOT send
              sendContent = await e2eeService.encryptForChannel(channelId, content);
              keyVersion = e2eeService.getCurrentKeyVersion(channelId);
              // Validate encrypted output: must be non-empty base64 with minimum size
              // (12-byte IV + 16-byte auth tag = 28 bytes minimum decoded)
              if (!sendContent || sendContent.length < 40) {
                throw new Error('Encryption produced invalid output');
              }
            }
            wsService.sendMessage(channelId, sendContent, {
              nonce: clientMessageId,
              isEncrypted,
              keyVersion,
              mentionMeta,
              replyToId,
              attachmentIds,
            });
            messageQueue.markAsSent(clientMessageId);
            messageQueue.remove(clientMessageId);
            updateMessageStatus(channelId, clientMessageId, 'sent');
          } catch (error) {
            console.error('[useMessaging] Failed to send message:', error);
            const errMsg = isEncrypted ? 'Encryption failed — message not sent' : String(error);
            messageQueue.markAsFailed(clientMessageId, errMsg);
            updateMessageStatus(channelId, clientMessageId, 'failed', undefined, errMsg);
          }
        };
        doSend();
      } else {
        // Message stays in queue with "pending" status
        console.debug(`[useMessaging] Message queued (offline): ${clientMessageId}`);
      }

      return clientMessageId;
    },
    [wsService, messageQueue, addMessage, updateMessageStatus, userId]
  );

  /**
   * Mark a message as delivered (called when server acknowledges)
   */
  const markDelivered = useCallback(
    (clientMessageId: string, serverMessageId: string, channelId: string) => {
      messageQueue.markAsDelivered(clientMessageId, serverMessageId);
      updateMessageStatus(channelId, clientMessageId, 'delivered', serverMessageId);
    },
    [messageQueue, updateMessageStatus]
  );

  /**
   * Send typing indicator
   */
  const sendTyping = useCallback(
    (channelId: string, isTyping: boolean) => {
      if (wsService.getState() === ConnectionState.CONNECTED) {
        wsService.sendTypingIndicator(channelId, isTyping);
      }
    },
    [wsService]
  );

  /**
   * Get pending message count
   */
  const getPendingCount = useCallback((): number => {
    return messageQueue.size();
  }, [messageQueue]);

  /**
   * Get pending messages for a specific channel
   */
  const getPendingMessagesForChannel = useCallback(
    (channelId: string): QueuedMessage[] => {
      return messageQueue.getMessagesForChannel(channelId);
    },
    [messageQueue]
  );

  return {
    sendMessage,
    markDelivered,
    sendTyping,
    getPendingCount,
    getPendingMessagesForChannel,
  };
}
