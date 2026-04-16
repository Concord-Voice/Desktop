import * as Sentry from '@sentry/electron/renderer';
import { scrubEvent, scrubBreadcrumb } from '../shared/sentry-scrubbers';

const sentryConfig = globalThis.electron?.sentry;

/**
 * Build the Sentry.init options for the renderer. Extracted into a
 * function so opt-in after an earlier opt-off can call Sentry.init
 * again without duplicating config.
 */
function renderSentryOptions(): Parameters<typeof Sentry.init>[0] {
  return {
    dsn: sentryConfig?.dsn,
    environment: sentryConfig?.environment,
    enabled: sentryConfig?.enabled ?? false,
    // 100% error capture during beta — tune down before GA once baseline rates are established.
    sampleRate: 1,
    // Tracing disabled until a beforeSendTransaction scrubber is implemented.
    // Transaction events bypass beforeSend and would reach Sentry unscrubbed.
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

// Collect unsubscribes for HMR cleanup (dev only — in production the renderer
// lifecycle is the same as the module lifecycle, so unsubscribes are never needed).
const unsubscribes: Array<() => void> = [];

/**
 * Populate Sentry with renderer-process metadata after (re-)initialization.
 *
 * Called both during the initial DSN-gated setup and inside `onConsentRestored`
 * so that a revoke → restore cycle re-attaches user.id, release, and the
 * clientId-upgraded listener. Without this, post-restore crash reports are
 * missing user.id and release, breaking event correlation and source-map
 * resolution (Sentry Seer finding, PR #682 / issue #661).
 *
 * HMR note: `onClientIdUpgraded` is re-registered on each restore without
 * removing the prior subscription. In production the renderer lifecycle is
 * one-shot so this is harmless; in dev HMR, the outer `import.meta.hot`
 * dispose block (below) cleans up unsubscribes from the *initial* wiring.
 * A second restore during a single dev session would add a duplicate listener,
 * but this is an acceptable trade-off given the rarity of that path in
 * development and the clarity of keeping `setupSentryMetadata` side-effect-free
 * with respect to the unsubscribes array.
 */
function setupSentryMetadata(): void {
  // Fetch clientId from the main process so renderer events carry the same
  // user.id as main-process events. The main process computed this from
  // hardware inputs in initSentry; the renderer just mirrors it.
  globalThis.electron
    .getClientId()
    .then((clientId: string) => Sentry.setUser({ id: clientId }))
    .catch((err: unknown) => {
      console.warn('[sentry] Failed to fetch clientId for renderer user tag:', err);
    });

  // When the main process upgrades from the per-launch fallback to the stable
  // userUUID+hardware hash (post-login), mirror the change in the renderer's
  // own Sentry client so events from both processes carry the same user.id.
  if (globalThis.electron?.onClientIdUpgraded) {
    globalThis.electron.onClientIdUpgraded((clientId: string) => {
      Sentry.setUser({ id: clientId });
    });
  }

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

if (sentryConfig?.dsn) {
  // Init immediately so errors during initial render are captured.
  // Release tag is added asynchronously once the version is available;
  // early events may not resolve source maps but won't be lost.
  Sentry.init(renderSentryOptions());
  setupSentryMetadata();
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

// Note: onConsentChanged (enabled flag flip) co-fires with onConsentRevoked/Restored
// (close/init). The handlers are idempotent and converge — both channels are FIFO
// per-channel but independent across channels; final state is correct regardless of
// arrival order because Sentry.init replaces the client authoritatively.
if (globalThis.electron?.onConsentChanged && !sentryOverrideActive) {
  unsubscribes.push(
    globalThis.electron.onConsentChanged((state) => {
      const client = Sentry.getClient();
      if (client) {
        client.getOptions().enabled = state.telemetryOptIn;
      }
    })
  );
}

// Immediate teardown on opt-off: drops any queued events. The main process
// also handles this for its own client and wipes the on-disk offline queue.
if (globalThis.electron?.onConsentRevoked && !sentryOverrideActive) {
  unsubscribes.push(
    globalThis.electron.onConsentRevoked(() => {
      void Promise.resolve(Sentry.getClient()?.close(0)).catch(() => {
        // best-effort; opt-out already honored via the enabled flag above
      });
    })
  );
}

// Re-init after a previous revocation closed the client.
// setupSentryMetadata() is called again to re-attach user.id, release, and the
// clientId-upgraded listener — all of which are lost when the client is closed.
if (globalThis.electron?.onConsentRestored && !sentryOverrideActive) {
  unsubscribes.push(
    globalThis.electron.onConsentRestored(() => {
      Sentry.init({ ...renderSentryOptions(), enabled: true });
      setupSentryMetadata();
    })
  );
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const unsub of unsubscribes) {
      try {
        unsub();
      } catch {
        // best-effort
      }
    }
  });
}
