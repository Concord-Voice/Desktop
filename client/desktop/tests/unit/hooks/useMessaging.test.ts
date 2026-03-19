import { renderHook, act } from '@testing-library/react';
import { useMessaging } from '@/renderer/hooks/useMessaging';
import { useChatStore } from '@/renderer/stores/chatStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { mockUser, mockChannel, mockEncryptedChannel } from '../../mocks/fixtures';
import { ConnectionState } from '@/renderer/services/websocketService';

// Mock websocketService
const mockSendMessage = vi.fn();
const mockSendTypingIndicator = vi.fn();
const mockOnConnectionChange = vi.fn(() => vi.fn()); // returns unsubscribe
const mockGetState = vi.fn(() => ConnectionState.CONNECTED);
const mockIsSubscribed = vi.fn(() => true);

vi.mock('@/renderer/services/websocketService', () => ({
  getWebSocketService: () => ({
    sendMessage: mockSendMessage,
    sendTypingIndicator: mockSendTypingIndicator,
    onConnectionChange: mockOnConnectionChange,
    getState: mockGetState,
    isSubscribed: mockIsSubscribed,
  }),
  ConnectionState: {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
  },
}));

// Mock messageQueue
const mockEnqueue = vi.fn(() => 'client-msg-1');
const mockMarkAsSent = vi.fn();
const mockMarkAsDelivered = vi.fn();
const mockMarkAsFailed = vi.fn();
const mockRemove = vi.fn();
const mockStartProcessing = vi.fn();
const mockStopProcessing = vi.fn();
const mockSize = vi.fn(() => 0);
const mockGetMessagesForChannel = vi.fn(() => []);

vi.mock('@/renderer/services/messageQueue', () => ({
  getMessageQueue: () => ({
    enqueue: mockEnqueue,
    markAsSent: mockMarkAsSent,
    markAsDelivered: mockMarkAsDelivered,
    markAsFailed: mockMarkAsFailed,
    remove: mockRemove,
    startProcessing: mockStartProcessing,
    stopProcessing: mockStopProcessing,
    size: mockSize,
    getMessagesForChannel: mockGetMessagesForChannel,
  }),
}));

// Mock e2eeService
const mockEncryptForChannel = vi.fn();
const mockGetCurrentKeyVersion = vi.fn(() => undefined);

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    encryptForChannel: (...args: unknown[]) => mockEncryptForChannel(...args),
    getCurrentKeyVersion: (...args: unknown[]) => mockGetCurrentKeyVersion(...args),
    isInitialized: true,
  },
}));

describe('useMessaging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesByChannel: new Map(),
      isConnected: true,
    });
    useUserStore.setState({ user: mockUser });
    useChannelStore.setState({ channels: [mockChannel, mockEncryptedChannel] });
    mockGetState.mockReturnValue(ConnectionState.CONNECTED);
  });

  it('returns sendMessage, markDelivered, sendTyping, getPendingCount, getPendingMessagesForChannel', () => {
    const { result } = renderHook(() => useMessaging());
    expect(result.current.sendMessage).toBeInstanceOf(Function);
    expect(result.current.markDelivered).toBeInstanceOf(Function);
    expect(result.current.sendTyping).toBeInstanceOf(Function);
    expect(result.current.getPendingCount).toBeInstanceOf(Function);
    expect(result.current.getPendingMessagesForChannel).toBeInstanceOf(Function);
  });

  it('registers connection change handler on mount', () => {
    renderHook(() => useMessaging());
    expect(mockOnConnectionChange).toHaveBeenCalledWith(expect.any(Function));
  });

  it('unsubscribes and stops processing on unmount', () => {
    const unsubscribe = vi.fn();
    mockOnConnectionChange.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useMessaging());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
    expect(mockStopProcessing).toHaveBeenCalled();
  });

  it('sendMessage enqueues and adds optimistic message for unencrypted channel', () => {
    const { result } = renderHook(() => useMessaging());
    const addMessageSpy = vi.spyOn(useChatStore.getState(), 'addMessage');

    let clientId: string;
    act(() => {
      clientId = result.current.sendMessage('channel-1', 'Hello world', 'testuser');
    });

    expect(mockEnqueue).toHaveBeenCalledWith('channel-1', 'Hello world', 'message');
    expect(clientId!).toBe('client-msg-1');
  });

  it('sendMessage sends via websocket when connected', async () => {
    const { result } = renderHook(() => useMessaging());

    act(() => {
      result.current.sendMessage('channel-1', 'Hello world', 'testuser');
    });

    // Wait for async doSend
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith('channel-1', 'Hello world', 'client-msg-1', false, undefined, undefined);
    });
  });

  it('sendMessage encrypts for E2EE channels', async () => {
    mockEncryptForChannel.mockResolvedValue('encrypted-base64-content-that-is-long-enough-for-validation');
    mockGetCurrentKeyVersion.mockReturnValue(3);

    const { result } = renderHook(() => useMessaging());

    act(() => {
      result.current.sendMessage('channel-2', 'Secret message', 'testuser');
    });

    await vi.waitFor(() => {
      expect(mockEncryptForChannel).toHaveBeenCalledWith('channel-2', 'Secret message');
      expect(mockSendMessage).toHaveBeenCalledWith(
        'channel-2',
        'encrypted-base64-content-that-is-long-enough-for-validation',
        'client-msg-1',
        true,
        3,
        undefined,
      );
    });
  });

  it('sendMessage marks as failed when encryption fails', async () => {
    mockEncryptForChannel.mockRejectedValue(new Error('Key not available'));

    const { result } = renderHook(() => useMessaging());

    act(() => {
      result.current.sendMessage('channel-2', 'Secret message', 'testuser');
    });

    await vi.waitFor(() => {
      expect(mockMarkAsFailed).toHaveBeenCalledWith('client-msg-1', 'Encryption failed — message not sent');
    });
  });

  it('sendMessage does not send via websocket when disconnected', () => {
    mockGetState.mockReturnValue(ConnectionState.DISCONNECTED);

    const { result } = renderHook(() => useMessaging());

    act(() => {
      result.current.sendMessage('channel-1', 'Hello offline', 'testuser');
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
    // But should still enqueue
    expect(mockEnqueue).toHaveBeenCalled();
  });

  it('markDelivered updates queue and store', () => {
    const { result } = renderHook(() => useMessaging());

    act(() => {
      result.current.markDelivered('client-msg-1', 'server-msg-1', 'channel-1');
    });

    expect(mockMarkAsDelivered).toHaveBeenCalledWith('client-msg-1', 'server-msg-1');
  });

  it('sendTyping sends indicator when connected', () => {
    const { result } = renderHook(() => useMessaging());

    act(() => {
      result.current.sendTyping('channel-1', true);
    });

    expect(mockSendTypingIndicator).toHaveBeenCalledWith('channel-1', true);
  });

  it('sendTyping does nothing when disconnected', () => {
    mockGetState.mockReturnValue(ConnectionState.DISCONNECTED);

    const { result } = renderHook(() => useMessaging());

    act(() => {
      result.current.sendTyping('channel-1', true);
    });

    expect(mockSendTypingIndicator).not.toHaveBeenCalled();
  });

  it('getPendingCount returns queue size', () => {
    mockSize.mockReturnValue(3);
    const { result } = renderHook(() => useMessaging());
    expect(result.current.getPendingCount()).toBe(3);
  });

  it('getPendingMessagesForChannel delegates to queue', () => {
    const msgs = [{ id: '1', channelId: 'channel-1', content: 'test' }];
    mockGetMessagesForChannel.mockReturnValue(msgs);

    const { result } = renderHook(() => useMessaging());
    expect(result.current.getPendingMessagesForChannel('channel-1')).toEqual(msgs);
    expect(mockGetMessagesForChannel).toHaveBeenCalledWith('channel-1');
  });
});
