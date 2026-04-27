/**
 * Pure helpers for the main-process did-fail-load listener and the
 * spa:requestSelfHeal IPC handler. Originally extracted just for filter
 * testability, then expanded (#753 reconciliation finding TA3) to also
 * own the handler bodies so the wiring is unit-testable in isolation
 * from BrowserWindow / Electron event-loop instantiation.
 *
 * `main.ts` registers the actual `app.on('web-contents-created')` and
 * `ipcMain.handle('spa:requestSelfHeal')` callbacks, which are now thin
 * adapters that unpack Electron's event-args, populate plain-data
 * structures, and delegate to the handlers below.
 */

import { isRendererSelfHealRequest } from '../shared/spaIpcTypes';
import { SPA_CHUNK_URL_PATTERN, SPA_URL_PATTERN } from '../shared/spaUrlPattern';
import { attemptSelfHeal, type SelfHealOutcome } from './spaSelfHeal';

export interface DidFailLoadFilterArgs {
  errorCode: number;
  validatedURL: string;
  isMainFrame: boolean;
  remoteSpaBaseUrl: string | null;
}

export function shouldTriggerSelfHealForFailedLoad(args: DidFailLoadFilterArgs): boolean {
  // -3 ABORTED — user-initiated nav cancellation, common during fast nav.
  // Excluding this prevents denial-of-self-heal-budget via deliberate nav storms.
  if (args.errorCode === -3) return false;

  // No active SPA URL — we're already in bundled mode, nothing to recover to.
  if (!args.remoteSpaBaseUrl) return false;

  if (args.isMainFrame) {
    // Main-frame failure: the very index.html is unreachable. We want to
    // trigger ONLY when the failed URL is an SPA-shaped URL on the active
    // SPA origin — origin-equality alone would also match same-origin
    // non-SPA pages (e.g., PiP windows loading `<origin>#/pip/...` which has
    // pathname `/`, hash routes, the apex-redirect target). Those should
    // not consume the self-heal retry budget.
    if (!SPA_URL_PATTERN.test(args.validatedURL)) return false;
    let validatedOrigin: string;
    try {
      validatedOrigin = new URL(args.validatedURL).origin;
    } catch {
      return false;
    }
    return validatedOrigin === args.remoteSpaBaseUrl;
  }

  // Sub-resource failure: trigger only on chunk-shaped URLs from the
  // active SPA origin. SPA_CHUNK_URL_PATTERN is host-agnostic, so without
  // the origin check a failed cross-origin load like
  // `https://evil.example.com/spa/abc1234/assets/x.js` would falsely
  // consume self-heal budget. Mirrors the origin check in the main-frame
  // branch above.
  if (!SPA_CHUNK_URL_PATTERN.test(args.validatedURL)) return false;
  let subResourceOrigin: string;
  try {
    subResourceOrigin = new URL(args.validatedURL).origin;
  } catch {
    return false;
  }
  return subResourceOrigin === args.remoteSpaBaseUrl;
}

export interface SenderFrameValidationArgs {
  senderFrameUrl: string;
  remoteSpaBaseUrl: string | null;
}

export function validateSelfHealSenderFrame(args: SenderFrameValidationArgs): boolean {
  if (!args.senderFrameUrl || !args.remoteSpaBaseUrl) return false;

  // Sender frame URL must be SPA-shaped. Origin-only matching would accept
  // any non-SPA same-origin page (PiP windows, hash routes, the
  // origin-root) as a legitimate self-heal trigger source. The trust
  // boundary is "SPA bundle code requesting recovery", not "any code on
  // the SPA's origin", so we tighten the validator to require the sender's
  // pathname to match the SPA shape `/spa/<sha7>/...`.
  if (!SPA_URL_PATTERN.test(args.senderFrameUrl)) return false;

  // `remoteSpaBaseUrl` is already an origin string (main.ts sets it via
  // `new URL(decision.url).origin` when the SPA loads). We parse
  // `senderFrameUrl`, take its origin, and compare directly.
  let senderOrigin: string;
  try {
    senderOrigin = new URL(args.senderFrameUrl).origin;
  } catch {
    return false;
  }

  return senderOrigin === args.remoteSpaBaseUrl;
}

/**
 * IPC handler body for `spa:requestSelfHeal`. Validates the sender frame,
 * validates the payload, and dispatches to `attemptSelfHeal`. Returns the
 * recovery outcome on success, or `null` on rejection (logged but not
 * re-thrown — the renderer's `?.catch(() => {})` would swallow it anyway).
 *
 * Extracted from main.ts so the trust-boundary wiring is unit-testable
 * without standing up an `ipcMain` mock or BrowserWindow.
 */
export async function handleSpaRequestSelfHeal(args: {
  senderFrameUrl: string;
  payload: unknown;
  remoteSpaBaseUrl: string | null;
}): Promise<SelfHealOutcome | null> {
  if (
    !validateSelfHealSenderFrame({
      senderFrameUrl: args.senderFrameUrl,
      remoteSpaBaseUrl: args.remoteSpaBaseUrl,
    })
  ) {
    console.warn('[main] spa:requestSelfHeal rejected — sender frame not from active SPA origin');
    return null;
  }

  if (!isRendererSelfHealRequest(args.payload)) {
    console.warn('[main] spa:requestSelfHeal rejected — payload not a valid renderer request');
    return null;
  }

  return attemptSelfHeal({ reason: args.payload.reason, url: args.payload.url });
}

/**
 * Listener body for `webContents.on('did-fail-load', ...)`. Filters for
 * SPA-relevant failures (excluding errorCode -3 ABORTED, requiring the
 * failed URL to be SPA-shaped, etc.) and dispatches to `attemptSelfHeal`
 * with the appropriate reason. Returns the recovery outcome on dispatch,
 * or `null` if the filter rejected the event.
 *
 * Extracted from main.ts for the same reason as `handleSpaRequestSelfHeal`.
 */
export async function handleDidFailLoad(args: {
  errorCode: number;
  validatedURL: string;
  isMainFrame: boolean;
  remoteSpaBaseUrl: string | null;
}): Promise<SelfHealOutcome | null> {
  const trigger = shouldTriggerSelfHealForFailedLoad(args);
  if (!trigger) return null;

  return attemptSelfHeal({
    reason: args.isMainFrame ? 'main-frame-load' : 'sub-resource',
    url: args.validatedURL,
    errorCode: args.errorCode,
  });
}
