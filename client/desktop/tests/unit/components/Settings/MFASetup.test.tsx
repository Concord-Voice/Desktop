import { render, screen, userEvent } from '../../../test-utils';
import { vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockApiFetch = vi.fn();

vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,mockQRCode'),
  },
}));

vi.mock('@/renderer/utils/crypto', () => ({
  generateRecoveryKey: vi.fn().mockReturnValue('AAAA-BBBB-CCCC-DDDD'),
  wrapWithRecoveryKey: vi.fn().mockResolvedValue({
    wrappedKey: 'mock-wrapped-key',
    salt: 'mock-salt',
  }),
  wrapPrefsKeyWithRecoveryKey: vi.fn().mockResolvedValue({
    wrappedKey: 'mock-wrapped-prefs',
    salt: 'mock-prefs-salt',
  }),
}));

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    getWrappingKey: vi.fn().mockReturnValue('mock-wrapping-key'),
    getWrappedPrivateKey: vi.fn().mockReturnValue('mock-wrapped-private-key'),
    getPreferencesKeyBase64: vi.fn().mockReturnValue('mock-prefs-key'),
  },
}));

vi.mock('@/renderer/components/Auth/TOTPInput', () => ({
  default: ({
    onSubmit,
    disabled,
    error,
  }: {
    onSubmit: (code: string) => void;
    disabled?: boolean;
    error?: string;
  }) => (
    <div data-testid="totp-input">
      <input data-testid="totp-code-input" disabled={disabled} onChange={() => {}} />
      <button data-testid="totp-submit" disabled={disabled} onClick={() => onSubmit('123456')}>
        Verify
      </button>
      {error && <span data-testid="totp-error">{error}</span>}
    </div>
  ),
}));

vi.mock('@/renderer/components/Auth/MFAVerifyPrompt', () => ({
  default: ({
    onVerify,
    disabled,
    error,
  }: {
    methods: string[];
    onVerify: (code: string) => void;
    disabled?: boolean;
    error?: string;
    excludeBackupCodes?: boolean;
    recoveryOnlyMethods?: string[];
  }) => (
    <div data-testid="mfa-verify-prompt">
      <input
        data-testid="mfa-verify-input"
        disabled={disabled}
        onChange={(e) => onVerify(e.target.value)}
      />
      {error && <span data-testid="mfa-verify-error">{error}</span>}
    </div>
  ),
}));

vi.mock('@/renderer/components/Settings/BackupCodeDisplay', () => ({
  default: ({
    codes,
    onConfirm,
    disabled,
  }: {
    codes: string[];
    onConfirm: () => void;
    disabled?: boolean;
  }) => (
    <div data-testid="backup-code-display">
      <span data-testid="backup-codes">{codes.join(', ')}</span>
      <button data-testid="backup-confirm" onClick={onConfirm} disabled={disabled}>
        Saved My Codes
      </button>
    </div>
  ),
}));

vi.mock('@/renderer/components/Settings/RecoveryKeyDisplay', () => ({
  default: ({
    recoveryKey,
    onConfirm,
    onSkip,
    disabled,
  }: {
    recoveryKey: string;
    onConfirm: () => void;
    onSkip: () => void;
    disabled?: boolean;
  }) => (
    <div data-testid="recovery-key-display">
      <span data-testid="recovery-key">{recoveryKey}</span>
      <button data-testid="recovery-confirm" onClick={onConfirm} disabled={disabled}>
        Done
      </button>
      <button data-testid="recovery-skip" onClick={onSkip}>
        Skip
      </button>
    </div>
  ),
}));

import MFASetup from '@/renderer/components/Settings/MFASetup';

describe('MFASetup', () => {
  const onComplete = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('TOTP Flow', () => {
    it('renders TOTP setup wizard title', () => {
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Set Up Authenticator App')).toBeInTheDocument();
    });

    it('renders password input on initial step', () => {
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByPlaceholderText('Your password')).toBeInTheDocument();
    });

    it('renders continue and cancel buttons', () => {
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Continue')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('shows setup prompt for new MFA', () => {
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Enter your password to begin setup.')).toBeInTheDocument();
    });

    it('shows identity verification message when mfaActive', () => {
      render(<MFASetup method="totp" mfaActive onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Verify your identity to add another method.')).toBeInTheDocument();
    });

    it('shows MFA verify prompt when mfaActive', () => {
      render(
        <MFASetup
          method="totp"
          mfaActive
          activeMethods={['totp']}
          onComplete={onComplete}
          onCancel={onCancel}
        />
      );
      expect(screen.getByTestId('mfa-verify-prompt')).toBeInTheDocument();
    });

    it('disables Continue button when password is empty', () => {
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Continue')).toBeDisabled();
    });

    it('enables Continue button when password is entered', async () => {
      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'mypassword');
      expect(screen.getByText('Continue')).not.toBeDisabled();
    });

    it('calls onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.click(screen.getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('calls TOTP setup API with password', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          otpauth_url: 'otpauth://totp/Concord:test@example.com?secret=JBSWY3DPEHPK3PXP',
          secret: 'JBSWY3DPEHPK3PXP',
        }),
      });

      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'mypassword');
      await user.click(screen.getByText('Continue'));

      await vi.waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/api/v1/mfa/totp/setup',
          expect.objectContaining({ method: 'POST' })
        );
      });
    });

    it('advances to QR step after successful setup', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          otpauth_url: 'otpauth://totp/Concord:test@example.com?secret=JBSWY3DPEHPK3PXP',
          secret: 'JBSWY3DPEHPK3PXP',
        }),
      });

      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'mypassword');
      await user.click(screen.getByText('Continue'));

      await vi.waitFor(() => {
        expect(
          screen.getByText(
            'Scan this QR code with your authenticator app, then enter the 6-digit code below.'
          )
        ).toBeInTheDocument();
      });
    });

    it('shows manual secret entry on QR step', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          otpauth_url: 'otpauth://totp/test',
          secret: 'JBSWY3DPEHPK3PXP',
        }),
      });

      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'mypassword');
      await user.click(screen.getByText('Continue'));

      await vi.waitFor(() => {
        expect(screen.getByText("Can't scan? Enter manually")).toBeInTheDocument();
        expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
      });
    });

    it('shows error on setup failure', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Incorrect password' }),
      });

      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'wrongpassword');
      await user.click(screen.getByText('Continue'));

      await vi.waitFor(() => {
        expect(screen.getByText('Incorrect password')).toBeInTheDocument();
      });
    });

    it('advances to backup codes after TOTP verification', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ otpauth_url: 'otpauth://totp/test', secret: 'TESTSECRET' }),
      });

      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'mypassword');
      await user.click(screen.getByText('Continue'));

      await vi.waitFor(() => {
        expect(screen.getByTestId('totp-input')).toBeInTheDocument();
      });

      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ backup_codes: ['AAAA1111', 'BBBB2222', 'CCCC3333'] }),
      });

      await user.click(screen.getByTestId('totp-submit'));

      await vi.waitFor(() => {
        expect(screen.getByTestId('backup-code-display')).toBeInTheDocument();
        expect(screen.getByText('AAAA1111, BBBB2222, CCCC3333')).toBeInTheDocument();
      });
    });

    it('completes full TOTP flow through recovery key', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ otpauth_url: 'otpauth://totp/test', secret: 'TESTSECRET' }),
      });

      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'mypassword');
      await user.click(screen.getByText('Continue'));

      await vi.waitFor(() => expect(screen.getByTestId('totp-input')).toBeInTheDocument());

      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ backup_codes: ['CODE1'] }),
      });
      await user.click(screen.getByTestId('totp-submit'));

      await vi.waitFor(() => expect(screen.getByTestId('backup-code-display')).toBeInTheDocument());

      mockApiFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await user.click(screen.getByTestId('backup-confirm'));

      await vi.waitFor(() => {
        expect(screen.getByTestId('recovery-key-display')).toBeInTheDocument();
        expect(screen.getByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('recovery-confirm'));

      await vi.waitFor(() => {
        expect(screen.getByText('MFA Activated!')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Done'));
      expect(onComplete).toHaveBeenCalled();
    });

    it('skips recovery key when skip is clicked', async () => {
      mockApiFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ otpauth_url: 'otpauth://totp/test', secret: 'S' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ backup_codes: ['CODE1'] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const user = userEvent.setup();
      render(<MFASetup method="totp" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'mypassword');
      await user.click(screen.getByText('Continue'));

      await vi.waitFor(() => expect(screen.getByTestId('totp-submit')).toBeInTheDocument());
      await user.click(screen.getByTestId('totp-submit'));

      await vi.waitFor(() => expect(screen.getByTestId('backup-confirm')).toBeInTheDocument());
      await user.click(screen.getByTestId('backup-confirm'));

      await vi.waitFor(() => expect(screen.getByTestId('recovery-skip')).toBeInTheDocument());
      await user.click(screen.getByTestId('recovery-skip'));

      await vi.waitFor(() => {
        expect(screen.getByText('MFA Activated!')).toBeInTheDocument();
      });
    });
  });

  describe('WebAuthn Flow', () => {
    it('renders WebAuthn setup wizard title for hardware key', () => {
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Set Up Security Key')).toBeInTheDocument();
    });

    it('renders WebAuthn setup wizard title for platform authenticator', () => {
      render(
        <MFASetup
          method="webauthn"
          credentialType="platform"
          onComplete={onComplete}
          onCancel={onCancel}
        />
      );
      expect(screen.getByText('Set Up Platform Authenticator')).toBeInTheDocument();
    });

    it('renders password input for WebAuthn', () => {
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByPlaceholderText('Your password')).toBeInTheDocument();
    });

    it('renders key name input with hardware key placeholder', () => {
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      expect(
        screen.getByPlaceholderText('Key name (e.g. YubiKey 5, Google Titan)')
      ).toBeInTheDocument();
    });

    it('renders key name input with platform placeholder', () => {
      render(
        <MFASetup
          method="webauthn"
          credentialType="platform"
          onComplete={onComplete}
          onCancel={onCancel}
        />
      );
      expect(
        screen.getByPlaceholderText('Key name (e.g. MacBook Touch ID, Windows Hello)')
      ).toBeInTheDocument();
    });

    it('renders Register Key button', () => {
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Register Key')).toBeInTheDocument();
    });

    it('disables Register Key button when password is empty', () => {
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Register Key')).toBeDisabled();
    });

    it('enables Register Key button when password is entered', async () => {
      const user = userEvent.setup();
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'mypassword');
      expect(screen.getByText('Register Key')).not.toBeDisabled();
    });

    it('calls onCancel when cancel button is clicked in WebAuthn flow', async () => {
      const user = userEvent.setup();
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      await user.click(screen.getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('shows MFA verify prompt when mfaActive in WebAuthn flow', () => {
      render(
        <MFASetup
          method="webauthn"
          mfaActive
          activeMethods={['totp']}
          onComplete={onComplete}
          onCancel={onCancel}
        />
      );
      expect(screen.getByTestId('mfa-verify-prompt')).toBeInTheDocument();
    });

    it('shows identity verification message for WebAuthn when mfaActive', () => {
      render(<MFASetup method="webauthn" mfaActive onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Verify your identity and name your key.')).toBeInTheDocument();
    });

    it('shows password prompt for WebAuthn when not mfaActive', () => {
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      expect(screen.getByText('Enter your password and name your key.')).toBeInTheDocument();
    });

    it('shows error on WebAuthn begin failure', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Incorrect password' }),
      });

      const user = userEvent.setup();
      render(<MFASetup method="webauthn" onComplete={onComplete} onCancel={onCancel} />);
      await user.type(screen.getByPlaceholderText('Your password'), 'wrongpw');
      await user.click(screen.getByText('Register Key'));

      await vi.waitFor(() => {
        expect(screen.getByText('Incorrect password')).toBeInTheDocument();
      });
    });
  });
});
