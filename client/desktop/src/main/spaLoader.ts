/**
 * SPA Loader — Adaptive renderer loading for Tier 3 hot updates.
 *
 * On startup (packaged builds only), fetches the server's client config to
 * determine whether to load the renderer from a remote SPA URL or the bundled
 * index.html.
 *
 * Decision flow:
 * 1. Read persisted API base from token metadata (requires prior login)
 * 2. Fetch GET /api/v1/client/config?ipc={contract} with a short timeout
 * 3. If server returns a spaUrl and our contract version is compatible → loadURL(spaUrl)
 * 4. Otherwise → loadFile(bundled index.html)
 *
 * Safety guarantees:
 * - First-time users (no stored token) → always bundled
 * - Server unreachable → always bundled
 * - IPC contract mismatch → bundled (shell needs a native update)
 * - Self-hosted servers (no spaUrl) → always bundled
 */

import { net } from 'electron';
import { IPC_CONTRACT_VERSION } from './ipcContract';
import { getPersistedApiBase } from './tokenManager';

const CONFIG_TIMEOUT_MS = 5_000;

interface ClientConfigResponse {
  spaUrl?: string;
  spaIpcContract?: number;
}

export interface SpaLoadDecision {
  mode: 'remote' | 'bundled';
  url?: string;
  reason: string;
}

/**
 * Determine whether to load the renderer from a remote SPA or the bundled file.
 * This runs in the main process before the BrowserWindow loads any content.
 */
export async function resolveSpaSource(): Promise<SpaLoadDecision> {
  const apiBase = getPersistedApiBase();
  if (!apiBase) {
    return { mode: 'bundled', reason: 'no persisted API base (first launch or logged out)' };
  }

  try {
    const configUrl = `${apiBase}/api/v1/client/config?ipc=${IPC_CONTRACT_VERSION}`;
    const response = await fetchWithTimeout(configUrl, CONFIG_TIMEOUT_MS);

    if (!response.ok) {
      return { mode: 'bundled', reason: `config fetch returned ${response.status}` };
    }

    const data = (await response.json()) as ClientConfigResponse;

    if (!data.spaUrl) {
      return { mode: 'bundled', reason: 'server has no spaUrl configured' };
    }

    // Security: only allow HTTPS remote SPAs (the SPA gets full IPC access)
    try {
      const spaOrigin = new URL(data.spaUrl);
      if (spaOrigin.protocol !== 'https:') {
        return {
          mode: 'bundled',
          reason: `spaUrl rejected: non-HTTPS protocol ${spaOrigin.protocol}`,
        };
      }
    } catch {
      return { mode: 'bundled', reason: 'spaUrl rejected: invalid URL' };
    }

    if (!data.spaIpcContract || data.spaIpcContract <= 0) {
      return { mode: 'bundled', reason: 'server spaIpcContract is zero or absent' };
    }

    if (IPC_CONTRACT_VERSION < data.spaIpcContract) {
      return {
        mode: 'bundled',
        reason: `IPC contract ${IPC_CONTRACT_VERSION} < required ${data.spaIpcContract} — shell update needed`,
      };
    }

    // All checks pass — use remote SPA
    return {
      mode: 'remote',
      url: data.spaUrl,
      reason: `remote SPA compatible (contract ${IPC_CONTRACT_VERSION} >= ${data.spaIpcContract})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { mode: 'bundled', reason: `config fetch failed: ${message}` };
  }
}

/**
 * Fetch with a timeout using Electron's net module (respects proxy settings,
 * works before renderer loads, not subject to CORS).
 */
function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    net
      .fetch(url, { signal: controller.signal })
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
