import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { app, type BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { getPersistedApiBase } from './tokenManager';
import { createUpdateLogger, type UpdateLogger } from './updateLogger';
import { prepareForUpdate } from './updateSafety';

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
    const message = `Failed to write update prefs: ${(err as Error).message}`;
    if (logger) logger.error(message);
    else console.error('[updater]', message);
  }
}

let checkInterval: ReturnType<typeof setInterval> | null = null;
let getWindow: (() => BrowserWindow | null) | null = null;
let handlersRegistered = false;
let logger: UpdateLogger | null = null;
let pendingUpdateVersion: string | null = null;

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

  // Initialize structured file logger (#383)
  logger = createUpdateLogger();
  autoUpdater.logger = logger;

  // Privacy-first: require explicit user action to download.
  // autoInstallOnAppQuit is false so updates always go through safeQuitAndInstall (#384).
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Read persisted preference (defaults to true for 0.x pre-release cycle)
  autoUpdater.allowPrerelease = readUpdatePrefs().allowPrerelease;

  // ─── Event handlers ─────────────────────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    logger!.info(
      `Checking for updates (current: v${app.getVersion()}, ${process.platform}/${process.arch})`
    );
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger!.info(
      `Update available: v${app.getVersion()} → v${info.version} (released ${info.releaseDate ?? 'unknown'})`
    );
    sendToRenderer('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    logger!.info(`Up to date (v${info.version})`);
    sendToRenderer('update:not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    const msg = `${progress.percent.toFixed(1)}% (${formatBytes(progress.transferred)}/${formatBytes(progress.total)})`;
    logger!.info(`Download: ${msg}`);
    sendToRenderer('update:download-progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    pendingUpdateVersion = info.version;
    logger!.info(`Downloaded v${info.version} — ready to install`);
    sendToRenderer('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (error: Error) => {
    logger!.error(`Error: ${error.message}${error.stack ? '\n' + error.stack : ''}`);
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
    // No logger yet in dev mode — use console directly
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
    logger!.info('No API base available, deferring update check until login');
  }
}

// ─── Public API (consumed by IPC handlers in main.ts) ─────────────────

export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // Log for diagnostics, then rethrow so the IPC invoke rejects
    // and the renderer can transition out of the "checking" state.
    logger?.error(`Check failed: ${(error as Error).message}`);
    throw error;
  }
}

export function downloadUpdate(): Promise<string[]> {
  return autoUpdater.downloadUpdate();
}

/**
 * Safe quit-and-install: creates a backup + sentinel before handing off
 * to electron-updater's quitAndInstall(). If backup creation fails the
 * install is aborted and the user is notified (#384).
 */
export async function safeQuitAndInstall(): Promise<void> {
  const currentVersion = app.getVersion();
  const targetVersion = pendingUpdateVersion;

  if (!targetVersion) {
    logger?.error('safeQuitAndInstall called but no pending update version');
    sendToRenderer('update:error', { message: 'No update downloaded.' });
    return;
  }

  logger?.info(`Preparing safe update: v${currentVersion} → v${targetVersion}`);

  const prepared = await prepareForUpdate(currentVersion, targetVersion, logger!);
  if (!prepared) {
    logger?.error('Failed to prepare safety backup, aborting update install');
    sendToRenderer('update:error', {
      message: 'Failed to create safety backup. Update aborted — you can retry.',
    });
    return;
  }

  logger?.info('Safety backup created, proceeding with quitAndInstall()');
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
  logger!.info(`Feed URL set to ${apiBase}/api/v1/updates`);
  startScheduledChecks();
}

/** Stop scheduled update checks (called on app quit). */
export function stopAutoUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

/** Get the update logger instance (available after initAutoUpdater or ensureUpdaterReady). */
export function getUpdateLogger(): UpdateLogger | null {
  return logger;
}

/** Get the path to today's update log file. */
export function getUpdateLogPath(): string | null {
  return logger?.getLogPath() ?? null;
}
