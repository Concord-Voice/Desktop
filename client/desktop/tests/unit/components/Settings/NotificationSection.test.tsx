import { render, screen, fireEvent } from '../../../test-utils';
import { vi, type Mock } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockNotificationState = {
  enabled: true,
  volume: 80,
  messageSound: true,
  mentionSound: true,
  dmSound: true,
  friendRequestSound: true,
  voiceEventSounds: true,
  suppressWhenFocused: true,
  desktopNotificationsEnabled: true,
  desktopNotifyDMs: true,
  desktopNotifyMentions: true,
  desktopNotifyAllMessages: false,
  doNotDisturb: false,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  setEnabled: vi.fn(),
  setVolume: vi.fn(),
  setMessageSound: vi.fn(),
  setMentionSound: vi.fn(),
  setDmSound: vi.fn(),
  setFriendRequestSound: vi.fn(),
  setVoiceEventSounds: vi.fn(),
  setSuppressWhenFocused: vi.fn(),
  setDesktopNotificationsEnabled: vi.fn(),
  setDesktopNotifyDMs: vi.fn(),
  setDesktopNotifyMentions: vi.fn(),
  setDesktopNotifyAllMessages: vi.fn(),
  setDoNotDisturb: vi.fn(),
  setQuietHoursEnabled: vi.fn(),
  setQuietHoursStart: vi.fn(),
  setQuietHoursEnd: vi.fn(),
};

vi.mock('@/renderer/stores/notificationStore', () => ({
  useNotificationStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { ...mockNotificationState };
    return selector ? selector(state) : state;
  }),
}));

const mockRequestOne = vi.fn();

vi.mock('@/renderer/stores/osPermissionStore', () => ({
  useOsPermissionStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      notifications: 'granted' as string,
      requestOne: mockRequestOne,
    };
    return selector ? selector(state) : state;
  }),
}));

import NotificationSection from '@/renderer/components/Settings/NotificationSection';
import { useOsPermissionStore } from '@/renderer/stores/osPermissionStore';

// Helper to override OS permission status
function setPermissionStatus(status: string) {
  (useOsPermissionStore as unknown as Mock).mockImplementation(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        notifications: status,
        requestOne: mockRequestOne,
      };
      return selector ? selector(state) : state;
    }
  );
}

describe('NotificationSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to granted by default
    setPermissionStatus('granted');
  });

  // ── Desktop Notification toggles ──────────────────────────────────

  it('renders all desktop notification toggles', () => {
    render(<NotificationSection />);
    expect(screen.getByText('Enable Desktop Notifications')).toBeInTheDocument();
    expect(screen.getByText('Direct Messages')).toBeInTheDocument();
    expect(screen.getByText('@Mentions')).toBeInTheDocument();
    expect(screen.getByText('All Messages')).toBeInTheDocument();
    expect(screen.getByText('Do Not Disturb')).toBeInTheDocument();
    expect(screen.getByText('Suppress when focused')).toBeInTheDocument();
  });

  // ── Sound toggles ────────────────────────────────────────────────

  it('renders all sound toggles', () => {
    render(<NotificationSection />);
    expect(screen.getByText('Enable Notification Sounds')).toBeInTheDocument();
    expect(screen.getByText('Message sounds')).toBeInTheDocument();
    expect(screen.getByText('Mention sounds')).toBeInTheDocument();
    expect(screen.getByText('DM sounds')).toBeInTheDocument();
    expect(screen.getByText('Friend request sounds')).toBeInTheDocument();
    expect(screen.getByText('Voice event sounds')).toBeInTheDocument();
  });

  // ── Master desktop toggle ────────────────────────────────────────

  it('master desktop toggle calls setDesktopNotificationsEnabled', () => {
    render(<NotificationSection />);
    const row = screen.getByText('Enable Desktop Notifications').closest('.settings-row');
    const checkbox = row?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInTheDocument();
    fireEvent.click(checkbox!);
    expect(mockNotificationState.setDesktopNotificationsEnabled).toHaveBeenCalledWith(
      expect.any(Boolean)
    );
  });

  // ── Volume slider ────────────────────────────────────────────────

  it('volume slider calls setVolume', () => {
    render(<NotificationSection />);
    const slider = document.querySelector('.settings-slider');
    expect(slider).toBeInTheDocument();
    fireEvent.change(slider!, { target: { value: '50' } });
    expect(mockNotificationState.setVolume).toHaveBeenCalledWith(50);
  });

  // ── Permission banner: not-determined ─────────────────────────────

  it('permission banner shows when status is not-determined', () => {
    setPermissionStatus('not-determined');
    render(<NotificationSection />);
    expect(screen.getByText('Desktop notifications require permission.')).toBeInTheDocument();
    expect(screen.getByText('Enable Notifications')).toBeInTheDocument();
  });

  // ── Permission banner: granted ────────────────────────────────────

  it('permission banner hidden when status is granted', () => {
    setPermissionStatus('granted');
    render(<NotificationSection />);
    expect(screen.queryByText('Desktop notifications require permission.')).not.toBeInTheDocument();
  });

  // ── DND toggle ────────────────────────────────────────────────────

  it('DND toggle calls setDoNotDisturb', () => {
    render(<NotificationSection />);
    const row = screen.getByText('Do Not Disturb').closest('.settings-row');
    const checkbox = row?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInTheDocument();
    fireEvent.click(checkbox!);
    expect(mockNotificationState.setDoNotDisturb).toHaveBeenCalledWith(expect.any(Boolean));
  });

  // ── Quiet Hours ───────────────────────────────────────────────────

  it('quiet hours section renders start/end time inputs when enabled', () => {
    mockNotificationState.quietHoursEnabled = true;
    render(<NotificationSection />);
    expect(screen.getByText('Start Time')).toBeInTheDocument();
    expect(screen.getByText('End Time')).toBeInTheDocument();
    const timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs.length).toBe(2);
    expect(timeInputs[0]).toHaveValue('22:00');
    expect(timeInputs[1]).toHaveValue('08:00');
    // Reset for other tests
    mockNotificationState.quietHoursEnabled = false;
  });

  it('quiet hours time inputs are hidden when disabled', () => {
    mockNotificationState.quietHoursEnabled = false;
    render(<NotificationSection />);
    expect(screen.queryByText('Start Time')).not.toBeInTheDocument();
    expect(screen.queryByText('End Time')).not.toBeInTheDocument();
  });

  // ── Permission banner: denied ──────────────────────────────────────

  it('permission banner shows denied message when status is denied', () => {
    setPermissionStatus('denied');
    render(<NotificationSection />);
    expect(
      screen.getByText('Notification permission was denied. Enable in system settings.')
    ).toBeInTheDocument();
    // The "Enable Notifications" button should NOT appear for denied state
    expect(screen.queryByText('Enable Notifications')).not.toBeInTheDocument();
  });

  // ── Enable Notifications button ────────────────────────────────────

  it('clicking Enable Notifications calls requestOne', () => {
    setPermissionStatus('not-determined');
    render(<NotificationSection />);
    const btn = screen.getByText('Enable Notifications');
    fireEvent.click(btn);
    expect(mockRequestOne).toHaveBeenCalledWith('notifications');
  });

  // ── Hint text branches ─────────────────────────────────────────────

  it('desktop notification hint shows disabled text when toggled off', () => {
    mockNotificationState.desktopNotificationsEnabled = false;
    render(<NotificationSection />);
    expect(
      screen.getByText('Disabled. No desktop notifications will be shown.')
    ).toBeInTheDocument();
    // Reset for other tests
    mockNotificationState.desktopNotificationsEnabled = true;
  });

  it('sound hint shows disabled text when toggled off', () => {
    mockNotificationState.enabled = false;
    render(<NotificationSection />);
    expect(screen.getByText('Disabled. All notification sounds are muted.')).toBeInTheDocument();
    // Reset for other tests
    mockNotificationState.enabled = true;
  });

  it('DND hint shows enabled text', () => {
    mockNotificationState.doNotDisturb = true;
    render(<NotificationSection />);
    expect(screen.getByText('Enabled. All notifications are suppressed.')).toBeInTheDocument();
    // Reset for other tests
    mockNotificationState.doNotDisturb = false;
  });

  it('quiet hours hint shows enabled text', () => {
    mockNotificationState.quietHoursEnabled = true;
    render(<NotificationSection />);
    expect(
      screen.getByText('Enabled. Notifications are suppressed during the configured time window.')
    ).toBeInTheDocument();
    // Reset for other tests
    mockNotificationState.quietHoursEnabled = false;
  });

  it('suppress when focused hint shows disabled text when toggled off', () => {
    mockNotificationState.suppressWhenFocused = false;
    render(<NotificationSection />);
    expect(
      screen.getByText('Disabled. Sounds and notifications play even when the app is focused.')
    ).toBeInTheDocument();
    mockNotificationState.suppressWhenFocused = true;
  });

  it('quiet hours time inputs call setters on change', () => {
    mockNotificationState.quietHoursEnabled = true;
    render(<NotificationSection />);
    const timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs.length).toBe(2);
    fireEvent.change(timeInputs[0], { target: { value: '23:00' } });
    expect(mockNotificationState.setQuietHoursStart).toHaveBeenCalledWith('23:00');
    fireEvent.change(timeInputs[1], { target: { value: '07:00' } });
    expect(mockNotificationState.setQuietHoursEnd).toHaveBeenCalledWith('07:00');
    mockNotificationState.quietHoursEnabled = false;
  });
});
