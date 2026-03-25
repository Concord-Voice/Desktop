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
});
