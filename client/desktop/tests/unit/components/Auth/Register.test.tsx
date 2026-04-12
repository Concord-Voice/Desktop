import { render, screen, userEvent } from '../../../test-utils';
import Register from '@/renderer/components/Auth/Register';
import { vi } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock crypto and services
vi.mock('@/renderer/utils/crypto', () => ({
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
    getSessionKeys: vi.fn().mockReturnValue({
      wrappingKeyBase64: 'mock-wrapping-key',
      preferencesKeyBase64: 'mock-preferences-key',
      wrappedPrivateKeyBase64: 'mock-wrapped-private-key',
    }),
  },
}));

vi.mock('@/renderer/services/preferencesSync', () => ({
  preferencesSyncService: {
    init: vi.fn(),
    startWatching: vi.fn(),
    fetchAndApply: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Register', () => {
  const onBack = vi.fn();
  const onSuccess = vi.fn();
  const onSwitchToLogin = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders registration form', () => {
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    expect(screen.getByText('Create Your Account')).toBeInTheDocument();
    expect(screen.getByText(/Join the Concord Voice network/)).toBeInTheDocument();
  });

  it('renders all form fields', () => {
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('your_username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Create a strong password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Confirm your password')).toBeInTheDocument();
  });

  it('renders age confirmation checkbox', () => {
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    expect(screen.getByText(/at least 16 years old/)).toBeInTheDocument();
  });

  it('renders E2EE info banner', () => {
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    expect(screen.getByText('End-to-End Encryption Enabled')).toBeInTheDocument();
  });

  it('shows email validation error', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.click(screen.getByText('Create Account'));
    expect(screen.getByText('Email is required')).toBeInTheDocument();
  });

  it('shows username validation error', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com');
    await user.click(screen.getByText('Create Account'));
    expect(screen.getByText('Username is required')).toBeInTheDocument();
  });

  it('shows password validation error for short password', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com');
    await user.type(screen.getByPlaceholderText('your_username'), 'testuser');
    await user.type(screen.getByPlaceholderText('Create a strong password'), 'short');
    await user.type(screen.getByPlaceholderText('Confirm your password'), 'short');
    await user.click(screen.getByText('Create Account'));
    expect(screen.getByText('Password must be at least 12 characters')).toBeInTheDocument();
  });

  it('shows password mismatch error', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com');
    await user.type(screen.getByPlaceholderText('your_username'), 'testuser');
    await user.type(
      screen.getByPlaceholderText('Create a strong password'),
      'MySecurePassword123!'
    );
    await user.type(screen.getByPlaceholderText('Confirm your password'), 'DifferentPassword456!');
    await user.click(screen.getByText('Create Account'));
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
  });

  it('shows age confirmation error', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com');
    await user.type(screen.getByPlaceholderText('your_username'), 'testuser');
    await user.type(
      screen.getByPlaceholderText('Create a strong password'),
      'MySecurePassword123!'
    );
    await user.type(screen.getByPlaceholderText('Confirm your password'), 'MySecurePassword123!');
    await user.click(screen.getByText('Create Account'));
    expect(screen.getByText(/must confirm you are at least 16/)).toBeInTheDocument();
  });

  it('shows username hint with identity', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.type(screen.getByPlaceholderText('your_username'), 'myname');
    expect(screen.getByText(/myname@concordvoice\.chat/)).toBeInTheDocument();
  });

  it('calls onBack when back button is clicked', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.click(screen.getByText(/Back to Connection Options/));
    expect(onBack).toHaveBeenCalled();
  });

  it('calls onSwitchToLogin when sign in is clicked', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.click(screen.getByText('Sign in'));
    expect(onSwitchToLogin).toHaveBeenCalled();
  });

  it('renders terms text', () => {
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    expect(screen.getByText(/Terms of Service and Privacy Policy/)).toBeInTheDocument();
  });

  it('submits registration and calls onSuccess', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'mock-access',
        user: { id: 'user-1', username: 'testuser', email: 'test@example.com' },
      }),
    });

    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com');
    await user.type(screen.getByPlaceholderText('your_username'), 'testuser');
    await user.type(
      screen.getByPlaceholderText('Create a strong password'),
      'MySecurePassword123!'
    );
    await user.type(screen.getByPlaceholderText('Confirm your password'), 'MySecurePassword123!');
    // Click age confirmation checkbox
    await user.click(screen.getByText(/at least 16 years old/));
    await user.click(screen.getByText('Create Account'));

    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'mock-access',
        })
      );
    });
  });

  it('shows error on registration failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Email already registered' }),
    });

    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com');
    await user.type(screen.getByPlaceholderText('your_username'), 'testuser');
    await user.type(
      screen.getByPlaceholderText('Create a strong password'),
      'MySecurePassword123!'
    );
    await user.type(screen.getByPlaceholderText('Confirm your password'), 'MySecurePassword123!');
    await user.click(screen.getByText(/at least 16 years old/));
    await user.click(screen.getByText('Create Account'));

    await vi.waitFor(() => {
      expect(screen.getByText('Email already registered')).toBeInTheDocument();
    });
  });

  it('clears field error when user starts typing', async () => {
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);
    await user.click(screen.getByText('Create Account'));
    expect(screen.getByText('Email is required')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('you@example.com'), 't');
    expect(screen.queryByText('Email is required')).not.toBeInTheDocument();
  });
});
