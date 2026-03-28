import { render, screen, waitFor } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useDMStore, type DMConversation } from '@/renderer/stores/dmStore';
import { useChatStore } from '@/renderer/stores/chatStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { usePrivacyStore } from '@/renderer/stores/privacyStore';
import { mockUser } from '../../../mocks/fixtures';
import { vi } from 'vitest';

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
  default: ({
    channelName,
    disabled,
    isChannelEncrypted,
  }: {
    channelName?: string;
    disabled: boolean;
    isChannelEncrypted: boolean;
  }) => (
    <div
      data-testid="message-input"
      data-channel={channelName}
      data-disabled={disabled}
      data-encrypted={isChannelEncrypted}
    />
  ),
}));

vi.mock('@/renderer/components/Chat/TypingIndicator', () => ({
  default: ({ channelId }: { channelId: string }) => (
    <div data-testid="typing-indicator" data-channel={channelId} />
  ),
}));

// Mock hooks
vi.mock('@/renderer/hooks/useDMSubscription', () => ({
  useDMSubscription: vi.fn(),
}));

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: false,
    decryptForChannel: vi.fn(),
    encryptForChannel: vi.fn(),
    getChannelKey: vi.fn(),
  },
}));

vi.mock('@/renderer/services/websocketService', () => ({
  getWebSocketService: vi.fn().mockReturnValue({
    getState: vi.fn().mockReturnValue(0),
    sendDMMessage: vi.fn(),
    sendDMTypingIndicator: vi.fn(),
  }),
  ConnectionState: { CONNECTED: 1, DISCONNECTED: 0 },
}));

vi.mock('@/renderer/services/messageQueue', () => ({
  getMessageQueue: vi.fn().mockReturnValue({
    enqueue: vi.fn().mockReturnValue('client-msg-1'),
    markAsSent: vi.fn(),
    remove: vi.fn(),
    markAsFailed: vi.fn(),
  }),
}));

import DMChatArea from '@/renderer/components/DirectMessages/DMChatArea';

// --- Test fixtures ---

const makeConversation = (overrides: Partial<DMConversation> = {}): DMConversation => ({
  id: 'conv-1',
  isGroup: false,
  isPersonal: false,
  name: null,
  isEncrypted: false,
  participants: [
    { userId: 'user-1', username: 'me', displayName: 'Me', status: 'online' },
    { userId: 'user-2', username: 'alice', displayName: 'Alice', status: 'online' },
  ],
  lastMessage: null,
  unreadCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('DMChatArea', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useUserStore.setState({ user: mockUser });
    useDMStore.setState({
      conversations: [],
      clearUnread: vi.fn(),
    });
    useChatStore.setState({
      messagesByChannel: new Map(),
      isConnected: true,
    });
    usePrivacyStore.setState({
      settings: {
        dmPrivacyLevel: 2,
        messagesFriendsOnly: true,
        messagesServerMembers: true,
        dmFriendsOfFriends: false,
        autoAcceptFriendCodes: false,
        searchableByUsername: false,
        searchableByEmail: false,
        searchableByPhone: false,
        allowEmbeddedContent: false,
      },
    });
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
  });

  // --- Empty State (no thread selected) ---

  it('shows empty state when no thread is selected', () => {
    render(<DMChatArea selectedThreadId={null} />);
    expect(screen.getByText('Welcome to Concord Voice')).toBeInTheDocument();
    expect(
      screen.getByText('Select a message thread or server to get started')
    ).toBeInTheDocument();
  });

  it('does not render MessageList when no thread is selected', () => {
    render(<DMChatArea selectedThreadId={null} />);
    expect(screen.queryByTestId('message-list')).not.toBeInTheDocument();
  });

  it('does not render MessageInput when no thread is selected', () => {
    render(<DMChatArea selectedThreadId={null} />);
    expect(screen.queryByTestId('message-input')).not.toBeInTheDocument();
  });

  // --- Active Conversation ---

  it('renders chat header with participant name for 1:1 conversation', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('renders "Conversation" when conversation is not found in store', () => {
    useDMStore.setState({ conversations: [] });
    render(<DMChatArea selectedThreadId="non-existent" />);
    // The header initial and name
    const headerName = document.querySelector('.dm-chat-header-name');
    expect(headerName?.textContent).toBe('Conversation');
  });

  it('renders MessageList when thread is selected', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('renders MessageInput when thread is selected', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('renders TypingIndicator for active thread', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const typingIndicator = screen.getByTestId('typing-indicator');
    expect(typingIndicator).toBeInTheDocument();
    expect(typingIndicator).toHaveAttribute('data-channel', 'conv-1');
  });

  it('passes correct channel name to MessageList for 1:1 conversation', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const messageList = screen.getByTestId('message-list');
    expect(messageList).toHaveAttribute('data-channel', 'Alice');
  });

  // --- Group Conversation ---

  it('shows group name in header for group conversation', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          isGroup: true,
          name: 'Study Group',
          participants: [
            { userId: 'user-1', username: 'me', displayName: 'Me' },
            { userId: 'user-2', username: 'alice', displayName: 'Alice' },
            { userId: 'user-3', username: 'bob', displayName: 'Bob' },
          ],
        }),
      ],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(screen.getByText('Study Group')).toBeInTheDocument();
  });

  it('shows participant names for unnamed group', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          isGroup: true,
          name: null,
          participants: [
            { userId: 'user-1', username: 'me', displayName: 'Me' },
            { userId: 'user-2', username: 'alice', displayName: 'Alice' },
            { userId: 'user-3', username: 'bob', displayName: 'Bob' },
          ],
        }),
      ],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(screen.getByText('Me, Alice, Bob')).toBeInTheDocument();
  });

  it('shows member count for group conversations', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          isGroup: true,
          name: 'Team',
          participants: [
            { userId: 'user-1', username: 'me' },
            { userId: 'user-2', username: 'alice' },
            { userId: 'user-3', username: 'bob' },
          ],
        }),
      ],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const statusDiv = document.querySelector('.dm-chat-header-status');
    expect(statusDiv?.textContent).toBe('3 members');
  });

  // --- Personal Thread ---

  it('shows "Personal Thread" for personal conversation', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          isPersonal: true,
          participants: [{ userId: 'user-1', username: 'me', displayName: 'Me' }],
        }),
      ],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(screen.getByText('Personal Thread')).toBeInTheDocument();
  });

  it('shows "Your personal notes" status for personal thread', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          isPersonal: true,
          participants: [{ userId: 'user-1', username: 'me' }],
        }),
      ],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const statusDiv = document.querySelector('.dm-chat-header-status');
    expect(statusDiv?.textContent).toBe('Your personal notes');
  });

  // --- Status Display ---

  it('shows participant status for 1:1 conversation', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          participants: [
            { userId: 'user-1', username: 'me', displayName: 'Me', status: 'online' },
            { userId: 'user-2', username: 'alice', displayName: 'Alice', status: 'idle' },
          ],
        }),
      ],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const statusDiv = document.querySelector('.dm-chat-header-status');
    expect(statusDiv?.textContent).toBe('idle');
  });

  // --- Header Avatar ---

  it('renders avatar initial in header', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    const { container } = render(<DMChatArea selectedThreadId="conv-1" />);
    const avatarInitial = container.querySelector('.conversation-avatar-initial');
    expect(avatarInitial).toBeInTheDocument();
    expect(avatarInitial?.textContent).toBe('A');
  });

  // --- Error State ---

  it('shows error banner when fetch fails', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Failed to load messages' }),
    });
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(await screen.findByText('Failed to load messages')).toBeInTheDocument();
  });

  // --- DM Privacy Level ---

  it('shows disabled notice when dmPrivacyLevel is 0', () => {
    usePrivacyStore.setState({
      settings: {
        dmPrivacyLevel: 0,
        messagesFriendsOnly: true,
        messagesServerMembers: true,
        dmFriendsOfFriends: false,
        autoAcceptFriendCodes: false,
        searchableByUsername: false,
        searchableByEmail: false,
        searchableByPhone: false,
        allowEmbeddedContent: false,
      },
    });
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(
      screen.getByText('All DMs have been disabled. Change your privacy settings to restore DMs.')
    ).toBeInTheDocument();
    // Should NOT show MessageInput
    expect(screen.queryByTestId('message-input')).not.toBeInTheDocument();
  });

  it('shows MessageInput when dmPrivacyLevel is not 0', () => {
    usePrivacyStore.setState({
      settings: {
        dmPrivacyLevel: 2,
        messagesFriendsOnly: true,
        messagesServerMembers: true,
        dmFriendsOfFriends: false,
        autoAcceptFriendCodes: false,
        searchableByUsername: false,
        searchableByEmail: false,
        searchableByPhone: false,
        allowEmbeddedContent: false,
      },
    });
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
    expect(screen.queryByText(/All DMs have been disabled/)).not.toBeInTheDocument();
  });

  // --- Encrypted Conversation ---

  it('passes isChannelEncrypted=true for encrypted conversations', () => {
    useDMStore.setState({
      conversations: [makeConversation({ isEncrypted: true })],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const messageInput = screen.getByTestId('message-input');
    expect(messageInput).toHaveAttribute('data-encrypted', 'true');
  });

  it('passes isChannelEncrypted=false for unencrypted conversations', () => {
    useDMStore.setState({
      conversations: [makeConversation({ isEncrypted: false })],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const messageInput = screen.getByTestId('message-input');
    expect(messageInput).toHaveAttribute('data-encrypted', 'false');
  });

  // --- Message Fetch ---

  it('fetches messages for the selected thread', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/dm/conversations/conv-1/messages')
    );
  });

  it('marks conversation as read after fetch completes', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
    const mockClearUnread = vi.fn();
    useDMStore.setState({
      conversations: [makeConversation()],
      clearUnread: mockClearUnread,
    });
    render(<DMChatArea selectedThreadId="conv-1" />);

    await waitFor(() => {
      // Should call the read endpoint
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/dm/conversations/conv-1/read'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // --- Username fallback in header ---

  it('falls back to username when participant has no display name', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          participants: [
            { userId: 'user-1', username: 'me' },
            { userId: 'user-2', username: 'raw_username' },
          ],
        }),
      ],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const headerName = document.querySelector('.dm-chat-header-name');
    expect(headerName?.textContent).toBe('raw_username');
  });

  // --- MessageInput disabled state ---

  it('disables MessageInput when no current user', () => {
    useUserStore.setState({ user: null });
    useDMStore.setState({
      conversations: [makeConversation()],
    });
    render(<DMChatArea selectedThreadId="conv-1" />);
    const messageInput = screen.getByTestId('message-input');
    expect(messageInput).toHaveAttribute('data-disabled', 'true');
  });
});
