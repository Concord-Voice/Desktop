/**
 * API Client - Authenticated fetch wrapper with automatic token refresh
 *
 * Wraps native fetch to:
 * - Auto-inject Authorization header from authStore
 * - Include credentials (cookies) for refresh token
 * - On 401, attempt token refresh via /api/v1/auth/refresh
 * - Retry the original request once with the new token
 * - If refresh fails, clear tokens (triggers logout redirect)
 */

import { useAuthStore } from '../stores/authStore';
import { API_BASE } from '../config';

export { API_BASE };

let refreshPromise: Promise<string | null> | null = null;

/**
 * Attempt to refresh the access token using the httpOnly refresh cookie.
 * Deduplicates concurrent refresh attempts.
 */
async function refreshAccessToken(): Promise<string | null> {
  // If a refresh is already in flight, piggyback on it
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) {
        return null;
      }

      const data = await res.json();
      const newToken = data.access_token;

      if (newToken) {
        useAuthStore.getState().setTokens(newToken, undefined);
        return newToken as string;
      }

      return null;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Authenticated fetch wrapper.
 *
 * Usage: `apiFetch('/api/v1/messages/123', { method: 'PATCH', body: ... })`
 *
 * - Automatically adds Authorization header
 * - Automatically includes credentials (cookies)
 * - On 401, refreshes token and retries once
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

  // Attempt token refresh
  const newToken = await refreshAccessToken();
  if (!newToken) {
    // Refresh failed — clear auth (triggers logout)
    useAuthStore.getState().clearTokens();
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
