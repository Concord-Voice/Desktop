import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EmailVerification from '../../../src/renderer/components/Auth/EmailVerification';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock API_BASE
vi.mock('../../../src/renderer/services/apiClient', () => ({
  API_BASE: 'http://localhost:8080',
}));

describe('EmailVerification', () => {
  const mockOnVerified = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ accessToken: 'test-token', emailVerified: false });
  });

  it('renders with masked email', () => {
    render(
      <EmailVerification
        email="test@example.com"
        onVerified={mockOnVerified}
        onBack={mockOnBack}
      />
    );

    expect(screen.getByText('Verify your email')).toBeInTheDocument();
    expect(screen.getByText(/t\*+t@example\.com/)).toBeInTheDocument();
  });

  it('renders 6 digit input fields', () => {
    render(
      <EmailVerification
        email="test@example.com"
        onVerified={mockOnVerified}
        onBack={mockOnBack}
      />
    );

    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(6);
  });

  it('shows resend button enabled on mount (no initial cooldown)', () => {
    render(
      <EmailVerification
        email="test@example.com"
        onVerified={mockOnVerified}
        onBack={mockOnBack}
      />
    );

    const resendButton = screen.getByText(/Send new code/);
    expect(resendButton).toBeInTheDocument();
    expect(resendButton).not.toBeDisabled(); // no cooldown until first send
  });

  it('shows change email form when clicked', () => {
    render(
      <EmailVerification
        email="test@example.com"
        onVerified={mockOnVerified}
        onBack={mockOnBack}
      />
    );

    fireEvent.click(screen.getByText('Change email'));
    expect(screen.getByPlaceholderText('New email address')).toBeInTheDocument();
  });

  it('calls onBack when back button clicked', () => {
    render(
      <EmailVerification
        email="test@example.com"
        onVerified={mockOnVerified}
        onBack={mockOnBack}
      />
    );

    fireEvent.click(screen.getByText('← Back to registration'));
    expect(mockOnBack).toHaveBeenCalledOnce();
  });

  it('submits code and calls onVerified on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: 'Email verified successfully',
        access_token: 'new-verified-token',
        expires_in: 900,
      }),
    });

    render(
      <EmailVerification
        email="test@example.com"
        onVerified={mockOnVerified}
        onBack={mockOnBack}
      />
    );

    // Type all 6 digits (simulates auto-submit)
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

  it('shows error on invalid code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({
        error: 'Invalid verification code',
        attempts_remaining: 4,
      }),
    });

    render(
      <EmailVerification
        email="test@example.com"
        onVerified={mockOnVerified}
        onBack={mockOnBack}
      />
    );

    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < 6; i++) {
      fireEvent.change(inputs[i], { target: { value: '0' } });
    }

    await waitFor(() => {
      expect(screen.getByText('4 attempts remaining')).toBeInTheDocument();
    });
  });
});
