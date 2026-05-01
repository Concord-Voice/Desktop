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

export function getRemoteSpaBaseUrl(): string | null {
  return remoteSpaBaseUrl;
}

export function getRemoteSpaUrl(): string | null {
  return remoteSpaUrl;
}

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
    return;
  }
  try {
    remoteSpaBaseUrl = new URL(decisionUrl).origin;
    remoteSpaUrl = decisionUrl;
  } catch {
    remoteSpaBaseUrl = null;
    remoteSpaUrl = null;
  }
}
