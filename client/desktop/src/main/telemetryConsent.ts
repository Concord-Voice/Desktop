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
  /**
   * True between eager-revert at launch and the user answering the
   * re-consent dialog. Persisted so a renderer crash mid-dialog does
   * not lose the prompt. Default false.
   */
  pendingReConsent: boolean;
  updatedAt: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────

const CONSENT_DEFAULTS: ConsentState = {
  telemetryOptIn: false,
  firstPromptCompleted: false,
  policyAcknowledgedVersion: 0,
  pendingReConsent: false,
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
      pendingReConsent:
        typeof parsed.pendingReConsent === 'boolean'
          ? parsed.pendingReConsent
          : CONSENT_DEFAULTS.pendingReConsent,
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
  if (typeof obj.pendingReConsent === 'boolean') {
    safe.pendingReConsent = obj.pendingReConsent;
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

/**
 * In-flight mutex for consent:setState. Racing off→on (or on→off) calls
 * would otherwise let a still-pending Sentry.close(0) interfere with a
 * subsequent re-init. The chain is private to this module.
 */
let consentMutex: Promise<void> = Promise.resolve();
function serializeConsent(run: () => Promise<void>): Promise<void> {
  const next = consentMutex.then(run, run);
  // Swallow errors on the mutex chain itself so one failure does not
  // permanently wedge subsequent calls.
  consentMutex = next.catch(() => undefined);
  return next;
}

export function registerConsentIpcHandlers(): void {
  ipcMain.handle('consent:getState', (): ConsentState => {
    return readTelemetryConsent();
  });

  ipcMain.handle('consent:setState', (_event, raw: unknown): Promise<void> => {
    return serializeConsent(async () => {
      const safe = sanitizeConsentUpdates(raw);

      // Capture prior persisted state BEFORE any write so we can detect
      // a true revoked→granted transition for sentry:consentRestored.
      const previousConsent = readTelemetryConsent();

      // Fail-closed: opt-off path performs the teardown BEFORE persisting.
      // If anything throws, the user's intent (disable) is already honored
      // for the current session.
      if (safe.telemetryOptIn === false) {
        // 1. Eager in-memory disable (takes effect immediately for main).
        toggleSentry(false);

        // 2. Zero-timeout close = drop queued in-memory events, then replace
        //    the client with a disabled stub. Subsequent captureException
        //    calls are no-ops.
        try {
          await Sentry.close(0);
        } catch (err) {
          console.warn('[TelemetryConsent] Sentry.close(0) rejected; continuing opt-out:', err);
        }

        // 3. Delete the on-disk offline queue. @sentry/electron writes
        //    envelopes and queue state under `{userData}/sentry/queue/`.
        //    We remove the parent `{userData}/sentry/` dir to tolerate any
        //    future SDK layout changes within that directory.
        //    Directory verified at implementation time against @sentry/electron
        //    v7.11.0 (see esm/main/electron-normalize.js: getSentryCachePath
        //    returns join(app.getPath('userData'), 'sentry')).
        const queueDir = path.join(app.getPath('userData'), 'sentry');
        try {
          await fs.promises.rm(queueDir, { recursive: true, force: true });
        } catch (err) {
          console.warn('[TelemetryConsent] offline queue cleanup failed:', err);
        }
      }

      // 4. Persist.
      try {
        writeTelemetryConsent(safe);
      } catch (err) {
        console.error('[TelemetryConsent] Failed to write consent file:', err);
        throw err; // Propagate to renderer via IPC rejection
      }

      const newState = readTelemetryConsent();

      // 5. If opt-on, restore Sentry enablement on the (still-present) client.
      //    On renderers, a separate sentry:consentRestored broadcast triggers
      //    re-init (see Task 3.4).
      toggleSentry(newState.telemetryOptIn);

      // 6. Broadcast to all open windows (handles PiP + macOS re-open scenarios).
      //    sentry:consentRevoked fires on opt-off so renderer Sentry clients can
      //    close immediately. sentry:consentRestored fires ONLY on a true
      //    revoked→granted transition (previousConsent.telemetryOptIn === false →
      //    new telemetryOptIn === true) so renderers re-init exactly once per
      //    revocation. A redundant opt-in update on an already-opted-in account
      //    must NOT trigger a spurious renderer Sentry re-init.
      const wasOptOff = safe.telemetryOptIn === false;
      const wasTrueTransition =
        safe.telemetryOptIn === true && previousConsent.telemetryOptIn === false;
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send('consent:changed', newState);
        if (wasOptOff) {
          win.webContents.send('sentry:consentRevoked');
        } else if (wasTrueTransition) {
          win.webContents.send('sentry:consentRestored');
        }
      }
    });
  });
}
