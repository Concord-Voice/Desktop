import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStore } from '@/renderer/stores/chatStore';

const mockSubscribeDM = vi.fn();
const mockUnsubscribeDM = vi.fn();

vi.mock('@/renderer/services/websocketService', () => ({
  getWebSocketService: () => ({
    subscribeDM: mockSubscribeDM,
    unsubscribeDM: mockUnsubscribeDM,
  }),
}));

import { useDMSubscription } from '@/renderer/hooks/useDMSubscription';

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ isConnected: true });
});

describe('useDMSubscription', () => {
  it('subscribes to DM conversation on mount when connected', () => {
    renderHook(() => useDMSubscription('conv-1'));
    expect(mockSubscribeDM).toHaveBeenCalledWith('conv-1');
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useDMSubscription('conv-1'));
    unmount();
    expect(mockUnsubscribeDM).toHaveBeenCalledWith('conv-1');
  });

  it('does not subscribe when disconnected', () => {
    useChatStore.setState({ isConnected: false });
    renderHook(() => useDMSubscription('conv-1'));
    expect(mockSubscribeDM).not.toHaveBeenCalled();
  });

  it('does not subscribe when conversationId is null', () => {
    renderHook(() => useDMSubscription(null));
    expect(mockSubscribeDM).not.toHaveBeenCalled();
  });

  it('returns isSubscribed=true when active', () => {
    const { result } = renderHook(() => useDMSubscription('conv-1'));
    expect(result.current.isSubscribed).toBe(true);
  });

  it('returns isSubscribed=false when disconnected', () => {
    useChatStore.setState({ isConnected: false });
    const { result } = renderHook(() => useDMSubscription('conv-1'));
    expect(result.current.isSubscribed).toBe(false);
  });

  it('re-subscribes when conversationId changes', () => {
    const { rerender } = renderHook(({ convId }) => useDMSubscription(convId), {
      initialProps: { convId: 'conv-1' as string | null },
    });

    expect(mockSubscribeDM).toHaveBeenCalledWith('conv-1');

    rerender({ convId: 'conv-2' });

    // Should have unsubscribed from old and subscribed to new
    expect(mockUnsubscribeDM).toHaveBeenCalledWith('conv-1');
    expect(mockSubscribeDM).toHaveBeenCalledWith('conv-2');
  });
});
