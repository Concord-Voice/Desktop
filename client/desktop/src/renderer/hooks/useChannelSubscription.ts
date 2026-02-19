/**
 * useChannelSubscription - React hook for automatic channel subscription management
 *
 * Automatically subscribes to a channel when the component mounts and the channel ID changes,
 * and unsubscribes when the component unmounts or channel changes.
 *
 * Uses getWebSocketService() directly (not useWebSocket()) to avoid registering
 * duplicate event handlers — App.tsx already calls useWebSocket() once for all handlers.
 */

import { useEffect } from 'react';
import { getWebSocketService } from '../services/websocketService';
import { useChatStore } from '../stores/chatStore';

export function useChannelSubscription(channelId: string | null | undefined) {
  const isConnected = useChatStore((s) => s.isConnected);

  useEffect(() => {
    if (!channelId || !isConnected) {
      return;
    }

    const wsService = getWebSocketService();

    // Subscribe to channel
    wsService.subscribe(channelId);

    // Unsubscribe on cleanup
    return () => {
      wsService.unsubscribe(channelId);
    };
  }, [channelId, isConnected]);

  return {
    isSubscribed: !!channelId && isConnected,
  };
}
