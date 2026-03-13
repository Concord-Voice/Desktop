import { render, screen, fireEvent } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { mockUser, mockServer, mockMember, mockMember2 } from '../../../mocks/fixtures';

import MemberList from '@/renderer/components/Members/MemberList';

// Mock apiFetch to control member loading
const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_BASE: 'http://localhost:8080',
}));

// Mock MemberProfileCard and MemberContextMenu to avoid complex rendering
vi.mock('@/renderer/components/Members/MemberProfileCard', () => ({
  default: ({ member, onClose }: { member: { username: string }; onClose: () => void }) => (
    <div data-testid="profile-card">{member.username}<button onClick={onClose}>Close</button></div>
  ),
}));

vi.mock('@/renderer/components/Members/MemberContextMenu', () => ({
  default: ({ member, onClose }: { member: { username: string }; onClose: () => void }) => (
    <div data-testid="context-menu">{member.username}<button onClick={onClose}>Close</button></div>
  ),
}));

describe('MemberList', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useAuthStore.getState().setAccessToken('mock-token');
    useUserStore.setState({ user: mockUser });
    useServerStore.getState().addServer(mockServer);
    useServerStore.getState().setActiveServer(mockServer.id);
    // No RBAC roles configured — members fall into Online/Offline groups
    usePermissionStore.setState({ serverPermissions: {}, serverRoles: {} });
    // Default: return members successfully
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ members: [mockMember, mockMember2] }),
    });
  });

  it('renders Members header', () => {
    render(<MemberList />);
    expect(screen.getByText('Members')).toBeInTheDocument();
  });

  it('shows empty state when no members', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ members: [] }),
    });
    render(<MemberList />);
    expect(await screen.findByText('No members')).toBeInTheDocument();
  });

  it('shows loading skeletons when loading', () => {
    // Make fetch never resolve so isLoading stays true
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<MemberList />);
    const skeletons = document.querySelectorAll('.member-skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows error state with retry button', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Network error' }),
    });
    render(<MemberList />);
    expect(await screen.findByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('renders members grouped by role', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ members: [mockMember, mockMember2] }),
    });
    render(<MemberList />);
    // Without display_separately RBAC roles, members fall into Online/Offline groups
    expect(await screen.findByText(/Offline/)).toBeInTheDocument();
  });

  it('shows member display name', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ members: [mockMember] }),
    });
    render(<MemberList />);
    expect(await screen.findByText('Test User')).toBeInTheDocument();
  });

  it('renders avatar initial when no avatar URL', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ members: [mockMember] }),
    });
    render(<MemberList />);
    await screen.findByText('Test User');
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('opens profile card on member click', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ members: [mockMember] }),
    });
    render(<MemberList />);
    await screen.findByText('Test User');
    fireEvent.click(screen.getByText('Test User'));
    expect(screen.getByTestId('profile-card')).toBeInTheDocument();
  });

  it('opens context menu on right click', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ members: [mockMember] }),
    });
    render(<MemberList />);
    await screen.findByText('Test User');
    fireEvent.contextMenu(screen.getByText('Test User'));
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
  });
});
