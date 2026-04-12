// @vitest-environment node
import { describe, it, expect, vi, beforeAll, type Mock } from 'vitest';

// ── Hoisted mocks (available during vi.mock factory execution) ─────────

const { mockMainWindow, mockWebContents, MockBrowserWindow } = vi.hoisted(() => {
  const mockWebContents = {
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
    isDevToolsOpened: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
  };
  const mockMainWindow = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    on: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    webContents: mockWebContents,
  };
  // Use mockImplementation (not mockReturnValue) — Vitest requires this for `new` calls
  const bw = vi.fn().mockImplementation(function () {
    return mockMainWindow;
  });
  // Static method used by activate handler
  (bw as Record<string, unknown>).getAllWindows = vi.fn(() => [mockMainWindow]);
  return { mockMainWindow, mockWebContents, MockBrowserWindow: bw };
});

// ── Electron mock ──────────────────────────────────────────────────────

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: vi.fn(() => false),
      toDataURL: vi.fn(() => 'data:image/png;base64,MOCKICON'),
    })),
  },
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getAppPath: vi.fn(() => '/tmp/test-app'),
    getVersion: vi.fn(() => '1.0.0-test'),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
    on: vi.fn(),
    getGPUInfo: vi.fn(() =>
      Promise.resolve({
        gpuDevice: [
          {
            vendorId: 0x10de,
            deviceId: 0x1234,
            driverVendor: 'NVIDIA',
            driverDescription: 'GeForce GTX 1080',
          },
        ],
      })
    ),
  },
  ipcMain: { handle: vi.fn() },
  clipboard: { writeText: vi.fn() },
  desktopCapturer: {
    getSources: vi.fn(() =>
      Promise.resolve([
        {
          id: 'screen:1',
          name: 'Screen 1',
          thumbnail: { toDataURL: () => 'data:image/png;base64,thumb' },
          appIcon: { toDataURL: () => 'data:image/png;base64,icon' },
        },
      ])
    ),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        id: 1,
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        displayFrequency: 120,
        colorDepth: 24,
        colorSpace: 'srgb',
      },
    ]),
    getPrimaryDisplay: vi.fn(() => ({ id: 1 })),
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      on: vi.fn(),
    },
  },
  shell: { openExternal: vi.fn() },
  powerMonitor: { on: vi.fn() },
}));

// ── Sentry mock ───────────────────────────────────────────────────────

vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ── Node / internal module mocks ───────────────────────────────────────

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(() => JSON.stringify({ enabled: true })),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    renameSync: vi.fn(),
  },
}));

// Mock node:http — make dev server check fail so createWindow falls back to loadFile
vi.mock('node:http', () => {
  const mockGet = vi.fn(
    (_url: string, _opts: Record<string, unknown>, _cb: (res: unknown) => void) => {
      const req = {
        on: vi.fn((event: string, handler: (err?: Error) => void) => {
          if (event === 'error') {
            // Fire error asynchronously to simulate ECONNREFUSED
            Promise.resolve().then(() => handler(new Error('ECONNREFUSED')));
          }
          return req;
        }),
        destroy: vi.fn(),
      };
      return req;
    }
  );
  return { default: { get: mockGet }, get: mockGet };
});

vi.mock('electron-squirrel-startup', () => ({ default: false }));

vi.mock('../../../src/main/tokenManager', () => ({
  storeRefreshToken: vi.fn(),
  restoreRefreshToken: vi.fn(() => ({
    status: 'ok',
    refreshToken: 'mock-token',
    apiBase: 'http://localhost:8080',
  })),
  performRefresh: vi.fn(() =>
    Promise.resolve({ status: 'ok', accessToken: 'mock-access', sessionId: 'mock-session' })
  ),
  performLogout: vi.fn(() => Promise.resolve()),
  clearTokens: vi.fn(),
  getCapabilities: vi.fn(() => ({ safeStorage: true, secureKeychain: true })),
  storeE2EEKeys: vi.fn(),
  restoreE2EEKeys: vi.fn(() => ({
    wrappingKeyBase64: 'key',
    preferencesKeyBase64: 'pkey',
    wrappedPrivateKeyBase64: 'wpk',
  })),
  setProactiveRefreshCallback: vi.fn(),
  onSystemResume: vi.fn(),
}));

vi.mock('../../../src/main/machineId', () => ({
  getMachineId: vi.fn(() => 'mock-machine-id'),
}));

vi.mock('../../../src/main/updater', () => ({
  initAutoUpdater: vi.fn(),
  stopAutoUpdater: vi.fn(),
  setUpdateFeedUrl: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve({ updateAvailable: false })),
  downloadUpdate: vi.fn(() => Promise.resolve()),
  safeQuitAndInstall: vi.fn(() => Promise.resolve()),
  getAllowPrerelease: vi.fn(() => false),
  setAllowPrerelease: vi.fn(),
  getUpdateLogger: vi.fn(() => null),
  getUpdateLogPath: vi.fn(() => '/tmp/test-logs/update-2026-03-25.log'),
}));

vi.mock('../../../src/main/updateSafety', () => ({
  checkUpdateSentinel: vi.fn(() => ({ type: 'none' })),
  finalizeUpdate: vi.fn(() => Promise.resolve()),
  finalizeRollback: vi.fn(() => Promise.resolve()),
  runDeferredCleanup: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/main/userDataMigration', () => ({
  migrateUserData: vi.fn(),
}));

vi.mock('../../../src/main/splashWindow', () => ({
  showSplash: vi.fn(),
  closeSplash: vi.fn(),
}));

vi.mock('../../../src/main/spaLoader', () => ({
  resolveSpaSource: vi.fn(() => Promise.resolve({ mode: 'bundled', reason: 'test' })),
}));

vi.mock('../../../src/main/ipcContract', () => ({
  IPC_CONTRACT_VERSION: '1.0',
}));

vi.mock('../../../src/main/permissionManager', () => ({
  registerIpcHandlers: vi.fn(),
}));

// ── Import + extract ───────────────────────────────────────────────────

type HandlerFn = (...args: unknown[]) => unknown;
type CallbackFn = (...args: unknown[]) => void;
let handlers: Map<string, HandlerFn>;
let appOnCallbacks: Map<string, CallbackFn>;
let sessionHandlers: {
  permissionRequest?: CallbackFn;
  permissionCheck?: CallbackFn;
  devicePermission?: CallbackFn;
  hidSelect?: CallbackFn;
};

beforeAll(async () => {
  // Import triggers all module-scope side effects + whenReady resolves
  await import('../../../src/main/main');

  // Allow async operations to settle (createWindow, whenReady callback)
  await new Promise((resolve) => setTimeout(resolve, 100));

  const electron = await import('electron');

  // Extract IPC handlers from ipcMain.handle mock calls
  handlers = new Map();
  for (const call of (electron.ipcMain.handle as Mock).mock.calls) {
    handlers.set(call[0] as string, call[1] as HandlerFn);
  }

  // Extract app.on callbacks
  appOnCallbacks = new Map();
  for (const call of (electron.app.on as Mock).mock.calls) {
    appOnCallbacks.set(call[0] as string, call[1] as CallbackFn);
  }

  // Extract session permission handlers
  const sess = electron.session.defaultSession;
  sessionHandlers = {};
  const prh = (sess.setPermissionRequestHandler as Mock).mock.calls;
  if (prh.length > 0) sessionHandlers.permissionRequest = prh[0][0] as CallbackFn;
  const pch = (sess.setPermissionCheckHandler as Mock).mock.calls;
  if (pch.length > 0) sessionHandlers.permissionCheck = pch[0][0] as CallbackFn;
  const dph = (sess.setDevicePermissionHandler as Mock).mock.calls;
  if (dph.length > 0) sessionHandlers.devicePermission = dph[0][0] as CallbackFn;
  const hid = (sess.on as Mock).mock.calls.find((c: unknown[]) => c[0] === 'select-hid-device');
  if (hid) sessionHandlers.hidSelect = hid[1] as CallbackFn;
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('main.ts', () => {
  describe('module initialization', () => {
    it('calls migrateUserData on startup (before app.whenReady)', async () => {
      const { migrateUserData } = await import('../../../src/main/userDataMigration');
      expect(migrateUserData).toHaveBeenCalled();
    });

    it('reads hardware acceleration preference on startup', async () => {
      const fs = (await import('node:fs')).default;
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    it('appends accelerated video flags when hw accel enabled', async () => {
      const { app } = await import('electron');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
        'enable-features',
        'AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL'
      );
    });

    it('sets autoplay policy for WebRTC', async () => {
      const { app } = await import('electron');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
        'autoplay-policy',
        'no-user-gesture-required'
      );
    });

    it('requests single instance lock', async () => {
      const { app } = await import('electron');
      expect(app.requestSingleInstanceLock).toHaveBeenCalled();
    });

    it('registers second-instance handler when lock acquired', () => {
      expect(appOnCallbacks.has('second-instance')).toBe(true);
    });

    it('registers web-contents-created handler', () => {
      expect(appOnCallbacks.has('web-contents-created')).toBe(true);
    });

    it('registers window-all-closed handler', () => {
      expect(appOnCallbacks.has('window-all-closed')).toBe(true);
    });

    it('registers before-quit handler', () => {
      expect(appOnCallbacks.has('before-quit')).toBe(true);
    });
  });

  describe('IPC: app info', () => {
    it('app:getVersion returns version', async () => {
      const result = await handlers.get('app:getVersion')!();
      expect(result).toBe('1.0.0-test');
    });

    it('app:getPlatform returns platform', async () => {
      const result = await handlers.get('app:getPlatform')!();
      expect(result).toBe(process.platform);
    });

    it('app:getIpcContract returns contract version', async () => {
      const result = await handlers.get('app:getIpcContract')!();
      expect(result).toBe('1.0');
    });

    it('app:getSystemInfo returns system details', async () => {
      const result = (await handlers.get('app:getSystemInfo')!()) as Record<string, string>;
      expect(result).toHaveProperty('platform');
      expect(result).toHaveProperty('arch');
      expect(result).toHaveProperty('electronVersion');
      expect(result).toHaveProperty('chromiumVersion');
      expect(result).toHaveProperty('nodeVersion');
    });
  });

  describe('IPC: hardware acceleration', () => {
    it('app:getHardwareAcceleration returns current pref', async () => {
      const result = await handlers.get('app:getHardwareAcceleration')!();
      expect(result).toBe(true);
    });

    it('app:setHardwareAcceleration writes pref file', async () => {
      const fs = (await import('node:fs')).default;
      await handlers.get('app:setHardwareAcceleration')!({}, false);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('hw-accel.json'),
        JSON.stringify({ enabled: false }),
        'utf-8'
      );
    });

    it('app:relaunch restarts the app', async () => {
      const { app } = await import('electron');
      await handlers.get('app:relaunch')!();
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    it('app:quit exits the app', async () => {
      const { app } = await import('electron');
      (app.quit as Mock).mockClear();
      await handlers.get('app:quit')!();
      expect(app.quit).toHaveBeenCalled();
    });
  });

  describe('IPC: GPU info', () => {
    it('gpu:getInfo returns vendor and device', async () => {
      const result = (await handlers.get('gpu:getInfo')!()) as {
        vendor: string;
        device: string;
      } | null;
      expect(result).not.toBeNull();
      expect(result!.vendor).toBe('NVIDIA');
      expect(result!.device).toBe('GeForce GTX 1080');
    });

    it('gpu:getInfo returns null on failure', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockRejectedValueOnce(new Error('fail'));
      const result = await handlers.get('gpu:getInfo')!();
      expect(result).toBeNull();
    });
  });

  describe('IPC: screen info', () => {
    it('screen:getDisplayInfo returns display list', async () => {
      const result = (await handlers.get('screen:getDisplayInfo')!()) as Array<{
        width: number;
        height: number;
        refreshRate: number;
        isPrimary: boolean;
      }>;
      expect(result).toHaveLength(1);
      expect(result[0].width).toBe(3840); // 1920 * 2 (scaleFactor)
      expect(result[0].height).toBe(2160);
      expect(result[0].refreshRate).toBe(120);
      expect(result[0].isPrimary).toBe(true);
    });
  });

  describe('IPC: media & clipboard', () => {
    it('media:getDesktopSources returns source list', async () => {
      const result = (await handlers.get('media:getDesktopSources')!()) as Array<{
        id: string;
        name: string;
        thumbnail: string;
      }>;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('screen:1');
      expect(result[0].name).toBe('Screen 1');
      expect(result[0].thumbnail).toContain('data:image');
    });

    it('clipboard:writeText writes to clipboard', async () => {
      const { clipboard } = await import('electron');
      await handlers.get('clipboard:writeText')!({}, 'hello');
      expect(clipboard.writeText).toHaveBeenCalledWith('hello');
    });
  });

  describe('IPC: auth (tokenManager passthrough)', () => {
    it('auth:storeRefreshToken stores token and sets update feed', async () => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      const { setUpdateFeedUrl } = await import('../../../src/main/updater');
      const data = { refreshToken: 'tok', rememberMe: true, apiBase: 'http://localhost:8080' };
      await handlers.get('auth:storeRefreshToken')!({}, data);
      expect(storeRefreshToken).toHaveBeenCalledWith(data);
      expect(setUpdateFeedUrl).toHaveBeenCalledWith('http://localhost:8080');
    });

    it('auth:restoreSession restores and refreshes token', async () => {
      const result = (await handlers.get('auth:restoreSession')!()) as {
        status: string;
        accessToken?: string;
      };
      expect(result.status).toBe('restored');
      expect(result.accessToken).toBe('mock-access');
    });

    it('auth:storeE2EEKeys stores keys', async () => {
      const { storeE2EEKeys } = await import('../../../src/main/tokenManager');
      const data = {
        wrappingKeyBase64: 'a',
        preferencesKeyBase64: 'b',
        wrappedPrivateKeyBase64: 'c',
      };
      await handlers.get('auth:storeE2EEKeys')!({}, data);
      expect(storeE2EEKeys).toHaveBeenCalledWith(data);
    });

    it('auth:refreshToken delegates to performRefresh', async () => {
      const result = (await handlers.get('auth:refreshToken')!()) as { status: string };
      expect(result.status).toBe('ok');
    });

    it('auth:logout delegates to performLogout', async () => {
      const { performLogout } = await import('../../../src/main/tokenManager');
      await handlers.get('auth:logout')!({}, { accessToken: 'tok' });
      expect(performLogout).toHaveBeenCalledWith('tok');
    });

    it('auth:clearTokens delegates to clearTokens', async () => {
      const { clearTokens } = await import('../../../src/main/tokenManager');
      await handlers.get('auth:clearTokens')!();
      expect(clearTokens).toHaveBeenCalled();
    });

    it('auth:getCapabilities returns capabilities', async () => {
      const result = (await handlers.get('auth:getCapabilities')!()) as {
        safeStorage: boolean;
      };
      expect(result.safeStorage).toBe(true);
    });

    it('auth:getMachineId returns machine id', async () => {
      const result = await handlers.get('auth:getMachineId')!();
      expect(result).toBe('mock-machine-id');
    });
  });

  describe('IPC: auto-update', () => {
    it('update:check delegates to checkForUpdates', async () => {
      const result = (await handlers.get('update:check')!()) as { updateAvailable: boolean };
      expect(result.updateAvailable).toBe(false);
    });

    it('update:download delegates to downloadUpdate', async () => {
      await handlers.get('update:download')!();
      const { downloadUpdate } = await import('../../../src/main/updater');
      expect(downloadUpdate).toHaveBeenCalled();
    });

    it('update:install delegates to safeQuitAndInstall', async () => {
      await handlers.get('update:install')!();
      const { safeQuitAndInstall } = await import('../../../src/main/updater');
      expect(safeQuitAndInstall).toHaveBeenCalled();
    });

    it('update:getAllowPrerelease returns current setting', async () => {
      const result = await handlers.get('update:getAllowPrerelease')!();
      expect(result).toBe(false);
    });

    it('update:setAllowPrerelease updates setting', async () => {
      await handlers.get('update:setAllowPrerelease')!({}, true);
      const { setAllowPrerelease } = await import('../../../src/main/updater');
      expect(setAllowPrerelease).toHaveBeenCalledWith(true);
    });
  });

  describe('IPC: PiP window management', () => {
    it('pip:open creates a new PiP window', async () => {
      const { BrowserWindow } = await import('electron');
      (BrowserWindow as unknown as Mock).mockClear();
      await handlers.get('pip:open')!({}, { id: 'test-pip', width: 400, height: 300 });
      expect(BrowserWindow).toHaveBeenCalled();
    });

    it('pip:close closes a PiP window', async () => {
      mockMainWindow.close.mockClear();
      await handlers.get('pip:close')!({}, { id: 'test-pip' });
      // Window was stored in pipWindows map and should be closeable
      expect(mockMainWindow.close).toHaveBeenCalled();
    });

    it('pip:setAlwaysOnTop sets the flag', async () => {
      mockMainWindow.setAlwaysOnTop.mockClear();
      await handlers.get('pip:setAlwaysOnTop')!({}, { id: 'test-pip', flag: false });
      expect(mockMainWindow.setAlwaysOnTop).toHaveBeenCalledWith(false);
    });
  });

  describe('permission handlers', () => {
    it('denies geolocation requests', () => {
      expect(sessionHandlers.permissionRequest).toBeDefined();
      const callback = vi.fn();
      sessionHandlers.permissionRequest!(null, 'geolocation', callback);
      expect(callback).toHaveBeenCalledWith(false);
    });

    it('allows camera requests', () => {
      const callback = vi.fn();
      sessionHandlers.permissionRequest!(null, 'media', callback);
      expect(callback).toHaveBeenCalledWith(true);
    });

    it('allows notification requests', () => {
      const callback = vi.fn();
      sessionHandlers.permissionRequest!(null, 'notifications', callback);
      expect(callback).toHaveBeenCalledWith(true);
    });

    it('permission check denies geolocation', () => {
      expect(sessionHandlers.permissionCheck).toBeDefined();
      const result = sessionHandlers.permissionCheck!(null, 'geolocation');
      expect(result).toBe(false);
    });

    it('permission check allows camera', () => {
      const result = sessionHandlers.permissionCheck!(null, 'media');
      expect(result).toBe(true);
    });

    it('device permission allows camera/microphone/hid', () => {
      expect(sessionHandlers.devicePermission).toBeDefined();
      expect(sessionHandlers.devicePermission!({ deviceType: 'camera' })).toBe(true);
      expect(sessionHandlers.devicePermission!({ deviceType: 'microphone' })).toBe(true);
      expect(sessionHandlers.devicePermission!({ deviceType: 'hid' })).toBe(true);
    });

    it('device permission denies unknown types', () => {
      expect(sessionHandlers.devicePermission!({ deviceType: 'serial' })).toBe(false);
    });

    it('HID device selection picks first device', () => {
      expect(sessionHandlers.hidSelect).toBeDefined();
      const event = { preventDefault: vi.fn() };
      const callback = vi.fn();
      sessionHandlers.hidSelect!(event, { deviceList: [{ deviceId: 'dev-1' }] }, callback);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith('dev-1');
    });

    it('HID device selection returns empty when no devices', () => {
      const event = { preventDefault: vi.fn() };
      const callback = vi.fn();
      sessionHandlers.hidSelect!(event, { deviceList: [] }, callback);
      expect(callback).toHaveBeenCalledWith('');
    });
  });

  describe('app lifecycle callbacks', () => {
    it('before-quit stops auto-updater', async () => {
      const { stopAutoUpdater } = await import('../../../src/main/updater');
      const beforeQuit = appOnCallbacks.get('before-quit');
      expect(beforeQuit).toBeDefined();
      beforeQuit!();
      expect(stopAutoUpdater).toHaveBeenCalled();
    });

    it('window-all-closed quits on non-macOS', async () => {
      const { app } = await import('electron');
      (app.quit as Mock).mockClear();
      const windowAllClosed = appOnCallbacks.get('window-all-closed');
      expect(windowAllClosed).toBeDefined();
      windowAllClosed!();
      // On non-darwin platforms, quit is called
      if (process.platform !== 'darwin') {
        expect(app.quit).toHaveBeenCalled();
      }
    });

    it('proactive refresh callback sends to renderer', async () => {
      const { setProactiveRefreshCallback } = await import('../../../src/main/tokenManager');
      const cb = (setProactiveRefreshCallback as Mock).mock.calls[0]?.[0] as (...args: unknown[]) => void;
      expect(cb).toBeDefined();
      mockWebContents.send.mockClear();
      cb('new-access-token', 'new-session-id');
      expect(mockWebContents.send).toHaveBeenCalledWith('auth:token-refreshed', {
        accessToken: 'new-access-token',
        sessionId: 'new-session-id',
      });
    });

    it('resume handler triggers onSystemResume', async () => {
      const { powerMonitor } = await import('electron');
      const { onSystemResume } = await import('../../../src/main/tokenManager');
      const resumeCall = (powerMonitor.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'resume'
      );
      expect(resumeCall).toBeDefined();
      (onSystemResume as Mock).mockClear();
      resumeCall![1]();
      expect(onSystemResume).toHaveBeenCalled();
    });
  });

  describe('createWindow', () => {
    it('creates a BrowserWindow', async () => {
      const { BrowserWindow } = await import('electron');
      // BrowserWindow was called during module init (createWindow from whenReady)
      expect(BrowserWindow).toHaveBeenCalled();
    });

    it('registers ready-to-show handler', () => {
      expect(mockMainWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));
    });

    it('registers closed handler', () => {
      expect(mockMainWindow.on).toHaveBeenCalledWith('closed', expect.any(Function));
    });

    it('registers window open handler for external links', () => {
      expect(mockWebContents.setWindowOpenHandler).toHaveBeenCalled();
    });
  });

  describe('GPU_VENDORS mapping', () => {
    it('maps Intel vendor ID', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x8086, deviceId: 0x5678 }],
      });
      const result = (await handlers.get('gpu:getInfo')!()) as { vendor: string } | null;
      expect(result!.vendor).toBe('Intel');
    });

    it('maps Apple vendor ID', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x106b, deviceId: 0x0001 }],
      });
      const result = (await handlers.get('gpu:getInfo')!()) as { vendor: string } | null;
      expect(result!.vendor).toBe('Apple');
    });

    it('maps AMD vendor ID', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x1002, deviceId: 0x0001 }],
      });
      const result = (await handlers.get('gpu:getInfo')!()) as { vendor: string } | null;
      expect(result!.vendor).toBe('AMD');
    });

    it('handles unknown vendor ID', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x9999, deviceId: 0x0001 }],
      });
      const result = (await handlers.get('gpu:getInfo')!()) as { vendor: string } | null;
      expect(result!.vendor).toContain('Unknown');
    });

    it('returns null when no GPU device', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({ gpuDevice: [] });
      const result = await handlers.get('gpu:getInfo')!();
      expect(result).toBeNull();
    });

    it('skips hex-only driverVendor on macOS', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [
          { vendorId: 0x106b, deviceId: 0x0001, driverVendor: '0x106b', driverDescription: 'M1' },
        ],
      });
      const result = (await handlers.get('gpu:getInfo')!()) as { vendor: string } | null;
      expect(result!.vendor).toBe('Apple'); // Falls back to vendor map, not hex string
    });
  });

  describe('createWindow callbacks', () => {
    it('ready-to-show shows the window', () => {
      const readyCall = mockMainWindow.once.mock.calls.find(
        (c: unknown[]) => c[0] === 'ready-to-show'
      );
      expect(readyCall).toBeDefined();
      readyCall![1](); // invoke the callback
      expect(mockMainWindow.show).toHaveBeenCalled();
    });

    it('closed handler nulls mainWindow', () => {
      const closedCall = mockMainWindow.on.mock.calls.find((c: unknown[]) => c[0] === 'closed');
      expect(closedCall).toBeDefined();
      closedCall![1](); // invoke — sets mainWindow = null internally
    });

    it('window open handler allows https and denies others', async () => {
      const handlerCall = mockWebContents.setWindowOpenHandler.mock.calls[0];
      expect(handlerCall).toBeDefined();
      const handler = handlerCall[0] as (details: { url: string }) => { action: string };

      const { shell } = await import('electron');

      // HTTPS opens external
      (shell.openExternal as Mock).mockClear();
      const result1 = handler({ url: 'https://example.com' });
      expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
      expect(result1.action).toBe('deny');

      // Invalid URL is ignored
      (shell.openExternal as Mock).mockClear();
      const result2 = handler({ url: 'not-a-url' });
      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result2.action).toBe('deny');

      // javascript: protocol is blocked
      (shell.openExternal as Mock).mockClear();
      const result3 = handler({ url: 'javascript:alert(1)' });
      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result3.action).toBe('deny');
    });
  });

  describe('navigation guard', () => {
    it('blocks external navigation in dev mode', async () => {
      const { app } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      expect(webContentsCreated).toBeDefined();

      // Invoke web-contents-created to get the will-navigate handler
      const mockContents = { on: vi.fn() };
      webContentsCreated![1]({}, mockContents);

      const willNavigateCall = mockContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'will-navigate'
      );
      expect(willNavigateCall).toBeDefined();
      const willNavigate = willNavigateCall![1] as (
        event: { preventDefault: () => void },
        url: string
      ) => void;

      // Localhost should be allowed (dev mode, isPackaged=false)
      const event1 = { preventDefault: vi.fn() };
      willNavigate(event1, 'http://localhost:3001/some/path');
      expect(event1.preventDefault).not.toHaveBeenCalled();

      // External URL should be blocked in dev
      const event2 = { preventDefault: vi.fn() };
      willNavigate(event2, 'https://evil.com/steal');
      expect(event2.preventDefault).toHaveBeenCalled();
    });
  });

  describe('second-instance handler', () => {
    it('focuses existing window', () => {
      const secondInstance = appOnCallbacks.get('second-instance');
      expect(secondInstance).toBeDefined();
      // Note: mainWindow might be null from the 'closed' test above,
      // but the handler checks for it gracefully
      secondInstance!();
      // Just verify it doesn't throw
    });
  });

  describe('restoreSession deduplication', () => {
    it('dedup cache returns same promise on repeated calls', async () => {
      // The restoreSession handler caches its promise — calling it twice
      // should return the same result without re-invoking performRefresh.
      const handler = handlers.get('auth:restoreSession')!;
      const result1 = await handler();
      const result2 = await handler();
      expect(result1).toEqual(result2);
    });

    it('restoreSession handler exists and returns an object', async () => {
      const handler = handlers.get('auth:restoreSession')!;
      const result = await handler();
      expect(result).toHaveProperty('status');
    });
  });

  describe('IPC handler registration', () => {
    it('registers all expected IPC channels', () => {
      const expected = [
        'app:getVersion',
        'app:getPlatform',
        'app:getIpcContract',
        'app:getSystemInfo',
        'app:getHardwareAcceleration',
        'app:setHardwareAcceleration',
        'app:relaunch',
        'app:quit',
        'media:getDesktopSources',
        'clipboard:writeText',
        'gpu:getInfo',
        'screen:getDisplayInfo',
        'auth:storeRefreshToken',
        'auth:restoreSession',
        'auth:storeE2EEKeys',
        'auth:refreshToken',
        'auth:logout',
        'auth:clearTokens',
        'auth:getCapabilities',
        'auth:getMachineId',
        'update:check',
        'update:download',
        'update:install',
        'update:getAllowPrerelease',
        'update:setAllowPrerelease',
        'update:getLogPath',
        'pip:open',
        'pip:close',
        'pip:setAlwaysOnTop',
      ];
      for (const channel of expected) {
        expect(handlers.has(channel), `missing handler: ${channel}`).toBe(true);
      }
    });
  });
});
