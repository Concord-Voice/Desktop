/**
 * useChannelSubscription - React hook for automatic channel subscription management
 *
 * Automatically subscribes to a channel when the component mounts and the channel ID changes,
 * and unsubscribes when the component unmounts or channel changes.
 */

import { useEffect } from 'react';
import { useWebSocket } from './useWebSocket';
import { useChatStore } from '../stores/chatStore';

export function useChannelSubscription(channelId: string | null | undefined) {
  const { subscribe, unsubscribe } = useWebSocket();
  const { isConnected } = useChatStore();

  useEffect(() => {
    if (!channelId || !isConnected) {
      return;
    }

    // Subscribe to channel
    subscribe(channelId);

    // Unsubscribe on cleanup
    return () => {
      unsubscribe(channelId);
    };
  }, [channelId, isConnected, subscribe, unsubscribe]);

  return {
    isSubscribed: !!channelId && isConnected,
  };
}
