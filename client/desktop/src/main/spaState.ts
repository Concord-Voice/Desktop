/**
 * Shared module-scope state for the active remote SPA load.
 *
 * `remoteSpaBaseUrl` is the origin (scheme + host + port). `remoteSpaUrl` is
 * the full URL including the `/spa/<sha>/index.html` path. Both are written
 * atomically via `setRemoteSpaState()` so origin-only readers and full-URL
 * readers never see divergent state.
 *
 * Origin-only readers: openExternalHandler, SSOIPC, will-navigate origin
 * guard, did-fail-load self-heal filter (#753), spa:requestSelfHeal IPC
 * sender-frame validator (#753).
 * Full-URL reader: PiP window URL construction. Origin alone strips the
 * `/spa/<sha>/` path required by nginx, causing fallthrough to the
 * marketing-site catch-all (#802).
 *
 * Single-threaded JS event-loop semantics make reads at trigger time atomic
 * w.r.t. writes.
 */

let remoteSpaBaseUrl: string | null = null;
let remoteSpaUrl: string | null = null;

type SpaStateListener = (url: string | null) => void;
const listeners = new Set<SpaStateListener>();

export function getRemoteSpaBaseUrl(): string | null {
  return remoteSpaBaseUrl;
}

export function getRemoteSpaUrl(): string | null {
  return remoteSpaUrl;
}

/**
 * Subscribe to SPA state changes. Listener is invoked synchronously with the
 * full URL (or null) whenever `setRemoteSpaState` runs. Returns an
 * unsubscribe function.
 *
 * Listeners are NOT wrapped in try/catch; throwing in a listener propagates
 * to the caller of setRemoteSpaState. This is intentional per
 * internal-reference — silent error swallowing in main-process
 * code is forbidden.
 */
export function onSpaStateChange(listener: SpaStateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ─── SPA attestation capture state (Task 17 / #677) ─────────────────────────
// These singletons record the hash of the entry HTML bytes the client loaded
// and the SPA version string. A later task reads them when assembling the
// attestation request payload.
//
// Note: an earlier iteration also tracked a loader-mode singleton (remote
// vs bundled), but the dual-hash → single-hash collapse (see the
// 2026-05-31 reconciliation spec for #677) made the loader mode dead weight
// on the attestation wire. The mode DECISION (remote vs bundled) still
// lives in spaLoader.ts and drives delivery selection — only its
// attestation export was removed.

let spaHash = '';
let spaVersion = '';

export function setSpaHash(h: string): void {
  spaHash = h;
}
export function getSpaHash(): string {
  return spaHash;
}
export function setSpaVersion(v: string): void {
  spaVersion = v;
}
export function getSpaVersion(): string {
  return spaVersion;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically set or clear both SPA-state variables. Pass a valid URL to set
 * both (origin extracted via `new URL(decisionUrl).origin`); pass `null` to
 * clear both. If URL parsing throws, both are cleared (treat malformed input
 * as bundled-mode fallback — same posture as the original loadPackagedRenderer
 * catch path).
 */
export function setRemoteSpaState(decisionUrl: string | null): void {
  if (decisionUrl === null) {
    remoteSpaBaseUrl = null;
    remoteSpaUrl = null;
  } else {
    try {
      remoteSpaBaseUrl = new URL(decisionUrl).origin;
      remoteSpaUrl = decisionUrl;
    } catch {
      remoteSpaBaseUrl = null;
      remoteSpaUrl = null;
    }
  }
  listeners.forEach((l) => l(remoteSpaUrl));
}
