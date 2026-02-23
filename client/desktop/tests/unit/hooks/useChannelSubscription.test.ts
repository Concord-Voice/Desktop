import { renderHook } from '@testing-library/react';
import { useChannelSubscription } from '@/renderer/hooks/useChannelSubscription';
import { useChatStore } from '@/renderer/stores/chatStore';

// Mock websocketService
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();

vi.mock('@/renderer/services/websocketService', () => ({
  getWebSocketService: () => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
  }),
}));

describe('useChannelSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({ isConnected: true });
  });

  it('subscribes to channel when connected and channelId provided', () => {
    renderHook(() => useChannelSubscription('channel-1'));
    expect(mockSubscribe).toHaveBeenCalledWith('channel-1');
  });

  it('returns isSubscribed: true when connected and channelId provided', () => {
    const { result } = renderHook(() => useChannelSubscription('channel-1'));
    expect(result.current.isSubscribed).toBe(true);
  });

  it('does not subscribe when channelId is null', () => {
    renderHook(() => useChannelSubscription(null));
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('returns isSubscribed: false when channelId is null', () => {
    const { result } = renderHook(() => useChannelSubscription(null));
    expect(result.current.isSubscribed).toBe(false);
  });

  it('does not subscribe when disconnected', () => {
    useChatStore.setState({ isConnected: false });
    renderHook(() => useChannelSubscription('channel-1'));
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('returns isSubscribed: false when disconnected', () => {
    useChatStore.setState({ isConnected: false });
    const { result } = renderHook(() => useChannelSubscription('channel-1'));
    expect(result.current.isSubscribed).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useChannelSubscription('channel-1'));
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledWith('channel-1');
  });

  it('resubscribes when channelId changes', () => {
    const { rerender } = renderHook(
      ({ channelId }) => useChannelSubscription(channelId),
      { initialProps: { channelId: 'channel-1' as string | null } },
    );

    expect(mockSubscribe).toHaveBeenCalledWith('channel-1');

    rerender({ channelId: 'channel-2' });

    expect(mockUnsubscribe).toHaveBeenCalledWith('channel-1');
    expect(mockSubscribe).toHaveBeenCalledWith('channel-2');
  });
});
