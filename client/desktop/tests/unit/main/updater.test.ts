// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const mockAutoUpdater = vi.hoisted(() => ({
  logger: null as unknown,
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  on: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn().mockResolvedValue(undefined),
  downloadUpdate: vi.fn().mockResolvedValue([]),
  quitAndInstall: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  getLogPath: vi.fn().mockReturnValue('/tmp/test-update.log'),
}));

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn().mockReturnValue('1.0.0'),
    getPath: vi.fn().mockReturnValue('/tmp/test-userdata'),
    isPackaged: true,
  },
  BrowserWindow: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    }),
    writeFileSync: vi.fn(),
  },
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error('ENOENT');
  }),
  writeFileSync: vi.fn(),
}));

vi.mock('../../../src/main/tokenManager', () => ({
  getPersistedApiBase: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/main/updateLogger', () => ({
  createUpdateLogger: vi.fn().mockReturnValue(mockLogger),
}));

vi.mock('../../../src/main/updateSafety', () => ({
  prepareForUpdate: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/main/splashWindow', () => ({
  updateSplashStatus: vi.fn(),
  showSplashProgress: vi.fn(),
  updateSplashError: vi.fn(),
  showSplash: vi.fn(),
  closeSplash: vi.fn(),
}));

// ── Tests ────────────────────────────────────────────────────────────────

describe('updater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function loadModule() {
    vi.resetModules();
    const updater = await import('../../../src/main/updater');
    const splash = await import('../../../src/main/splashWindow');
    return { updater, splash };
  }

  /** Return the handler registered for a given autoUpdater event. */
  function getEventHandler(event: string): (...args: unknown[]) => void {
    const call = mockAutoUpdater.on.mock.calls.find((c: unknown[]) => c[0] === event);
    if (!call) throw new Error(`No handler registered for '${event}'`);
    return call[1] as (...args: unknown[]) => void;
  }

  describe('splash integration via updater events', () => {
    it('checking-for-update calls updateSplashStatus with airwaves copy', async () => {
      const { updater, splash } = await loadModule();
      updater.initAutoUpdater(() => null);

      getEventHandler('checking-for-update')();

      expect(splash.updateSplashStatus).toHaveBeenCalledWith('Checking the airwaves...');
    });

    it('update-available calls updateSplashStatus with version string', async () => {
      const { updater, splash } = await loadModule();
      updater.initAutoUpdater(() => null);

      getEventHandler('update-available')({
        version: '2.0.0',
        releaseDate: '2026-01-01',
        releaseNotes: '',
      });

      expect(splash.updateSplashStatus).toHaveBeenCalledWith('New flight plan detected: v2.0.0');
    });

    it('update-not-available calls updateSplashStatus with go copy', async () => {
      const { updater, splash } = await loadModule();
      updater.initAutoUpdater(() => null);

      getEventHandler('update-not-available')({ version: '1.0.0' });

      expect(splash.updateSplashStatus).toHaveBeenCalledWith('All systems go');
    });

    it('download-progress calls showSplashProgress with percent and updateSplashStatus with fuel copy', async () => {
      const { updater, splash } = await loadModule();
      updater.initAutoUpdater(() => null);

      getEventHandler('download-progress')({
        percent: 42.7,
        transferred: 1024,
        total: 2048,
        bytesPerSecond: 512,
      });

      expect(splash.showSplashProgress).toHaveBeenCalledWith(42.7);
      expect(splash.updateSplashStatus).toHaveBeenCalledWith('Fueling up... 43%');
    });

    it('update-downloaded calls showSplashProgress(100) and updateSplashStatus with liftoff copy', async () => {
      const { updater, splash } = await loadModule();
      updater.initAutoUpdater(() => null);

      getEventHandler('update-downloaded')({ version: '2.0.0' });

      expect(splash.showSplashProgress).toHaveBeenCalledWith(100);
      expect(splash.updateSplashStatus).toHaveBeenCalledWith('Ready for liftoff');
    });

    it('error calls updateSplashError', async () => {
      const { updater, splash } = await loadModule();
      updater.initAutoUpdater(() => null);

      getEventHandler('error')(new Error('Network failure'));

      expect(splash.updateSplashError).toHaveBeenCalledWith('Houston, we have a problem');
    });
  });
});
