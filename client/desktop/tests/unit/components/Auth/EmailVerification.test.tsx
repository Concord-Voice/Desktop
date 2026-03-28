import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import EmailVerification from '@/renderer/components/Auth/EmailVerification';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../../helpers/store-helpers';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock API_BASE
vi.mock('@/renderer/services/apiClient', () => ({
  API_BASE: 'http://localhost:8080',
}));

describe('EmailVerification', () => {
  const mockOnVerified = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllStores();
    useAuthStore.setState({ accessToken: 'test-token', emailVerified: false });
  });

  // ── Rendering ──────────────────────────────────────────────────────────

  it('renders with masked email', () => {
    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );
    expect(screen.getByText('Verify your email')).toBeInTheDocument();
    expect(screen.getByText(/t\*+t@example\.com/)).toBeInTheDocument();
  });

  it('renders 6 digit input fields', () => {
    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(6);
  });

  it('masks short emails correctly', () => {
    render(
      <EmailVerification email="ab@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );
    // For 2-char local part: first char + *** + @domain
    expect(screen.getByText(/a\*\*\*@example\.com/)).toBeInTheDocument();
  });

  it('masks single-char emails correctly', () => {
    render(
      <EmailVerification email="a@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );
    expect(screen.getByText(/a\*\*\*@example\.com/)).toBeInTheDocument();
  });

  it('masks long emails with max 6 asterisks', () => {
    render(
      <EmailVerification
        email="longusername@example.com"
        onVerified={mockOnVerified}
        onBack={mockOnBack}
      />
    );
    // First char + up to 6 asterisks + last char
    expect(screen.getByText(/l\*{6}e@example\.com/)).toBeInTheDocument();
  });

  // ── Resend Functionality ───────────────────────────────────────────────

  it('shows resend button enabled on mount (no initial cooldown)', () => {
    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );
    const resendButton = screen.getByText(/Send new code/);
    expect(resendButton).toBeInTheDocument();
    expect(resendButton).not.toBeDisabled();
  });

  it('disables resend button and shows cooldown after successful resend', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: 'Code sent' }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Send new code'));

    await waitFor(() => {
      expect(screen.getByText(/Send new code \(\d+s\)/)).toBeInTheDocument();
    });
  });

  it('sends resend request with auth header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: 'Code sent' }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Send new code'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/auth/verify-email/send',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
    });
  });

  it('shows error when resend fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Rate limited' }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Send new code'));

    await waitFor(() => {
      expect(screen.getByText('Rate limited')).toBeInTheDocument();
    });
  });

  // ── Change Email ───────────────────────────────────────────────────────

  it('shows change email form when clicked', () => {
    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Change email'));
    expect(screen.getByPlaceholderText('New email address')).toBeInTheDocument();
    expect(screen.getByText('Update & send code')).toBeInTheDocument();
  });

  it('toggles change email form off when clicked again', () => {
    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Change email'));
    expect(screen.getByPlaceholderText('New email address')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('New email address')).not.toBeInTheDocument();
  });

  it('disables submit when new email is empty', () => {
    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Change email'));
    const submitBtn = screen.getByText('Update & send code');
    expect(submitBtn).toBeDisabled();
  });

  it('sends change email request to server', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: 'Email changed, code sent' }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Change email'));
    fireEvent.change(screen.getByPlaceholderText('New email address'), {
      target: { value: 'newemail@example.com' },
    });
    fireEvent.submit(screen.getByPlaceholderText('New email address').closest('form')!);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/auth/verify-email/change-email',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ new_email: 'newemail@example.com' }),
        })
      );
    });
  });

  it('updates displayed email after successful change', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: 'Email changed' }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Change email'));
    fireEvent.change(screen.getByPlaceholderText('New email address'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.submit(screen.getByPlaceholderText('New email address').closest('form')!);

    await waitFor(() => {
      // New email should be masked and displayed
      expect(screen.getByText(/n\*+w@example\.com/)).toBeInTheDocument();
    });
  });

  it('updates pendingVerificationEmail in auth store after change', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: 'Email changed' }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Change email'));
    fireEvent.change(screen.getByPlaceholderText('New email address'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.submit(screen.getByPlaceholderText('New email address').closest('form')!);

    await waitFor(() => {
      expect(useAuthStore.getState().pendingVerificationEmail).toBe('new@example.com');
    });
  });

  it('shows error on change email failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Email already in use' }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Change email'));
    fireEvent.change(screen.getByPlaceholderText('New email address'), {
      target: { value: 'taken@example.com' },
    });
    fireEvent.submit(screen.getByPlaceholderText('New email address').closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Email already in use')).toBeInTheDocument();
    });
  });

  // ── Code Verification ──────────────────────────────────────────────────

  it('submits code and calls onVerified on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: 'Email verified successfully',
          access_token: 'new-verified-token',
          expires_in: 900,
        }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    const inputs = screen.getAllByRole('textbox');
    const code = '123456';
    for (let i = 0; i < 6; i++) {
      fireEvent.change(inputs[i], { target: { value: code[i] } });
    }

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/auth/verify-email/confirm',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ code: '123456' }),
        })
      );
    });

    await waitFor(() => {
      expect(mockOnVerified).toHaveBeenCalledWith('new-verified-token');
    });
  });

  it('sets emailVerified in auth store on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'new-token',
        }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < 6; i++) {
      fireEvent.change(inputs[i], { target: { value: String(i + 1) } });
    }

    await waitFor(() => {
      expect(useAuthStore.getState().emailVerified).toBe(true);
    });
  });

  it('shows error on invalid code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () =>
        Promise.resolve({
          error: 'Invalid verification code',
          attempts_remaining: 4,
        }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < 6; i++) {
      fireEvent.change(inputs[i], { target: { value: '0' } });
    }

    await waitFor(() => {
      expect(screen.getByText('4 attempts remaining')).toBeInTheDocument();
    });
  });

  it('shows singular "attempt" when 1 attempt remaining', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () =>
        Promise.resolve({
          error: 'Invalid code',
          attempts_remaining: 1,
        }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < 6; i++) {
      fireEvent.change(inputs[i], { target: { value: '0' } });
    }

    await waitFor(() => {
      expect(screen.getByText('1 attempt remaining')).toBeInTheDocument();
    });
  });

  it('does not show attempts remaining when not provided by server', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () =>
        Promise.resolve({
          error: 'Invalid code',
        }),
    });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < 6; i++) {
      fireEvent.change(inputs[i], { target: { value: '0' } });
    }

    await waitFor(() => {
      expect(screen.getByText('Invalid code')).toBeInTheDocument();
    });
    expect(screen.queryByText(/attempts? remaining/)).not.toBeInTheDocument();
  });

  // ── Navigation ─────────────────────────────────────────────────────────

  it('calls onBack when back button clicked', () => {
    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText(/Back to registration/));
    expect(mockOnBack).toHaveBeenCalledOnce();
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────

  it('does not submit when accessToken is null', async () => {
    useAuthStore.setState({ accessToken: null });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < 6; i++) {
      fireEvent.change(inputs[i], { target: { value: String(i) } });
    }

    // Wait briefly to confirm fetch was not called
    await new Promise((r) => setTimeout(r, 100));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not resend when accessToken is null', async () => {
    useAuthStore.setState({ accessToken: null });

    render(
      <EmailVerification email="test@example.com" onVerified={mockOnVerified} onBack={mockOnBack} />
    );

    fireEvent.click(screen.getByText('Send new code'));
    await new Promise((r) => setTimeout(r, 100));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
