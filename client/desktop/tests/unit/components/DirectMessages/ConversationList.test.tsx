import { render, screen, fireEvent } from '../../../test-utils';
import { useDMStore, type DMConversation } from '@/renderer/stores/dmStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { vi } from 'vitest';

// Mock e2eeService
vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: false,
    decryptForChannel: vi.fn().mockResolvedValue(null),
  },
}));

import ConversationList from '@/renderer/components/DirectMessages/ConversationList';

const makeConversation = (overrides: Partial<DMConversation> = {}): DMConversation => ({
  id: 'conv-1',
  isGroup: false,
  isPersonal: false,
  name: null,
  isEncrypted: false,
  participants: [
    { userId: 'user-1', username: 'me', displayName: 'Me' },
    { userId: 'user-2', username: 'alice', displayName: 'Alice' },
  ],
  lastMessage: null,
  unreadCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

const personalThread: DMConversation = {
  id: 'personal-1',
  isGroup: false,
  isPersonal: true,
  name: 'Personal',
  isEncrypted: false,
  participants: [{ userId: 'user-1', username: 'me', displayName: 'Me' }],
  lastMessage: null,
  unreadCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
};

describe('ConversationList', () => {
  const mockOnSelectThread = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useUserStore.setState({
      user: {
        id: 'user-1',
        username: 'me',
        display_name: 'Me',
        email: 'me@test.com',
        email_verified: true,
        age_verified: true,
        e2ee_preference: false,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    });
    useDMStore.setState({
      conversations: [],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
      openPersonalThread: vi.fn().mockResolvedValue(personalThread),
    });
  });

  it('renders conversation list container', () => {
    const { container } = render(
      <ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />
    );
    expect(container.querySelector('.conversation-list')).toBeInTheDocument();
  });

  it('renders search input', () => {
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByPlaceholderText('Search conversations...')).toBeInTheDocument();
  });

  it('renders Personal Thread button', () => {
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('Personal Thread')).toBeInTheDocument();
  });

  it('fetches conversations on mount', () => {
    const mockFetch = vi.fn().mockResolvedValue(undefined);
    useDMStore.setState({ fetchConversations: mockFetch });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('shows empty state when no conversations exist', () => {
    useDMStore.setState({ conversations: [] });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
  });

  it('renders 1:1 conversation with other users name', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('renders group conversation with group name', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          id: 'group-1',
          isGroup: true,
          name: 'Study Group',
          participants: [
            { userId: 'user-1', username: 'me', displayName: 'Me' },
            { userId: 'user-2', username: 'alice', displayName: 'Alice' },
          ],
        }),
      ],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('Study Group')).toBeInTheDocument();
  });

  it('renders group with participant names when no group name', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          id: 'group-1',
          isGroup: true,
          name: null,
          participants: [
            { userId: 'user-1', username: 'me', displayName: 'Me' },
            { userId: 'user-2', username: 'alice', displayName: 'Alice' },
            { userId: 'user-3', username: 'bob', displayName: 'Bob' },
          ],
        }),
      ],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('Me, Alice, Bob')).toBeInTheDocument();
  });

  it('renders conversation with username when no display name', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          participants: [
            { userId: 'user-1', username: 'me' },
            { userId: 'user-2', username: 'charlie' },
          ],
        }),
      ],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('charlie')).toBeInTheDocument();
  });

  it('shows last message preview', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          lastMessage: {
            content: 'Hey there!',
            userId: 'user-2',
            username: 'alice',
            createdAt: '2025-01-01T12:00:00Z',
            isEncrypted: false,
          },
        }),
      ],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('Hey there!')).toBeInTheDocument();
  });

  it('shows "Encrypted message" for encrypted last message', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          lastMessage: {
            content: 'encrypted-ciphertext',
            userId: 'user-2',
            username: 'alice',
            createdAt: '2025-01-01T12:00:00Z',
            isEncrypted: true,
          },
        }),
      ],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('Encrypted message')).toBeInTheDocument();
  });

  it('calls onSelectThread on conversation click', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    fireEvent.click(screen.getByText('Alice'));
    expect(mockOnSelectThread).toHaveBeenCalledWith('conv-1');
  });

  it('applies active class to selected conversation', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(
      <ConversationList selectedThreadId="conv-1" onSelectThread={mockOnSelectThread} />
    );
    const activeItem = container.querySelector('.conversation-item.active');
    expect(activeItem).toBeInTheDocument();
  });

  it('highlights personal thread when selected', () => {
    useDMStore.setState({
      conversations: [personalThread],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(
      <ConversationList selectedThreadId="personal-1" onSelectThread={mockOnSelectThread} />
    );
    const activePersonal = container.querySelector('.personal-thread.active');
    expect(activePersonal).toBeInTheDocument();
  });

  it('shows unread badge on conversation with unreads', () => {
    useDMStore.setState({
      conversations: [makeConversation({ unreadCount: 5 })],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows 99+ for large unread counts', () => {
    useDMStore.setState({
      conversations: [makeConversation({ unreadCount: 200 })],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('does not show unread badge when count is 0', () => {
    useDMStore.setState({
      conversations: [makeConversation({ unreadCount: 0 })],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(
      <ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />
    );
    expect(container.querySelector('.conversation-unread-badge')).not.toBeInTheDocument();
  });

  it('applies unread class to conversation with unreads', () => {
    useDMStore.setState({
      conversations: [makeConversation({ unreadCount: 3 })],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(
      <ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />
    );
    const unreadItem = container.querySelector('.conversation-item.unread');
    expect(unreadItem).toBeInTheDocument();
  });

  it('filters conversations by search query', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({ id: 'conv-1' }),
        makeConversation({
          id: 'conv-2',
          participants: [
            { userId: 'user-1', username: 'me', displayName: 'Me' },
            { userId: 'user-3', username: 'bob', displayName: 'Bob' },
          ],
        }),
      ],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    const searchInput = screen.getByPlaceholderText('Search conversations...');
    fireEvent.change(searchInput, { target: { value: 'alice' } });
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('search is case insensitive', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    const searchInput = screen.getByPlaceholderText('Search conversations...');
    fireEvent.change(searchInput, { target: { value: 'ALICE' } });
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('opens personal thread on click', async () => {
    const mockOpen = vi.fn().mockResolvedValue(personalThread);
    useDMStore.setState({ openPersonalThread: mockOpen });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    fireEvent.click(screen.getByText('Personal Thread'));
    await vi.waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
      expect(mockOnSelectThread).toHaveBeenCalledWith('personal-1');
    });
  });

  it('does not show personal thread in filtered conversation list', () => {
    useDMStore.setState({
      conversations: [personalThread, makeConversation()],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    const personalButtons = screen.getAllByText('Personal Thread');
    expect(personalButtons.length).toBe(1);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows avatar initial for 1:1 conversations', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(
      <ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />
    );
    const initial = container.querySelector('.conversation-avatar-initial');
    expect(initial).toBeInTheDocument();
    expect(initial?.textContent).toBe('A');
  });

  it('shows group avatar icon for group conversations', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({
          id: 'group-1',
          isGroup: true,
          name: 'Team',
          participants: [
            { userId: 'user-1', username: 'me' },
            { userId: 'user-2', username: 'alice' },
          ],
        }),
      ],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(
      <ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />
    );
    const groupAvatar = container.querySelector('.conversation-avatar.group');
    expect(groupAvatar).toBeInTheDocument();
  });

  it('opens context menu on right-click', () => {
    useDMStore.setState({
      conversations: [makeConversation()],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    const item = screen.getByLabelText('Alice');
    fireEvent.contextMenu(item);
    // DMConversationContextMenu renders — unencrypted conversation shows fallback text
    expect(screen.getByText('No actions available')).toBeInTheDocument();
  });

  it('renders multiple conversations', () => {
    useDMStore.setState({
      conversations: [
        makeConversation({ id: 'conv-1' }),
        makeConversation({
          id: 'conv-2',
          participants: [
            { userId: 'user-1', username: 'me', displayName: 'Me' },
            { userId: 'user-3', username: 'charlie', displayName: 'Charlie' },
          ],
        }),
      ],
      fetchConversations: vi.fn().mockResolvedValue(undefined),
    });
    render(<ConversationList selectedThreadId={null} onSelectThread={mockOnSelectThread} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });
});
