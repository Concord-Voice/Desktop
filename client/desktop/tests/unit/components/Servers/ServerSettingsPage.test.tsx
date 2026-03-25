import { render, screen, fireEvent } from '../../../test-utils';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useInviteStore } from '@/renderer/stores/inviteStore';
import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { mockServer } from '../../../mocks/fixtures';
import type { Role } from '@/renderer/types/server';
import {
  MANAGE_SERVER,
  ADMIN_PERMISSIONS,
  BASE_PERMISSIONS,
  MANAGE_ROLES,
  MANAGE_ROLES_ASSIGN,
  INVITE,
} from '@/renderer/utils/permissions';
import { vi } from 'vitest';

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

// Mock ImageCropEditor
vi.mock('@/renderer/components/ui/ImageCropEditor', () => ({
  default: () => null,
}));

// Mock EmojiPicker
vi.mock('@/renderer/components/EmojiPicker/LazyEmojiPicker', () => ({
  default: () => <div data-testid="emoji-picker" />,
}));

// Mock PermissionGrid
vi.mock('@/renderer/components/Permissions/PermissionGrid', () => ({
  default: ({ value, onChange }: { value: bigint; onChange: (v: bigint) => void }) => (
    <div data-testid="permission-grid" onClick={() => onChange(value | 1n)}>
      PermissionGrid
    </div>
  ),
}));

// Mock ToggleSwitch
vi.mock('@/renderer/components/Settings/ToggleSwitch', () => ({
  default: ({
    checked,
    onChange,
    disabled,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <button
      data-testid="toggle-switch"
      data-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      Toggle
    </button>
  ),
}));

// Mock useParams and useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ serverId: 'server-1' }),
  };
});

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import ServerSettingsPage from '@/renderer/components/Servers/ServerSettingsPage';

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
    id: 'role-admin',
    server_id: 'server-1',
    name: 'Admin',
    color: '#3498db',
    permissions: '1024',
    position: 2,
    is_default: false,
    display_separately: true,
    mentionable: true,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  },
];

const allPerms = ADMIN_PERMISSIONS | MANAGE_SERVER | MANAGE_ROLES | MANAGE_ROLES_ASSIGN | INVITE;

describe('ServerSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.setState({ servers: [mockServer] });
    useInviteStore.setState({
      invites: {},
      fetchInvites: vi.fn().mockResolvedValue(undefined),
      createInvite: vi.fn().mockResolvedValue(null),
    });
    usePermissionStore.setState({
      serverPermissions: { 'server-1': allPerms },
      serverRoles: {},
      fetchRoles: vi.fn().mockResolvedValue(undefined),
      createRole: vi.fn().mockResolvedValue(null),
      updateRole: vi.fn().mockResolvedValue(undefined),
      deleteRole: vi.fn().mockResolvedValue(true),
      assignRole: vi.fn().mockResolvedValue(undefined),
      unassignRole: vi.fn().mockResolvedValue(undefined),
    });
    useMemberStore.setState({
      members: [],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('renders Server Settings title', () => {
    render(<ServerSettingsPage />);
    expect(screen.getByText('Server Settings')).toBeInTheDocument();
  });

  it('renders back button', () => {
    render(<ServerSettingsPage />);
    expect(screen.getByText('Back to app')).toBeInTheDocument();
  });

  it('navigates back on back button click', () => {
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Back to app'));
    expect(mockNavigate).toHaveBeenCalledWith('/app');
  });

  it('shows "Server not found" when server does not exist', () => {
    useServerStore.setState({ servers: [] });
    render(<ServerSettingsPage />);
    expect(screen.getByText('Server not found.')).toBeInTheDocument();
  });

  it('shows General nav item', () => {
    render(<ServerSettingsPage />);
    expect(screen.getByText('General')).toBeInTheDocument();
  });

  it('shows Roles nav item when user has MANAGE_ROLES permission', () => {
    render(<ServerSettingsPage />);
    expect(screen.getByText('Roles')).toBeInTheDocument();
  });

  it('shows Members nav item when user has MANAGE_ROLES_ASSIGN permission', () => {
    render(<ServerSettingsPage />);
    expect(screen.getByText('Members')).toBeInTheDocument();
  });

  it('hides Roles nav item when user lacks MANAGE_ROLES permission', () => {
    usePermissionStore.setState({ serverPermissions: { 'server-1': BASE_PERMISSIONS } });
    render(<ServerSettingsPage />);
    expect(screen.queryByText('Roles')).not.toBeInTheDocument();
  });

  it('hides Members nav item when user lacks MANAGE_ROLES_ASSIGN permission', () => {
    usePermissionStore.setState({ serverPermissions: { 'server-1': BASE_PERMISSIONS } });
    render(<ServerSettingsPage />);
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
  });

  it('renders Server Info section with server name input', () => {
    render(<ServerSettingsPage />);
    // "Server Info" appears in both nav tree and section heading
    expect(screen.getAllByText('Server Info').length).toBeGreaterThanOrEqual(1);
    const input = screen.getByPlaceholderText('My Awesome Server') as HTMLInputElement;
    expect(input.value).toBe('Test Server');
  });

  it('renders Content Safety section', () => {
    render(<ServerSettingsPage />);
    // "Content Safety" appears in both nav tree and section heading
    expect(screen.getAllByText('Content Safety').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Allow Embedded Content')).toBeInTheDocument();
  });

  it('renders Invite Code section for users with INVITE permission', () => {
    render(<ServerSettingsPage />);
    // "Invite Code" appears in both nav tree and section heading
    expect(screen.getAllByText('Invite Code').length).toBeGreaterThanOrEqual(1);
  });

  it('renders Save Changes button', () => {
    render(<ServerSettingsPage />);
    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });

  it('updates name on input change', () => {
    render(<ServerSettingsPage />);
    const input = screen.getByPlaceholderText('My Awesome Server') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Name' } });
    expect(input.value).toBe('New Name');
  });

  it('shows character count', () => {
    render(<ServerSettingsPage />);
    expect(screen.getByText(/11\/100 characters/)).toBeInTheDocument();
  });

  it('validates empty server name on submit', () => {
    render(<ServerSettingsPage />);
    const input = screen.getByPlaceholderText('My Awesome Server');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Save Changes'));
    expect(screen.getByText('Server name is required')).toBeInTheDocument();
  });

  it('submits form on Save Changes click', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ server: { ...mockServer, name: 'Updated' } }),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Save Changes'));
    await vi.waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/servers/server-1'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  it('shows error on failed save', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Server name taken' }),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Save Changes'));
    await vi.waitFor(() => {
      expect(screen.getByText('Server name taken')).toBeInTheDocument();
    });
  });

  it('switches to Roles section on nav click', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': allPerms },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Roles'));
    expect(screen.getByText('+ Create Role')).toBeInTheDocument();
  });

  it('switches to Members section on nav click', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': allPerms },
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
          roles: [{ role_id: 'role-admin', role_name: 'Admin', role_color: '#3498db' }],
        },
      ],
      fetchMembers: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Members'));
    // "Member List" appears in both nav tree and section heading
    expect(screen.getAllByText('Member List').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('shows role editor when role is selected', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': allPerms },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('Admin'));
    expect(screen.getByText('Role Name')).toBeInTheDocument();
    expect(screen.getByText('Role Color')).toBeInTheDocument();
    expect(screen.getByText('Display Separately')).toBeInTheDocument();
    expect(screen.getByText('Mentionable')).toBeInTheDocument();
  });

  it('shows role editor placeholder text when no role selected', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': allPerms },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Roles'));
    expect(screen.getByText('Select a role to edit, or create a new one.')).toBeInTheDocument();
  });

  it('shows Delete button for non-default roles', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': allPerms },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('Admin'));
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('hides Delete button for default role', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': allPerms },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Roles'));
    fireEvent.click(screen.getByText('@everyone'));
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows "No members found" when list is empty', () => {
    usePermissionStore.setState({
      serverPermissions: { 'server-1': allPerms },
      serverRoles: { 'server-1': mockRoles },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
    render(<ServerSettingsPage />);
    fireEvent.click(screen.getByText('Members'));
    expect(screen.getByText('No members found.')).toBeInTheDocument();
  });

  it('shows Generate Invite Code when no active invite', () => {
    render(<ServerSettingsPage />);
    expect(screen.getByText('Generate Invite Code')).toBeInTheDocument();
  });

  it('shows existing invite code', () => {
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
    render(<ServerSettingsPage />);
    expect(screen.getByText('TESTCODE')).toBeInTheDocument();
  });

  it('shows subsection nav items for general section', () => {
    render(<ServerSettingsPage />);
    // Each subsection label appears in both the nav tree and the section heading
    expect(screen.getAllByText('Server Info').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Content Safety').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Invite Code').length).toBeGreaterThanOrEqual(2);
  });
});
