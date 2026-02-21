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
import { useChannelStore } from '../stores/channelStore';
import { useServerStore } from '../stores/serverStore';
import { useMemberStore, PresenceStatus } from '../stores/memberStore';
import { useUserStore } from '../stores/userStore';
import { useUnreadStore } from '../stores/unreadStore';
import {
  getWebSocketService,
  ConnectionState,
  type WebSocketMessage,
} from '../services/websocketService';
import { e2eeService } from '../services/e2eeService';

export function useWebSocket() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const wsService = useRef(getWebSocketService()).current;

  const {
    setConnectionStatus,
    addMessage,
    updateMessage,
    updateMessageStatus,
    updateUserInMessages,
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
      else if (state === ConnectionState.CONNECTING || state === ConnectionState.RECONNECTING)
        uiState = 'connecting';

      setConnectionStatus(isConnected, connectionInfo?.clientId, uiState);

      console.debug(`[WebSocket] state → ${state}`, connectionInfo);

      // Process any pending key requests on connect/reconnect
      if (state === ConnectionState.CONNECTED && e2eeService.isInitialized) {
        e2eeService.processPendingKeyRequests().catch(() => {
          // Non-critical — will retry on next key_needed event
        });
      }
    });

    // Message handler
    const unsubMessage = wsService.on('message', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;

      if (!channelId) {
        console.error('Message missing channel_id:', msg);
        return;
      }

      const isEncrypted = data.is_encrypted || false;
      const baseMessage = {
        id: data.id || crypto.randomUUID(),
        channel_id: channelId,
        user_id: data.user_id,
        username: data.username || 'Unknown',
        display_name: data.display_name || undefined,
        avatar_url: data.avatar_url || undefined,
        is_encrypted: isEncrypted,
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
      };

      if (isEncrypted && e2eeService.isInitialized) {
        // Decrypt asynchronously, then add to store
        e2eeService
          .decryptForChannel(channelId, data.content)
          .then((plaintext) => {
            addMessage(channelId, { ...baseMessage, content: plaintext });
          })
          .catch((err) => {
            const isPending = err instanceof Error && err.message === 'PENDING_KEY';
            addMessage(channelId, {
              ...baseMessage,
              content: '',
              decryptFailed: !isPending,
              pendingKeys: isPending,
            });
          });
      } else if (isEncrypted) {
        // E2EE service not initialized — can't decrypt
        addMessage(channelId, { ...baseMessage, content: '', decryptFailed: true });
      } else {
        addMessage(channelId, { ...baseMessage, content: data.content });
      }

      // NOTE: Unread tracking is handled exclusively by the 'unread_notify' handler
      // (server-level subscription). The 'message' event only arrives for the active
      // channel the user is subscribed to, so no unread increment is needed here.
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

    // Message acknowledgment handler — maps temp client IDs to server UUIDs
    const unsubAck = wsService.on('message_ack', (msg: WebSocketMessage) => {
      const { data } = msg;
      const nonce = data.nonce;
      const serverId = data.id;
      const channelId = data.channel_id;

      if (nonce && serverId && channelId) {
        updateMessageStatus(channelId, nonce, 'delivered', serverId);
      }
    });

    // Member joined handler — updates member list in real time
    const unsubMemberJoined = wsService.on('member_joined', (msg: WebSocketMessage) => {
      const { data } = msg;
      const activeServerId = useServerStore.getState().activeServerId;

      // Only update if the event is for the currently viewed server
      if (data.server_id && data.server_id === activeServerId) {
        useMemberStore.getState().addMember({
          user_id: data.user_id,
          username: data.username || 'Unknown',
          display_name: data.display_name || undefined,
          avatar_url: data.avatar_url || undefined,
          role: data.role || 'member',
          joined_at: new Date().toISOString(),
        });
      }
    });

    // Profile updated handler — updates messages and member list
    const unsubProfileUpdated = wsService.on('profile_updated', (msg: WebSocketMessage) => {
      const { data } = msg;
      const userId = data.user_id;

      if (!userId) return;

      // Update all messages from this user across all channels
      updateUserInMessages(userId, {
        username: data.username,
        display_name: data.display_name,
        avatar_url: data.avatar_url,
      });

      // Update member list if applicable
      useMemberStore.getState().updateMemberProfile(userId, {
        username: data.username,
        display_name: data.display_name || undefined,
        avatar_url: data.avatar_url || undefined,
      });
    });

    // Server updated handler — updates server list for all members
    const unsubServerUpdated = wsService.on('server_updated', (msg: WebSocketMessage) => {
      const { data } = msg;
      const serverId = data.server_id;
      if (!serverId) return;

      useServerStore.getState().updateServer(serverId, {
        name: data.name,
        icon_url: data.icon_url ?? null,
      });
    });

    // Channel updated handler — updates channel list for all server members
    const unsubChannelUpdated = wsService.on('channel_updated', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      if (!channelId) return;

      useChannelStore.getState().updateChannel(channelId, {
        name: data.name,
        type: data.type,
        emoji: data.emoji ?? null,
      });
    });

    // Channel deleted handler — removes channel and cascades cleanup
    const unsubChannelDeleted = wsService.on('channel_deleted', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      if (!channelId) return;

      useChannelStore.getState().removeChannel(channelId);
    });

    // Server deleted handler — removes server and cascades cleanup
    const unsubServerDeleted = wsService.on('server_deleted', (msg: WebSocketMessage) => {
      const { data } = msg;
      const serverId = data.server_id;
      if (!serverId) return;

      useServerStore.getState().removeServer(serverId);
    });

    // Member removed handler — handles both kicks and self-leave
    const unsubMemberRemoved = wsService.on('member_removed', (msg: WebSocketMessage) => {
      const { data } = msg;
      const serverId = data.server_id;
      const removedUserId = data.user_id;
      if (!serverId || !removedUserId) return;

      const selfId = useUserStore.getState().user?.id;
      if (removedUserId === selfId) {
        // Current user was removed/left — purge server data entirely
        useServerStore.getState().removeServer(serverId);
      } else {
        // Another member was removed — update the member list
        const activeServerId = useServerStore.getState().activeServerId;
        if (serverId === activeServerId) {
          useMemberStore.getState().removeMember(removedUserId);
        }
      }
    });

    // Lightweight unread notification handler — from server subscription
    const unsubUnreadNotify = wsService.on('unread_notify', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const serverId = data.server_id;
      const activeServerId = useServerStore.getState().activeServerId;

      if (serverId && serverId !== activeServerId) {
        // Non-active server: just mark the server icon as having unreads
        useUnreadStore.getState().markServerUnread(serverId);
      } else if (channelId) {
        // Active server: increment per-channel unread count
        const activeChannelId = useChannelStore.getState().activeChannelId;
        if (channelId !== activeChannelId) {
          useUnreadStore.getState().incrementUnread(channelId);
          // Also mark the server so the dot persists if the user switches away.
          // The dot won't show while this server is active (ServerList filters it).
          if (serverId) {
            useUnreadStore.getState().markServerUnread(serverId);
          }
        }
      }
    });

    // Key needed handler — auto-process pending key requests for new members
    const unsubKeyNeeded = wsService.on('key_needed', (msg: WebSocketMessage) => {
      console.debug('[WebSocket] key_needed event received:', msg.data);
      if (e2eeService.isInitialized) {
        e2eeService.processPendingKeyRequests().catch((err) => {
          console.debug('[WebSocket] processPendingKeyRequests failed:', err);
        });
      } else {
        console.debug('[WebSocket] key_needed ignored — E2EE not initialized');
      }
    });

    // Key delivered handler — a channel key was distributed to the current user
    const unsubKeyDelivered = wsService.on('key_delivered', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const targetUserId = data.user_id;
      if (!channelId) return;

      // Only act if this key delivery is for the current user
      const selfId = useUserStore.getState().user?.id;
      if (targetUserId !== selfId) return;

      // Invalidate the cached key so it gets re-fetched
      e2eeService.invalidateChannelKey(channelId);

      // Dispatch event so ChatView can re-fetch and decrypt messages
      window.dispatchEvent(new CustomEvent('e2ee-key-delivered', { detail: { channelId } }));
    });

    // Presence snapshot handler — received on connection with all online users and their statuses
    const unsubPresenceSnapshot = wsService.on('presence_snapshot', (msg: WebSocketMessage) => {
      // Enhanced format: array of { user_id, status } objects
      if (msg.data.users && Array.isArray(msg.data.users)) {
        useMemberStore
          .getState()
          .setPresenceSnapshot(msg.data.users as Array<{ user_id: string; status: string }>);
      } else if (msg.data.online_user_ids) {
        // Backward compatibility: simple list of online user IDs
        const userIds = msg.data.online_user_ids as string[];
        useMemberStore.getState().setOnlineUsers(userIds);
      }
    });

    // Presence change handler — individual status updates (online/offline/dnd/invisible)
    const unsubPresence = wsService.on('presence', (msg: WebSocketMessage) => {
      const userId = msg.data.user_id as string;
      const status = msg.data.status as PresenceStatus;
      const timestamp = msg.data.timestamp as number | undefined;
      if (!userId) return;

      // Skip overriding self user's status from broadcast — selfStatus is the local source of truth.
      // The server broadcasts "offline" for invisible users, so trusting the broadcast
      // would incorrectly show the self user as offline when they chose invisible.
      const selfId = useUserStore.getState().user?.id;
      if (userId === selfId) return;

      useMemberStore.getState().setUserStatus(userId, status);

      if (status === 'offline' && timestamp) {
        useMemberStore.getState().setUserLastSeen(userId, timestamp);
      }
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
      unsubAck();
      unsubMemberJoined();
      unsubProfileUpdated();
      unsubServerUpdated();
      unsubChannelUpdated();
      unsubChannelDeleted();
      unsubServerDeleted();
      unsubMemberRemoved();
      unsubUnreadNotify();
      unsubKeyNeeded();
      unsubKeyDelivered();
      unsubPresenceSnapshot();
      unsubPresence();
      unsubSubscribed();
      unsubError();
    };
  }, [
    wsService,
    setConnectionStatus,
    addMessage,
    updateMessage,
    updateMessageStatus,
    updateUserInMessages,
    deleteMessage,
    setTyping,
  ]);

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
