import { BrowserWindow, screen } from 'electron';

// ─── Brand constants ─────────────────────────────────────────────────────

const SPLASH_WIDTH = 300;
const SPLASH_HEIGHT = SPLASH_WIDTH;
const BRAND_BG = '#0d0821';
const BRAND_ACCENT = '#fa709a';

// ─── Splash HTML (self-contained, no external dependencies) ──────────────

const SPLASH_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: ${BRAND_BG};
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    overflow: hidden;
    -webkit-app-region: drag;
    user-select: none;
  }
  .logo {
    width: 120px;
    height: 120px;
    border-radius: 24px;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.05); opacity: 0.85; }
  }
  .status {
    margin-top: 24px;
    font-size: 13px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.7);
    text-align: center;
    transition: opacity 0.3s ease;
  }
  .brand {
    margin-top: 12px;
    font-size: 16px;
    font-weight: 600;
    background: linear-gradient(135deg, ${BRAND_ACCENT}, #ffe13f);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
</style>
</head>
<body>
  <img class="logo" src="APP_ICON_DATA_URL" alt="Concord Voice" />
  <div class="brand">Concord Voice</div>
  <div class="status" id="status">Starting...</div>
</body>
</html>`;

// ─── Module state ────────────────────────────────────────────────────────

let splashWindow: BrowserWindow | null = null;

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Show the branded splash window centered on the primary display.
 * The splash is frameless, non-resizable, and always on top.
 */
export function showSplash(iconDataUrl?: string): void {
  if (splashWindow && !splashWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  splashWindow = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    x: Math.round((screenW - SPLASH_WIDTH) / 2),
    y: Math.round((screenH - SPLASH_HEIGHT) / 2),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: BRAND_BG,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Replace placeholder with actual icon data URL (or empty for tests)
  const html = SPLASH_HTML.replace('APP_ICON_DATA_URL', iconDataUrl ?? '');

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  splashWindow.once('ready-to-show', () => {
    splashWindow?.show();
  });
}

/**
 * Update the status text displayed on the splash window.
 * No-op if the splash window doesn't exist or has been destroyed.
 */
export function updateSplashStatus(text: string): void {
  if (!splashWindow || splashWindow.isDestroyed()) return;

  splashWindow.webContents
    .executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(text)};`)
    .catch(() => {
      // Swallow errors — splash may have been destroyed between the check and execution
    });
}

/**
 * Close and destroy the splash window.
 * Safe to call multiple times (idempotent).
 */
export function closeSplash(): void {
  if (!splashWindow) return;
  if (!splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }
  splashWindow = null;
}
