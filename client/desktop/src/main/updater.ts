import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { app, type BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { getPersistedApiBase } from './tokenManager';

// Check every 4 hours; delay first check 10s so it doesn't block app startup
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 10_000;

// Persisted preference for pre-release updates (same pattern as hw-accel.json)
const prereleasePrefPath = path.join(app.getPath('userData'), 'update-prefs.json');

interface UpdatePrefs {
  allowPrerelease: boolean;
}

function readUpdatePrefs(): UpdatePrefs {
  try {
    const data = JSON.parse(fs.readFileSync(prereleasePrefPath, 'utf-8'));
    return { allowPrerelease: data.allowPrerelease !== false };
  } catch {
    return { allowPrerelease: true }; // Default: true (all 0.x releases are pre-release)
  }
}

function writeUpdatePrefs(prefs: UpdatePrefs): void {
  try {
    fs.writeFileSync(prereleasePrefPath, JSON.stringify(prefs), 'utf-8');
  } catch (err) {
    console.error('[updater] Failed to write update prefs:', (err as Error).message);
  }
}

let checkInterval: ReturnType<typeof setInterval> | null = null;
let getWindow: (() => BrowserWindow | null) | null = null;
let handlersRegistered = false;

/** Send an IPC event to the renderer (if the window exists). */
function sendToRenderer(channel: string, data: unknown): void {
  const win = getWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

/** Configure updater settings and register event handlers (runs exactly once). */
function ensureUpdaterReady(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // Privacy-first: require explicit user action to download
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Read persisted preference (defaults to true for 0.x pre-release cycle)
  autoUpdater.allowPrerelease = readUpdatePrefs().allowPrerelease;

  // ─── Event handlers ─────────────────────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log(`[updater] Update available: v${info.version}`);
    sendToRenderer('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log(`[updater] Up to date (v${info.version})`);
    sendToRenderer('update:not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    const msg = `${progress.percent.toFixed(1)}% (${formatBytes(progress.transferred)}/${formatBytes(progress.total)})`;
    console.log(`[updater] Download: ${msg}`);
    sendToRenderer('update:download-progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log(`[updater] Downloaded v${info.version} — ready to install`);
    sendToRenderer('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (error: Error) => {
    console.error('[updater] Error:', error.message);
    sendToRenderer('update:error', { message: error.message });
  });
}

/** Start the scheduled update check interval (idempotent). */
function startScheduledChecks(): void {
  if (checkInterval) return;

  const scheduledCheck = () => {
    checkForUpdates().catch(() => {});
  };
  setTimeout(scheduledCheck, STARTUP_CHECK_DELAY_MS);
  checkInterval = setInterval(scheduledCheck, UPDATE_CHECK_INTERVAL_MS);
}

export function initAutoUpdater(mainWindowGetter: () => BrowserWindow | null): void {
  getWindow = mainWindowGetter;

  if (!app.isPackaged) {
    console.log('[updater] Skipping auto-update in development');
    return;
  }

  // Always register settings and event handlers so renderer events work
  // even if the feed URL is set later via setUpdateFeedUrl().
  ensureUpdaterReady();

  // Privacy-first: update checks go through our server, never GitHub directly.
  // The server serves release assets from disk via GET /api/v1/updates/*
  const apiBase = getPersistedApiBase();
  if (apiBase) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${apiBase}/api/v1/updates`,
    });
    startScheduledChecks();
  } else {
    // No persisted API base (first launch, never logged in).
    // Updates will be enabled after login via setUpdateFeedUrl().
    console.log('[updater] No API base available, deferring update check until login');
  }
}

// ─── Public API (consumed by IPC handlers in main.ts) ─────────────────

export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // Log for diagnostics, then rethrow so the IPC invoke rejects
    // and the renderer can transition out of the "checking" state.
    console.error('[updater] Check failed:', (error as Error).message);
    throw error;
  }
}

export function downloadUpdate(): Promise<string[]> {
  return autoUpdater.downloadUpdate();
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export function getAllowPrerelease(): boolean {
  return autoUpdater.allowPrerelease;
}

export function setAllowPrerelease(enabled: boolean): void {
  autoUpdater.allowPrerelease = enabled;
  writeUpdatePrefs({ allowPrerelease: enabled });
}

// ─── Helpers ──────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Set the update feed URL after login (when apiBase becomes available). */
export function setUpdateFeedUrl(apiBase: string): void {
  if (!app.isPackaged) return; // No-op in development
  ensureUpdaterReady();
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${apiBase}/api/v1/updates`,
  });
  console.log('[updater] Feed URL set to', `${apiBase}/api/v1/updates`);
  startScheduledChecks();
}

/** Stop scheduled update checks (called on app quit). */
export function stopAutoUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
