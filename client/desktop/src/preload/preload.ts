import { contextBridge, ipcRenderer } from 'electron';
import { SENTRY_DSN } from '../shared/sentry-config.generated';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
// Desktop source info for screen share picker
export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string; // data URL
  appIcon: string | null; // data URL
}

export type PermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'restricted'
  | 'unavailable';

contextBridge.exposeInMainWorld('electron', {
  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
  // Reserved for Tier 3 remote SPA — the remote renderer calls this to verify
  // compatibility with the shell's IPC contract version before using newer APIs.
  getIpcContract: () => ipcRenderer.invoke('app:getIpcContract') as Promise<number>,

  // Media: screen capture sources for voice/video screen share
  getDesktopSources: () =>
    ipcRenderer.invoke('media:getDesktopSources') as Promise<DesktopSource[]>,

  // Clipboard (navigator.clipboard.writeText is blocked in Electron renderers)
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),

  // GPU, display info & hardware acceleration
  getGPUInfo: () =>
    ipcRenderer.invoke('gpu:getInfo') as Promise<{ vendor: string; device: string } | null>,
  getDisplayInfo: () =>
    ipcRenderer.invoke('screen:getDisplayInfo') as Promise<
      {
        width: number;
        height: number;
        refreshRate: number;
        scaleFactor: number;
        isPrimary: boolean;
        colorDepth: number;
        colorSpace: string;
      }[]
    >,
  getHardwareAcceleration: () =>
    ipcRenderer.invoke('app:getHardwareAcceleration') as Promise<boolean>,
  setHardwareAcceleration: (enabled: boolean) =>
    ipcRenderer.invoke('app:setHardwareAcceleration', enabled),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // PiP (Picture-in-Picture) windows
  openPipWindow: (opts: { id: string; width?: number; height?: number; title?: string }) =>
    ipcRenderer.invoke('pip:open', opts),
  closePipWindow: (id: string) => ipcRenderer.invoke('pip:close', { id }),
  setPipAlwaysOnTop: (id: string, flag: boolean) =>
    ipcRenderer.invoke('pip:setAlwaysOnTop', { id, flag }),
  onPipClosed: (callback: (id: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data.id);
    ipcRenderer.on('pip:closed', handler);
    return () => {
      ipcRenderer.removeListener('pip:closed', handler);
    };
  },

  // Secure auth token management (safeStorage via main process)
  storeRefreshToken: (data: { refreshToken: string; rememberMe: boolean; apiBase: string }) =>
    ipcRenderer.invoke('auth:storeRefreshToken', data),
  restoreSession: () =>
    ipcRenderer.invoke('auth:restoreSession') as Promise<{
      status: string;
      accessToken?: string;
      sessionId?: string;
      e2eeKeys?: {
        wrappingKeyBase64: string;
        preferencesKeyBase64: string;
        wrappedPrivateKeyBase64: string;
      } | null;
    }>,
  refreshToken: () =>
    ipcRenderer.invoke('auth:refreshToken') as Promise<{
      status: string;
      accessToken?: string;
      sessionId?: string;
      mfaChallengeToken?: string;
      mfaMethods?: string[];
      mfaRecoveryOnlyMethods?: string[];
    }>,
  clearTokens: () => ipcRenderer.invoke('auth:clearTokens'),
  logout: (data?: { accessToken?: string }) => ipcRenderer.invoke('auth:logout', data),
  getAuthCapabilities: () =>
    ipcRenderer.invoke('auth:getCapabilities') as Promise<{ persistAvailable: boolean }>,

  // E2EE key persistence (safeStorage via main process)
  storeE2EEKeys: (data: {
    wrappingKeyBase64: string;
    preferencesKeyBase64: string;
    wrappedPrivateKeyBase64: string;
  }) => ipcRenderer.invoke('auth:storeE2EEKeys', data),

  // Proactive token refresh event (#254): main process pushes new access token
  // when its timer or sleep/wake handler refreshes proactively.
  onTokenRefreshed: (callback: (data: { accessToken: string; sessionId?: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { accessToken: string; sessionId?: string }
    ) => callback(data);
    ipcRenderer.on('auth:token-refreshed', handler);
    return () => {
      ipcRenderer.removeListener('auth:token-refreshed', handler);
    };
  },

  // Machine ID for token theft detection (#89)
  getMachineId: () => ipcRenderer.invoke('auth:getMachineId') as Promise<string>,

  // System info for About page (#155 Tier 4)
  getSystemInfo: () =>
    ipcRenderer.invoke('app:getSystemInfo') as Promise<{
      platform: string;
      arch: string;
      electronVersion: string;
      chromiumVersion: string;
      nodeVersion: string;
    }>,

  // Developer Mode (REMOVE BEFORE BETA)
  getDeveloperMode: () => ipcRenderer.invoke('app:getDeveloperMode') as Promise<boolean>,
  setDeveloperMode: (enabled: boolean) =>
    ipcRenderer.invoke('app:setDeveloperMode', enabled) as Promise<void>,

  // Auto-update (#155)
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getAllowPrerelease: () => ipcRenderer.invoke('update:getAllowPrerelease') as Promise<boolean>,
  setAllowPrerelease: (enabled: boolean) =>
    ipcRenderer.invoke('update:setAllowPrerelease', enabled),
  onUpdateAvailable: (
    callback: (info: { version: string; releaseNotes?: string; releaseDate?: string }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { version: string; releaseNotes?: string; releaseDate?: string }
    ) => callback(data);
    ipcRenderer.on('update:available', handler);
    return () => {
      ipcRenderer.removeListener('update:available', handler);
    };
  },
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { version: string }) =>
      callback(data);
    ipcRenderer.on('update:not-available', handler);
    return () => {
      ipcRenderer.removeListener('update:not-available', handler);
    };
  },
  onUpdateDownloadProgress: (
    callback: (progress: {
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { percent: number; transferred: number; total: number; bytesPerSecond: number }
    ) => callback(data);
    ipcRenderer.on('update:download-progress', handler);
    return () => {
      ipcRenderer.removeListener('update:download-progress', handler);
    };
  },
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { version: string }) =>
      callback(data);
    ipcRenderer.on('update:downloaded', handler);
    return () => {
      ipcRenderer.removeListener('update:downloaded', handler);
    };
  },
  onUpdateError: (callback: (error: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) =>
      callback(data);
    ipcRenderer.on('update:error', handler);
    return () => {
      ipcRenderer.removeListener('update:error', handler);
    };
  },
  onUpdateRollback: (
    callback: (data: { fromVersion: string; toVersion: string; message: string }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { fromVersion: string; toVersion: string; message: string }
    ) => callback(data);
    ipcRenderer.on('update:rollback', handler);
    return () => {
      ipcRenderer.removeListener('update:rollback', handler);
    };
  },
  getUpdateLogPath: () => ipcRenderer.invoke('update:getLogPath') as Promise<string | null>,

  // OS permission management (#197)
  checkAllPermissions: () =>
    ipcRenderer.invoke('permission:checkAll') as Promise<Record<string, PermissionStatus>>,
  checkPermission: (type: string) =>
    ipcRenderer.invoke('permission:check', type) as Promise<PermissionStatus>,
  requestPermission: (type: string) =>
    ipcRenderer.invoke('permission:request', type) as Promise<PermissionStatus>,
  openPermissionSettings: (type: string) =>
    ipcRenderer.invoke('permission:openSettings', type) as Promise<void>,
  onPermissionChanged: (callback: (data: { type: string; status: PermissionStatus }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        type: string;
        status: PermissionStatus;
      }
    ) => callback(data);
    ipcRenderer.on('permission:changed', handler);
    return () => {
      ipcRenderer.removeListener('permission:changed', handler);
    };
  },

  // Desktop notification helpers (#175)
  setBadgeCount: (count: number) => ipcRenderer.invoke('app:setBadgeCount', count),
  flashFrame: (flash: boolean) => ipcRenderer.invoke('app:flashFrame', flash),
  focusWindow: () => ipcRenderer.invoke('app:focusWindow'),

  // Telemetry consent (#618)
  getConsentState: () =>
    ipcRenderer.invoke('consent:getState') as Promise<{
      telemetryOptIn: boolean;
      firstPromptCompleted: boolean;
      policyAcknowledgedVersion: number;
      pendingReConsent: boolean;
      updatedAt: string | null;
    }>,
  setConsentState: (updates: {
    telemetryOptIn?: boolean;
    firstPromptCompleted?: boolean;
    policyAcknowledgedVersion?: number;
    pendingReConsent?: boolean;
  }) => ipcRenderer.invoke('consent:setState', updates) as Promise<void>,
  onConsentChanged: (
    callback: (state: {
      telemetryOptIn: boolean;
      firstPromptCompleted: boolean;
      policyAcknowledgedVersion: number;
      pendingReConsent: boolean;
      updatedAt: string | null;
    }) => void
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) =>
      callback(data);
    ipcRenderer.on('consent:changed', handler);
    return () => {
      ipcRenderer.removeListener('consent:changed', handler);
    };
  },

  onConsentRevoked: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('sentry:consentRevoked', handler);
    return () => {
      ipcRenderer.removeListener('sentry:consentRevoked', handler);
    };
  },

  onConsentRestored: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('sentry:consentRestored', handler);
    return () => {
      ipcRenderer.removeListener('sentry:consentRestored', handler);
    };
  },

  // Sentry config (read-only — consent gating happens at runtime via onConsentChanged)
  // Renderer Sentry starts disabled; App.tsx toggles it after consent hydration.
  // We cannot read the consent file here because `electron.app` is unavailable
  // in the preload context when sandbox is enabled.
  sentry: (() => {
    const env =
      process.env.SENTRY_ENVIRONMENT ||
      process.env.NODE_ENV ||
      (process.defaultApp ? 'development' : 'production');
    const enabled =
      process.env.SENTRY_ENABLED == null
        ? false // Always disabled at preload time; consent gate toggles at runtime
        : process.env.SENTRY_ENABLED.toLowerCase() === 'true';
    return { dsn: SENTRY_DSN, environment: env, enabled };
  })(),

  // Returns the main-process clientId (anonymized host identifier) so
  // renderer events carry the same user.id as main-process events.
  getClientId: () => ipcRenderer.invoke('sentry:getClientId') as Promise<string>,

  // Post-login: upgrade the main-process Sentry user.id from the per-launch
  // random fallback to the stable userUUID+hardware hash. See
  // client/desktop/src/main/sentry.ts for the upgrade lifecycle rationale.
  upgradeSentryUser: (userUUID: string) => ipcRenderer.invoke('sentry:upgradeUser', userUUID),
  onClientIdUpgraded: (callback: (clientId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { clientId: string }) =>
      callback(data.clientId);
    ipcRenderer.on('sentry:clientIdUpgraded', handler);
    return () => {
      ipcRenderer.removeListener('sentry:clientIdUpgraded', handler);
    };
  },
});

// Type definitions for the exposed API
export interface ElectronAPI {
  getVersion: () => Promise<string>;
  getPlatform: () => Promise<string>;
  /** Tier 3 remote SPA: query the shell's IPC contract version for compatibility. */
  getIpcContract: () => Promise<number>;
  getDesktopSources: () => Promise<DesktopSource[]>;
  writeClipboard: (text: string) => Promise<void>;
  getGPUInfo: () => Promise<{ vendor: string; device: string } | null>;
  getDisplayInfo: () => Promise<
    {
      width: number;
      height: number;
      refreshRate: number;
      scaleFactor: number;
      isPrimary: boolean;
      colorDepth: number;
      colorSpace: string;
    }[]
  >;
  getHardwareAcceleration: () => Promise<boolean>;
  setHardwareAcceleration: (enabled: boolean) => Promise<void>;
  relaunchApp: () => Promise<void>;
  quitApp: () => Promise<void>;
  openPipWindow: (opts: {
    id: string;
    width?: number;
    height?: number;
    title?: string;
  }) => Promise<void>;
  closePipWindow: (id: string) => Promise<void>;
  setPipAlwaysOnTop: (id: string, flag: boolean) => Promise<void>;
  onPipClosed: (callback: (id: string) => void) => () => void;

  // Secure auth token management
  storeRefreshToken: (data: {
    refreshToken: string;
    rememberMe: boolean;
    apiBase: string;
  }) => Promise<void>;
  restoreSession: () => Promise<{
    status: string;
    accessToken?: string;
    sessionId?: string;
    e2eeKeys?: {
      wrappingKeyBase64: string;
      preferencesKeyBase64: string;
      wrappedPrivateKeyBase64: string;
    } | null;
  }>;
  refreshToken: () => Promise<{
    status: string;
    accessToken?: string;
    sessionId?: string;
    mfaChallengeToken?: string;
    mfaMethods?: string[];
    mfaRecoveryOnlyMethods?: string[];
  }>;
  clearTokens: () => Promise<void>;
  logout: (data?: { accessToken?: string }) => Promise<void>;
  getAuthCapabilities: () => Promise<{ persistAvailable: boolean }>;

  // E2EE key persistence
  storeE2EEKeys: (data: {
    wrappingKeyBase64: string;
    preferencesKeyBase64: string;
    wrappedPrivateKeyBase64: string;
  }) => Promise<void>;

  // Proactive token refresh event (#254)
  onTokenRefreshed: (
    callback: (data: { accessToken: string; sessionId?: string }) => void
  ) => () => void;

  // Machine ID for token theft detection
  getMachineId: () => Promise<string>;

  // System info for About page (#155 Tier 4)
  getSystemInfo: () => Promise<{
    platform: string;
    arch: string;
    electronVersion: string;
    chromiumVersion: string;
    nodeVersion: string;
  }>;

  // Developer Mode (REMOVE BEFORE BETA)
  getDeveloperMode: () => Promise<boolean>;
  setDeveloperMode: (enabled: boolean) => Promise<void>;

  // Auto-update (#155)
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<string[]>;
  installUpdate: () => Promise<void>;
  getAllowPrerelease: () => Promise<boolean>;
  setAllowPrerelease: (enabled: boolean) => Promise<void>;
  onUpdateAvailable: (
    callback: (info: { version: string; releaseNotes?: string; releaseDate?: string }) => void
  ) => () => void;
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => () => void;
  onUpdateDownloadProgress: (
    callback: (progress: {
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }) => void
  ) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  onUpdateError: (callback: (error: { message: string }) => void) => () => void;
  onUpdateRollback: (
    callback: (data: { fromVersion: string; toVersion: string; message: string }) => void
  ) => () => void;
  getUpdateLogPath: () => Promise<string | null>;

  // OS permission management (#197)
  checkAllPermissions: () => Promise<Record<string, PermissionStatus>>;
  checkPermission: (type: string) => Promise<PermissionStatus>;
  requestPermission: (type: string) => Promise<PermissionStatus>;
  openPermissionSettings: (type: string) => Promise<void>;
  onPermissionChanged: (
    callback: (data: { type: string; status: PermissionStatus }) => void
  ) => () => void;

  // Desktop notification helpers (#175)
  setBadgeCount: (count: number) => Promise<void>;
  flashFrame: (flash: boolean) => Promise<void>;
  focusWindow: () => Promise<void>;

  // Telemetry consent (#618)
  getConsentState: () => Promise<{
    telemetryOptIn: boolean;
    firstPromptCompleted: boolean;
    policyAcknowledgedVersion: number;
    pendingReConsent: boolean;
    updatedAt: string | null;
  }>;
  setConsentState: (updates: {
    telemetryOptIn?: boolean;
    firstPromptCompleted?: boolean;
    policyAcknowledgedVersion?: number;
    pendingReConsent?: boolean;
  }) => Promise<void>;
  onConsentChanged: (
    callback: (state: {
      telemetryOptIn: boolean;
      firstPromptCompleted: boolean;
      policyAcknowledgedVersion: number;
      pendingReConsent: boolean;
      updatedAt: string | null;
    }) => void
  ) => () => void;
  onConsentRevoked: (callback: () => void) => () => void;
  onConsentRestored: (callback: () => void) => () => void;

  // Sentry config
  sentry: {
    dsn: string;
    environment: string;
    enabled: boolean;
  };
  getClientId: () => Promise<string>;
  upgradeSentryUser: (userUUID: string) => Promise<void>;
  onClientIdUpgraded: (callback: (clientId: string) => void) => () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var electron: ElectronAPI;
  interface Window {
    electron: ElectronAPI;
  }
}
