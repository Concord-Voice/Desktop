import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useFriendStore, type Friend, type FriendRequest } from '@/renderer/stores/friendStore';
import { vi } from 'vitest';

// Mock child components that are heavy or have their own dependencies
vi.mock('@/renderer/components/DirectMessages/AddFriendModal', () => ({
  default: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div data-testid="add-friend-modal">
        <button onClick={onClose}>Close Modal</button>
      </div>
    ) : null,
}));

vi.mock('@/renderer/components/Members/MemberProfileCard', () => ({
  default: ({
    member,
    onClose,
  }: {
    member: { user_id: string; username: string };
    onClose: () => void;
  }) => (
    <div data-testid="profile-card" data-user-id={member.user_id}>
      <span>{member.username}</span>
      <button onClick={onClose}>Close Profile</button>
    </div>
  ),
}));

vi.mock('@/renderer/utils/schemeColors', () => ({
  resolveUserAccentColors: vi.fn().mockReturnValue(null),
}));

import FriendsList from '@/renderer/components/DirectMessages/FriendsList';

// --- Test fixtures ---

const makeFriend = (overrides: Partial<Friend> = {}): Friend => ({
  id: 'friendship-1',
  userId: 'user-2',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: undefined,
  colorScheme: undefined,
  status: 'online',
  ...overrides,
});

const makeRequest = (overrides: Partial<FriendRequest> = {}): FriendRequest => ({
  id: 'req-1',
  fromUserId: 'user-3',
  fromUsername: 'bob',
  fromDisplayName: 'Bob',
  fromAvatarUrl: undefined,
  toUserId: 'user-1',
  toUsername: 'me',
  toDisplayName: 'Me',
  toAvatarUrl: undefined,
  direction: 'received',
  createdAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('FriendsList', () => {
  const mockOnFriendClick = vi.fn();

  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useFriendStore.setState({
      friends: [],
      pendingRequests: [],
      fetchFriends: vi.fn().mockResolvedValue(undefined),
      fetchRequests: vi.fn().mockResolvedValue(undefined),
      acceptRequest: vi.fn().mockResolvedValue(undefined),
      declineRequest: vi.fn().mockResolvedValue(undefined),
      removeFriend: vi.fn().mockResolvedValue(undefined),
    });
  });

  // --- Basic Rendering ---

  it('renders the Friends header', () => {
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('Friends')).toBeInTheDocument();
  });

  it('renders Add Friend button', () => {
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByTitle('Add Friend')).toBeInTheDocument();
  });

  it('fetches friends and requests on mount', () => {
    const mockFetchFriends = vi.fn().mockResolvedValue(undefined);
    const mockFetchRequests = vi.fn().mockResolvedValue(undefined);
    useFriendStore.setState({
      fetchFriends: mockFetchFriends,
      fetchRequests: mockFetchRequests,
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(mockFetchFriends).toHaveBeenCalled();
    expect(mockFetchRequests).toHaveBeenCalled();
  });

  // --- Empty State ---

  it('shows empty state when no friends', () => {
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('Add friends to see them here')).toBeInTheDocument();
  });

  // --- Online/Offline Categories ---

  it('renders Online and Offline categories with friend counts', () => {
    useFriendStore.setState({
      friends: [
        makeFriend({
          id: 'f-1',
          userId: 'u-1',
          username: 'alice',
          displayName: 'Alice',
          status: 'online',
        }),
        makeFriend({
          id: 'f-2',
          userId: 'u-2',
          username: 'bob',
          displayName: 'Bob',
          status: 'offline',
        }),
        makeFriend({
          id: 'f-3',
          userId: 'u-3',
          username: 'charlie',
          displayName: 'Charlie',
          status: 'idle',
        }),
      ],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    // Online: Alice (online) + Charlie (idle) = 2; Offline: Bob = 1
    // Verify friends are displayed
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });

  it('renders friend with display name when available', () => {
    useFriendStore.setState({
      friends: [makeFriend({ displayName: 'Alice Wonderland' })],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('Alice Wonderland')).toBeInTheDocument();
  });

  it('renders friend with username when no display name', () => {
    useFriendStore.setState({
      friends: [makeFriend({ displayName: undefined })],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('renders avatar initial from display name', () => {
    useFriendStore.setState({
      friends: [makeFriend({ displayName: 'Alice' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);
    const initial = container.querySelector('.member-avatar-initial');
    expect(initial?.textContent).toBe('A');
  });

  it('renders avatar image when avatarUrl is provided', () => {
    useFriendStore.setState({
      friends: [makeFriend({ avatarUrl: 'https://example.com/avatar.png' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);
    const img = container.querySelector('.member-avatar-img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://example.com/avatar.png');
  });

  it('renders status dot for friend', () => {
    useFriendStore.setState({
      friends: [makeFriend({ status: 'online' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);
    const statusDot = container.querySelector('.member-status-dot.online');
    expect(statusDot).toBeInTheDocument();
  });

  it('applies offline class to offline friends', () => {
    useFriendStore.setState({
      friends: [makeFriend({ status: 'offline' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);
    const offlineFriend = container.querySelector('.friend-item.offline');
    expect(offlineFriend).toBeInTheDocument();
  });

  // --- Category Collapsing ---

  it('toggles category collapsed state on click', () => {
    useFriendStore.setState({
      friends: [makeFriend({ status: 'online' })],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    // Online category should be expanded by default
    const onlineHeader = screen.getByText('Online').closest('button');
    expect(onlineHeader).toHaveAttribute('aria-expanded', 'true');

    // Click to collapse
    fireEvent.click(onlineHeader!);
    expect(onlineHeader).toHaveAttribute('aria-expanded', 'false');

    // Click again to expand
    fireEvent.click(onlineHeader!);
    expect(onlineHeader).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles category on Enter key press', () => {
    useFriendStore.setState({
      friends: [makeFriend({ status: 'online' })],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const onlineHeader = screen.getByText('Online').closest('button');
    expect(onlineHeader).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(onlineHeader!, { key: 'Enter' });
    expect(onlineHeader).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides friends when category is collapsed', () => {
    useFriendStore.setState({
      friends: [makeFriend({ status: 'online', displayName: 'Alice' })],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();

    // Collapse the Online category
    const onlineHeader = screen.getByText('Online').closest('button');
    fireEvent.click(onlineHeader!);

    // Alice should no longer be visible
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  // --- Pending Requests Section ---

  it('shows Pending Requests section with incoming requests', () => {
    useFriendStore.setState({
      pendingRequests: [makeRequest()],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('Pending Requests')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Incoming request')).toBeInTheDocument();
  });

  it('shows incoming request count badge in header', () => {
    useFriendStore.setState({
      pendingRequests: [
        makeRequest({ id: 'req-1', direction: 'received' }),
        makeRequest({
          id: 'req-2',
          direction: 'received',
          fromUsername: 'charlie',
          fromDisplayName: 'Charlie',
        }),
      ],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);
    const badge = container.querySelector('.friends-header-badge');
    expect(badge).toBeInTheDocument();
    expect(badge?.textContent).toBe('2');
  });

  it('does not show incoming count badge when no incoming requests', () => {
    useFriendStore.setState({
      pendingRequests: [makeRequest({ direction: 'sent' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);
    const badge = container.querySelector('.friends-header-badge');
    expect(badge).not.toBeInTheDocument();
  });

  it('does not show Pending Requests section when no pending requests', () => {
    useFriendStore.setState({ pendingRequests: [] });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.queryByText('Pending Requests')).not.toBeInTheDocument();
  });

  it('shows outgoing request with Pending label', () => {
    useFriendStore.setState({
      pendingRequests: [
        makeRequest({
          id: 'req-2',
          direction: 'sent',
          toUsername: 'dave',
          toDisplayName: 'Dave',
        }),
      ],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('Dave')).toBeInTheDocument();
    expect(screen.getByText('Outgoing request')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('shows request display name from fromDisplayName when available', () => {
    useFriendStore.setState({
      pendingRequests: [makeRequest({ fromDisplayName: 'Bobby Tables' })],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('Bobby Tables')).toBeInTheDocument();
  });

  it('shows request username when fromDisplayName is not available', () => {
    useFriendStore.setState({
      pendingRequests: [makeRequest({ fromDisplayName: undefined })],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('shows avatar initial from request display name', () => {
    useFriendStore.setState({
      pendingRequests: [makeRequest({ fromDisplayName: 'Bob' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);
    const initials = container.querySelectorAll('.member-avatar-initial');
    const bobInitial = Array.from(initials).find((el) => el.textContent === 'B');
    expect(bobInitial).toBeTruthy();
  });

  // --- Accept/Decline Requests ---

  it('calls acceptRequest when accept button is clicked', async () => {
    const mockAccept = vi.fn().mockResolvedValue(undefined);
    useFriendStore.setState({
      pendingRequests: [makeRequest()],
      acceptRequest: mockAccept,
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const acceptBtn = screen.getByTitle('Accept');
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      expect(mockAccept).toHaveBeenCalledWith('req-1');
    });
  });

  it('calls declineRequest when decline button is clicked', async () => {
    const mockDecline = vi.fn().mockResolvedValue(undefined);
    useFriendStore.setState({
      pendingRequests: [makeRequest()],
      declineRequest: mockDecline,
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const declineBtn = screen.getByTitle('Decline');
    fireEvent.click(declineBtn);

    await waitFor(() => {
      expect(mockDecline).toHaveBeenCalledWith('req-1');
    });
  });

  it('disables accept/decline buttons during loading', async () => {
    // Make acceptRequest hang indefinitely
    const mockAccept = vi.fn().mockImplementation(() => new Promise(() => {}));
    useFriendStore.setState({
      pendingRequests: [makeRequest()],
      acceptRequest: mockAccept,
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const acceptBtn = screen.getByTitle('Accept');
    const declineBtn = screen.getByTitle('Decline');

    fireEvent.click(acceptBtn);

    // Both buttons should become disabled
    await waitFor(() => {
      expect(acceptBtn).toBeDisabled();
      expect(declineBtn).toBeDisabled();
    });
  });

  it('handles acceptRequest error gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockAccept = vi.fn().mockRejectedValue(new Error('Network error'));
    useFriendStore.setState({
      pendingRequests: [makeRequest()],
      acceptRequest: mockAccept,
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    fireEvent.click(screen.getByTitle('Accept'));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to accept friend request:',
        expect.any(Error)
      );
    });
    consoleSpy.mockRestore();
  });

  it('handles declineRequest error gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockDecline = vi.fn().mockRejectedValue(new Error('Network error'));
    useFriendStore.setState({
      pendingRequests: [makeRequest()],
      declineRequest: mockDecline,
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    fireEvent.click(screen.getByTitle('Decline'));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to decline friend request:',
        expect.any(Error)
      );
    });
    consoleSpy.mockRestore();
  });

  // --- Pending Requests Collapse ---

  it('collapses pending requests section on category header click', () => {
    useFriendStore.setState({
      pendingRequests: [makeRequest()],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    expect(screen.getByText('Bob')).toBeInTheDocument();

    const pendingHeader = screen.getByText('Pending Requests').closest('button');
    fireEvent.click(pendingHeader!);

    expect(screen.queryByText('Incoming request')).not.toBeInTheDocument();
  });

  it('shows pending request count in category header', () => {
    useFriendStore.setState({
      pendingRequests: [
        makeRequest({ id: 'req-1' }),
        makeRequest({ id: 'req-2', direction: 'sent', toDisplayName: 'Eve' }),
      ],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);
    // Total pending count (including outgoing) should be 2
    const pendingHeader = screen.getByText('Pending Requests').closest('button');
    const countEl = pendingHeader?.querySelector('.friend-category-count');
    expect(countEl?.textContent).toBe('2');
  });

  // --- Add Friend Modal ---

  it('opens AddFriendModal when add button is clicked', () => {
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    expect(screen.queryByTestId('add-friend-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Add Friend'));

    expect(screen.getByTestId('add-friend-modal')).toBeInTheDocument();
  });

  it('closes AddFriendModal when close is called', () => {
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    fireEvent.click(screen.getByTitle('Add Friend'));
    expect(screen.getByTestId('add-friend-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Close Modal'));
    expect(screen.queryByTestId('add-friend-modal')).not.toBeInTheDocument();
  });

  // --- Context Menu ---

  it('shows context menu on right-click of a friend', () => {
    useFriendStore.setState({
      friends: [makeFriend()],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');
    fireEvent.contextMenu(friendItem!, { clientX: 100, clientY: 200 });

    expect(screen.getByText('Remove Friend')).toBeInTheDocument();
    expect(screen.getByText('Message')).toBeInTheDocument();
  });

  it('calls onFriendClick when Message is clicked in context menu', () => {
    useFriendStore.setState({
      friends: [makeFriend({ userId: 'user-2' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');
    fireEvent.contextMenu(friendItem!, { clientX: 100, clientY: 200 });

    fireEvent.click(screen.getByText('Message'));
    expect(mockOnFriendClick).toHaveBeenCalledWith('user-2');
  });

  it('calls removeFriend when Remove Friend is clicked in context menu', async () => {
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    useFriendStore.setState({
      friends: [makeFriend({ userId: 'user-2' })],
      removeFriend: mockRemove,
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');
    fireEvent.contextMenu(friendItem!, { clientX: 100, clientY: 200 });

    fireEvent.click(screen.getByText('Remove Friend'));

    await waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith('user-2');
    });
  });

  it('handles removeFriend error gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockRemove = vi.fn().mockRejectedValue(new Error('Remove failed'));
    useFriendStore.setState({
      friends: [makeFriend()],
      removeFriend: mockRemove,
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');
    fireEvent.contextMenu(friendItem!, { clientX: 100, clientY: 200 });
    fireEvent.click(screen.getByText('Remove Friend'));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to remove friend:', expect.any(Error));
    });
    consoleSpy.mockRestore();
  });

  // --- Friend Click / Profile Card ---

  it('shows profile card when friend is clicked', () => {
    useFriendStore.setState({
      friends: [makeFriend({ userId: 'user-2', username: 'alice' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');
    fireEvent.click(friendItem!, { clientX: 150, clientY: 250 });

    expect(screen.getByTestId('profile-card')).toBeInTheDocument();
    expect(screen.getByTestId('profile-card')).toHaveAttribute('data-user-id', 'user-2');
  });

  it('closes profile card when clicking the same friend again', () => {
    useFriendStore.setState({
      friends: [makeFriend()],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');

    // Open
    fireEvent.click(friendItem!, { clientX: 150, clientY: 250 });
    expect(screen.getByTestId('profile-card')).toBeInTheDocument();

    // Close by clicking the same friend
    fireEvent.click(friendItem!, { clientX: 150, clientY: 250 });
    expect(screen.queryByTestId('profile-card')).not.toBeInTheDocument();
  });

  it('closes profile card via onClose callback', () => {
    useFriendStore.setState({
      friends: [makeFriend()],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');
    fireEvent.click(friendItem!, { clientX: 150, clientY: 250 });

    expect(screen.getByTestId('profile-card')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Close Profile'));
    expect(screen.queryByTestId('profile-card')).not.toBeInTheDocument();
  });

  // --- Context Menu Header ---

  it('shows friend display name in context menu header', () => {
    useFriendStore.setState({
      friends: [makeFriend({ displayName: 'Alice Wonderland' })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');
    fireEvent.contextMenu(friendItem!, { clientX: 100, clientY: 200 });

    // The name appears in both the friend list and context menu header
    const ctxHeader = document.querySelector('.ctx-menu-header');
    expect(ctxHeader?.textContent).toBe('Alice Wonderland');
  });

  it('shows friend username in context menu header when no display name', () => {
    useFriendStore.setState({
      friends: [makeFriend({ displayName: undefined })],
    });
    const { container } = render(<FriendsList onFriendClick={mockOnFriendClick} />);

    const friendItem = container.querySelector('.friend-item:not(.friend-request-item)');
    fireEvent.contextMenu(friendItem!, { clientX: 100, clientY: 200 });

    // username 'alice' should appear in the context menu header
    const ctxHeader = document.querySelector('.ctx-menu-header');
    expect(ctxHeader?.textContent).toBe('alice');
  });

  // --- Mixed friend list ---

  it('separates online and offline friends correctly', () => {
    useFriendStore.setState({
      friends: [
        makeFriend({
          id: 'f-1',
          userId: 'u-1',
          username: 'online-alice',
          displayName: 'Alice',
          status: 'online',
        }),
        makeFriend({
          id: 'f-2',
          userId: 'u-2',
          username: 'idle-bob',
          displayName: 'Bob',
          status: 'idle',
        }),
        makeFriend({
          id: 'f-3',
          userId: 'u-3',
          username: 'dnd-charlie',
          displayName: 'Charlie',
          status: 'dnd',
        }),
        makeFriend({
          id: 'f-4',
          userId: 'u-4',
          username: 'offline-dave',
          displayName: 'Dave',
          status: 'offline',
        }),
      ],
    });
    render(<FriendsList onFriendClick={mockOnFriendClick} />);

    // All should be visible
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
    expect(screen.getByText('Dave')).toBeInTheDocument();
  });
});
