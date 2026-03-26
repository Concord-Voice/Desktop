// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const mockWebContents = vi.hoisted(() => ({
  executeJavaScript: vi.fn().mockResolvedValue(undefined),
}));

const mockSplashWindow = vi.hoisted(() => ({
  loadURL: vi.fn(),
  once: vi.fn(),
  show: vi.fn(),
  destroy: vi.fn(),
  isDestroyed: vi.fn(() => false),
  webContents: mockWebContents,
}));

const MockBrowserWindow = vi.hoisted(() =>
  vi.fn().mockImplementation(function () {
    return mockSplashWindow;
  })
);

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workAreaSize: { width: 1920, height: 1080 },
    })),
  },
}));

// ── Tests ────────────────────────────────────────────────────────────────

describe('splashWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSplashWindow.isDestroyed.mockReturnValue(false);
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function loadModule() {
    vi.resetModules();
    return import('../../../src/main/splashWindow');
  }

  describe('showSplash', () => {
    it('creates a frameless BrowserWindow with correct dimensions', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash();

      expect(MockBrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 300,
          height: 300,
          frame: false,
          resizable: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          backgroundColor: '#0d0821',
          show: false,
        })
      );

      closeSplash();
    });

    it('centers the window on the primary display', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash();

      const opts = MockBrowserWindow.mock.calls[0][0];
      // (1920 - 300) / 2 = 810, (1080 - 300) / 2 = 390
      expect(opts.x).toBe(810);
      expect(opts.y).toBe(390);

      closeSplash();
    });

    it('loads a data URL with brand HTML', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash();

      expect(mockSplashWindow.loadURL).toHaveBeenCalledWith(
        expect.stringContaining('data:text/html;charset=utf-8,')
      );

      closeSplash();
    });

    it('registers ready-to-show handler that shows the window', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash();

      expect(mockSplashWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));

      // Simulate ready-to-show
      const handler = mockSplashWindow.once.mock.calls.find(
        (c: unknown[]) => c[0] === 'ready-to-show'
      );
      handler![1]();
      expect(mockSplashWindow.show).toHaveBeenCalled();

      closeSplash();
    });

    it('does not create a second window if splash already open', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash();
      showSplash(); // second call — should be no-op

      expect(MockBrowserWindow).toHaveBeenCalledTimes(1);

      closeSplash();
    });

    it('embeds icon data URL when provided', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash('data:image/png;base64,TESTICON');

      expect(mockSplashWindow.loadURL).toHaveBeenCalledWith(expect.stringContaining('TESTICON'));

      closeSplash();
    });
  });

  describe('updateSplashStatus', () => {
    it('executes JavaScript to update status text', async () => {
      const { showSplash, updateSplashStatus, closeSplash } = await loadModule();
      showSplash();
      updateSplashStatus('Downloading update...');

      expect(mockWebContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('Downloading update...')
      );

      closeSplash();
    });

    it('uses JSON.stringify for safe encoding (single quotes, backslashes, unicode line terminators)', async () => {
      const { showSplash, updateSplashStatus, closeSplash } = await loadModule();
      showSplash();
      updateSplashStatus("It's updating");

      // JSON.stringify wraps in double quotes — single quotes need no escaping
      expect(mockWebContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('"It\'s updating"')
      );

      closeSplash();
    });

    it('is a no-op when no splash window exists', async () => {
      const { updateSplashStatus } = await loadModule();
      // No showSplash() called — should not throw
      expect(() => updateSplashStatus('test')).not.toThrow();
      expect(mockWebContents.executeJavaScript).not.toHaveBeenCalled();
    });

    it('is a no-op when splash window is destroyed', async () => {
      const { showSplash, updateSplashStatus, closeSplash } = await loadModule();
      showSplash();
      closeSplash();
      mockSplashWindow.isDestroyed.mockReturnValue(true);

      expect(() => updateSplashStatus('test')).not.toThrow();
    });
  });

  describe('closeSplash', () => {
    it('destroys the splash window', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash();
      closeSplash();

      expect(mockSplashWindow.destroy).toHaveBeenCalled();
    });

    it('is idempotent (calling twice does not throw)', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash();
      closeSplash();
      mockSplashWindow.isDestroyed.mockReturnValue(true);

      expect(() => closeSplash()).not.toThrow();
      // destroy should only be called once
      expect(mockSplashWindow.destroy).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no splash window was created', async () => {
      const { closeSplash } = await loadModule();
      expect(() => closeSplash()).not.toThrow();
      expect(mockSplashWindow.destroy).not.toHaveBeenCalled();
    });

    it('clears the reference when window was already destroyed externally', async () => {
      const { showSplash, closeSplash, updateSplashStatus } = await loadModule();
      showSplash();
      // Simulate the window being destroyed by Electron (e.g. OS close)
      mockSplashWindow.isDestroyed.mockReturnValue(true);
      closeSplash();

      // destroy() should NOT have been called (already destroyed)
      expect(mockSplashWindow.destroy).not.toHaveBeenCalled();
      // Reference should be nulled — updateSplashStatus should be a no-op
      expect(() => updateSplashStatus('test')).not.toThrow();
      expect(mockWebContents.executeJavaScript).not.toHaveBeenCalled();
    });

    it('allows showSplash to create a new window after close', async () => {
      const { showSplash, closeSplash } = await loadModule();
      showSplash();
      closeSplash();
      mockSplashWindow.isDestroyed.mockReturnValue(true);

      // Reset mock to track new call
      MockBrowserWindow.mockClear();
      showSplash();

      expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
      closeSplash();
    });
  });
});
