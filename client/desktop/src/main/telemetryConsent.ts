/**
 * Telemetry Consent — Main process consent file I/O and IPC handlers
 *
 * Persists user telemetry consent as a plain JSON file at:
 *   {userData}/telemetry-consent.json
 *
 * Plain JSON (not encrypted) — consent is not sensitive data. The file must
 * be readable synchronously at startup, before Sentry.init() runs.
 *
 * Architecture:
 * - readTelemetryConsent(): sync read, validates each field type individually,
 *   returns fail-closed defaults for missing/corrupt file
 * - writeTelemetryConsent(): merge-write — read current, spread updates, stamp updatedAt;
 *   throws on write failure so callers can propagate the error via IPC
 * - registerConsentIpcHandlers(): wires consent:getState / consent:setState IPC channels;
 *   call once at app init — NOT inside createWindow (avoids duplicate registration on macOS)
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import * as Sentry from '@sentry/electron/main';
import path from 'node:path';
import fs from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────────

export interface ConsentState {
  telemetryOptIn: boolean;
  firstPromptCompleted: boolean;
  policyAcknowledgedVersion: number;
  updatedAt: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────

const CONSENT_DEFAULTS: ConsentState = {
  telemetryOptIn: false,
  firstPromptCompleted: false,
  policyAcknowledgedVersion: 0,
  updatedAt: null,
};

const CONSENT_FILE = path.join(app.getPath('userData'), 'telemetry-consent.json');

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Synchronously read the consent file.
 *
 * Validates each field type individually (fail-closed): if a field is missing
 * or has the wrong type it falls back to the default. Returns all defaults if
 * the file does not exist or contains invalid JSON.
 */
export function readTelemetryConsent(): ConsentState {
  try {
    const raw = fs.readFileSync(CONSENT_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return {
      telemetryOptIn:
        typeof parsed.telemetryOptIn === 'boolean'
          ? parsed.telemetryOptIn
          : CONSENT_DEFAULTS.telemetryOptIn,
      firstPromptCompleted:
        typeof parsed.firstPromptCompleted === 'boolean'
          ? parsed.firstPromptCompleted
          : CONSENT_DEFAULTS.firstPromptCompleted,
      policyAcknowledgedVersion:
        typeof parsed.policyAcknowledgedVersion === 'number'
          ? parsed.policyAcknowledgedVersion
          : CONSENT_DEFAULTS.policyAcknowledgedVersion,
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : CONSENT_DEFAULTS.updatedAt,
    };
  } catch (err: unknown) {
    // ENOENT (file not found) is expected on first launch — silent.
    // All other errors (corrupt JSON, permission denied, etc.) get a warning.
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isEnoent) {
      console.warn('[TelemetryConsent] Failed to read consent file, using defaults:', err);
    }
    return { ...CONSENT_DEFAULTS };
  }
}

/**
 * Merge-write consent updates to disk.
 *
 * Reads the current state first, applies updates on top, then stamps updatedAt
 * with the current ISO timestamp before writing.
 *
 * Throws on write failure — callers should catch and propagate via IPC rejection.
 * The `updatedAt` field is always stamped here; renderers must not supply it.
 */
export function writeTelemetryConsent(updates: Partial<ConsentState>): void {
  const current = readTelemetryConsent();
  const merged: ConsentState = { ...current, ...updates, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CONSENT_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Register IPC handlers for renderer ↔ main consent sync.
 *
 * IMPORTANT: Call once at app initialisation (in app.whenReady), NOT inside
 * createWindow(). On macOS, createWindow() runs again when the dock icon is
 * clicked after all windows are closed; ipcMain.handle() throws on duplicate
 * registration.
 *
 * Channels:
 * - consent:getState  → returns current ConsentState
 * - consent:setState  → validates + merges Partial<ConsentState>, toggles Sentry
 *                       enabled flag, broadcasts consent:changed to all windows
 */
/**
 * Validate and sanitize renderer-supplied consent updates.
 *
 * Strips unexpected keys and wrong-type fields. `updatedAt` is never accepted
 * from the renderer — it is always stamped by writeTelemetryConsent.
 */
function sanitizeConsentUpdates(raw: unknown): Partial<ConsentState> {
  const safe: Partial<ConsentState> = {};
  if (raw === null || typeof raw !== 'object') return safe;

  const obj = raw as Record<string, unknown>;
  if (typeof obj.telemetryOptIn === 'boolean') safe.telemetryOptIn = obj.telemetryOptIn;
  if (typeof obj.firstPromptCompleted === 'boolean') {
    safe.firstPromptCompleted = obj.firstPromptCompleted;
  }
  if (typeof obj.policyAcknowledgedVersion === 'number') {
    safe.policyAcknowledgedVersion = obj.policyAcknowledgedVersion;
  }
  return safe;
}

/**
 * Toggle the main-process Sentry client's enabled flag.
 *
 * Respects SENTRY_ENABLED env override — when set, consent cannot override it
 * (used for dev/test bypass).
 */
function toggleSentry(enabled: boolean): void {
  if (process.env.SENTRY_ENABLED != null) return;
  const client = Sentry.getClient();
  if (client) {
    client.getOptions().enabled = enabled;
  }
}

export function registerConsentIpcHandlers(): void {
  ipcMain.handle('consent:getState', (): ConsentState => {
    return readTelemetryConsent();
  });

  ipcMain.handle('consent:setState', (_event, raw: unknown): void => {
    const safe = sanitizeConsentUpdates(raw);

    // Fail-closed: for opt-out, disable Sentry eagerly BEFORE attempting the write.
    // This ensures the current session respects the opt-out even if the file
    // write subsequently fails — crash data stops flowing immediately on user intent.
    if (safe.telemetryOptIn === false) {
      toggleSentry(false);
    }

    try {
      writeTelemetryConsent(safe);
    } catch (err) {
      console.error('[TelemetryConsent] Failed to write consent file:', err);
      throw err; // Propagate to renderer via IPC rejection
    }

    const newState = readTelemetryConsent();

    // Toggle Sentry based on persisted state (handles opt-in; opt-out already
    // applied eagerly above).
    toggleSentry(newState.telemetryOptIn);

    // Broadcast to all open windows (handles PiP + macOS re-open scenarios)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('consent:changed', newState);
      }
    }
  });
}
