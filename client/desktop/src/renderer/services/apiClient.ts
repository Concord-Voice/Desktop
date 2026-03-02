/**
 * API Client - Authenticated fetch wrapper with automatic token refresh
 *
 * Wraps native fetch to:
 * - Auto-inject Authorization header from authStore
 * - On 401, attempt token refresh via main process IPC
 * - Retry the original request once with the new token
 * - If refresh fails, clear tokens (triggers logout redirect)
 *
 * The refresh token never enters the renderer process — the main process
 * handles refresh via safeStorage-encrypted token + net.fetch().
 */

import { useAuthStore } from '../stores/authStore';
import { API_BASE } from '../config';

export { API_BASE };

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
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = useAuthStore.getState().accessToken;

  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
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

  // Attempt token refresh via main process (deduplicated at renderer level)
  const newToken = await refreshAccessToken();
  if (!newToken) {
    // Refresh failed — but only trigger logout once. Another concurrent caller
    // may have already cleared auth while we were awaiting the shared promise.
    if (useAuthStore.getState().accessToken) {
      const { gracefulReset, nuclearReset } = await import('./resetService');
      if (useAuthStore.getState().rememberMe) {
        gracefulReset();
      } else {
        nuclearReset();
      }
      useAuthStore.getState().clearAccessToken();
      window.electron?.clearTokens?.();
    }
    return response; // Return the original 401
  }

  // Retry with new token
  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set('Authorization', `Bearer ${newToken}`);

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: retryHeaders,
    credentials: 'include',
  });
}
