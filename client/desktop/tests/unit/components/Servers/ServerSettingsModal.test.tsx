import { render, screen, fireEvent } from '../../../test-utils';
import { useInviteStore } from '@/renderer/stores/inviteStore';
import { mockServer } from '../../../mocks/fixtures';
import type { ServerWithRole } from '@/renderer/types/server';

// Mock apiFetch
const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_BASE: 'http://localhost:8080',
}));

// Mock LoadingSpinner
vi.mock('@/renderer/components/Auth/LoadingSpinner', () => ({
  default: () => <div data-testid="loading-spinner" />,
}));

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import ServerSettingsModal from '@/renderer/components/Servers/ServerSettingsModal';

describe('ServerSettingsModal', () => {
  const mockOnClose = vi.fn();
  const ownerServer: ServerWithRole = { ...mockServer, role: 'owner' };

  beforeEach(() => {
    vi.clearAllMocks();
    useInviteStore.setState({
      invites: {},
      isLoading: false,
      error: null,
      fetchInvites: vi.fn().mockResolvedValue(undefined),
      createInvite: vi.fn().mockResolvedValue(null),
    });
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <ServerSettingsModal isOpen={false} server={ownerServer} onClose={mockOnClose} />,
    );
    expect(container.querySelector('.modal-overlay')).not.toBeInTheDocument();
  });

  it('renders modal title when open', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Server Settings')).toBeInTheDocument();
  });

  it('renders server name input with current name', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server') as HTMLInputElement;
    expect(input.value).toBe('Test Server');
  });

  it('shows Server Name label', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Server Name')).toBeInTheDocument();
  });

  it('shows character count', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText(/11\/100 characters/)).toBeInTheDocument();
  });

  it('shows Cancel and Save buttons', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });

  it('calls onClose when Cancel clicked', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('shows invite section for owner/admin', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Invite Code')).toBeInTheDocument();
  });

  it('shows Generate Invite Code button when no active invite', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Generate Invite Code')).toBeInTheDocument();
  });

  it('shows icon upload area', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Upload')).toBeInTheDocument();
  });

  it('updates server name on input change', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Server Name' } });
    expect(input.value).toBe('New Server Name');
  });

  it('shows character count after name change', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: 'Short' } });
    expect(screen.getByText(/5\/100 characters/)).toBeInTheDocument();
  });

  it('shows existing invite code when present', () => {
    useInviteStore.setState({
      invites: {
        'server-1': [
          {
            id: 'inv-1',
            server_id: 'server-1',
            code: 'ABCD1234',
            created_by: 'user-1',
            max_uses: 0,
            uses: 2,
            expires_at: null,
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      },
      isLoading: false,
      error: null,
      fetchInvites: vi.fn().mockResolvedValue(undefined),
      createInvite: vi.fn().mockResolvedValue(null),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('ABCD1234')).toBeInTheDocument();
  });

  it('shows invite code section with active invite', () => {
    useInviteStore.setState({
      invites: {
        'server-1': [
          {
            id: 'inv-1',
            server_id: 'server-1',
            code: 'ABCD1234',
            created_by: 'user-1',
            max_uses: 10,
            uses: 3,
            expires_at: null,
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      },
      isLoading: false,
      error: null,
      fetchInvites: vi.fn().mockResolvedValue(undefined),
      createInvite: vi.fn().mockResolvedValue(null),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('ABCD1234')).toBeInTheDocument();
  });

  it('hides invite section for regular members', () => {
    const memberServer: ServerWithRole = { ...mockServer, role: 'member' };
    render(<ServerSettingsModal isOpen={true} server={memberServer} onClose={mockOnClose} />);
    expect(screen.queryByText('Invite Code')).not.toBeInTheDocument();
  });

  it('submits name change on Save', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ server: { ...ownerServer, name: 'Updated Name' } }),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: 'Updated Name' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await vi.waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/servers/server-1'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  it('renders modal overlay when open', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const modal = document.querySelector('.modal-overlay');
    expect(modal).toBeInTheDocument();
  });
});
