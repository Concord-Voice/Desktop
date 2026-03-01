import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, screen, session, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  storeRefreshToken,
  restoreRefreshToken,
  performRefresh,
  performLogout,
  clearTokens,
  getCapabilities,
  storeE2EEKeys,
  restoreE2EEKeys,
} from './tokenManager';

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

if (!readHwAccelPref()) {
  app.disableHardwareAcceleration();
} else {
  // Hardware acceleration flags for video encode/decode (IGNIS insight: fastest preset wins)
  app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL');
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

const createWindow = (): void => {
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

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:3001');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

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
};

// App lifecycle handlers
app.whenReady().then(() => {
  // Media permission handler (#44): only allow media and display-capture
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'display-capture'].includes(permission);
    callback(allowed);
  });

  createWindow();

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

// IPC Handlers
ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('app:getPlatform', () => {
  return process.platform;
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
  0x106b: 'Apple', 0x8086: 'Intel', 0x10de: 'NVIDIA', 0x1002: 'AMD',
  0x1022: 'AMD', 0x5143: 'Qualcomm', 0x13b5: 'ARM',
};

ipcMain.handle('gpu:getInfo', async () => {
  try {
    const info = await app.getGPUInfo('basic');
    const gpu = (info as { gpuDevice?: Array<{ vendorId: number; deviceId: number; driverVendor?: string; driverDescription?: string }> })
      .gpuDevice?.[0];
    if (gpu) {
      // driverVendor on macOS often contains the hex vendorId as a string — skip it
      const driverName = gpu.driverVendor && !/^0x[0-9a-f]+$/i.test(gpu.driverVendor) ? gpu.driverVendor : '';
      const vendor = driverName || GPU_VENDORS[gpu.vendorId] || `Unknown (0x${gpu.vendorId.toString(16)})`;
      const device = gpu.driverDescription || (gpu.deviceId ? `Device 0x${gpu.deviceId.toString(16)}` : '');
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

// ─── Secure Auth Token Management (safeStorage) ──────────────────────

ipcMain.handle('auth:storeRefreshToken', (_event, data: {
  refreshToken: string;
  rememberMe: boolean;
  apiBase: string;
}) => {
  storeRefreshToken(data);
});

ipcMain.handle('auth:restoreSession', async () => {
  const restored = restoreRefreshToken();
  if (restored.status !== 'ok') {
    return { status: restored.status };
  }
  // Token restored from disk — refresh it to get a fresh access token
  const refreshResult = await performRefresh();
  if (refreshResult.status === 'ok' && refreshResult.accessToken) {
    // Also restore E2EE keys if available
    const e2eeKeys = restoreE2EEKeys();
    return { status: 'restored', accessToken: refreshResult.accessToken, sessionId: refreshResult.sessionId, e2eeKeys };
  }
  return { status: 'refresh_failed' };
});

ipcMain.handle('auth:storeE2EEKeys', (_event, data: {
  wrappingKeyBase64: string;
  preferencesKeyBase64: string;
  wrappedPrivateKeyBase64: string;
}) => {
  storeE2EEKeys(data);
});

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

// ─── PiP (Picture-in-Picture) Window Management ──────────────────────
const pipWindows = new Map<string, BrowserWindow>();

ipcMain.handle('pip:open', (_event, opts: { id: string; width?: number; height?: number; title?: string }) => {
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
  if (process.env.NODE_ENV === 'development') {
    pip.loadURL(`http://localhost:3001#/pip/${opts.id}`);
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
});

ipcMain.handle('pip:close', (_event, opts: { id: string }) => {
  pipWindows.get(opts.id)?.close();
});

ipcMain.handle('pip:setAlwaysOnTop', (_event, opts: { id: string; flag: boolean }) => {
  pipWindows.get(opts.id)?.setAlwaysOnTop(opts.flag);
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Security: Disable remote module
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);

    if (process.env.NODE_ENV === 'development') {
      // In dev, allow localhost navigation (any port) for HMR
      if (parsedUrl.hostname !== 'localhost') {
        event.preventDefault();
      }
    } else {
      // In production, block all navigation (app loads from file://)
      event.preventDefault();
    }
  });
});
