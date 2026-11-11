/**
 * The `saas` connection's first-party API origin (#86 Task 7B ruling, DEV-BUILD ORIGIN).
 *
 * Its own module, not part of apiBaseUrl.ts, because selfHostedProfile reads it on every
 * service-id derivation and many suites mock apiBaseUrl wholesale. Only the pin reads
 * `getApiBaseUrl`, and only main calls the pin.
 */
import { app } from 'electron';
import { getApiBaseUrl, PRODUCTION_API_BASE } from './apiBaseUrl';

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
