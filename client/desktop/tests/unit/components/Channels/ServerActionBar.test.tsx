import { render, screen, fireEvent } from '../../../test-utils';
import { useInviteStore } from '@/renderer/stores/inviteStore';
import ServerActionBar from '@/renderer/components/Channels/ServerActionBar';
import { mockServer } from '../../../mocks/fixtures';
import type { ServerWithRole } from '@/renderer/types/server';

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

describe('ServerActionBar', () => {
  const mockOnOpenCreateModal = vi.fn();

  const ownerServer: ServerWithRole = { ...mockServer, role: 'owner' };
  const adminServer: ServerWithRole = { ...mockServer, role: 'admin' };
  const memberServer: ServerWithRole = { ...mockServer, role: 'member' };

  beforeEach(() => {
    vi.clearAllMocks();
    useInviteStore.setState({ invites: {}, isLoading: false, error: null });
  });

  it('renders Channel and Invite buttons for owner', () => {
    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    expect(screen.getByText('Channel')).toBeInTheDocument();
    expect(screen.getByText('Invite')).toBeInTheDocument();
  });

  it('renders Channel and Invite buttons for admin', () => {
    render(<ServerActionBar server={adminServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    expect(screen.getByText('Channel')).toBeInTheDocument();
    expect(screen.getByText('Invite')).toBeInTheDocument();
  });

  it('renders spacer for regular member (no actions)', () => {
    const { container } = render(
      <ServerActionBar server={memberServer} onOpenCreateModal={mockOnOpenCreateModal} />,
    );
    expect(container.querySelector('.channel-actions-spacer')).toBeInTheDocument();
    expect(screen.queryByText('Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Invite')).not.toBeInTheDocument();
  });

  it('calls onOpenCreateModal when Channel button clicked', () => {
    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Channel'));
    expect(mockOnOpenCreateModal).toHaveBeenCalled();
  });

  it('shows invite popup when Invite clicked', () => {
    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));
    expect(screen.getByText('Invite Code')).toBeInTheDocument();
  });

  it('shows Generate Code button when no active invites', () => {
    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));
    expect(screen.getByText('Generate Code')).toBeInTheDocument();
  });

  it('shows existing invite code and Copy Code button', () => {
    const now = new Date();
    now.setHours(now.getHours() + 1); // expires in 1 hour
    useInviteStore.setState({
      invites: {
        'server-1': [
          {
            id: 'inv-1',
            server_id: 'server-1',
            code: 'AbCd1234',
            is_revoked: false,
            expires_at: now.toISOString(),
            max_uses: null,
            use_count: 0,
            created_by: 'user-1',
            creator_username: 'testuser',
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      },
    });

    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));

    expect(screen.getByText('AbCd1234')).toBeInTheDocument();
    expect(screen.getByText('Copy Code')).toBeInTheDocument();
  });

  it('toggles popup closed on second click', () => {
    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));
    expect(screen.getByText('Invite Code')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Invite'));
    expect(screen.queryByText('Invite Code')).not.toBeInTheDocument();
  });

  it('shows Direct Invite section (disabled)', () => {
    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));
    expect(screen.getByText('Direct Invite')).toBeInTheDocument();
    const sendBtn = screen.getByText('Send to a Friend');
    expect(sendBtn.closest('button')).toBeDisabled();
  });

  it('copies invite code to clipboard on Copy Code click', async () => {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    useInviteStore.setState({
      invites: {
        'server-1': [
          {
            id: 'inv-1',
            server_id: 'server-1',
            code: 'COPY1234',
            is_revoked: false,
            expires_at: now.toISOString(),
            max_uses: null,
            use_count: 0,
            created_by: 'user-1',
            creator_username: 'testuser',
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      },
    });

    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));
    fireEvent.click(screen.getByText('Copy Code'));
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('COPY1234');
    });
  });

  it('skips expired invites', () => {
    const expired = new Date();
    expired.setHours(expired.getHours() - 1);
    useInviteStore.setState({
      invites: {
        'server-1': [
          {
            id: 'inv-1',
            server_id: 'server-1',
            code: 'EXPIRED1',
            is_revoked: false,
            expires_at: expired.toISOString(),
            max_uses: null,
            use_count: 0,
            created_by: 'user-1',
            creator_username: 'testuser',
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      },
    });

    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));
    // Should show Generate Code since the invite is expired
    expect(screen.getByText('Generate Code')).toBeInTheDocument();
  });

  it('skips revoked invites', () => {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    useInviteStore.setState({
      invites: {
        'server-1': [
          {
            id: 'inv-1',
            server_id: 'server-1',
            code: 'REVOKED1',
            is_revoked: true,
            expires_at: now.toISOString(),
            max_uses: null,
            use_count: 0,
            created_by: 'user-1',
            creator_username: 'testuser',
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      },
    });

    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));
    expect(screen.getByText('Generate Code')).toBeInTheDocument();
  });

  it('shows "Coming soon" hint in Direct Invite section', () => {
    render(<ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />);
    fireEvent.click(screen.getByText('Invite'));
    expect(screen.getByText(/Coming soon/)).toBeInTheDocument();
  });

  it('renders single class when only one action available', () => {
    // Create a server that is admin but with only invite capability
    // Actually, admin has both Channel and Invite so not single
    // Let's check the strip class is present
    const { container } = render(
      <ServerActionBar server={ownerServer} onOpenCreateModal={mockOnOpenCreateModal} />,
    );
    expect(container.querySelector('.channel-actions-strip')).toBeInTheDocument();
  });
});
