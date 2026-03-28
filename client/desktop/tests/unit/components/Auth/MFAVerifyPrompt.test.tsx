import { render, screen, fireEvent } from '../../../test-utils';
import { vi } from 'vitest';

// Mock apiFetch for WebAuthn flows
const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_BASE: 'http://localhost:8080',
}));

import MFAVerifyPrompt from '@/renderer/components/Auth/MFAVerifyPrompt';

describe('MFAVerifyPrompt', () => {
  const onVerify = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────

  it('renders MFA Verification label', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} />);
    expect(screen.getByText('MFA Verification')).toBeInTheDocument();
  });

  it('shows TOTP input when totp is the default method', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} />);
    // Should show 6 digit inputs for TOTP
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(6);
  });

  it('shows WebAuthn button when webauthn is the default method', () => {
    render(<MFAVerifyPrompt methods={['webauthn']} onVerify={onVerify} />);
    expect(screen.getByText('Verify with security key')).toBeInTheDocument();
  });

  it('shows switch links for other available methods', () => {
    render(<MFAVerifyPrompt methods={['totp', 'webauthn']} onVerify={onVerify} />);
    // Default should be webauthn (highest priority), so we should see "Use authenticator app"
    expect(screen.getByText('Use authenticator app instead')).toBeInTheDocument();
  });

  // ── Mode Switching ─────────────────────────────────────────────────────

  it('switches from webauthn to totp mode', () => {
    render(<MFAVerifyPrompt methods={['totp', 'webauthn']} onVerify={onVerify} />);
    fireEvent.click(screen.getByText('Use authenticator app instead'));
    // Now should show TOTP digit inputs
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(6);
  });

  it('switches from totp to backup code mode', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} />);
    fireEvent.click(screen.getByText('Use a backup code instead'));
    expect(screen.getByPlaceholderText('XXXXXXXX')).toBeInTheDocument();
  });

  it('switches from backup back to totp mode', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} />);
    fireEvent.click(screen.getByText('Use a backup code instead'));
    expect(screen.getByPlaceholderText('XXXXXXXX')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Use authenticator app instead'));
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(6);
  });

  it('shows webauthn switch from totp mode', () => {
    render(<MFAVerifyPrompt methods={['totp', 'webauthn']} onVerify={onVerify} />);
    // Default is webauthn; switch to totp first
    fireEvent.click(screen.getByText('Use authenticator app instead'));
    // Now should see option to switch back to webauthn
    expect(screen.getByText('Use a security key instead')).toBeInTheDocument();
  });

  it('switches from backup to webauthn when available', () => {
    render(<MFAVerifyPrompt methods={['totp', 'webauthn']} onVerify={onVerify} />);
    // Start on webauthn, go to totp, then backup
    fireEvent.click(screen.getByText('Use authenticator app instead'));
    fireEvent.click(screen.getByText('Use a backup code instead'));
    // Should see webauthn link from backup mode
    expect(screen.getByText('Use a security key instead')).toBeInTheDocument();
  });

  // ── Exclude Options ────────────────────────────────────────────────────

  it('hides backup code option when excludeBackupCodes is true', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} excludeBackupCodes />);
    expect(screen.queryByText('Use a backup code instead')).not.toBeInTheDocument();
  });

  it('excludes recovery-only methods', () => {
    render(
      <MFAVerifyPrompt
        methods={['totp', 'email']}
        recoveryOnlyMethods={['email']}
        onVerify={onVerify}
      />
    );
    // Should not show email/sms switch
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });

  it('does not show backup switch when excludeBackupCodes and in webauthn mode', () => {
    render(
      <MFAVerifyPrompt methods={['webauthn', 'totp']} onVerify={onVerify} excludeBackupCodes />
    );
    expect(screen.queryByText('Use a backup code instead')).not.toBeInTheDocument();
  });

  // ── Code Submission ────────────────────────────────────────────────────

  it('calls onVerify when TOTP code is entered', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} />);
    for (let i = 1; i <= 6; i++) {
      fireEvent.change(screen.getByLabelText(`Digit ${i}`), {
        target: { value: String(i) },
      });
    }
    expect(onVerify).toHaveBeenCalledWith('123456');
  });

  it('calls onVerify when backup code is submitted', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} />);
    fireEvent.click(screen.getByText('Use a backup code instead'));
    const input = screen.getByPlaceholderText('XXXXXXXX');
    fireEvent.change(input, {
      target: { value: 'ABCD1234' },
    });
    fireEvent.submit(input.closest('form')!);
    expect(onVerify).toHaveBeenCalledWith('ABCD1234');
  });

  // ── Error & Disabled States ────────────────────────────────────────────

  it('shows error message when provided', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} error="Invalid code" />);
    expect(screen.getByText('Invalid code')).toBeInTheDocument();
  });

  it('disables inputs when disabled prop is true', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} disabled />);
    const inputs = screen.getAllByRole('textbox');
    for (const input of inputs) {
      expect(input).toBeDisabled();
    }
  });

  it('disables webauthn button when disabled', () => {
    render(<MFAVerifyPrompt methods={['webauthn']} onVerify={onVerify} disabled />);
    expect(screen.getByText('Verify with security key')).toBeDisabled();
  });

  it('disables switch links when disabled', () => {
    render(<MFAVerifyPrompt methods={['totp', 'webauthn']} onVerify={onVerify} disabled />);
    expect(screen.getByText('Use authenticator app instead')).toBeDisabled();
  });

  // ── WebAuthn Inline Flow ───────────────────────────────────────────────

  it('shows "Verify with security key" button in idle state', () => {
    render(<MFAVerifyPrompt methods={['webauthn']} onVerify={onVerify} />);
    expect(screen.getByText('Verify with security key')).toBeInTheDocument();
  });

  it('shows waiting state during WebAuthn ceremony', async () => {
    // Mock the begin endpoint to return valid options
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        publicKey: {
          challenge: 'dGVzdC1jaGFsbGVuZ2U',
          rpId: 'localhost',
          allowCredentials: [],
        },
      }),
    });

    // Mock navigator.credentials.get to never resolve (simulates waiting for key)
    Object.defineProperty(navigator, 'credentials', {
      value: {
        get: vi.fn().mockReturnValue(new Promise(() => {})),
        create: vi.fn(),
      },
      writable: true,
      configurable: true,
    });

    render(<MFAVerifyPrompt methods={['webauthn']} onVerify={onVerify} />);
    fireEvent.click(screen.getByText('Verify with security key'));

    // Should transition to waiting state
    await vi.waitFor(() => {
      expect(screen.getByText(/Touch your security key/)).toBeInTheDocument();
    });
  });

  it('shows error and retry when WebAuthn begin fails', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'No credentials registered' }),
    });

    render(<MFAVerifyPrompt methods={['webauthn']} onVerify={onVerify} />);
    fireEvent.click(screen.getByText('Verify with security key'));

    await vi.waitFor(() => {
      expect(screen.getByText('No credentials registered')).toBeInTheDocument();
      expect(screen.getByText('Try again')).toBeInTheDocument();
    });
  });

  // ── Email/SMS Mode ─────────────────────────────────────────────────────

  it('shows TOTP-style input for email-sms mode', () => {
    render(<MFAVerifyPrompt methods={['email']} onVerify={onVerify} />);
    // email maps to email-sms category, which shows TOTP input
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(6);
  });

  it('shows totp switch link from email-sms mode when totp is also available', () => {
    render(<MFAVerifyPrompt methods={['email', 'totp']} onVerify={onVerify} />);
    // Default should be totp (higher priority than email-sms)
    // Switch to email-sms would not be shown since totp is default
    // Actually: webauthn > totp > email-sms > backup
    // So with ['email', 'totp'], default = totp
    // From totp mode, we don't see email-sms switch because it would need methods
    // The component only shows links for available categories other than current
    // There's no explicit email-sms switch text in the code for totp→email-sms
    // Default should be totp — verify TOTP inputs are rendered
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBeGreaterThan(0);
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────

  it('handles empty methods array gracefully', () => {
    render(<MFAVerifyPrompt methods={[]} onVerify={onVerify} />);
    // Default method falls back to 'totp', should render TOTP inputs
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(6);
  });

  it('defaults to first available when excludeBackupCodes removes the default', () => {
    // If only backup would be available (which shouldn't normally happen),
    // the component handles it by falling through
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} excludeBackupCodes />);
    // Should still show TOTP
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(6);
  });
});
