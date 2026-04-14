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
