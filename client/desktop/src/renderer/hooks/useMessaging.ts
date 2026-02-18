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
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { getWebSocketService, ConnectionState } from '../services/websocketService';
import { getMessageQueue, type QueuedMessage } from '../services/messageQueue';
import type { MessageWithStatus } from '../types/chat';

export function useMessaging() {
  const wsService = useRef(getWebSocketService()).current;
  const messageQueue = useRef(
    getMessageQueue({
      onMessageSent: (messageId) => {
        console.log(`[useMessaging] Message ${messageId} sent to server`);
      },
      onMessageDelivered: (messageId, serverMessageId) => {
        console.log(`[useMessaging] Message ${messageId} delivered, server ID: ${serverMessageId}`);
      },
      onMessageFailed: (messageId, error) => {
        console.error(`[useMessaging] Message ${messageId} failed: ${error}`);
      },
    })
  ).current;

  const { updateMessageStatus, addMessage } = useChatStore();
  const { accessToken } = useAuthStore();
  const currentUserId = useRef<string | null>(null);

  // Get current user ID from connection info
  useEffect(() => {
    const connectionInfo = wsService.getConnectionInfo();
    if (connectionInfo) {
      currentUserId.current = connectionInfo.userId;
    }
  }, [wsService]);

  // Start/stop queue processing based on connection state
  useEffect(() => {
    const unsubscribe = wsService.onConnectionChange((state) => {
      if (state === ConnectionState.CONNECTED) {
        // Start processing queue when connected
        messageQueue.startProcessing(async (msg: QueuedMessage) => {
          // Send queued message via WebSocket
          wsService.sendMessage(msg.channelId, msg.content);
        });
      } else {
        // Stop processing when disconnected
        messageQueue.stopProcessing();
      }
    });

    return () => {
      unsubscribe();
      messageQueue.stopProcessing();
    };
  }, [wsService, messageQueue]);

  /**
   * Send a message with delivery tracking
   */
  const sendMessage = useCallback(
    (channelId: string, content: string, username: string = 'You'): string => {
      // Generate client-side message ID
      const clientMessageId = messageQueue.enqueue(channelId, content, 'message');

      // Optimistically add message to UI with "pending" status
      const optimisticMessage: MessageWithStatus = {
        id: clientMessageId, // Temporary ID
        clientMessageId,
        channel_id: channelId,
        user_id: currentUserId.current || 'unknown',
        username,
        content,
        is_encrypted: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'pending',
      };

      addMessage(channelId, optimisticMessage);

      // If connected, send immediately
      if (wsService.getState() === ConnectionState.CONNECTED) {
        try {
          wsService.sendMessage(channelId, content);
          messageQueue.markAsSent(clientMessageId);
          updateMessageStatus(channelId, clientMessageId, 'sent');
        } catch (error) {
          console.error('[useMessaging] Failed to send message:', error);
          messageQueue.markAsFailed(clientMessageId, String(error));
          updateMessageStatus(channelId, clientMessageId, 'failed', undefined, String(error));
        }
      } else {
        // Message stays in queue with "pending" status
        console.log(`[useMessaging] Message queued (offline): ${clientMessageId}`);
      }

      return clientMessageId;
    },
    [wsService, messageQueue, addMessage, updateMessageStatus]
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
