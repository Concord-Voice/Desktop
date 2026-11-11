/**
 * Main-process API base URL resolution (#974).
 *
 * The client-driven Apple exchange runs entirely in the main process, which
 * must reach the control plane BEFORE any login has persisted a credential (SSO
 * is a pre-auth flow). Resolution order:
 *
 *   1. Packaged builds: the production SaaS endpoint (single-tenant SaaS).
 *   2. Dev (unpackaged): CONCORD_DEV_API_BASE env override, else the local
 *      control plane on :8080 (mirrors the renderer config.ts default).
 *
 * No step reads a stored credential (#86 Task 7B): which server a handler speaks
 * to is its sender's service origin, never an app-wide "last signed in" base.
 *
 * SSO may also supply an invocation-time API base over IPC, but the SSO
 * handler accepts only this resolved base, the production SaaS origin, or a
 * self-host origin already approved by the main-process probe registry. Raw
 * renderer input never reaches OAuth network calls without that validation.
 */
import { app } from 'electron';

// Exported so the auth-IPC apiBase guard (main.ts `isValidApiBase`) can pin the
// renderer-supplied apiBase to this same single-tenant origin in packaged builds.
// This is an ORIGIN allowlist, not TLS pinning — see main.ts for why the API
// host carries no certificate pin.
export const PRODUCTION_API_BASE = 'https://api.concordvoice.chat';
const DEV_API_BASE = 'http://localhost:8080';

export function getApiBaseUrl(): string {
  if (app.isPackaged) return PRODUCTION_API_BASE;
  return process.env.CONCORD_DEV_API_BASE ?? DEV_API_BASE;
}

const PRODUCTION_API_ORIGIN = new URL(PRODUCTION_API_BASE).origin;

let pinnedFirstPartyOrigin: string | null = null;

function resolveFirstPartyOrigin(): string {
  // Packaged builds read no env at all, so nothing outside the binary can steer them.
  if (app.isPackaged) return PRODUCTION_API_ORIGIN;
  try {
    const url = new URL(getApiBaseUrl());
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
  } catch {
    // Fall through: a malformed dev override pins production, which no local dev
    // server answers. Fail closed rather than guess an origin.
  }
  console.warn('[apiBase] CONCORD_DEV_API_BASE is not an http(s) URL; using production');
  return PRODUCTION_API_ORIGIN;
}

/**
 * The origin of the `saas` connection's first-party control plane (#86 Task 7B ruling,
 * DEV-BUILD ORIGIN): production in packaged builds, the dev base in unpackaged ones.
 *
 * Invariant: resolved once, in main, from `getApiBaseUrl()` alone, then fixed for the
 * life of the process. It takes no argument, so neither a renderer nor an IPC payload
 * can name it, and a later env change cannot move it. What breaks it: a setter that
 * accepts an origin, or a packaged path that reads `process.env`.
 */
export function pinFirstPartyApiOrigin(): string {
  pinnedFirstPartyOrigin ??= resolveFirstPartyOrigin();
  return pinnedFirstPartyOrigin;
}

/** The pinned first-party origin, or production before main has pinned one. */
export function firstPartyApiOrigin(): string {
  return pinnedFirstPartyOrigin ?? PRODUCTION_API_ORIGIN;
}

export function _resetFirstPartyApiOriginForTesting(): void {
  pinnedFirstPartyOrigin = null;
}
