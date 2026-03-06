import { render, screen, fireEvent } from '../../../test-utils';

// Mock apiFetch for WebAuthn flows
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn(),
  API_BASE: 'http://localhost:8080',
}));

import MFAVerifyPrompt from '@/renderer/components/Auth/MFAVerifyPrompt';

describe('MFAVerifyPrompt', () => {
  const onVerify = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('hides backup code option when excludeBackupCodes is true', () => {
    render(
      <MFAVerifyPrompt methods={['totp']} onVerify={onVerify} excludeBackupCodes />
    );
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

  it('shows error message when provided', () => {
    render(
      <MFAVerifyPrompt methods={['totp']} onVerify={onVerify} error="Invalid code" />
    );
    expect(screen.getByText('Invalid code')).toBeInTheDocument();
  });

  it('disables inputs when disabled prop is true', () => {
    render(<MFAVerifyPrompt methods={['totp']} onVerify={onVerify} disabled />);
    const inputs = screen.getAllByRole('textbox');
    for (const input of inputs) {
      expect(input).toBeDisabled();
    }
  });

  it('shows webauthn switch from totp mode', () => {
    render(<MFAVerifyPrompt methods={['totp', 'webauthn']} onVerify={onVerify} />);
    // Default is webauthn; switch to totp first
    fireEvent.click(screen.getByText('Use authenticator app instead'));
    // Now should see option to switch back to webauthn
    expect(screen.getByText('Use a security key instead')).toBeInTheDocument();
  });
});
