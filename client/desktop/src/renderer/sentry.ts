import * as Sentry from '@sentry/electron/renderer';
import { scrubEvent, scrubBreadcrumb } from '../shared/sentry-scrubbers';

const sentryConfig = globalThis.electron?.sentry;

if (sentryConfig?.dsn) {
  // Init immediately so errors during initial render are captured.
  // Release tag is added asynchronously once the version is available;
  // early events may not resolve source maps but won't be lost.
  Sentry.init({
    dsn: sentryConfig.dsn,
    environment: sentryConfig.environment,
    enabled: sentryConfig.enabled,
    // 100% error capture during beta — tune down before GA once baseline rates are established.
    sampleRate: 1,
    // Tracing disabled until a beforeSendTransaction scrubber is implemented.
    // Transaction events bypass beforeSend and would reach Sentry unscrubbed.
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });

  // Fetch version and stamp release on all subsequent events via the client options.
  globalThis.electron
    .getVersion()
    .then((version: string) => {
      const client = Sentry.getClient();
      if (client) {
        client.getOptions().release = `concord-desktop@${version}`;
      }
    })
    .catch((err: unknown) => {
      console.warn('[sentry] Failed to fetch app version for release tag:', err);
      // Sentry is already initialized — events will be captured but
      // stack traces may not resolve source maps without a release tag.
    });
}

// Listen for consent changes from the main process and toggle Sentry at runtime.
// This handles both the initial consent dialog and Settings toggle changes.
// Note: toggling `enabled` on a client initialized with enabled=false works for
// @sentry/electron as of v8 but is not part of the documented SDK API contract.
// The main process Sentry is the primary crash capture path; renderer Sentry
// supplements it for React-specific errors.
// The renderer follows the preload's sentry config for the SENTRY_ENABLED override.
// If the override was set, consent changes should not toggle Sentry.
const sentryOverrideActive =
  sentryConfig != null && typeof process !== 'undefined' && process.env?.SENTRY_ENABLED != null;
if (globalThis.electron?.onConsentChanged && !sentryOverrideActive) {
  globalThis.electron.onConsentChanged((state) => {
    const client = Sentry.getClient();
    if (client) {
      client.getOptions().enabled = state.telemetryOptIn;
    }
  });
}
