/**
 * API Client - Authenticated fetch wrapper with automatic token refresh
 *
 * Wraps native fetch to:
 * - Auto-inject Authorization header from authStore
 * - Proactively refresh the access token ~60s before JWT expiry (#240)
 * - On 401, attempt token refresh via main process IPC and retry once
 * - If refresh fails, clear tokens (triggers logout redirect)
 * - Rate-limit refresh calls to max 1 per 10s to prevent hammering
 *
 * The refresh token never enters the renderer process — the main process
 * handles refresh via safeStorage-encrypted token + net.fetch().
 */

import { useAuthStore } from '../stores/authStore';
import { API_BASE } from '../config';

export { API_BASE };

// ─── Machine ID cache (for X-Machine-Id header, #89) ─────────────────
let cachedMachineId: string | null = null;

export async function ensureMachineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;
  if (window.electron?.getMachineId) {
    cachedMachineId = await window.electron.getMachineId();
  }
  return cachedMachineId ?? '';
}

/** Synchronous accessor — returns '' until ensureMachineId() resolves */
export function getMachineIdSync(): string {
  return cachedMachineId ?? '';
}

// ─── Proactive Token Refresh (#240-A) ────────────────────────────────
// Decode JWT exp claim and schedule refresh ~60s before expiry.
// This prevents 401s in normal operation — the reactive 401 handler below
// is belt-and-suspenders for clock skew, server restarts, etc.

const REFRESH_BUFFER_SECONDS = 60; // Refresh 60s before expiry
const MIN_REFRESH_INTERVAL_MS = 10_000; // Rate limit: max 1 refresh per 10s (#240-D)

let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefreshTimestamp = 0;

/**
 * Decode the `exp` claim from a JWT access token without a library.
 * JWTs are base64url-encoded — no secret needed to read the payload.
 * Returns the Unix timestamp (seconds) or null if parsing fails.
 */
function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // base64url → base64 → decode (with padding)
    let payload = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    // Pad to multiple of 4 — atob() requires proper padding
    const pad = payload.length % 4;
    if (pad === 2) payload += '==';
    else if (pad === 3) payload += '=';
    const json = atob(payload);
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

/**
 * Schedule a proactive token refresh based on the JWT's exp claim.
 * Called automatically whenever a new access token is set in authStore.
 */
function scheduleProactiveRefresh(token: string | null): void {
  // Clear any existing timer
  if (proactiveRefreshTimer) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }

  if (!token) return;

  const exp = decodeJwtExp(token);
  if (!exp) return;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const delaySeconds = exp - nowSeconds - REFRESH_BUFFER_SECONDS;

  if (delaySeconds <= 0) {
    // Token already expired or about to — refresh immediately (rate-limited).
    // If rate-limited, schedule a retry after the cooldown window.
    rateLimitedRefresh().then((result) => {
      if (result === null && useAuthStore.getState().accessToken === token) {
        // Rate-limited and token unchanged — retry after cooldown
        proactiveRefreshTimer = setTimeout(() => {
          proactiveRefreshTimer = null;
          void rateLimitedRefresh();
        }, MIN_REFRESH_INTERVAL_MS);
      }
    });
    return;
  }

  proactiveRefreshTimer = setTimeout(() => {
    proactiveRefreshTimer = null;
    void rateLimitedRefresh();
  }, delaySeconds * 1000);
}

/**
 * Perform a refresh with rate limiting (max 1 per 10s).
 * Prevents hammering the server if tokens are very short-lived or clock is skewed.
 */
async function rateLimitedRefresh(): Promise<string | null> {
  const now = Date.now();
  if (now - lastRefreshTimestamp < MIN_REFRESH_INTERVAL_MS) {
    return null;
  }
  lastRefreshTimestamp = now;
  return refreshAccessToken();
}

/** Stop proactive refresh (called on logout/cleanup). */
export function stopProactiveRefresh(): void {
  if (proactiveRefreshTimer) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }
}

/** Reset rate limiter state (for tests only). */
export function _resetRefreshState(): void {
  lastRefreshTimestamp = 0;
  stopProactiveRefresh();
}

// Subscribe to authStore: whenever accessToken changes, reschedule proactive refresh.
// This fires on login, token refresh, and logout (null).
let _prevToken: string | null = null;
const _unsubscribeAuthStore = useAuthStore.subscribe((state) => {
  if (state.accessToken !== _prevToken) {
    _prevToken = state.accessToken;
    scheduleProactiveRefresh(state.accessToken);
  }
});

// ─── Main Process Proactive Refresh (#254) ───────────────────────────
// The main process schedules its own proactive timer (immune to Chromium
// throttling). When it refreshes, it pushes the new token here via IPC.
let _unsubscribeTokenRefreshed: (() => void) | undefined;
if (window.electron?.onTokenRefreshed) {
  _unsubscribeTokenRefreshed = window.electron.onTokenRefreshed((data) => {
    useAuthStore.getState().setAccessToken(data.accessToken);
    if (data.sessionId) useAuthStore.getState().setSessionId(data.sessionId);
  });
}

// Clean up subscription on Vite HMR to prevent duplicate subscriptions/timers
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _unsubscribeAuthStore();
    _unsubscribeTokenRefreshed?.();
    stopProactiveRefresh();
  });
}

// ─── Renderer-level refresh deduplication ────────────────────────────
/**
 * Renderer-level refresh deduplication.
 *
 * When multiple apiFetch calls get 401 simultaneously (e.g. channel read +
 * StrictMode double-mount message fetches), they all try to refresh. Without
 * dedup, even though the main process deduplicates the actual HTTP call, the
 * "refresh failed → logout" path can fire multiple times or a second call can
 * race with the first's token rotation.
 *
 * This promise is shared: concurrent callers await the same in-flight refresh.
 */
let rendererRefreshPromise: Promise<string | null> | null = null;

/**
 * Attempt to refresh the access token via the main process IPC.
 * The main process holds the refresh token securely and makes the HTTP call.
 * Concurrent calls from the renderer are deduplicated.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (rendererRefreshPromise) {
    return rendererRefreshPromise;
  }

  rendererRefreshPromise = (async () => {
    if (!window.electron?.refreshToken) return null;

    const result = await window.electron.refreshToken();
    if (result.status === 'ok' && result.accessToken) {
      useAuthStore.getState().setAccessToken(result.accessToken);
      if (result.sessionId) useAuthStore.getState().setSessionId(result.sessionId);
      return result.accessToken;
    }

    // Handle suspicious session MFA challenge
    if (result.status === 'mfa_required' && result.mfaChallengeToken) {
      const { useMFAChallengeStore } = await import('../stores/mfaChallengeStore');
      const verified = await useMFAChallengeStore
        .getState()
        .showChallenge(
          result.mfaChallengeToken,
          result.mfaMethods || [],
          'suspicious_refresh',
          result.mfaRecoveryOnlyMethods || []
        );
      if (verified) {
        // MFA verified — retry the refresh
        const retryResult = await window.electron.refreshToken();
        if (retryResult.status === 'ok' && retryResult.accessToken) {
          useAuthStore.getState().setAccessToken(retryResult.accessToken);
          if (retryResult.sessionId) useAuthStore.getState().setSessionId(retryResult.sessionId);
          return retryResult.accessToken;
        }
      }
    }

    return null;
  })();

  try {
    return await rendererRefreshPromise;
  } finally {
    rendererRefreshPromise = null;
  }
}

/**
 * Authenticated fetch wrapper.
 *
 * Usage: `apiFetch('/api/v1/messages/123', { method: 'PATCH', body: ... })`
 *
 * - Automatically adds Authorization header
 * - On 401, refreshes token via main process IPC and retries once
 * - Paths are relative to API_BASE (pass full path starting with /)
 */
/**
 * Safely parse a JSON response, handling non-JSON responses (e.g. Cloudflare HTML pages).
 * Throws a descriptive error instead of a cryptic "Unexpected token '<'" SyntaxError.
 */
export async function safeJson<T = unknown>(res: Response): Promise<T> {
  const contentType = res.headers.get('Content-Type') || '';
  // Accept application/json, application/problem+json, application/vnd.api+json, etc.
  if (!contentType.includes('json')) {
    const text = await res.text().catch(() => '');
    const preview = text.slice(0, 120);
    throw new Error(
      `Expected JSON but got ${contentType || 'unknown'} (HTTP ${res.status}): ${preview}`
    );
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`Invalid JSON in response (HTTP ${res.status}, Content-Type: ${contentType})`);
  }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = useAuthStore.getState().accessToken;

  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const mid = getMachineIdSync();
  if (mid) {
    headers.set('X-Machine-Id', mid);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  // If not 401, return as-is
  if (response.status !== 401) {
    return response;
  }

  // If auth has already been cleared (e.g. a concurrent 401 handler already
  // triggered logout), don't attempt another refresh — just return the 401.
  if (!useAuthStore.getState().accessToken) {
    return response;
  }

  // Attempt token refresh via main process (deduplicated + rate-limited).
  // If a refresh is already in-flight, await it (dedup) regardless of rate limit.
  // Only rate-limit the *initiation* of new refreshes.
  let newToken: string | null = null;
  if (rendererRefreshPromise) {
    // Another 401 handler already started a refresh — piggyback on it
    newToken = await rendererRefreshPromise;
  } else {
    const now = Date.now();
    if (now - lastRefreshTimestamp < MIN_REFRESH_INTERVAL_MS) {
      // Recently refreshed and no in-flight refresh — likely token revocation
      return response;
    }
    lastRefreshTimestamp = now;
    newToken = await refreshAccessToken();
  }
  if (!newToken) {
    // Refresh failed — but only trigger logout once. Another concurrent caller
    // may have already cleared auth while we were awaiting the shared promise.
    if (useAuthStore.getState().accessToken) {
      // If recovery system is already handling this disconnect, don't double-reset
      const { useConnectionStore } = await import('../stores/connectionStore');
      const phase = useConnectionStore.getState().phase;
      if (phase !== 'stable') {
        useAuthStore.getState().clearAccessToken();
        return response;
      }

      const { gracefulReset, nuclearReset } = await import('./resetService');
      if (useAuthStore.getState().rememberMe) {
        gracefulReset();
        // DO NOT clear disk tokens — session can be restored on next launch
      } else {
        nuclearReset(); // already calls clearTokens() internally
      }
      useAuthStore.getState().clearAccessToken();
    }
    return response; // Return the original 401
  }

  // Retry with new token
  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set('Authorization', `Bearer ${newToken}`);
  if (mid) {
    retryHeaders.set('X-Machine-Id', mid);
  }

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: retryHeaders,
    credentials: 'include',
  });
}
