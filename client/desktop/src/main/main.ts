import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  session,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {
  storeRefreshToken,
  restoreRefreshToken,
  performRefresh,
  performLogout,
  clearTokens,
  getCapabilities,
  storeE2EEKeys,
  restoreE2EEKeys,
  setProactiveRefreshCallback,
  onSystemResume,
} from './tokenManager';
import { getMachineId } from './machineId';
import {
  initAutoUpdater,
  stopAutoUpdater,
  setUpdateFeedUrl,
  checkForUpdates,
  downloadUpdate,
  safeQuitAndInstall,
  getAllowPrerelease,
  setAllowPrerelease,
  getUpdateLogger,
  getUpdateLogPath,
} from './updater';
import {
  checkUpdateSentinel,
  finalizeUpdate,
  finalizeRollback,
  runDeferredCleanup,
  type SentinelResult,
} from './updateSafety';
import { resolveSpaSource } from './spaLoader';
import { IPC_CONTRACT_VERSION } from './ipcContract';
import { registerIpcHandlers as registerPermissionHandlers } from './permissionManager';
import { migrateUserData } from './userDataMigration';
import { showSplash, closeSplash, updateSplashError } from './splashWindow';

// One-time migration: rename "Concord Voice" → "ConcordVoice" userData directory (#385).
// Must run before any app.getPath('userData') reads (e.g. hw-accel prefs below).
migrateUserData();

// Hardware acceleration preference — must be checked before app.whenReady()
const hwAccelPrefPath = path.join(app.getPath('userData'), 'hw-accel.json');
function readHwAccelPref(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(hwAccelPrefPath, 'utf-8'));
    return data.enabled !== false;
  } catch {
    return true; // Default: enabled
  }
}

if (readHwAccelPref()) {
  // Hardware acceleration flags for video encode/decode (IGNIS insight: fastest preset wins)
  app.commandLine.appendSwitch(
    'enable-features',
    'AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL'
  );
} else {
  app.disableHardwareAcceleration();
}

// Allow autoplay for all media — Concord is a real-time communication app that
// dynamically creates <audio>/<video> elements for voice/video calls.  The default
// 'document-user-activation-required' policy can silently block these elements.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let remoteSpaBaseUrl: string | null = null; // Set when loading remote SPA, used by PiP + navigation guard

const createWindow = async (): Promise<void> => {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1a1a',
    show: false, // Don't show until ready
  });

  const bundledPath = path.join(__dirname, '../renderer/index.html');

  // Register before loading any URL — ready-to-show fires during loadURL
  // and the listener must be attached first to avoid a race condition where
  // the event fires before the handler is registered (window never shows).
  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow?.show();
  });

  if (app.isPackaged) {
    // Tier 3: Attempt remote SPA loading with compatibility check.
    // Falls back to bundled renderer on any failure.
    const decision = await resolveSpaSource();
    console.log(`[SpaLoader] ${decision.mode}: ${decision.reason}`);

    if (decision.mode === 'remote' && decision.url) {
      try {
        remoteSpaBaseUrl = decision.url;
        await mainWindow.loadURL(decision.url);
      } catch {
        console.warn('[SpaLoader] Failed to load remote SPA, falling back to bundled');
        remoteSpaBaseUrl = null;
        await mainWindow.loadFile(bundledPath);
      }
    } else {
      await mainWindow.loadFile(bundledPath);
    }
  } else {
    // Development: try Vite dev server, fall back to bundled
    const devServerUrl = 'http://localhost:3001';
    const http = await import('node:http');
    const httpGet = (http.default?.get ?? http.get) as typeof import('node:http').get;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpGet(devServerUrl, { timeout: 1000 }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      await mainWindow.loadURL(devServerUrl);
      if (process.env.DEVTOOLS !== '0') {
        mainWindow.webContents.openDevTools();
      }
    } catch {
      await mainWindow.loadFile(bundledPath);
    }
  }

  // Open external links in browser (validate protocol to prevent code injection)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      }
    } catch {
      // Invalid URL, ignore
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Log renderer crashes to diagnose voice join segfaults
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[MAIN] Renderer process gone:', details.reason, 'exitCode:', details.exitCode);
  });
};

// Track rollback result so we can notify the renderer after window creation
let rollbackResult: SentinelResult | null = null;

// App lifecycle handlers
app.whenReady().then(() => {
  // Permission request handler: explicitly allow app-required permissions, deny risky ones.
  // Notifications are allowed (JIT-managed by permissionManager #197).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const denied = ['geolocation'];
    if (denied.includes(permission)) {
      callback(false);
      return;
    }
    callback(true);
  });

  // Permission check handler: Chromium queries this synchronously to verify grants.
  // Default to true so internal checks (e.g. WebAuthn/FIDO2) aren't silently blocked.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const denied = ['geolocation'];
    return !denied.includes(permission);
  });

  // Device permission handler: allow camera, microphone, speaker, and HID (security keys)
  session.defaultSession.setDevicePermissionHandler((details) => {
    return ['camera', 'microphone', 'speaker', 'hid'].includes(details.deviceType ?? '');
  });

  // HID device selection: auto-select for WebAuthn hardware security keys
  session.defaultSession.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    if (details.deviceList && details.deviceList.length > 0) {
      callback(details.deviceList[0].deviceId);
    } else {
      callback('');
    }
  });

  // OS permission management (#197) — JIT prompting replaces proactive startup requests.
  // Camera/mic/screen/notifications are requested when the feature is first used.
  registerPermissionHandlers(() => mainWindow);

  // ─── Update safety: startup validation (#384) ─────────────────────
  // Must run before createWindow() so we can stash rollback info,
  // but after initAutoUpdater() so the logger is available.
  initAutoUpdater(() => mainWindow);

  const updateLogger = getUpdateLogger();
  if (updateLogger) {
    // Check for deferred cleanup from a previous incomplete finalization
    runDeferredCleanup(updateLogger).catch(() => {});

    const sentinelResult = checkUpdateSentinel(updateLogger);
    if (sentinelResult.type === 'success') {
      updateLogger.info(
        `Update validated: v${sentinelResult.fromVersion} → v${sentinelResult.toVersion}`
      );
      finalizeUpdate(updateLogger, sentinelResult).catch((err) => {
        updateLogger.error(`Post-update cleanup failed: ${(err as Error).message}`);
      });
    } else if (sentinelResult.type === 'rollback') {
      updateLogger.warn(
        `Update to v${sentinelResult.toVersion} failed, rolled back to v${sentinelResult.fromVersion}`
      );
      finalizeRollback(updateLogger, sentinelResult).catch((err) => {
        updateLogger.error(`Rollback cleanup failed: ${(err as Error).message}`);
      });
      rollbackResult = sentinelResult;
    }
  }

  // Show branded splash while the main window loads (#387)
  if (app.isPackaged) {
    const iconPath = path.join(app.getAppPath(), 'build', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    showSplash(icon.isEmpty() ? undefined : icon.toDataURL());

    // If a rollback was detected, show error state on the splash while main window loads
    if (rollbackResult) {
      updateSplashError(
        `Update to v${rollbackResult.toVersion} failed — rolled back to v${rollbackResult.fromVersion}`
      );
    }
  }

  createWindow();

  // Notify renderer of rollback after window is created (#384)
  if (rollbackResult) {
    // Delay slightly to ensure renderer IPC listeners are registered
    setTimeout(() => {
      mainWindow?.webContents.send('update:rollback', {
        fromVersion: rollbackResult!.fromVersion,
        toVersion: rollbackResult!.toVersion,
        message: `Update to v${rollbackResult!.toVersion} failed. You are still on v${rollbackResult!.fromVersion}.`,
      });
    }, 2000);
  }

  // Proactive token refresh (#254): notify renderer when main process
  // refreshes the token (timer or sleep/wake), so authStore stays current.
  setProactiveRefreshCallback((accessToken, sessionId) => {
    mainWindow?.webContents.send('auth:token-refreshed', { accessToken, sessionId });
  });

  // Refresh token immediately on system wake — main process timers may have
  // drifted past the token's expiry window during sleep (#248).
  powerMonitor.on('resume', () => {
    onSystemResume();
  });

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up scheduled update checks on quit; flush update log (#383)
app.on('before-quit', () => {
  const ul = getUpdateLogger();
  ul?.info('Application quitting');
  ul?.flush();
  stopAutoUpdater();
});

// Crash-safe logging: flush update log before unhandled exceptions terminate the process (#383).
// Registering this listener disables Node's default crash behavior, so we must exit explicitly.
process.on('uncaughtException', (error) => {
  const ul = getUpdateLogger();
  ul?.error(`Uncaught exception: ${error.message}\n${error.stack ?? ''}`);
  ul?.flush();
  setImmediate(() => app.exit(1));
});

// IPC Handlers
ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('app:getPlatform', () => {
  return process.platform;
});

ipcMain.handle('app:getIpcContract', () => {
  return IPC_CONTRACT_VERSION;
});

// Screen capture sources for voice/video screen share picker (#44)
ipcMain.handle('media:getDesktopSources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon?.toDataURL() || null,
  }));
});

// Clipboard write (navigator.clipboard.writeText is blocked in Electron)
ipcMain.handle('clipboard:writeText', (_event, text: string) => {
  clipboard.writeText(text);
});

// GPU info
const GPU_VENDORS: Record<number, string> = {
  0x106b: 'Apple',
  0x8086: 'Intel',
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x5143: 'Qualcomm',
  0x13b5: 'ARM',
};

ipcMain.handle('gpu:getInfo', async () => {
  try {
    const info = await app.getGPUInfo('basic');
    const gpu = (
      info as {
        gpuDevice?: Array<{
          vendorId: number;
          deviceId: number;
          driverVendor?: string;
          driverDescription?: string;
        }>;
      }
    ).gpuDevice?.[0];
    if (gpu) {
      // driverVendor on macOS often contains the hex vendorId as a string — skip it
      const driverName =
        gpu.driverVendor && !/^0x[0-9a-f]+$/i.test(gpu.driverVendor) ? gpu.driverVendor : '';
      const vendor =
        driverName || GPU_VENDORS[gpu.vendorId] || `Unknown (0x${gpu.vendorId.toString(16)})`;
      const device =
        gpu.driverDescription || (gpu.deviceId ? `Device 0x${gpu.deviceId.toString(16)}` : '');
      return { vendor, device };
    }
    return null;
  } catch {
    return null;
  }
});

// Display info for resolution/refresh rate awareness
ipcMain.handle('screen:getDisplayInfo', () => {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return displays.map((d) => ({
    width: d.size.width * d.scaleFactor,
    height: d.size.height * d.scaleFactor,
    refreshRate: d.displayFrequency,
    scaleFactor: d.scaleFactor,
    isPrimary: d.id === primary.id,
    colorDepth: d.colorDepth, // 24 = SDR, 30/48 = HDR
    colorSpace: d.colorSpace, // "srgb" = SDR, "p3"/"rec2020" = wide gamut
  }));
});

// Hardware acceleration preference
ipcMain.handle('app:getHardwareAcceleration', () => readHwAccelPref());

ipcMain.handle('app:setHardwareAcceleration', (_event, enabled: boolean) => {
  fs.writeFileSync(hwAccelPrefPath, JSON.stringify({ enabled }), 'utf-8');
});

// Relaunch (for hardware acceleration toggle)
ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.quit();
});

// Clean app exit (preserves persisted auth/remember-me state)
ipcMain.handle('app:quit', () => {
  app.quit();
});

// ─── Desktop Notification Helpers (#175) ────────────────────────────

ipcMain.handle('app:setBadgeCount', (_event, count: number) => {
  app.setBadgeCount(count);
});

ipcMain.handle('app:flashFrame', (_event, flash: boolean) => {
  mainWindow?.flashFrame(flash);
});

ipcMain.handle('app:focusWindow', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ─── Auto-Update IPC ──────────────────────────────────────────────────

ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('update:download', () => downloadUpdate());
ipcMain.handle('update:install', () => safeQuitAndInstall());
ipcMain.handle('update:getAllowPrerelease', () => getAllowPrerelease());
ipcMain.handle('update:setAllowPrerelease', (_event, enabled: boolean) =>
  setAllowPrerelease(enabled)
);
ipcMain.handle('update:getLogPath', () => getUpdateLogPath());

// System info for About page (#155 Tier 4)
ipcMain.handle('app:getSystemInfo', () => ({
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron,
  chromiumVersion: process.versions.chrome,
  nodeVersion: process.versions.node,
}));

// ─── Secure Auth Token Management (safeStorage) ──────────────────────

ipcMain.handle(
  'auth:storeRefreshToken',
  (
    _event,
    data: {
      refreshToken: string;
      rememberMe: boolean;
      apiBase: string;
    }
  ) => {
    storeRefreshToken(data);
    // Clear any cached restore result so subsequent restoreSession calls
    // (e.g. after HMR or renderer reload) use the fresh token, not a stale
    // 'refresh_failed' from a previous attempt.
    restoreSessionPromise = null;

    // Activate auto-updater now that we have an API base
    // (first-launch users won't have this until login)
    if (data.apiBase) {
      setUpdateFeedUrl(data.apiBase);
    }
  }
);

// Deduplicate restoreSession: React Strict Mode can fire the renderer's
// useEffect twice, causing two IPC calls.  Without dedup each call would
// trigger a separate token rotation, wasting rotations and widening the
// window for race conditions.
let restoreSessionPromise: Promise<{
  status: string;
  accessToken?: string;
  sessionId?: string;
  e2eeKeys?: unknown;
}> | null = null;

ipcMain.handle('auth:restoreSession', () => {
  if (restoreSessionPromise) return restoreSessionPromise;

  restoreSessionPromise = (async () => {
    const restored = restoreRefreshToken();
    if (restored.status !== 'ok') {
      return { status: restored.status };
    }
    // Token restored from disk — refresh it to get a fresh access token
    const refreshResult = await performRefresh();
    if (refreshResult.status === 'ok' && refreshResult.accessToken) {
      // Also restore E2EE keys if available
      const e2eeKeys = restoreE2EEKeys();
      return {
        status: 'restored',
        accessToken: refreshResult.accessToken,
        sessionId: refreshResult.sessionId,
        e2eeKeys,
      };
    }
    return { status: 'refresh_failed' };
  })();

  return restoreSessionPromise;
});

ipcMain.handle(
  'auth:storeE2EEKeys',
  (
    _event,
    data: {
      wrappingKeyBase64: string;
      preferencesKeyBase64: string;
      wrappedPrivateKeyBase64: string;
    }
  ) => {
    storeE2EEKeys(data);
  }
);

ipcMain.handle('auth:refreshToken', async () => {
  return performRefresh();
});

ipcMain.handle('auth:logout', async (_event, data?: { accessToken?: string }) => {
  await performLogout(data?.accessToken);
});

ipcMain.handle('auth:clearTokens', () => {
  clearTokens();
});

ipcMain.handle('auth:getCapabilities', () => {
  return getCapabilities();
});

ipcMain.handle('auth:getMachineId', () => {
  return getMachineId();
});

// ─── PiP (Picture-in-Picture) Window Management ──────────────────────
const pipWindows = new Map<string, BrowserWindow>();

ipcMain.handle(
  'pip:open',
  (_event, opts: { id: string; width?: number; height?: number; title?: string }) => {
    if (pipWindows.has(opts.id)) {
      pipWindows.get(opts.id)!.focus();
      return;
    }

    const pip = new BrowserWindow({
      width: opts.width || 320,
      height: opts.height || 240,
      minWidth: 160,
      minHeight: 120,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      title: opts.title || 'Concord Voice PiP',
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
      backgroundColor: '#000',
    });

    // Load PiP route (hash-based routing)
    if (!app.isPackaged) {
      pip.loadURL(`http://localhost:3001#/pip/${opts.id}`);
    } else if (remoteSpaBaseUrl) {
      // Tier 3: PiP windows also load from the remote SPA (preserves sub-path)
      pip.loadURL(`${remoteSpaBaseUrl}#/pip/${opts.id}`);
    } else {
      pip.loadFile(path.join(__dirname, '../renderer/index.html'), {
        hash: `/pip/${opts.id}`,
      });
    }

    pipWindows.set(opts.id, pip);

    pip.on('closed', () => {
      pipWindows.delete(opts.id);
      mainWindow?.webContents.send('pip:closed', { id: opts.id });
    });
  }
);

ipcMain.handle('pip:close', (_event, opts: { id: string }) => {
  pipWindows.get(opts.id)?.close();
});

ipcMain.handle('pip:setAlwaysOnTop', (_event, opts: { id: string; flag: boolean }) => {
  pipWindows.get(opts.id)?.setAlwaysOnTop(opts.flag);
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (gotTheLock) {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
} else {
  app.quit();
}

// Security: Disable remote module
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);

    if (app.isPackaged) {
      // Packaged release: block navigation unless it's to the remote SPA origin (Tier 3)
      const spaOrigin = remoteSpaBaseUrl ? new URL(remoteSpaBaseUrl).origin : null;
      if (!spaOrigin || parsedUrl.origin !== spaOrigin) {
        event.preventDefault();
      }
    } else if (parsedUrl.hostname !== 'localhost') {
      // In dev, allow localhost navigation (any port) for HMR
      event.preventDefault();
    }
  });
});
