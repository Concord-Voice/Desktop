import { render, screen, userEvent } from '../../../test-utils';
import Register from '@/renderer/components/Auth/Register';
import { vi } from 'vitest';
import { usePendingRegistrationStore } from '@/renderer/stores/pendingRegistrationStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../../helpers/store-helpers';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock crypto
vi.mock('@/renderer/utils/crypto', () => ({
  generateRegistrationKeys: vi.fn().mockResolvedValue({
    wrappedPrivateKey: 'mock',
    keyDerivationSalt: 'mock',
    keyDerivationAlg: 'argon2id',
    publicKey: {},
  }),
  exportPublicKey: vi.fn().mockResolvedValue('mock-public-key'),
}));

// Mock useSSOFlow so we can assert the SSOButton wiring without exercising
// the full loopback flow. The actual flow is covered in ssoService.test.ts.
const beginSSOMock = vi.fn();
vi.mock('@/renderer/hooks/useSSOFlow', () => ({
  useSSOFlow: () => ({ begin: beginSSOMock }),
}));

describe('Register', () => {
  const onBack = vi.fn();
  const onSuccess = vi.fn();
  const onSwitchToLogin = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllStores();
    usePendingRegistrationStore.getState().clearPending();
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

  it('on 201 response, writes pending registration to store', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        pending_id: 'mock-pending-id',
        email: 'test@example.com',
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        code_expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
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
    await user.click(screen.getByText(/at least 16 years old/));
    await user.click(screen.getByText('Create Account'));

    await vi.waitFor(() => {
      expect(usePendingRegistrationStore.getState().pendingId).toBe('mock-pending-id');
    });
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(onSuccess).toHaveBeenCalledWith({
      pendingId: 'mock-pending-id',
      email: 'test@example.com',
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

  // ── SSO entry point (#270) ────────────────────────────────────────────
  // The Register form mounts an SSOButton above the email/password form.
  // Clicking it must invoke useSSOFlow().begin('google') so the loopback
  // OAuth flow starts. We mock useSSOFlow at the module level (above) to
  // assert the wiring without exercising the loopback round-trip itself
  // (covered in ssoService.test.ts).

  it('calls useSSOFlow().begin("google") when the Sign in with Google button is clicked', async () => {
    beginSSOMock.mockClear();
    const user = userEvent.setup();
    render(<Register onBack={onBack} onSuccess={onSuccess} onSwitchToLogin={onSwitchToLogin} />);

    await user.click(screen.getByRole('button', { name: /sign in with google/i }));
    expect(beginSSOMock).toHaveBeenCalledWith('google');
  });
});
