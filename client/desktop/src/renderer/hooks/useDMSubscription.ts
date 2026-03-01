/**
 * useDMSubscription - React hook for automatic DM conversation subscription management
 *
 * Mirrors useChannelSubscription but uses subscribeDM/unsubscribeDM for DM conversations.
 */

import { useEffect } from 'react';
import { getWebSocketService } from '../services/websocketService';
import { useChatStore } from '../stores/chatStore';

export function useDMSubscription(conversationId: string | null | undefined) {
  const isConnected = useChatStore((s) => s.isConnected);

  useEffect(() => {
    if (!conversationId || !isConnected) {
      return;
    }

    const wsService = getWebSocketService();

    // Subscribe to DM conversation
    wsService.subscribeDM(conversationId);

    // Unsubscribe on cleanup
    return () => {
      wsService.unsubscribeDM(conversationId);
    };
  }, [conversationId, isConnected]);

  return {
    isSubscribed: !!conversationId && isConnected,
  };
}
