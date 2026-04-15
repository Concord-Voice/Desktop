import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { scrubEvent, scrubBreadcrumb } from '../shared/sentry-scrubbers';
import { SENTRY_DSN } from '../shared/sentry-config.generated';
import { readTelemetryConsent } from './telemetryConsent';
import {
  computeClientId,
  getPlatformRetrievers,
  makeFallbackId,
  type ClientIdResult,
} from './clientId';

let cachedClientId: ClientIdResult | null = null;

/**
 * Return the ClientIdResult cached by initSentry. Throws if called before
 * initSentry has resolved — this is intentional to surface startup ordering
 * bugs rather than silently returning a stale or missing value.
 */
export function getClientId(): ClientIdResult {
  if (!cachedClientId) {
    throw new Error('getClientId called before initSentry — check startup ordering');
  }
  return cachedClientId;
}

/**
 * Initialize Sentry for the main process. Pre-login, the user.id is set to
 * a per-launch random fallback identifier — matching the spec's two-tier
 * anonymous-session behavior. After login completes, upgradeSentryUserId()
 * swaps the tag forward to the stable userUUID+hardware hash.
 *
 * If clientId computation later fails on upgrade (retriever throws or
 * returns a sentinel), the fallback path stays in effect — still safe, no
 * event goes out untagged.
 */
export async function initSentry(): Promise<void> {
  const sentryEnvironment =
    process.env.SENTRY_ENVIRONMENT ||
    process.env.NODE_ENV ||
    (app.isPackaged ? 'production' : 'development');
  const consentState = readTelemetryConsent();
  const sentryEnabled =
    process.env.SENTRY_ENABLED == null
      ? consentState.telemetryOptIn && Boolean(SENTRY_DSN) && sentryEnvironment === 'production'
      : process.env.SENTRY_ENABLED.toLowerCase() === 'true';

  // Pre-login: always start with a per-launch random fallback identifier.
  // This tags any crash that happens before the user authenticates.
  const result: ClientIdResult = { kind: 'fallback', id: makeFallbackId() };
  cachedClientId = result;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: sentryEnvironment,
    enabled: sentryEnabled,
    release: `concord-desktop@${app.getVersion()}`,
    sampleRate: 1,
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    initialScope: {
      user: { id: result.id },
    },
  });

  Sentry.addBreadcrumb({
    category: 'sentry.init',
    level: 'info',
    data: { fallback: result.kind === 'fallback' },
  });
}

/**
 * Upgrade the Sentry user.id from the per-launch random fallback to the
 * stable `sha256(userUUID + diskVolumeUUID + motherboardSerial).slice(0, 32)`
 * identifier. Called after login completes and a verified user UUID is
 * available. Idempotent-safe — calling repeatedly with the same UUID is a
 * no-op beyond re-emitting the upgrade breadcrumb.
 *
 * Broadcasts `sentry:clientIdUpgraded` to all renderer webContents so each
 * renderer can re-fetch its clientId and call Sentry.setUser on its own
 * client.
 */
export async function upgradeSentryUserId(userUUID: string): Promise<void> {
  const { disk, mobo } = getPlatformRetrievers(process.platform);
  const result = await computeClientId(userUUID, disk, mobo);
  cachedClientId = result;

  Sentry.setUser({ id: result.id });

  Sentry.addBreadcrumb({
    category: 'sentry.clientid.upgraded',
    level: 'info',
    data: { fallback: result.kind === 'fallback' },
  });

  // Broadcast to all renderer processes so they can update their own Sentry
  // client's user tag without re-crossing IPC for the clientId value.
  // Dynamic import avoids pulling BrowserWindow at module-load time — this
  // keeps unit tests that stub only a minimal `electron` export working, and
  // defers the dependency until the upgrade path actually runs.
  const { BrowserWindow } = await import('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('sentry:clientIdUpgraded', { clientId: result.id });
    } catch {
      // webContents may be destroyed; ignore.
    }
  }
}
