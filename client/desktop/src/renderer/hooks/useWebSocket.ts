/**
 * useWebSocket - React hook for WebSocket connection management
 *
 * Provides:
 * - Connection state and control
 * - Message sending
 * - Channel subscriptions
 * - Typing indicators
 * - Integration with chat store
 *
 * Orchestrates useConnectionRecovery (phased reconnection) and
 * useWebSocketMessages (all event handler subscriptions).
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useChannelStore } from '../stores/channelStore';
import { getWebSocketService, ConnectionState } from '../services/websocketService';
import { e2eeService } from '../services/e2eeService';
import { apiFetch, safeJson } from '../services/apiClient';
import { useConnectionRecovery } from './useConnectionRecovery';
import { useWebSocketMessages } from './useWebSocketMessages';

export function useWebSocket() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const wsService = useRef(getWebSocketService()).current;

  const { setConnectionStatus } = useChatStore();

  /**
   * Validate key epochs on reconnect — pull-based catch-up for missed key_revocation events.
   * Sends current cached epochs to the server and processes any revocations.
   */
  const validateEpochsOnReconnect = useCallback(async () => {
    // Build epochs map from cached channel keys
    const epochs: Record<string, number> = {};
    // Only validate channels we're subscribed to (active channels)
    const channels = useChannelStore.getState().channels.filter((c) => c.is_encrypted);
    for (const ch of channels) {
      const version = e2eeService.getCurrentKeyVersion(ch.id);
      if (version > 0) {
        epochs[ch.id] = version;
      }
    }

    if (Object.keys(epochs).length === 0) return;

    const res = await apiFetch('/api/v1/e2ee/validate-epochs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epochs }),
    });

    if (!res.ok) return;
    const data = await safeJson<{
      revocations?: Array<{
        channel_id: string;
        revoked_epoch: number;
        successor_epoch: number;
        reason?: string;
      }>;
    }>(res);
    const revocations = data.revocations || [];

    for (const rev of revocations) {
      console.debug(
        '[WebSocket] Stale epoch detected:',
        rev.channel_id,
        'revoked:',
        rev.revoked_epoch,
        '→',
        rev.successor_epoch
      );
      e2eeService.invalidateChannelKey(rev.channel_id);

      // Trigger rotation coordinator
      globalThis.dispatchEvent(
        new CustomEvent('e2ee-key-rotation', {
          detail: {
            channelId: rev.channel_id,
            newEpoch: rev.successor_epoch,
            reason: rev.reason,
          },
        })
      );
    }
  }, []);

  // Track rotation timeouts so they can be cleared on unmount
  const rotationTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Rotation coordinator — listens for key rotation events and distributes new keys
  useEffect(() => {
    const timers = rotationTimers.current;
    const handleKeyRotation = (event: Event) => {
      const { channelId, newEpoch } = (event as CustomEvent).detail;
      if (!channelId || !newEpoch || !e2eeService.isInitialized) return;

      // Jitter: 0-2s random delay to avoid N clients racing simultaneously
      const jitterMs = Math.random() * 2000;
      const timerId = setTimeout(async () => {
        timers.delete(timerId);
        try {
          // Check if another client already rotated to this epoch
          const checkRes = await apiFetch(`/api/v1/e2ee/keys/${channelId}`);
          if (checkRes.ok) {
            const checkData = await safeJson<{ key?: { key_version: number } }>(checkRes);
            if (checkData.key && checkData.key.key_version >= newEpoch) {
              console.debug('[E2EE] Key rotation already done for', channelId, 'epoch', newEpoch);
              // Invalidate local cache so we pick up the new key
              e2eeService.invalidateChannelKey(channelId);
              return;
            }
          }

          // Fetch remaining server members and their public keys
          const channel = useChannelStore.getState().channels.find((c) => c.id === channelId);
          if (!channel) return;

          const membersRes = await apiFetch(`/api/v1/servers/${channel.server_id}/members`);
          if (!membersRes.ok) return;
          const membersData = await safeJson<{ members?: Array<{ user_id: string }> }>(membersRes);
          const members = membersData.members || [];

          // Fetch public keys for all members
          const memberPublicKeys = new Map<string, string>();
          for (const member of members) {
            try {
              const pkRes = await apiFetch(`/api/v1/users/${member.user_id}/public-key`);
              if (pkRes.ok) {
                const pkData = await safeJson<{ public_key?: string }>(pkRes);
                if (pkData.public_key) {
                  memberPublicKeys.set(member.user_id, pkData.public_key);
                }
              }
            } catch {
              // Skip members whose keys we can't fetch
            }
          }

          if (memberPublicKeys.size === 0) return;

          // Rotate: generate new key, wrap for all members, distribute
          await e2eeService.rotateChannelKey(channelId, newEpoch, memberPublicKeys);
          console.debug('[E2EE] Key rotation completed for', channelId, 'epoch', newEpoch);
        } catch (err) {
          // Non-fatal: another client may handle the rotation (first-response-wins)
          console.debug('[E2EE] Key rotation failed (another client may handle it):', err);
        }
      }, jitterMs);
      timers.add(timerId);
    };

    globalThis.addEventListener('e2ee-key-rotation', handleKeyRotation);
    return () => {
      globalThis.removeEventListener('e2ee-key-rotation', handleKeyRotation);
      // Clear any pending rotation timers on unmount
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

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

  // Connection recovery handler
  const handleRecovery = useConnectionRecovery(wsService, validateEpochsOnReconnect);

  // Connection state listener
  useEffect(() => {
    const unsub = wsService.onConnectionChange((state) => {
      const isConnected = state === ConnectionState.CONNECTED;
      const connectionInfo = wsService.getConnectionInfo();

      // Map WS states to simplified UI states
      let uiState: 'connected' | 'connecting' | 'disconnected' = 'disconnected';
      if (state === ConnectionState.CONNECTED) uiState = 'connected';
      else if (state === ConnectionState.CONNECTING || state === ConnectionState.RECONNECTING)
        uiState = 'connecting';

      setConnectionStatus(isConnected, connectionInfo?.clientId, uiState);

      console.debug(`[WebSocket] state → ${state}`, connectionInfo);

      handleRecovery(state);
    });
    return unsub;
  }, [wsService, setConnectionStatus, handleRecovery]);

  // Message handlers (self-contained hook)
  useWebSocketMessages(wsService);

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
