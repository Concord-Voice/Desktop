/**
 * useWebSocket - React hook for WebSocket connection management
 *
 * Provides:
 * - Connection state and control
 * - Message sending
 * - Channel subscriptions
 * - Typing indicators
 * - Integration with chat store
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import {
  getWebSocketService,
  ConnectionState,
  type WebSocketMessage,
} from '../services/websocketService';

export function useWebSocket() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const wsService = useRef(getWebSocketService()).current;

  const {
    setConnectionStatus,
    addMessage,
    updateMessage,
    deleteMessage,
    setTyping,
  } = useChatStore();

  // Connect when token is available
  useEffect(() => {
    if (!accessToken) {
      wsService.disconnect();
      return;
    }

    // Connect with current token
    wsService.connect(accessToken);

    // Cleanup on unmount or token change
    return () => {
      wsService.disconnect();
    };
  }, [accessToken, wsService]);

  // Set up message handlers
  useEffect(() => {
    // Connection state handler
    const unsubConnection = wsService.onConnectionChange((state) => {
      const isConnected = state === ConnectionState.CONNECTED;
      const connectionInfo = wsService.getConnectionInfo();

      // Map WS states to simplified UI states
      let uiState: 'connected' | 'connecting' | 'disconnected' = 'disconnected';
      if (state === ConnectionState.CONNECTED) uiState = 'connected';
      else if (state === ConnectionState.CONNECTING || state === ConnectionState.RECONNECTING) uiState = 'connecting';

      setConnectionStatus(isConnected, connectionInfo?.clientId, uiState);

      console.debug(`[WebSocket] state → ${state}`, connectionInfo);
    });

    // Message handler
    const unsubMessage = wsService.on('message', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;

      if (!channelId) {
        console.error('Message missing channel_id:', msg);
        return;
      }

      // Add message to store
      addMessage(channelId, {
        id: data.id || crypto.randomUUID(),
        channel_id: channelId,
        user_id: data.user_id,
        username: data.username || 'Unknown',
        display_name: data.display_name || undefined,
        avatar_url: data.avatar_url || undefined,
        content: data.content,
        is_encrypted: data.is_encrypted || false,
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
      });
    });

    // Message update handler
    const unsubUpdate = wsService.on('message_update', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const messageId = data.id;

      if (!channelId || !messageId) {
        console.error('Message update missing channel_id or id:', msg);
        return;
      }

      updateMessage(channelId, messageId, {
        content: data.content,
        edited_at: data.edited_at,
        updated_at: data.updated_at || new Date().toISOString(),
      });
    });

    // Message delete handler
    const unsubDelete = wsService.on('message_delete', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const messageId = data.id;

      if (!channelId || !messageId) {
        console.error('Message delete missing channel_id or id:', msg);
        return;
      }

      deleteMessage(channelId, messageId);
    });

    // Typing indicator handler
    const unsubTyping = wsService.on('typing', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const userId = data.user_id;
      const isTyping = data.is_typing;
      const username = data.username;

      if (!channelId || !userId) {
        console.error('Typing indicator missing channel_id or user_id:', msg);
        return;
      }

      setTyping(channelId, userId, isTyping, username);
    });

    // Subscribed confirmation handler
    const unsubSubscribed = wsService.on('subscribed', (msg: WebSocketMessage) => {
      console.debug('[WebSocket] Subscribed to channel:', msg.data.channel_id);
    });

    // Error handler
    const unsubError = wsService.on('error', (msg: WebSocketMessage) => {
      console.error('WebSocket error:', msg.data);
    });

    // Cleanup handlers
    return () => {
      unsubConnection();
      unsubMessage();
      unsubUpdate();
      unsubDelete();
      unsubTyping();
      unsubSubscribed();
      unsubError();
    };
  }, [wsService, setConnectionStatus, addMessage, updateMessage, deleteMessage, setTyping]);

  // Subscribe to a channel
  const subscribe = useCallback(
    (channelId: string) => {
      wsService.subscribe(channelId);
    },
    [wsService]
  );

  // Unsubscribe from a channel
  const unsubscribe = useCallback(
    (channelId: string) => {
      wsService.unsubscribe(channelId);
    },
    [wsService]
  );

  // Send a message
  const sendMessage = useCallback(
    (channelId: string, content: string) => {
      wsService.sendMessage(channelId, content);
    },
    [wsService]
  );

  // Send typing indicator
  const sendTyping = useCallback(
    (channelId: string, isTyping: boolean) => {
      wsService.sendTypingIndicator(channelId, isTyping);
    },
    [wsService]
  );

  // Get connection state
  const getState = useCallback(() => {
    return wsService.getState();
  }, [wsService]);

  return {
    subscribe,
    unsubscribe,
    sendMessage,
    sendTyping,
    getState,
  };
}
