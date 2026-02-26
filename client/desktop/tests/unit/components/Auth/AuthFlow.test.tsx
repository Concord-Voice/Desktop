import { render, screen, fireEvent } from '../../../test-utils';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { resetAllStores } from '../../../helpers/store-helpers';

// Mock child components to isolate AuthFlow logic
vi.mock('@/renderer/components/Auth/ConnectionSelector', () => ({
  default: ({ onSelect }: { onSelect: (mode: string) => void }) => (
    <div data-testid="connection-selector">
      <button onClick={() => onSelect('hosted')}>Select Hosted</button>
      <button onClick={() => onSelect('hosted-login')}>Select Login</button>
      <button onClick={() => onSelect('self-hosted')}>Select Self-Hosted</button>
    </div>
  ),
}));

vi.mock('@/renderer/components/Auth/ServerInput', () => ({
  default: ({ onConnect, onBack }: { onConnect: (url: string) => void; onBack: () => void }) => (
    <div data-testid="server-input">
      <button onClick={() => onConnect('https://my.server.com')}>Connect</button>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));

vi.mock('@/renderer/components/Auth/Register', () => ({
  default: ({ onBack, onSuccess, onSwitchToLogin }: any) => (
    <div data-testid="register">
      <button onClick={onBack}>Back</button>
      <button onClick={() => onSuccess({ accessToken: 'reg-token', user: { id: 'u1', username: 'newuser', e2ee_preference: false } })}>Register Success</button>
      <button onClick={onSwitchToLogin}>Switch to Login</button>
    </div>
  ),
}));

vi.mock('@/renderer/components/Auth/Login', () => ({
  default: ({ onBack, onSuccess, onSwitchToRegister }: any) => (
    <div data-testid="login">
      <button onClick={onBack}>Back</button>
      <button onClick={() => onSuccess({ accessToken: 'login-token', user: { id: 'u1', username: 'existing', e2ee_preference: false }, rememberMe: false })}>Login Success</button>
      <button onClick={onSwitchToRegister}>Switch to Register</button>
    </div>
  ),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import AuthFlow from '@/renderer/components/Auth/AuthFlow';

describe('AuthFlow', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
  });

  it('renders connection selector initially', () => {
    render(<AuthFlow />);
    expect(screen.getByTestId('connection-selector')).toBeInTheDocument();
  });

  it('shows register form when hosted mode selected', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Hosted'));
    expect(screen.getByTestId('register')).toBeInTheDocument();
  });

  it('shows login form when hosted-login mode selected', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Login'));
    expect(screen.getByTestId('login')).toBeInTheDocument();
  });

  it('shows server input when self-hosted mode selected', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Self-Hosted'));
    expect(screen.getByTestId('server-input')).toBeInTheDocument();
  });

  it('navigates back to connection selector', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Hosted'));
    expect(screen.getByTestId('register')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByTestId('connection-selector')).toBeInTheDocument();
  });

  it('switches from register to login', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Hosted'));
    expect(screen.getByTestId('register')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Switch to Login'));
    expect(screen.getByTestId('login')).toBeInTheDocument();
  });

  it('switches from login to register', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Login'));
    expect(screen.getByTestId('login')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Switch to Register'));
    expect(screen.getByTestId('register')).toBeInTheDocument();
  });

  it('shows self-hosted auth after server connect', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Self-Hosted'));
    fireEvent.click(screen.getByText('Connect'));
    expect(screen.getByText('Connecting to: https://my.server.com')).toBeInTheDocument();
  });

  it('handles registration success', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Hosted'));
    fireEvent.click(screen.getByText('Register Success'));

    expect(useAuthStore.getState().accessToken).toBe('reg-token');
    expect(useUserStore.getState().user?.username).toBe('newuser');
    expect(mockNavigate).toHaveBeenCalledWith('/app/dms');
  });

  it('handles login success', () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Select Login'));
    fireEvent.click(screen.getByText('Login Success'));

    expect(useAuthStore.getState().accessToken).toBe('login-token');
    expect(useUserStore.getState().user?.username).toBe('existing');
    expect(mockNavigate).toHaveBeenCalledWith('/app/dms');
  });
});
