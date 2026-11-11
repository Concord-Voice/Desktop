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

import { app, Notification, shell, systemPreferences } from 'electron';
import type { ConnectionRef } from '../shared/connectionIdentity';
import { CHANNEL_CLASSES } from './ipc/channelClassification';
import { registerIpc } from './ipc/registry';
import { isSecureStorageAvailable } from './secureStorage';

// ─── Types ────────────────────────────────────────────────────────────

export type OsPermissionType =
  'microphone' | 'camera' | 'screen' | 'secureStorage' | 'notifications';

export type OsPermissionStatus =
  'granted' | 'denied' | 'not-determined' | 'restricted' | 'unavailable';

export type OsPermissionState = Record<OsPermissionType, OsPermissionStatus>;

const PERMISSION_TYPES = new Set<OsPermissionType>([
  'microphone',
  'camera',
  'screen',
  'secureStorage',
  'notifications',
]);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- systemPreferences.getNotificationSettings was added in Electron 28 but is missing from older bundled type definitions; runtime-guarded below
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

function checkMacMediaOrGranted(mediaType: 'microphone' | 'camera' | 'screen'): OsPermissionStatus {
  if (process.platform === 'darwin') {
    return mapMacMediaStatus(systemPreferences.getMediaAccessStatus(mediaType));
  }
  return 'granted';
}

const PERMISSION_CHECKERS: Record<
  OsPermissionType,
  () => OsPermissionStatus | Promise<OsPermissionStatus>
> = {
  microphone: () => checkMacMediaOrGranted('microphone'),
  camera: () => checkMacMediaOrGranted('camera'),
  screen: () => checkMacMediaOrGranted('screen'),
  // 'unavailable' also covers Linux's hardcoded-key fallback (see secureStorage.ts).
  secureStorage: async () => ((await isSecureStorageAvailable()) ? 'granted' : 'unavailable'),
  notifications: () => {
    if (!Notification.isSupported()) return 'unavailable';
    // In dev mode, the Electron binary isn't a registered notification
    // provider with macOS, so getNotificationSettings() returns cached
    // stale data that won't reflect grants made via System Settings
    // until the process restarts. Since dev notifications work regardless
    // of what the API reports, skip the check entirely in dev.
    if (!app.isPackaged) return 'granted';
    if (process.platform === 'darwin') return mapMacNotificationStatus();
    return 'granted';
  },
};

export async function checkPermission(type: OsPermissionType): Promise<OsPermissionStatus> {
  const checker = PERMISSION_CHECKERS[type];
  return checker ? checker() : 'unavailable';
}

export async function checkAllPermissions(): Promise<OsPermissionState> {
  const state = {} as OsPermissionState;
  for (const type of PERMISSION_TYPES) {
    state[type] = await checkPermission(type);
  }
  return state;
}

// ─── Request ──────────────────────────────────────────────────────────

/**
 * Request macOS media access for microphone or camera.
 * Deduplicates the nearly-identical logic for both media types.
 */
async function requestMacMediaAccess(
  mediaType: 'microphone' | 'camera'
): Promise<OsPermissionStatus> {
  const status = systemPreferences.getMediaAccessStatus(mediaType);
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return mapMacMediaStatus(status);
  // Dev mode: askForMediaAccess can SIGABRT when the Electron helper
  // process lacks the usage description in its Info.plist.
  // Return the raw status and let getUserMedia trigger the TCC prompt.
  if (!app.isPackaged) return mapMacMediaStatus(status);
  // Production (packaged): askForMediaAccess works correctly because
  // forge.config.ts sets the usage descriptions in the signed bundle.
  const granted = await systemPreferences.askForMediaAccess(mediaType);
  return granted ? 'granted' : 'denied';
}

const PERMISSION_REQUESTERS: Record<OsPermissionType, () => Promise<OsPermissionStatus>> = {
  microphone: async () => {
    if (process.platform === 'darwin') return requestMacMediaAccess('microphone');
    return 'granted';
  },
  camera: async () => {
    if (process.platform === 'darwin') return requestMacMediaAccess('camera');
    return 'granted';
  },
  screen: async () => {
    // macOS screen recording cannot be programmatically requested —
    // the user must toggle it manually in System Settings.
    if (process.platform === 'darwin') {
      openSystemSettings('screen');
      return checkPermission('screen');
    }
    return 'granted';
  },
  secureStorage: async () => {
    // Secure storage availability cannot be "requested" — it depends on
    // whether the OS keyring/credential manager is functional.
    return checkPermission('secureStorage');
  },
  notifications: async () => {
    // Show a minimal silent notification to trigger the macOS permission prompt.
    // On first invocation the OS presents its "allow notifications?" dialog.
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
  },
};

export async function requestPermission(type: OsPermissionType): Promise<OsPermissionStatus> {
  const requester = PERMISSION_REQUESTERS[type];
  return requester ? requester() : 'unavailable';
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

/** Pushes to one connection's primary; a stale ref is a no-op (`sendToConnection`). */
export type ConnectionPush = (ref: ConnectionRef, channel: string, ...args: unknown[]) => unknown;

function requireKnownType(type: string): OsPermissionType {
  if (!PERMISSION_TYPES.has(type as OsPermissionType)) {
    throw new Error(`Unknown permission type: ${type}`);
  }
  return type as OsPermissionType;
}

/**
 * #86 Task 7B: every channel goes through `registerIpc`. The two reads are
 * `app-global-read`, the request and the settings deep link `app-global-mutate`
 * (foreground primary only, so a hidden view cannot raise an OS prompt). A refused
 * sender resolves `undefined`, as before. `permission:changed` goes only to the
 * requesting connection, and only while its generation is still current.
 */
export function registerIpcHandlers(push: ConnectionPush): void {
  const refused = () => undefined;
  registerIpc(
    'permission:checkAll',
    CHANNEL_CLASSES['permission:checkAll'],
    () => checkAllPermissions(),
    { refusal: refused }
  );

  registerIpc(
    'permission:check',
    CHANNEL_CLASSES['permission:check'],
    (_sender, _event, type: string) => checkPermission(requireKnownType(type)),
    { refusal: refused }
  );

  registerIpc(
    'permission:request',
    CHANNEL_CLASSES['permission:request'],
    async (sender, _event, type: string): Promise<OsPermissionStatus | undefined> => {
      const known = requireKnownType(type);
      const status = await requestPermission(known);
      push(sender.ref, 'permission:changed', { type: known, status });
      return status;
    },
    { refusal: (): Promise<OsPermissionStatus | undefined> => Promise.resolve(undefined) }
  );

  registerIpc(
    'permission:openSettings',
    CHANNEL_CLASSES['permission:openSettings'],
    (_sender, _event, type: string) => {
      openSystemSettings(requireKnownType(type));
    },
    { refusal: refused }
  );
}
