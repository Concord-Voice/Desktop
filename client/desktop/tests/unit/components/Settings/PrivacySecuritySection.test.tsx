import { render, screen, fireEvent } from '../../../test-utils';
import { vi } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_BASE: 'http://localhost:8080',
}));
vi.mock('@/renderer/stores/authStore', () => ({
  useAuthStore: vi.fn((s) => s({ accessToken: 'mock-token' })),
}));
vi.mock('@/renderer/stores/userStore', () => ({
  useUserStore: vi.fn((s) => s({ logout: vi.fn() })),
}));
const mockFetchPrivacy = vi.fn().mockResolvedValue(undefined);
const mockUpdatePrivacy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/renderer/stores/privacyStore', () => ({
  usePrivacyStore: vi.fn((s) =>
    s({
      settings: {
        messagesFriendsOnly: true,
        messagesServerMembers: true,
        dmPrivacyLevel: 2 as const,
        dmFriendsOfFriends: false,
        autoAcceptFriendCodes: false,
        searchableByUsername: false,
        searchableByEmail: false,
        searchableByPhone: false,
        allowEmbeddedContent: false,
      },
      fetchPrivacy: mockFetchPrivacy,
      updatePrivacy: mockUpdatePrivacy,
    })
  ),
  DMPrivacyLevel: {},
}));
vi.mock('@/renderer/stores/osPermissionStore', () => ({
  useOsPermissionStore: vi.fn((s) =>
    s({
      microphone: 'granted',
      camera: 'granted',
      screen: 'granted',
      secureStorage: 'granted',
      notifications: 'granted',
      isLoaded: true,
      fetchAll: vi.fn().mockResolvedValue(undefined),
      requestOne: vi.fn().mockResolvedValue('granted'),
      openSettings: vi.fn().mockResolvedValue(undefined),
    })
  ),
}));
vi.mock('@/renderer/components/Settings/MFATierSelector', () => ({
  default: () => <div data-testid="mfa-tier-selector">MFATierSelector</div>,
  WebAuthnCredential: {},
}));
vi.mock('@/renderer/components/Settings/MFASetup', () => ({
  default: () => <div data-testid="mfa-setup">MFASetup</div>,
}));
vi.mock('@/renderer/components/Auth/MFAVerifyPrompt', () => ({
  default: () => <div data-testid="mfa-verify-prompt">MFAVerifyPrompt</div>,
}));
vi.mock('@/renderer/components/Settings/BackupCodeDisplay', () => ({
  default: () => <div data-testid="backup-code-display">BackupCodeDisplay</div>,
}));
vi.mock('@/renderer/components/Settings/EmailSmsSetup', () => ({
  default: () => <div data-testid="email-sms-setup">EmailSmsSetup</div>,
}));
vi.mock('@/renderer/components/Auth/LoadingSpinner', () => ({
  default: ({ size }: { size?: string }) => (
    <div data-testid="loading-spinner" data-size={size}>
      Loading...
    </div>
  ),
}));
vi.mock('@/renderer/components/ui/Modal', () => ({
  default: ({
    isOpen,
    children,
    onClose,
    title,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    onClose: () => void;
    title?: string;
  }) =>
    isOpen ? (
      <div data-testid="modal" role="dialog">
        {title && <h2>{title}</h2>}
        {children}
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

import PrivacySecuritySection from '@/renderer/components/Settings/PrivacySecuritySection';

describe('PrivacySecuritySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [], past_sessions: [], revocation_mode: 'secure' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          methods: [],
          recovery_only_methods: [],
          recovery_hardened: false,
          backup_codes_remaining: 0,
          backup_email: '',
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
  });

  it('renders privacy section heading', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Privacy')).toBeInTheDocument());
  });
  it('renders privacy description', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(
        screen.getByText('Control who can message you and how others can find you.')
      ).toBeInTheDocument()
    );
  });
  it('renders DM privacy labels', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Who Can DM You')).toBeInTheDocument());
    expect(screen.getByText('No One')).toBeInTheDocument();
    expect(screen.getByText('Friends')).toBeInTheDocument();
    expect(screen.getByText('Everyone')).toBeInTheDocument();
  });
  it('renders friends-of-friends toggle', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Allow Friends-of-Friends')).toBeInTheDocument()
    );
  });
  it('renders auto-accept friend codes toggle', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Auto-Accept Friend Requests from Codes')).toBeInTheDocument()
    );
  });
  it('renders search visibility settings', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Search Visibility')).toBeInTheDocument());
    expect(screen.getByText('Searchable by Username')).toBeInTheDocument();
    expect(screen.getByText('Searchable by Email')).toBeInTheDocument();
    expect(screen.getByText('Searchable by Phone Number')).toBeInTheDocument();
  });
  it('renders content safety', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Allow Embedded Content')).toBeInTheDocument());
  });
  it('toggles searchable by username', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Searchable by Username')).toBeInTheDocument());
    fireEvent.click(
      screen
        .getByText('Searchable by Username')
        .closest('.settings-row')!
        .querySelector('input[type="checkbox"]')!
    );
    expect(mockUpdatePrivacy).toHaveBeenCalledWith({ searchableByUsername: true });
  });
  it('toggles searchable by email', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Searchable by Email')).toBeInTheDocument());
    fireEvent.click(
      screen
        .getByText('Searchable by Email')
        .closest('.settings-row')!
        .querySelector('input[type="checkbox"]')!
    );
    expect(mockUpdatePrivacy).toHaveBeenCalledWith({ searchableByEmail: true });
  });
  it('toggles searchable by phone', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Searchable by Phone Number')).toBeInTheDocument()
    );
    fireEvent.click(
      screen
        .getByText('Searchable by Phone Number')
        .closest('.settings-row')!
        .querySelector('input[type="checkbox"]')!
    );
    expect(mockUpdatePrivacy).toHaveBeenCalledWith({ searchableByPhone: true });
  });
  it('toggles embedded content', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Allow Embedded Content')).toBeInTheDocument());
    fireEvent.click(
      screen
        .getByText('Allow Embedded Content')
        .closest('.settings-row')!
        .querySelector('input[type="checkbox"]')!
    );
    expect(mockUpdatePrivacy).toHaveBeenCalledWith({ allowEmbeddedContent: true });
  });
  it('toggles auto-accept friend codes', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Auto-Accept Friend Requests from Codes')).toBeInTheDocument()
    );
    fireEvent.click(
      screen
        .getByText('Auto-Accept Friend Requests from Codes')
        .closest('.settings-row')!
        .querySelector('input[type="checkbox"]')!
    );
    expect(mockUpdatePrivacy).toHaveBeenCalledWith({ autoAcceptFriendCodes: true });
  });
  it('highlights current DM privacy level', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Friends + Server')).toHaveAttribute('aria-pressed', 'true')
    );
  });
  it('renders system permissions section', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('System Permissions')).toBeInTheDocument());
  });
  it('System Permissions section is collapsed by default (#4)', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('System Permissions')).toBeInTheDocument());
    const details = screen.getByText('System Permissions').closest('details');
    expect(details?.hasAttribute('open')).toBe(false);
  });
  it('shows granted badges', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Microphone')).toBeInTheDocument());
    expect(screen.getAllByText('Granted').length).toBe(5);
  });
  it('renders MFA section', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Multi-Factor Authentication')).toBeInTheDocument()
    );
  });
  it('renders MFA description', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText(/Add an extra layer of security/)).toBeInTheDocument()
    );
  });
  it('renders security keys counter', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText(/Security Keys:/)).toBeInTheDocument());
  });
  it('renders active sessions section', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Active Sessions')).toBeInTheDocument());
  });
  it('shows session description', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText(/These are the devices currently logged/)).toBeInTheDocument()
    );
  });
  it('renders sessions from API', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's1',
              device_name: 'Desktop',
              ip_address: '192.168.1.x',
              user_agent: 'Mozilla/5.0 Electron',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: true,
            },
          ],
          past_sessions: [],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('This Device')).toBeInTheDocument());
    expect(screen.getByText('Concord Voice Desktop')).toBeInTheDocument();
  });
  it('calls fetchPrivacy on mount', () => {
    render(<PrivacySecuritySection />);
    expect(mockFetchPrivacy).toHaveBeenCalled();
  });
  it('fetches sessions on mount', () => {
    render(<PrivacySecuritySection />);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sessions');
  });
  it('fetches MFA status on mount', () => {
    render(<PrivacySecuritySection />);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/mfa/status');
  });
  it('shows session fetch error', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Failed to fetch sessions' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ methods: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Failed to fetch sessions')).toBeInTheDocument()
    );
  });

  // ── Session revocation mode ──────────────────────────────────────────────

  it('renders revocation mode toggle after loading', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Session Revocation')).toBeInTheDocument());
    expect(screen.getByText('Secure')).toBeInTheDocument();
    expect(screen.getByText('Simple')).toBeInTheDocument();
  });

  it('shows Secure mode description when revocationMode is secure', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText(/Authentication via Password or MFA is required/)).toBeInTheDocument()
    );
  });

  // ── Session with multiple sessions and Revoke All ────────────────────────

  it('renders Revoke All Sessions button when sessions exist', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's1',
              device_name: 'Desktop',
              ip_address: '1.2.3.4',
              user_agent: 'Mozilla/5.0 Electron',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: true,
            },
            {
              id: 's2',
              device_name: 'Phone',
              ip_address: '5.6.7.8',
              user_agent: 'Mozilla/5.0 Chrome',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-02-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: false,
            },
          ],
          past_sessions: [],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Revoke All Sessions')).toBeInTheDocument());
  });

  it('renders Revoke button for non-current sessions', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's1',
              device_name: 'Desktop',
              ip_address: '1.2.3.4',
              user_agent: 'Mozilla/5.0 Electron',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: true,
            },
            {
              id: 's2',
              device_name: 'Phone',
              ip_address: '5.6.7.8',
              user_agent: 'Mozilla/5.0 Chrome',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-02-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: false,
            },
          ],
          past_sessions: [],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => {
      const revokeButtons = screen.getAllByText('Revoke');
      expect(revokeButtons.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows confirmation for revoking current session', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's1',
              device_name: 'Desktop',
              ip_address: '1.2.3.4',
              user_agent: 'Mozilla/5.0 Electron',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: true,
            },
          ],
          past_sessions: [],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('This Device')).toBeInTheDocument());
    // Click Revoke on current session — should show confirmation
    fireEvent.click(screen.getAllByText('Revoke')[0]);
    await vi.waitFor(() =>
      expect(screen.getByText(/This is your current active session/)).toBeInTheDocument()
    );
  });

  // ── User agent parsing ───────────────────────────────────────────────────

  it('parses Chrome user agent', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's1',
              device_name: 'Test',
              ip_address: '1.2.3.4',
              user_agent: 'Mozilla/5.0 Chrome/100',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: false,
            },
          ],
          past_sessions: [],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Chrome Browser')).toBeInTheDocument());
  });

  it('parses Firefox user agent', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's1',
              device_name: 'Test',
              ip_address: '1.2.3.4',
              user_agent: 'Mozilla/5.0 Firefox/100',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: false,
            },
          ],
          past_sessions: [],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Firefox Browser')).toBeInTheDocument());
  });

  // ── DM privacy descriptions ──────────────────────────────────────────────

  it('renders DM privacy level description for Friends + Server', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Friends + Server Members')).toBeInTheDocument()
    );
  });

  // ── MFA status display ───────────────────────────────────────────────────

  it('shows Requires MFA for backup codes when no MFA active', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Requires MFA')).toBeInTheDocument());
  });

  it('shows backup code count when MFA is active', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [], past_sessions: [], revocation_mode: 'secure' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          methods: ['totp'],
          recovery_only_methods: [],
          recovery_hardened: false,
          backup_codes_remaining: 5,
          backup_email: '',
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('5')).toBeInTheDocument());
  });

  // ── MFA tier selector rendering ──────────────────────────────────────────

  it('renders MFATierSelector when no setup method is active', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByTestId('mfa-tier-selector')).toBeInTheDocument());
  });

  // ── Permission status badges ─────────────────────────────────────────────

  it('shows permission labels', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Microphone')).toBeInTheDocument());
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(screen.getByText('Screen Recording')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText(/Secure Storage/)).toBeInTheDocument();
  });

  it('shows permission descriptions', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() =>
      expect(screen.getByText('Used for voice channels and calls.')).toBeInTheDocument()
    );
    expect(screen.getByText('Used for video in voice channels and calls.')).toBeInTheDocument();
  });

  // ── Revoke All modal password input ──────────────────────────────────────

  // ── Permission status badge mapping ──────────────────────────────────────

  it('shows Denied badge for denied permission', async () => {
    vi.mocked(
      await import('@/renderer/stores/osPermissionStore').then((m) => m.useOsPermissionStore)
    ).mockImplementation((s) =>
      s({
        microphone: 'denied',
        camera: 'granted',
        screen: 'granted',
        secureStorage: 'granted',
        notifications: 'granted',
        isLoaded: true,
        fetchAll: vi.fn().mockResolvedValue(undefined),
        requestOne: vi.fn().mockResolvedValue('granted'),
        openSettings: vi.fn().mockResolvedValue(undefined),
      })
    );
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Denied')).toBeInTheDocument());
  });

  it('shows Restricted badge for restricted permission', async () => {
    vi.mocked(
      await import('@/renderer/stores/osPermissionStore').then((m) => m.useOsPermissionStore)
    ).mockImplementation((s) =>
      s({
        microphone: 'restricted',
        camera: 'granted',
        screen: 'granted',
        secureStorage: 'granted',
        notifications: 'granted',
        isLoaded: true,
        fetchAll: vi.fn().mockResolvedValue(undefined),
        requestOne: vi.fn().mockResolvedValue('granted'),
        openSettings: vi.fn().mockResolvedValue(undefined),
      })
    );
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Restricted')).toBeInTheDocument());
  });

  it('shows Not Requested badge for not-determined permission', async () => {
    vi.mocked(
      await import('@/renderer/stores/osPermissionStore').then((m) => m.useOsPermissionStore)
    ).mockImplementation((s) =>
      s({
        microphone: 'not-determined',
        camera: 'granted',
        screen: 'granted',
        secureStorage: 'granted',
        notifications: 'granted',
        isLoaded: true,
        fetchAll: vi.fn().mockResolvedValue(undefined),
        requestOne: vi.fn().mockResolvedValue('granted'),
        openSettings: vi.fn().mockResolvedValue(undefined),
      })
    );
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Not Requested')).toBeInTheDocument());
  });

  it('shows Unavailable badge for unavailable permission', async () => {
    vi.mocked(
      await import('@/renderer/stores/osPermissionStore').then((m) => m.useOsPermissionStore)
    ).mockImplementation((s) =>
      s({
        microphone: 'unavailable',
        camera: 'granted',
        screen: 'granted',
        secureStorage: 'granted',
        notifications: 'granted',
        isLoaded: true,
        fetchAll: vi.fn().mockResolvedValue(undefined),
        requestOne: vi.fn().mockResolvedValue('granted'),
        openSettings: vi.fn().mockResolvedValue(undefined),
      })
    );
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Unavailable')).toBeInTheDocument());
  });

  // ── Past sessions rendering ─────────────────────────────────────────────

  it('renders past sessions when they exist', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          past_sessions: [
            {
              id: 'ps1',
              device_name: 'Old Device',
              ip_address: '10.0.0.1',
              user_agent: 'Mozilla/5.0 Firefox/100',
              created_at: '2026-01-01T00:00:00Z',
              last_used: '2026-01-15T00:00:00Z',
              revoked_at: '2026-01-20T00:00:00Z',
            },
          ],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Past Sessions')).toBeInTheDocument());
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  // ── Session revoke flow (non-current) ───────────────────────────────────

  it('revokes a non-current session successfully', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's1',
              device_name: 'Desktop',
              ip_address: '1.2.3.4',
              user_agent: 'Mozilla/5.0 Electron',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: true,
            },
            {
              id: 's2',
              device_name: 'Phone',
              ip_address: '5.6.7.8',
              user_agent: 'Mozilla/5.0 Safari/600',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-02-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: false,
            },
          ],
          past_sessions: [],
          revocation_mode: 'simple',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });

    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Safari Browser')).toBeInTheDocument());

    // Mock the DELETE call for session revoke + subsequent fetchSessions
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessions: [], past_sessions: [], revocation_mode: 'simple' }),
    });

    // Click Revoke on the non-current session (second revoke button)
    const revokeButtons = screen.getAllByText('Revoke');
    fireEvent.click(revokeButtons[1]);

    await vi.waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/sessions/s2',
        expect.objectContaining({ method: 'DELETE' })
      )
    );
  });

  // ── Session revoke 403 password_required flow ───────────────────────────

  it('shows password modal on 403 password_required', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's2',
              device_name: 'Phone',
              ip_address: '5.6.7.8',
              user_agent: 'Mozilla/5.0 Chrome/100',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-02-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: false,
            },
          ],
          past_sessions: [],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });

    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Chrome Browser')).toBeInTheDocument());

    // Mock 403 response
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'password_required' }),
    });

    fireEvent.click(screen.getByText('Revoke'));

    await vi.waitFor(() => expect(screen.getByText('Verify Your Identity')).toBeInTheDocument());
  });

  // ── MFA enabled state ──────────────────────────────────────────────────

  it('shows backup code count and Reset button when MFA active', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [], past_sessions: [], revocation_mode: 'secure' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          methods: ['totp'],
          recovery_only_methods: [],
          recovery_hardened: false,
          backup_codes_remaining: 7,
          backup_email: 'test@example.com',
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });

    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
    const resetBtn = screen.getByText(/Reset/);
    expect(resetBtn).not.toBeDisabled();
  });

  it('disables Reset Codes button when no MFA is active', async () => {
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Requires MFA')).toBeInTheDocument());
    const resetBtn = screen.getByText(/Reset/);
    expect(resetBtn).toBeDisabled();
  });

  // ── DM privacy level descriptions ──────────────────────────────────────

  it('renders DM description for level 0 (No One)', async () => {
    vi.mocked(
      await import('@/renderer/stores/privacyStore').then((m) => m.usePrivacyStore)
    ).mockImplementation((s) =>
      s({
        settings: {
          messagesFriendsOnly: true,
          messagesServerMembers: true,
          dmPrivacyLevel: 0 as const,
          dmFriendsOfFriends: false,
          autoAcceptFriendCodes: false,
          searchableByUsername: false,
          searchableByEmail: false,
          searchableByPhone: false,
          allowEmbeddedContent: false,
        },
        fetchPrivacy: mockFetchPrivacy,
        updatePrivacy: mockUpdatePrivacy,
      })
    );
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText(/Hermit mode/)).toBeInTheDocument());
    expect(screen.getByText(/DMs are disabled/)).toBeInTheDocument();
  });

  // ── Revoke All modal ───────────────────────────────────────────────────

  it('opens Revoke All modal when button clicked', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 's1',
              device_name: 'Desktop',
              ip_address: '1.2.3.4',
              user_agent: 'Mozilla/5.0 Electron',
              expires_at: '2026-12-01T00:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              last_used: new Date().toISOString(),
              is_current: true,
            },
          ],
          past_sessions: [],
          revocation_mode: 'secure',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ methods: [], backup_codes_remaining: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    render(<PrivacySecuritySection />);
    await vi.waitFor(() => expect(screen.getByText('Revoke All Sessions')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Revoke All Sessions'));
    await vi.waitFor(() =>
      expect(screen.getByText(/revoke all of your active session tokens/)).toBeInTheDocument()
    );
  });
});
