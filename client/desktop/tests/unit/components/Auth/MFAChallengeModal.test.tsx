import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import { vi } from 'vitest';
import { useMFAChallengeStore } from '@/renderer/stores/mfaChallengeStore';
import { resetAllStores } from '../../../helpers/store-helpers';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@/renderer/services/apiClient', () => ({
  API_BASE: 'http://localhost:8080',
  ensureMachineId: vi.fn().mockResolvedValue('mock-machine-id'),
}));

// Mock child components to isolate MFAChallengeModal behavior
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
      <button data-testid="totp-submit" disabled={disabled} onClick={() => onSubmit('123456')}>
        Submit TOTP
      </button>
      {error && <span data-testid="totp-error">{error}</span>}
    </div>
  ),
}));

vi.mock('@/renderer/components/Auth/BackupCodeInput', () => ({
  default: ({
    onSubmit,
    disabled,
    error,
  }: {
    onSubmit: (code: string) => void;
    disabled?: boolean;
    error?: string;
  }) => (
    <div data-testid="backup-input">
      <button
        data-testid="backup-submit"
        disabled={disabled}
        onClick={() => onSubmit('BACKUP1234')}
      >
        Submit Backup
      </button>
      {error && <span data-testid="backup-error">{error}</span>}
    </div>
  ),
}));

vi.mock('@/renderer/components/Auth/WebAuthnPrompt', () => ({
  default: () => <div data-testid="webauthn-prompt">WebAuthn Prompt</div>,
}));

vi.mock('@/renderer/components/Auth/MFAMethodPicker', () => {
  const React = require('react');
  const component = ({
    onSelect,
    onCancel,
  }: {
    methods: string[];
    currentMethod: string;
    onSelect: (method: string) => void;
    onCancel?: () => void;
    excludeMethods?: string[];
  }) => (
    <div data-testid="method-picker">
      <button data-testid="pick-totp" onClick={() => onSelect('totp')}>
        Pick TOTP
      </button>
      <button data-testid="pick-backup" onClick={() => onSelect('backup')}>
        Pick Backup
      </button>
      {onCancel && (
        <button data-testid="picker-cancel" onClick={onCancel}>
          Cancel Picker
        </button>
      )}
    </div>
  );

  return {
    default: component,
    getDefaultMethod: (methods: string[]) => {
      if (methods.includes('webauthn')) return 'webauthn';
      if (methods.includes('totp')) return 'totp';
      if (methods.includes('email') || methods.includes('sms')) return 'email-sms';
      return 'totp';
    },
    getAvailableCategories: (methods: string[]) => {
      const cats: string[] = [];
      if (methods.includes('webauthn')) cats.push('webauthn');
      if (methods.includes('totp')) cats.push('totp');
      if (methods.includes('email') || methods.includes('sms')) cats.push('email-sms');
      if (cats.length > 0) cats.push('backup');
      return cats;
    },
  };
});

import MFAChallengeModal from '@/renderer/components/Auth/MFAChallengeModal';

describe('MFAChallengeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllStores();
  });

  it('renders nothing when no challenge token is present', () => {
    const { container } = render(<MFAChallengeModal />);
    expect(container.innerHTML).toBe('');
  });

  it('renders modal when challenge token is set', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    expect(screen.getByText('Verify Your Identity')).toBeInTheDocument();
  });

  it('shows TOTP subtitle when in totp mode', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    expect(
      screen.getByText('Enter the 6-digit code from your authenticator app')
    ).toBeInTheDocument();
  });

  it('shows TOTP input when totp is the default method', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    expect(screen.getByTestId('totp-input')).toBeInTheDocument();
  });

  it('shows "Choose another form" when multiple methods are available', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp', 'webauthn'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    expect(screen.getByText('Choose another form of verification')).toBeInTheDocument();
  });

  it('switches to method-select when "Choose another form" is clicked', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp', 'webauthn'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByText('Choose another form of verification'));
    expect(screen.getByText('Select a verification method')).toBeInTheDocument();
    expect(screen.getByTestId('method-picker')).toBeInTheDocument();
  });

  it('switches from method-select to totp when a method is picked', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp', 'webauthn'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByText('Choose another form of verification'));
    fireEvent.click(screen.getByTestId('pick-totp'));
    expect(screen.getByTestId('totp-input')).toBeInTheDocument();
  });

  it('switches from method-select to backup when backup is picked', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp', 'webauthn'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByText('Choose another form of verification'));
    fireEvent.click(screen.getByTestId('pick-backup'));
    expect(screen.getByTestId('backup-input')).toBeInTheDocument();
  });

  it('sends TOTP verify request to server', async () => {
    const mockResolve = vi.fn();
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
      resolve: mockResolve,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByTestId('totp-submit'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/auth/mfa/verify',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"method":"totp"'),
        })
      );
    });
  });

  it('calls completeChallenge(true) on successful verification', async () => {
    const mockResolve = vi.fn();
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
      resolve: mockResolve,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByTestId('totp-submit'));

    await waitFor(() => {
      expect(mockResolve).toHaveBeenCalledWith(true);
    });
  });

  it('shows error on failed verification', async () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Invalid TOTP code' }),
    });

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByTestId('totp-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-error')).toHaveTextContent('Invalid TOTP code');
    });
  });

  it('shows generic error on network failure', async () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
    });

    mockFetch.mockRejectedValueOnce(new Error('network'));

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByTestId('totp-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-error')).toHaveTextContent(
        'Verification failed. Please try again.'
      );
    });
  });

  it('sends backup_code verify request when backup input is submitted', async () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(<MFAChallengeModal />);
    // Switch to method picker, then pick backup
    fireEvent.click(screen.getByText('Choose another form of verification'));
    fireEvent.click(screen.getByTestId('pick-backup'));
    fireEvent.click(screen.getByTestId('backup-submit'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/mfa/verify'),
        expect.objectContaining({
          body: expect.stringContaining('"method":"backup_code"'),
        })
      );
    });
  });

  it('calls clearChallenge when cancel button is clicked', () => {
    const mockResolve = vi.fn();
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
      resolve: mockResolve,
    });

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByText('Cancel'));

    // clearChallenge resolves with false
    expect(mockResolve).toHaveBeenCalledWith(false);
    // challengeToken should be cleared
    expect(useMFAChallengeStore.getState().challengeToken).toBeNull();
  });

  it('shows WebAuthn fallback when webauthn mode but no options', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['webauthn'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    expect(
      screen.getByText('WebAuthn verification will be triggered by the server challenge.')
    ).toBeInTheDocument();
  });

  it('shows email-sms subtitle and input when email method is available', () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['email'],
      recoveryOnlyMethods: [],
    });

    render(<MFAChallengeModal />);
    expect(screen.getByText('Enter the verification code sent to you')).toBeInTheDocument();
    expect(screen.getByTestId('totp-input')).toBeInTheDocument();
  });

  it('disables buttons while loading', async () => {
    useMFAChallengeStore.setState({
      challengeToken: 'test-token',
      methods: ['totp'],
      recoveryOnlyMethods: [],
    });

    // Never resolve to keep loading state
    mockFetch.mockReturnValueOnce(new Promise(() => {}));

    render(<MFAChallengeModal />);
    fireEvent.click(screen.getByTestId('totp-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-submit')).toBeDisabled();
    });
  });
});
