import { render, screen, fireEvent } from '../../../test-utils';
import { useSettingsStore } from '@/renderer/stores/settingsStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { mockUser } from '../../../mocks/fixtures';

// Mock apiFetch for session fetching
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ sessions: [], past_sessions: [] }),
  }),
  API_BASE: 'http://localhost:8080',
}));

// Mock LoadingSpinner
vi.mock('@/renderer/components/Auth/LoadingSpinner', () => ({
  default: ({ size, inline }: { size?: string; inline?: boolean }) => (
    <div data-testid="loading-spinner" data-size={size} data-inline={inline}>
      Loading...
    </div>
  ),
}));

import SettingsPage from '@/renderer/components/Settings/SettingsPage';

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().setTokens('mock-token', 'mock-refresh');
    useUserStore.setState({ user: mockUser });
    useSettingsStore.setState({
      appearance: {
        theme: 'dark',
        colorScheme: 'concord',
        fontSize: 'default',
        compactMode: false,
        reduceAnimations: false,
      },
    });
  });

  it('renders settings page with title', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders back button', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Back to app')).toBeInTheDocument();
  });

  it('renders navigation items', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Privacy & Security')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Voice & Audio')).toBeInTheDocument();
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
  });

  it('shows "Soon" badge for disabled sections', () => {
    render(<SettingsPage />);
    const soonBadges = screen.getAllByText('Soon');
    // Account, Notifications, Voice & Audio, Accessibility are disabled
    expect(soonBadges.length).toBe(4);
  });

  it('defaults to appearance section', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Color Scheme')).toBeInTheDocument();
    expect(screen.getByText('Theme')).toBeInTheDocument();
  });

  it('renders theme options', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('Light')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('renders font size options', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Font Size')).toBeInTheDocument();
    expect(screen.getByText('Small')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('Large')).toBeInTheDocument();
  });

  it('renders compact mode toggle', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Compact Mode')).toBeInTheDocument();
  });

  it('renders reduce animations toggle', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Reduce Animations')).toBeInTheDocument();
  });

  it('switches to privacy section on nav click', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Privacy & Security'));
    expect(screen.getByText('Active Sessions')).toBeInTheDocument();
  });

  it('changes theme on click', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Light'));
    expect(useSettingsStore.getState().appearance.theme).toBe('light');
  });

  it('changes font size on click', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Large'));
    expect(useSettingsStore.getState().appearance.fontSize).toBe('large');
  });

  it('renders color scheme options', () => {
    render(<SettingsPage />);
    // The active color scheme label should be shown
    expect(screen.getByText('Concord')).toBeInTheDocument();
  });

  it('toggles compact mode', () => {
    render(<SettingsPage />);
    const toggle = screen.getByText('Compact Mode').closest('.settings-row')?.querySelector('input[type="checkbox"]');
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle!);
    expect(useSettingsStore.getState().appearance.compactMode).toBe(true);
  });

  it('toggles reduce animations', () => {
    render(<SettingsPage />);
    const toggle = screen.getByText('Reduce Animations').closest('.settings-row')?.querySelector('input[type="checkbox"]');
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle!);
    expect(useSettingsStore.getState().appearance.reduceAnimations).toBe(true);
  });

  it('changes color scheme on click', () => {
    render(<SettingsPage />);
    // Click the Eclipse color scheme circle (second one)
    const circles = document.querySelectorAll('.color-scheme-circle');
    expect(circles.length).toBeGreaterThan(1);
    fireEvent.click(circles[1]); // Eclipse
    expect(useSettingsStore.getState().appearance.colorScheme).toBe('eclipse');
  });

  it('changes font size to small', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Small'));
    expect(useSettingsStore.getState().appearance.fontSize).toBe('small');
  });

  it('renders system theme option', () => {
    render(<SettingsPage />);
    // System theme option should be rendered but clicking it requires matchMedia
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('privacy section shows session loading state initially', async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Privacy & Security'));
    // Sessions section should exist
    expect(screen.getByText('Active Sessions')).toBeInTheDocument();
    expect(screen.getByText(/These are the devices currently logged/)).toBeInTheDocument();
  });

  it('renders sessions after loading', async () => {
    const { apiFetch } = await import('@/renderer/services/apiClient');
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [
          {
            id: 'session-1',
            device_name: 'Desktop',
            ip_address: '192.168.1.x',
            user_agent: 'Mozilla/5.0 Electron',
            expires_at: '2026-03-01T00:00:00Z',
            created_at: '2026-02-01T00:00:00Z',
            last_used: new Date().toISOString(),
            is_current: true,
          },
        ],
        past_sessions: [],
      }),
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Privacy & Security'));

    // Wait for sessions to load
    await vi.waitFor(() => {
      expect(screen.getByText('This Device')).toBeInTheDocument();
    });
    expect(screen.getByText('Concord Desktop')).toBeInTheDocument();
  });

  it('does not switch to disabled nav items', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Account'));
    // Should still show appearance section since Account is disabled
    expect(screen.getByText('Color Scheme')).toBeInTheDocument();
  });

  it('switches between appearance and privacy sections', () => {
    render(<SettingsPage />);
    // Switch to privacy
    fireEvent.click(screen.getByText('Privacy & Security'));
    expect(screen.getByText('Active Sessions')).toBeInTheDocument();
    // Switch back to appearance
    fireEvent.click(screen.getByText('Appearance'));
    expect(screen.getByText('Color Scheme')).toBeInTheDocument();
  });
});
