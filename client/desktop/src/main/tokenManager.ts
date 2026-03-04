/**
 * Token Manager — Main process secure token storage and refresh
 *
 * Uses Electron's safeStorage API (macOS Keychain, Windows DPAPI, Linux libsecret)
 * to encrypt the refresh token at rest. The refresh token never enters the
 * renderer process — only the short-lived access token is returned via IPC.
 *
 * Architecture:
 * - Refresh token: encrypted on disk + held in main process memory
 * - Access token: returned to renderer via IPC, memory-only (never persisted)
 * - Token refresh: main process makes HTTP calls via net.fetch()
 * - Tamper detection: safeStorage.decryptString() throws on corrupted ciphertext
 */

import { app, safeStorage, net } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { getMachineId } from './machineId';

/** Compute the same SHA-256 hex hash the server uses for DB lookups */
function clientHashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Module State (never leaves this process) ────────────────────────

let inMemoryRefreshToken: string | null = null;
let inMemoryRememberMe = true;
let inMemoryApiBase = '';
let refreshPromise: Promise<{ status: string; accessToken?: string }> | null = null;

const TOKEN_FILE = path.join(app.getPath('userData'), 'secure-token.dat');
const META_FILE = path.join(app.getPath('userData'), 'token-meta.json');
const E2EE_FILE = path.join(app.getPath('userData'), 'secure-e2ee.dat');

// ─── Helpers ─────────────────────────────────────────────────────────

function canPersist(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function writeMeta(apiBase: string, rememberMe: boolean): void {
  try {
    fs.writeFileSync(META_FILE, JSON.stringify({ apiBase, rememberMe }), 'utf-8');
  } catch (err) {
    console.error('[TokenManager] Failed to write meta file:', err);
  }
}

function readMeta(): { apiBase: string; rememberMe: boolean } | null {
  try {
    const raw = fs.readFileSync(META_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function deleteFiles(): void {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* no-op */ }
  try { fs.unlinkSync(META_FILE); } catch { /* no-op */ }
  try { fs.unlinkSync(E2EE_FILE); } catch { /* no-op */ }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Store the refresh token securely.
 * - If rememberMe=true and safeStorage is available: encrypt to disk + hold in memory
 * - If rememberMe=false: memory-only, delete any disk files
 * - If safeStorage unavailable: memory-only (user re-logins on restart)
 */
export function storeRefreshToken(data: {
  refreshToken: string;
  rememberMe: boolean;
  apiBase: string;
}): void {
  const suffix = data.refreshToken?.slice(-8) ?? '(empty)';
  const hash = data.refreshToken ? clientHashToken(data.refreshToken).slice(0, 16) : '(none)';
  inMemoryRefreshToken = data.refreshToken;
  inMemoryRememberMe = data.rememberMe;
  inMemoryApiBase = data.apiBase;

  if (!data.rememberMe) {
    // Session-only: clear any persisted token
    console.log(`[TokenManager] storeRefreshToken: rememberMe=false, deleting disk files (token …${suffix}, hash=${hash})`);
    deleteFiles();
    return;
  }

  if (!canPersist()) {
    // safeStorage unavailable (rare Linux without keyring) — memory-only
    console.warn('[TokenManager] safeStorage unavailable, token will not persist across restarts');
    return;
  }

  try {
    const encrypted = safeStorage.encryptString(data.refreshToken);
    fs.writeFileSync(TOKEN_FILE, encrypted);
    writeMeta(data.apiBase, data.rememberMe);

    // Verify disk round-trip: read back and compare
    const readBack = fs.readFileSync(TOKEN_FILE);
    const decrypted = safeStorage.decryptString(readBack);
    if (decrypted !== data.refreshToken) {
      console.error(`[TokenManager] DISK ROUND-TRIP MISMATCH! Stored …${suffix}, read back …${decrypted.slice(-8)}`);
    } else {
      console.log(`[TokenManager] storeRefreshToken: persisted to disk ✓ (token …${suffix}, hash=${hash}, rememberMe=true)`);
    }
  } catch (err) {
    console.error('[TokenManager] Failed to encrypt/write token:', err);
  }
}

/**
 * Restore the refresh token from disk on app startup.
 * Returns the token or an error status.
 */
export function restoreRefreshToken(): { status: 'ok'; token: string; apiBase: string } | { status: 'no_session' | 'tampered' | 'unavailable' } {
  if (!canPersist()) {
    console.log('[TokenManager] restoreRefreshToken: safeStorage unavailable');
    return { status: 'unavailable' };
  }

  const meta = readMeta();
  if (!meta) {
    const tokenFileExists = fs.existsSync(TOKEN_FILE);
    console.log(`[TokenManager] restoreRefreshToken: no meta file (token file exists: ${tokenFileExists})`);
    return { status: 'no_session' };
  }

  try {
    const encrypted = fs.readFileSync(TOKEN_FILE);
    const token = safeStorage.decryptString(encrypted);
    const suffix = token.slice(-8);
    const hash = clientHashToken(token).slice(0, 16);
    console.log(`[TokenManager] restoreRefreshToken: restored from disk (token …${suffix}, hash=${hash}, rememberMe=${meta.rememberMe}, apiBase=${meta.apiBase})`);
    inMemoryRefreshToken = token;
    inMemoryRememberMe = meta.rememberMe;
    inMemoryApiBase = meta.apiBase;
    return { status: 'ok', token, apiBase: meta.apiBase };
  } catch (err) {
    // decryptString throws on tampered ciphertext (AES-GCM auth tag failure)
    console.error('[TokenManager] Token decryption failed (tampered?):', err);
    deleteFiles();
    return { status: 'tampered' };
  }
}

/**
 * Perform a token refresh via the main process.
 * Deduplicates concurrent calls. Returns only the access token.
 */
export function performRefresh(): Promise<{ status: string; accessToken?: string; sessionId?: string }> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    if (!inMemoryRefreshToken || !inMemoryApiBase) {
      return { status: 'no_token' };
    }

    try {
      const tokenSuffix = inMemoryRefreshToken.slice(-8);
      const tokenHash = clientHashToken(inMemoryRefreshToken).slice(0, 16);
      console.log(`[TokenManager] Refreshing token (…${tokenSuffix}, hash=${tokenHash})`);

      const response = await net.fetch(`${inMemoryApiBase}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'X-Refresh-Token': inMemoryRefreshToken,
          'X-Machine-Id': getMachineId(),
        },
      });

      if (!response.ok) {
        console.warn(`[TokenManager] Refresh failed: HTTP ${response.status} (token …${tokenSuffix})`);
        return { status: 'refresh_failed' };
      }

      const data = (await response.json()) as { access_token?: string; refresh_token?: string; session_id?: string };
      const newAccessToken = data.access_token;
      const newRefreshToken = data.refresh_token;
      const newSessionId = data.session_id;

      if (!newAccessToken) {
        return { status: 'refresh_failed' };
      }

      // Rotate: update in-memory refresh token and re-encrypt to disk
      if (newRefreshToken) {
        const newSuffix = newRefreshToken.slice(-8);
        console.log(`[TokenManager] Token rotated: …${tokenSuffix} → …${newSuffix}`);
        inMemoryRefreshToken = newRefreshToken;

        if (inMemoryRememberMe && canPersist()) {
          try {
            const encrypted = safeStorage.encryptString(newRefreshToken);
            fs.writeFileSync(TOKEN_FILE, encrypted);
            console.log(`[TokenManager] Rotated token persisted to disk ✓ (…${newSuffix})`);
          } catch (err) {
            console.error('[TokenManager] Failed to re-encrypt rotated token:', err);
          }
        } else {
          console.log(`[TokenManager] Rotated token NOT persisted (rememberMe=${inMemoryRememberMe}, canPersist=${canPersist()})`);
        }
      }

      return { status: 'ok', accessToken: newAccessToken, sessionId: newSessionId };
    } catch (err) {
      console.error('[TokenManager] Refresh request failed:', err);
      return { status: 'refresh_failed' };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Perform logout — call server endpoint from main process, then clear everything.
 */
export async function performLogout(accessToken?: string): Promise<void> {
  if (!inMemoryApiBase) return;

  try {
    const headers: Record<string, string> = {};
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }
    if (inMemoryRefreshToken) {
      headers['X-Refresh-Token'] = inMemoryRefreshToken;
    }

    await net.fetch(`${inMemoryApiBase}/api/v1/auth/logout`, {
      method: 'POST',
      headers,
    });
  } catch (err) {
    console.error('[TokenManager] Logout request failed:', err);
  }

  clearTokens();
}

/**
 * Clear all token state — in-memory and on disk.
 */
export function clearTokens(): void {
  inMemoryRefreshToken = null;
  inMemoryRememberMe = true;
  inMemoryApiBase = '';
  deleteFiles();
}

// ─── E2EE Key Persistence (safeStorage) ──────────────────────────────

/**
 * Store E2EE session keys encrypted via safeStorage.
 * Called after login/registration when E2EE service has been initialized.
 */
export function storeE2EEKeys(data: {
  wrappingKeyBase64: string;
  preferencesKeyBase64: string;
  wrappedPrivateKeyBase64: string;
}): void {
  if (!canPersist() || !inMemoryRememberMe) {
    return; // Only persist if safeStorage available and rememberMe is on
  }

  try {
    const json = JSON.stringify(data);
    const encrypted = safeStorage.encryptString(json);
    fs.writeFileSync(E2EE_FILE, encrypted);
  } catch (err) {
    console.error('[TokenManager] Failed to encrypt/write E2EE keys:', err);
  }
}

/**
 * Restore E2EE session keys from safeStorage.
 * Returns the key material or null if unavailable.
 */
export function restoreE2EEKeys(): {
  wrappingKeyBase64: string;
  preferencesKeyBase64: string;
  wrappedPrivateKeyBase64: string;
} | null {
  if (!canPersist()) return null;

  try {
    const encrypted = fs.readFileSync(E2EE_FILE);
    const json = safeStorage.decryptString(encrypted);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Report capabilities to renderer.
 */
export function getCapabilities(): { persistAvailable: boolean } {
  return { persistAvailable: canPersist() };
}
