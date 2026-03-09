import { render, screen } from '../../../test-utils';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { useChatStore } from '@/renderer/stores/chatStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { mockUser, mockChannel, mockMessage, mockMessage2 } from '../../../mocks/fixtures';

// Mock apiFetch to prevent hanging fetches
const mockApiFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ messages: [] }),
});
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  safeJson: async (res: { json: () => Promise<unknown> }) => res.json(),
  API_BASE: 'http://localhost:8080',
}));

// Mock heavy child components
vi.mock('@/renderer/components/Chat/MessageList', () => ({
  default: ({
    messages,
    channelName,
    isLoading,
  }: {
    messages: unknown[];
    channelName?: string;
    isLoading: boolean;
  }) => (
    <div data-testid="message-list" data-channel={channelName} data-loading={isLoading}>
      {(messages as Array<{ id: string; content: string }>).map((m) => (
        <div key={m.id} data-testid="message">
          {m.content}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/renderer/components/Chat/MessageInput', () => ({
  default: ({ channelName, disabled }: { channelName?: string; disabled: boolean }) => (
    <div data-testid="message-input" data-channel={channelName} data-disabled={disabled} />
  ),
}));

// Mock hooks
vi.mock('@/renderer/hooks/useChannelSubscription', () => ({
  useChannelSubscription: vi.fn(),
}));

vi.mock('@/renderer/hooks/useMessaging', () => ({
  useMessaging: () => ({
    sendMessage: vi.fn(),
    markDelivered: vi.fn(),
    sendTyping: vi.fn(),
    getPendingCount: vi.fn(() => 0),
    getPendingMessagesForChannel: vi.fn(() => []),
  }),
}));

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: false,
    decryptForChannel: vi.fn(),
    getChannelKey: vi.fn(),
    invalidateChannelKey: vi.fn(),
  },
}));

import ChatView from '@/renderer/components/Chat/ChatView';

describe('ChatView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUserStore.setState({ user: mockUser });
    useChannelStore.setState({ channels: [mockChannel], activeChannelId: null });
    useChatStore.setState({
      messagesByChannel: new Map(),
      isConnected: true,
    });
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
  });

  it('renders nothing when no active channel', () => {
    const { container } = render(<ChatView />);
    expect(container.querySelector('.chat-view')).not.toBeInTheDocument();
  });

  it('renders chat view when channel is active', () => {
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    const { container } = render(<ChatView />);
    expect(container.querySelector('.chat-view')).toBeInTheDocument();
  });

  it('shows channel name in header', () => {
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    render(<ChatView />);
    expect(screen.getByText('general')).toBeInTheDocument();
  });

  it('renders MessageList component', () => {
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    render(<ChatView />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('renders MessageInput component', () => {
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    render(<ChatView />);
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('passes messages from store to MessageList', async () => {
    const msgs = [mockMessage, mockMessage2];
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: msgs }),
    });
    useChatStore.setState({
      messagesByChannel: new Map([['channel-1', msgs]]),
    });
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    render(<ChatView />);
    const messageList = screen.getByTestId('message-list');
    expect(messageList).toBeInTheDocument();
  });

  it('fetches messages when channel changes', () => {
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    render(<ChatView />);
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/channels/channel-1/messages')
    );
  });

  it('shows error when fetch fails', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Failed to load messages' }),
    });
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    render(<ChatView />);
    expect(await screen.findByText('Failed to load messages')).toBeInTheDocument();
  });

  it('renders with encrypted channel', () => {
    useChannelStore.setState({
      channels: [{ ...mockChannel, is_encrypted: true }],
      activeChannelId: 'channel-1',
    });
    render(<ChatView />);
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('passes correct channel name to MessageList', () => {
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    render(<ChatView />);
    const messageList = screen.getByTestId('message-list');
    expect(messageList).toHaveAttribute('data-channel', 'general');
  });

  it('handles empty messages response', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    render(<ChatView />);
    await vi.waitFor(() => {
      const messageList = screen.getByTestId('message-list');
      const messages = messageList.querySelectorAll('[data-testid="message"]');
      expect(messages.length).toBe(0);
    });
  });

  it('changes view when channel switches', () => {
    useChannelStore.setState({ activeChannelId: 'channel-1' });
    const { rerender } = render(<ChatView />);
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('channel-1'));
    // Switch channel
    useChannelStore.setState({
      channels: [mockChannel, { ...mockChannel, id: 'channel-2', name: 'random' }],
      activeChannelId: 'channel-2',
    });
    rerender(<ChatView />);
    // Second channel should also fetch
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('channel-2'));
  });
});
