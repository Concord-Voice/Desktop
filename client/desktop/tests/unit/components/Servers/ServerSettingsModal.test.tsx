import { render, screen, fireEvent } from '../../../test-utils';
import { useInviteStore } from '@/renderer/stores/inviteStore';
import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { useServerStore } from '@/renderer/stores/serverStore';
import { mockServer } from '../../../mocks/fixtures';
import type { ServerWithRole, Role } from '@/renderer/types/server';
import {
  MANAGE_SERVER,
  ADMIN_PERMISSIONS,
  BASE_PERMISSIONS,
  MANAGE_ROLES,
  MANAGE_ROLES_ASSIGN,
  INVITE,
} from '@/renderer/utils/permissions';

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

// Mock ImageCropEditor (heavy component)
vi.mock('@/renderer/components/ui/ImageCropEditor', () => ({
  default: () => null,
}));

import ServerSettingsModal from '@/renderer/components/Servers/ServerSettingsModal';

const mockRoles: Role[] = [
  {
    id: 'role-default',
    server_id: 'server-1',
    name: '@everyone',
    color: '#99aab5',
    permissions: '0',
    position: 0,
    is_default: true,
    display_separately: false,
    mentionable: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  },
  {
    id: 'role-mod',
    server_id: 'server-1',
    name: 'Moderator',
    color: '#e74c3c',
    permissions: '1024',
    position: 1,
    is_default: false,
    display_separately: true,
    mentionable: true,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  },
];

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
    // Initialize permission store with owner-level permissions for tests
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER },
      serverRoles: {},
      fetchRoles: vi.fn().mockResolvedValue(undefined),
      createRole: vi.fn().mockResolvedValue(null),
      updateRole: vi.fn().mockResolvedValue(undefined),
      deleteRole: vi.fn().mockResolvedValue(true),
    });
    useMemberStore.setState({
      members: [],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
  });

  // ── Basic Rendering ──

  it('renders nothing when closed', () => {
    const { container } = render(
      <ServerSettingsModal isOpen={false} server={ownerServer} onClose={mockOnClose} />
    );
    expect(container.querySelector('.modal-overlay')).not.toBeInTheDocument();
  });

  it('renders modal title when open', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Server Settings')).toBeInTheDocument();
  });

  it('renders modal overlay when open', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const modal = document.querySelector('.modal-overlay');
    expect(modal).toBeInTheDocument();
  });

  // ── General Tab ──

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

  // ── Invite Section ──

  it('shows invite section for owner/admin', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Invite Code')).toBeInTheDocument();
  });

  it('shows Generate Invite Code button when no active invite', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Generate Invite Code')).toBeInTheDocument();
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

  it('shows invite code section with active invite (max_uses > 0)', () => {
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
    usePermissionStore.setState({ serverPermissions: { 'server-1': BASE_PERMISSIONS } });
    const memberServer: ServerWithRole = { ...mockServer, role: 'member' };
    render(<ServerSettingsModal isOpen={true} server={memberServer} onClose={mockOnClose} />);
    expect(screen.queryByText('Invite Code')).not.toBeInTheDocument();
  });

  it('shows Copy button for active invite', () => {
    useInviteStore.setState({
      invites: {
        'server-1': [
          {
            id: 'inv-1',
            server_id: 'server-1',
            code: 'TESTCODE',
            created_by: 'user-1',
            max_uses: 0,
            uses: 0,
            expires_at: null,
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      },
      fetchInvites: vi.fn().mockResolvedValue(undefined),
      createInvite: vi.fn().mockResolvedValue(null),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('copies invite code to clipboard on Copy click', async () => {
    useInviteStore.setState({
      invites: {
        'server-1': [
          {
            id: 'inv-1',
            server_id: 'server-1',
            code: 'COPYTEST',
            created_by: 'user-1',
            max_uses: 0,
            uses: 0,
            expires_at: null,
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      },
      fetchInvites: vi.fn().mockResolvedValue(undefined),
      createInvite: vi.fn().mockResolvedValue(null),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Copy'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('COPYTEST');
  });

  // ── Form Submission ──

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
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  it('shows success message after successful save', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ server: { ...ownerServer, name: 'Updated Name' } }),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: 'Updated Name' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await vi.waitFor(() => {
      expect(screen.getByText('Server updated successfully!')).toBeInTheDocument();
    });
  });

  it('shows error message on failed save', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Permission denied' }),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: 'Updated Name' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await vi.waitFor(() => {
      expect(screen.getByText('Permission denied')).toBeInTheDocument();
    });
  });

  it('validates empty server name', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Save Changes'));
    expect(screen.getByText('Server name is required')).toBeInTheDocument();
  });

  it('validates server name too short', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.click(screen.getByText('Save Changes'));
    expect(screen.getByText(/at least/)).toBeInTheDocument();
  });

  it('clears name error on input change', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Save Changes'));
    expect(screen.getByText('Server name is required')).toBeInTheDocument();
    // Type a valid name — error should clear
    fireEvent.change(input, { target: { value: 'Valid Name' } });
    expect(screen.queryByText('Server name is required')).not.toBeInTheDocument();
  });

  it('disables submit button while submitting', async () => {
    let resolveApi: (value: unknown) => void;
    mockApiFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveApi = resolve;
      })
    );
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('Save Changes'));
    // Should show saving state
    await vi.waitFor(() => {
      expect(screen.getByText('Saving...')).toBeInTheDocument();
    });
    // Resolve
    resolveApi!({
      ok: true,
      json: async () => ({ server: { ...ownerServer, name: 'New Name' } }),
    });
  });

  it('does not close modal while submitting', async () => {
    let resolveApi: (value: unknown) => void;
    mockApiFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveApi = resolve;
      })
    );
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('Save Changes'));
    // Try to cancel while submitting
    await vi.waitFor(() => {
      expect(screen.getByText('Saving...')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Cancel'));
    // onClose should not be called while submitting
    expect(mockOnClose).not.toHaveBeenCalled();
    // Cleanup
    resolveApi!({
      ok: true,
      json: async () => ({ server: { ...ownerServer, name: 'New Name' } }),
    });
  });

  // ── Tabs ──

  it('shows General tab by default', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    const generalTab = screen.getByText('General');
    expect(generalTab).toBeInTheDocument();
    expect(generalTab.className).toContain('active');
  });

  it('shows Roles tab for users with MANAGE_ROLES permission', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Roles')).toBeInTheDocument();
  });

  it('shows Members tab for users with MANAGE_ROLES_ASSIGN permission', () => {
    usePermissionStore.setState({
      serverPermissions: {
        'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN,
      },
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText('Members')).toBeInTheDocument();
  });

  it('hides Roles tab when user lacks MANAGE_ROLES permission', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': BASE_PERMISSIONS },
    });
    render(
      <ServerSettingsModal
        isOpen={true}
        server={{ ...mockServer, role: 'member' }}
        onClose={mockOnClose}
      />
    );
    expect(screen.queryByText('Roles')).not.toBeInTheDocument();
  });

  it('switches to Roles tab on click', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    // Should now show role management UI
    expect(screen.getByText('+ Create Role')).toBeInTheDocument();
  });

  // ── Roles Tab ──

  it('renders role list in roles tab', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    expect(screen.getByText('@everyone')).toBeInTheDocument();
    expect(screen.getByText('Moderator')).toBeInTheDocument();
  });

  it('shows role editor placeholder when no role is selected', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    expect(screen.getByText('Select a role to edit, or create a new one.')).toBeInTheDocument();
  });

  it('shows role editor when a role is selected', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('Moderator'));
    expect(screen.getByText('Role Name')).toBeInTheDocument();
    expect(screen.getByText('Role Color')).toBeInTheDocument();
    expect(screen.getByText('Save Role')).toBeInTheDocument();
  });

  it('shows Delete button for non-default roles', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('Moderator'));
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('hides Delete button for default role', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('@everyone'));
    expect(
      screen.getByText('This is the default role assigned to all members.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows Create Role button', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    expect(screen.getByText('+ Create Role')).toBeInTheDocument();
  });

  it('calls createRole when Create Role is clicked', async () => {
    const mockCreateRole = vi.fn().mockResolvedValue({ id: 'new-role', name: 'New Role' });
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
      createRole: mockCreateRole,
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('+ Create Role'));
    await vi.waitFor(() => {
      expect(mockCreateRole).toHaveBeenCalledWith(
        'server-1',
        expect.objectContaining({
          name: 'New Role',
        })
      );
    });
  });

  it('calls updateRole when Save Role is clicked', async () => {
    const mockUpdateRole = vi.fn().mockResolvedValue(undefined);
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
      updateRole: mockUpdateRole,
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('Moderator'));
    // Change role name
    const nameInput = screen.getByDisplayValue('Moderator') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Senior Mod' } });
    fireEvent.click(screen.getByText('Save Role'));
    await vi.waitFor(() => {
      expect(mockUpdateRole).toHaveBeenCalledWith(
        'server-1',
        'role-mod',
        expect.objectContaining({
          name: 'Senior Mod',
        })
      );
    });
  });

  it('calls deleteRole when Delete is clicked', async () => {
    const mockDeleteRole = vi.fn().mockResolvedValue(true);
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
      deleteRole: mockDeleteRole,
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('Moderator'));
    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => {
      expect(mockDeleteRole).toHaveBeenCalledWith('server-1', 'role-mod');
    });
  });

  it('loads selected role data into editor fields', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('Moderator'));
    // Check that the name input has the role name
    expect(screen.getByDisplayValue('Moderator')).toBeInTheDocument();
    // Check that Display Separately checkbox is checked
    const displaySepCheckbox = screen
      .getByText('Display Separately')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(displaySepCheckbox.checked).toBe(true);
    // Check that Mentionable checkbox is checked
    const mentionableCheckbox = screen
      .getByText('Mentionable')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(mentionableCheckbox.checked).toBe(true);
  });

  // ── Members Tab ──

  it('switches to Members tab and shows member list', () => {
    usePermissionStore.setState({
      serverPermissions: {
        'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN,
      },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    useMemberStore.setState({
      members: [
        {
          user_id: 'user-1',
          username: 'testuser',
          display_name: 'Test User',
          avatar_url: null,
          roles: [],
        },
      ],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Members'));
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('shows "No members found" when member list is empty', () => {
    usePermissionStore.setState({
      serverPermissions: {
        'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN,
      },
      serverRoles: { 'server-1': [] },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    useMemberStore.setState({
      members: [],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Members'));
    expect(screen.getByText('No members found.')).toBeInTheDocument();
  });

  it('expands member row to show role assignment on click', () => {
    usePermissionStore.setState({
      serverPermissions: {
        'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN,
      },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    useMemberStore.setState({
      members: [
        {
          user_id: 'user-1',
          username: 'testuser',
          display_name: 'Test User',
          avatar_url: null,
          roles: [],
        },
      ],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Members'));
    // Click on the member row to expand
    fireEvent.click(screen.getByText('Test User'));
    // Should show assignable roles (non-default only)
    expect(screen.getByText('Moderator')).toBeInTheDocument();
  });

  it('shows "No roles available" when no assignable roles exist', () => {
    usePermissionStore.setState({
      serverPermissions: {
        'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN,
      },
      serverRoles: { 'server-1': [mockRoles[0]] }, // Only default role
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    useMemberStore.setState({
      members: [
        {
          user_id: 'user-1',
          username: 'testuser',
          display_name: 'Test User',
          avatar_url: null,
          roles: [],
        },
      ],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Members'));
    fireEvent.click(screen.getByText('Test User'));
    expect(
      screen.getByText('No roles available to assign. Create roles in the Roles tab first.')
    ).toBeInTheDocument();
  });

  it('collapses member row on second click', () => {
    usePermissionStore.setState({
      serverPermissions: {
        'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN,
      },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    useMemberStore.setState({
      members: [
        {
          user_id: 'user-1',
          username: 'testuser',
          display_name: 'Test User',
          avatar_url: null,
          roles: [],
        },
      ],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Members'));
    // Expand
    fireEvent.click(screen.getByText('Test User'));
    expect(document.querySelector('.member-role-assignment')).toBeInTheDocument();
    // Collapse
    fireEvent.click(screen.getByText('Test User'));
    expect(document.querySelector('.member-role-assignment')).not.toBeInTheDocument();
  });

  it('shows member username when display name is set', () => {
    usePermissionStore.setState({
      serverPermissions: {
        'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN,
      },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    useMemberStore.setState({
      members: [
        {
          user_id: 'user-1',
          username: 'testuser',
          display_name: 'Test User',
          avatar_url: null,
          roles: [],
        },
      ],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Members'));
    expect(screen.getByText('@testuser')).toBeInTheDocument();
  });

  it('shows role badges on members', () => {
    usePermissionStore.setState({
      serverPermissions: {
        'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN,
      },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    useMemberStore.setState({
      members: [
        {
          user_id: 'user-1',
          username: 'testuser',
          display_name: 'Test User',
          avatar_url: null,
          roles: [{ role_id: 'role-mod', role_name: 'Moderator', role_color: '#e74c3c' }],
        },
      ],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Members'));
    const badge = document.querySelector('.role-badge');
    expect(badge).toBeInTheDocument();
    expect(badge?.textContent).toBe('Moderator');
  });

  // ── Invite hint text ──

  it('shows invite default hint', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    expect(screen.getByText(/Invites default to 1 use, expire in 24 hours/)).toBeInTheDocument();
  });

  // ── Reset on server change ──

  it('resets form when server prop changes', () => {
    const { rerender } = render(
      <ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />
    );
    const input = screen.getByPlaceholderText('My Awesome Server') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    expect(input.value).toBe('Changed Name');

    // Change server prop
    const newServer = { ...ownerServer, id: 'server-2', name: 'Other Server' };
    rerender(<ServerSettingsModal isOpen={true} server={newServer} onClose={mockOnClose} />);
    const newInput = screen.getByPlaceholderText('My Awesome Server') as HTMLInputElement;
    expect(newInput.value).toBe('Other Server');
  });

  // ── Banner upload area ──

  it('renders banner upload area in general tab', () => {
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    // BannerUploadArea should render with hint text
    expect(screen.getByText(/PNG, JPEG, GIF, WebP/)).toBeInTheDocument();
  });

  // ── Permissions section in role editor ──

  it('shows Permissions section in role editor', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsModal isOpen={true} server={ownerServer} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('Moderator'));
    expect(screen.getByText('Permissions')).toBeInTheDocument();
  });
});
