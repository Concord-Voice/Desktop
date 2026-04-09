import * as Sentry from '@sentry/electron/renderer';
import { scrubEvent, scrubBreadcrumb } from '../shared/sentry-scrubbers';

const sentryConfig = globalThis.electron?.sentry;

if (sentryConfig?.dsn) {
  // Defer full init until version is available so `release` is set correctly
  // for source map resolution (setTag alone doesn't work for source maps).
  globalThis.electron
    .getVersion()
    .then((version: string) => {
      Sentry.init({
        dsn: sentryConfig.dsn,
        environment: sentryConfig.environment,
        enabled: sentryConfig.enabled,
        release: `concord-desktop@${version}`,
        // 100% error capture during beta — tune down before GA once baseline rates are established.
        sampleRate: 1,
        // Tracing disabled until a beforeSendTransaction scrubber is implemented.
        // Transaction events bypass beforeSend and would reach Sentry unscrubbed.
        tracesSampleRate: 0,
        beforeSend: scrubEvent,
        beforeBreadcrumb: scrubBreadcrumb,
      });
    })
    .catch(() => {
      // Fallback: init without release if version fetch fails
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
    });
}
