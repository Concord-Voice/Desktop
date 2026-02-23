import { render, screen, userEvent } from '../../../test-utils';
import Login from '@/renderer/components/Auth/Login';
import { vi } from 'vitest';

// Mock crypto and services to avoid real key operations
vi.mock('@/renderer/utils/crypto', () => ({
  unwrapLoginKeys: vi.fn().mockResolvedValue(undefined),
  generateRegistrationKeys: vi.fn().mockResolvedValue({
    wrappedPrivateKey: 'mock',
    keyDerivationSalt: 'mock',
    publicKey: {},
  }),
  exportPublicKey: vi.fn().mockResolvedValue('mock-public-key'),
}));

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    initialize: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/renderer/services/preferencesSync', () => ({
  preferencesSyncService: {
    startWatching: vi.fn(),
    fetchAndApply: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Login', () => {
  const onBack = vi.fn();
  const onSuccess = vi.fn();
  const onSwitchToRegister = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders login form', () => {
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    expect(screen.getByText('Welcome Back')).toBeInTheDocument();
    expect(screen.getByText('Sign in to your Concord account')).toBeInTheDocument();
  });

  it('renders email and password inputs', () => {
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter your password')).toBeInTheDocument();
  });

  it('renders remember me checkbox', () => {
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    expect(screen.getByText('Remember me')).toBeInTheDocument();
  });

  it('renders sign in button', () => {
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });

  it('shows email validation error for empty email', async () => {
    const user = userEvent.setup();
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    await user.click(screen.getByText('Sign In'));
    expect(screen.getByText('Email is required')).toBeInTheDocument();
  });

  it('shows email validation error for invalid email', async () => {
    const user = userEvent.setup();
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    // Use test@x — passes HTML5 type="email" validation but fails our regex (requires dot in domain)
    await user.type(screen.getByPlaceholderText('you@example.com'), 'test@x');
    await user.type(screen.getByPlaceholderText('Enter your password'), 'somepassword');
    await user.click(screen.getByText('Sign In'));
    expect(screen.getByText('Invalid email format')).toBeInTheDocument();
  });

  it('shows password validation error for empty password', async () => {
    const user = userEvent.setup();
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com');
    await user.click(screen.getByText('Sign In'));
    expect(screen.getByText('Password is required')).toBeInTheDocument();
  });

  it('calls onBack when back button is clicked', async () => {
    const user = userEvent.setup();
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    await user.click(screen.getByText(/Back to Connection Options/));
    expect(onBack).toHaveBeenCalled();
  });

  it('calls onSwitchToRegister when create one is clicked', async () => {
    const user = userEvent.setup();
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    await user.click(screen.getByText('Create one'));
    expect(onSwitchToRegister).toHaveBeenCalled();
  });

  it('renders forgot password link', () => {
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    expect(screen.getByText('Forgot password?')).toBeInTheDocument();
  });

  it('clears field error when user types', async () => {
    const user = userEvent.setup();
    render(<Login onBack={onBack} onSuccess={onSuccess} onSwitchToRegister={onSwitchToRegister} />);
    // Trigger validation
    await user.click(screen.getByText('Sign In'));
    expect(screen.getByText('Email is required')).toBeInTheDocument();
    // Start typing to clear error
    await user.type(screen.getByPlaceholderText('you@example.com'), 't');
    expect(screen.queryByText('Email is required')).not.toBeInTheDocument();
  });
});
