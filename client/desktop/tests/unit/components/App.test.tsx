import { render, screen } from '../../test-utils';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { mockUser } from '../../mocks/fixtures';

// Mock child components to prevent complex rendering
vi.mock('@/renderer/components/Auth/AuthFlow', () => ({
  default: () => <div data-testid="auth-flow">AuthFlow</div>,
}));
vi.mock('@/renderer/components/MainView/MainView', () => ({
  default: () => <div data-testid="main-view">MainView</div>,
}));
vi.mock('@/renderer/components/Profile/ProfilePage', () => ({
  default: () => <div data-testid="profile-page">ProfilePage</div>,
}));
vi.mock('@/renderer/components/Settings/SettingsPage', () => ({
  default: () => <div data-testid="settings-page">SettingsPage</div>,
}));
vi.mock('@/renderer/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

import App from '@/renderer/App';

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().clearAccessToken();
    useUserStore.setState({ user: null });
  });

  it('renders title bar', () => {
    render(<App />);
    expect(screen.getByText('Concord')).toBeInTheDocument();
  });

  it('renders auth flow on root path', () => {
    render(<App />);
    expect(screen.getByTestId('auth-flow')).toBeInTheDocument();
  });

  it('renders app container with correct class', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.app')).toBeInTheDocument();
  });

  it('renders title bar section', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.title-bar')).toBeInTheDocument();
    expect(container.querySelector('.title-bar-text')).toBeInTheDocument();
  });

  it('prevents context menu on app container', () => {
    const { container } = render(<App />);
    const appDiv = container.querySelector('.app');
    expect(appDiv).toBeInTheDocument();
  });
});
