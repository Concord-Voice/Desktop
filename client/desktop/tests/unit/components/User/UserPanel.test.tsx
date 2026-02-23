import { render, screen, fireEvent } from '../../../test-utils';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { mockUser } from '../../../mocks/fixtures';

// Mock UserPopover
vi.mock('@/renderer/components/User/UserPopover', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="user-popover"><button onClick={onClose}>Close</button></div>
  ),
}));

// Mock apiFetch
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ user: {} }),
  }),
  API_BASE: 'http://localhost:8080',
}));

import UserPanel from '@/renderer/components/User/UserPanel';

describe('UserPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().setTokens('mock-token', 'mock-refresh');
    useUserStore.setState({ user: mockUser, isLoading: false });
    useMemberStore.setState({ selfStatus: 'online' });
  });

  it('renders user avatar initial', () => {
    render(<UserPanel />);
    expect(screen.getByText('T')).toBeInTheDocument(); // First letter of "testuser"
  });

  it('renders username', () => {
    render(<UserPanel />);
    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  it('renders status text', () => {
    render(<UserPanel />);
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('shows DND status', () => {
    useMemberStore.setState({ selfStatus: 'dnd' });
    render(<UserPanel />);
    expect(screen.getByText('Do Not Disturb')).toBeInTheDocument();
  });

  it('renders settings button', () => {
    render(<UserPanel />);
    expect(screen.getByLabelText('Settings')).toBeInTheDocument();
  });

  it('opens popover on avatar click', () => {
    render(<UserPanel />);
    fireEvent.click(screen.getByText('T'));
    expect(screen.getByTestId('user-popover')).toBeInTheDocument();
  });

  it('renders loading state when user not loaded', () => {
    // Clear token so useEffect doesn't call fetchUser (which would set an invalid user)
    useAuthStore.getState().clearTokens();
    useUserStore.setState({ user: null, isLoading: true });
    const { container } = render(<UserPanel />);
    // Should render skeleton when loading
    expect(container.querySelector('.user-panel')).toBeInTheDocument();
    expect(container.querySelector('.user-avatar-skeleton')).toBeInTheDocument();
  });
});
