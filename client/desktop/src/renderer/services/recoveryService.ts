/**
 * Recovery Service — Preflight diagnostics and crash tracking
 *
 * Used by the connection recovery system to determine whether a disconnect
 * is caused by a server issue (Option A) or client issue (Option B).
 */

import { API_BASE } from '../config';
import { refreshAccessToken } from './apiClient';

export interface DiagnosticResults {
  internet: boolean;
  serverReachable: boolean;
  tokenValid: boolean;
  sessionRevoked: boolean;
  rendererStable: boolean;
}

/**
 * Run preflight diagnostics to determine the cause of a connection loss.
 * Checks are run sequentially — each depends on the previous passing.
 */
export async function runPreflight(): Promise<DiagnosticResults> {
  const results: DiagnosticResults = {
    internet: false,
    serverReachable: false,
    tokenValid: false,
    sessionRevoked: false,
    rendererStable: true,
  };

  // 1. Internet check (navigator.onLine + external fetch to confirm real connectivity)
  if (navigator.onLine) {
    try {
      await fetch('https://clients3.google.com/generate_204', {
        mode: 'no-cors',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      results.internet = true;
    } catch {
      /* offline or blocked */
    }
  }

  if (!results.internet) return results;

  // 2. Server reachability (HEAD to API health endpoint)
  try {
    const res = await fetch(`${API_BASE}/api/v1/health`, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    results.serverReachable = res.ok;
  } catch {
    /* server down */
  }

  if (!results.serverReachable) return results;

  // 3. Token validity (attempt refresh via main process IPC)
  try {
    const newToken = await refreshAccessToken();
    results.tokenValid = !!newToken;
    // Refresh failed with server reachable → session was revoked or token expired
    results.sessionRevoked = !newToken;
  } catch {
    results.sessionRevoked = true;
  }

  // 4. Renderer stability (check sessionStorage crash flag)
  results.rendererStable = !sessionStorage.getItem('concord:renderer-crashed');

  return results;
}

/** Record that the renderer crashed (called from error boundary) */
export function markRendererCrashed(): void {
  sessionStorage.setItem('concord:renderer-crashed', Date.now().toString());
}

/** Clear crash flag (called after successful recovery) */
export function clearCrashFlag(): void {
  sessionStorage.removeItem('concord:renderer-crashed');
}
