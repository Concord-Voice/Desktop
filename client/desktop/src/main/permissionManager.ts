/**
 * OS Permission Manager — Main process service for checking, requesting,
 * and enforcing system-level permissions across macOS, Windows, and Linux.
 *
 * Handles: microphone, camera, screen recording, secure storage (keychain),
 * and notifications. Permission checks are always fresh from the OS — never cached.
 *
 * Architecture:
 * - All platform-specific logic lives here (main process)
 * - Renderer queries via IPC (permission:check, permission:request, etc.)
 * - Push events (permission:changed) notify the renderer of status changes
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  safeStorage,
  shell,
  systemPreferences,
} from 'electron';

// ─── Types ────────────────────────────────────────────────────────────

export type OsPermissionType =
  | 'microphone'
  | 'camera'
  | 'screen'
  | 'secureStorage'
  | 'notifications';

export type OsPermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'restricted'
  | 'unavailable';

export type OsPermissionState = Record<OsPermissionType, OsPermissionStatus>;

const PERMISSION_TYPES: OsPermissionType[] = [
  'microphone',
  'camera',
  'screen',
  'secureStorage',
  'notifications',
];

// ─── Platform Helpers ─────────────────────────────────────────────────

/** Map Electron's macOS media access status string to our enum */
function mapMacMediaStatus(
  status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
): OsPermissionStatus {
  switch (status) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'restricted':
      return 'restricted';
    case 'not-determined':
      return 'not-determined';
    default:
      return 'unavailable';
  }
}

/**
 * Map macOS notification authorization status to our enum.
 * systemPreferences.getNotificationSettings() was added in Electron 28 but
 * isn't in all type definition versions — use a runtime check.
 */
function mapMacNotificationStatus(): OsPermissionStatus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sp = systemPreferences as any;
  if (typeof sp.getNotificationSettings !== 'function') {
    return 'not-determined'; // Fallback if API unavailable
  }
  const settings = sp.getNotificationSettings();
  switch (settings.authorizationStatus) {
    case 'authorized':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'provisional':
      return 'granted'; // Provisional = quiet notifications, still allowed
    case 'not-determined':
    default:
      return 'not-determined';
  }
}

// ─── Check ────────────────────────────────────────────────────────────

export function checkPermission(type: OsPermissionType): OsPermissionStatus {
  switch (type) {
    case 'microphone':
      if (process.platform === 'darwin') {
        return mapMacMediaStatus(systemPreferences.getMediaAccessStatus('microphone'));
      }
      // Windows/Linux: Chromium handles mic access via getUserMedia — no OS-level gate
      return 'granted';

    case 'camera':
      if (process.platform === 'darwin') {
        return mapMacMediaStatus(systemPreferences.getMediaAccessStatus('camera'));
      }
      return 'granted';

    case 'screen':
      if (process.platform === 'darwin') {
        return mapMacMediaStatus(systemPreferences.getMediaAccessStatus('screen'));
      }
      // Windows/Linux: no OS-level screen recording gate
      return 'granted';

    case 'secureStorage':
      return safeStorage.isEncryptionAvailable() ? 'granted' : 'unavailable';

    case 'notifications':
      if (!Notification.isSupported()) return 'unavailable';
      if (process.platform === 'darwin') {
        return mapMacNotificationStatus();
      }
      // Win/Linux: notifications are always available without an explicit grant
      return 'granted';

    default:
      return 'unavailable';
  }
}

export function checkAllPermissions(): OsPermissionState {
  const state = {} as OsPermissionState;
  for (const type of PERMISSION_TYPES) {
    state[type] = checkPermission(type);
  }
  return state;
}

// ─── Request ──────────────────────────────────────────────────────────

export async function requestPermission(type: OsPermissionType): Promise<OsPermissionStatus> {
  switch (type) {
    case 'microphone':
      if (process.platform === 'darwin') {
        const micStatus = systemPreferences.getMediaAccessStatus('microphone');
        if (micStatus === 'granted') return 'granted';
        if (micStatus === 'denied' || micStatus === 'restricted') {
          return mapMacMediaStatus(micStatus);
        }
        if (!app.isPackaged) {
          // Dev mode: askForMediaAccess can SIGABRT when the Electron helper
          // process lacks NSMicrophoneUsageDescription in its Info.plist.
          // Return the raw status and let getUserMedia trigger the TCC prompt
          // (safe after the postinstall plist patch).
          return mapMacMediaStatus(micStatus);
        }
        // Production (packaged): askForMediaAccess works correctly because
        // forge.config.ts sets the usage descriptions in the signed bundle.
        const micGranted = await systemPreferences.askForMediaAccess('microphone');
        return micGranted ? 'granted' : 'denied';
      }
      return 'granted';

    case 'camera':
      if (process.platform === 'darwin') {
        const camStatus = systemPreferences.getMediaAccessStatus('camera');
        if (camStatus === 'granted') return 'granted';
        if (camStatus === 'denied' || camStatus === 'restricted') {
          return mapMacMediaStatus(camStatus);
        }
        if (!app.isPackaged) {
          return mapMacMediaStatus(camStatus);
        }
        const camGranted = await systemPreferences.askForMediaAccess('camera');
        return camGranted ? 'granted' : 'denied';
      }
      return 'granted';

    case 'screen':
      // macOS screen recording cannot be programmatically requested —
      // the user must toggle it manually in System Settings.
      if (process.platform === 'darwin') {
        openSystemSettings('screen');
        return checkPermission('screen');
      }
      return 'granted';

    case 'secureStorage':
      // Secure storage availability cannot be "requested" — it depends on
      // whether the OS keyring/credential manager is functional.
      return checkPermission('secureStorage');

    case 'notifications':
      // Show a minimal silent notification to trigger the macOS permission prompt.
      // On first invocation the OS presents its "allow notifications?" dialog.
      // The actual notification feature is handled by #175.
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: 'Concord Notifications',
          body: 'Desktop notifications are now enabled.',
          silent: true,
        });
        notification.show();
      } else if (process.platform === 'darwin') {
        openSystemSettings('notifications');
      }
      // Return the real authorization status after the prompt
      return checkPermission('notifications');

    default:
      return 'unavailable';
  }
}

// ─── Open System Settings ─────────────────────────────────────────────

const MAC_SETTINGS: Record<string, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
  secureStorage: 'x-apple.systempreferences:com.apple.preference.security?Privacy',
};

const WIN_SETTINGS: Record<string, string> = {
  microphone: 'ms-settings:privacy-microphone',
  camera: 'ms-settings:privacy-webcam',
  screen: 'ms-settings:privacy-broadcastgameplay',
  notifications: 'ms-settings:notifications',
  secureStorage: 'ms-settings:privacy',
};

export function openSystemSettings(type: OsPermissionType): void {
  if (process.platform === 'darwin') {
    const url = MAC_SETTINGS[type];
    if (url) shell.openExternal(url);
  } else if (process.platform === 'win32') {
    const url = WIN_SETTINGS[type];
    if (url) shell.openExternal(url);
  } else {
    // Linux: no universal settings URL — log a hint
    console.warn(
      `[PermissionManager] Linux: open your system settings to manage "${type}" permission`
    );
  }
}

// ─── IPC Registration ─────────────────────────────────────────────────

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('permission:checkAll', () => {
    return checkAllPermissions();
  });

  ipcMain.handle('permission:check', (_event, type: string) => {
    if (!PERMISSION_TYPES.includes(type as OsPermissionType)) {
      throw new Error(`Unknown permission type: ${type}`);
    }
    return checkPermission(type as OsPermissionType);
  });

  ipcMain.handle('permission:request', async (_event, type: string) => {
    if (!PERMISSION_TYPES.includes(type as OsPermissionType)) {
      throw new Error(`Unknown permission type: ${type}`);
    }
    const status = await requestPermission(type as OsPermissionType);

    // Notify renderer of the new status
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('permission:changed', { type, status });
    }

    return status;
  });

  ipcMain.handle('permission:openSettings', (_event, type: string) => {
    if (!PERMISSION_TYPES.includes(type as OsPermissionType)) {
      throw new Error(`Unknown permission type: ${type}`);
    }
    openSystemSettings(type as OsPermissionType);
  });
}
