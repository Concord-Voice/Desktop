import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { scrubEvent, scrubBreadcrumb } from '../shared/sentry-scrubbers';
import { SENTRY_DSN } from '../shared/sentry-config.generated';
import { readTelemetryConsent } from './telemetryConsent';

const sentryEnvironment =
  process.env.SENTRY_ENVIRONMENT ||
  process.env.NODE_ENV ||
  (app.isPackaged ? 'production' : 'development');
const consentState = readTelemetryConsent();
const sentryEnabled =
  process.env.SENTRY_ENABLED == null
    ? consentState.telemetryOptIn && Boolean(SENTRY_DSN) && sentryEnvironment === 'production'
    : process.env.SENTRY_ENABLED.toLowerCase() === 'true';

Sentry.init({
  dsn: SENTRY_DSN,
  environment: sentryEnvironment,
  enabled: sentryEnabled,
  release: `concord-desktop@${app.getVersion()}`,
  // 100% error capture during beta — tune down before GA once baseline rates are established.
  sampleRate: 1,
  // Tracing disabled until a beforeSendTransaction scrubber is implemented.
  // Transaction events bypass beforeSend and would reach Sentry unscrubbed.
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
