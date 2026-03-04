/**
 * E2EE Service — JIT key management with zero-persistence of raw secrets.
 *
 * Design: Keys are derived/unwrapped at the moment of use and cleared after.
 * WebCrypto CryptoKey objects are opaque (browser keeps material in protected memory).
 *
 * Cached state:
 * - wrappingKey: CryptoKey (PBKDF2-derived, opaque, session lifetime)
 * - wrappedPrivateKey: string (encrypted blob, safe in memory)
 * - channelKeyCache: Map of wrapped keys (encrypted, safe in memory)
 *
 * NOT cached: unwrapped private key, unwrapped CSK — JIT only
 */

import {
  deriveKeyFromPasswordExportable,
  derivePreferencesKeyExportable,
  encryptBlob,
  decryptBlob,
  unwrapPrivateKey,
  unwrapChannelKey,
  wrapChannelKey,
  encryptMessage,
  decryptMessage,
  generateChannelKey,
  exportChannelKey,
  importPublicKey,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from '../utils/crypto';
import { apiFetch } from './apiClient';

const CHANNEL_KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedWrappedKey {
  wrappedKey: string;
  keyVersion: number;
  lastUsed: number;
}

/** Exported key material for safeStorage persistence */
export interface E2EESessionKeys {
  wrappingKeyBase64: string;
  preferencesKeyBase64: string;
  wrappedPrivateKeyBase64: string;
}

class E2EEService {
  private wrappingKey: CryptoKey | null = null;
  private preferencesKey: CryptoKey | null = null;
  private wrappedPrivateKey: string = '';
  private channelKeyCache: Map<string, CachedWrappedKey> = new Map();
  private versionedKeyCache: Map<string, Map<number, CachedWrappedKey>> = new Map();
  private pendingKeyFetches: Map<string, Promise<CryptoKey>> = new Map();
  private cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Cached exported keys for safeStorage persistence (set during initialize) */
  private sessionKeys: E2EESessionKeys | null = null;

  /**
   * Initialize the E2EE service after login/registration.
   * Derives PBKDF2 keys as extractable, exports raw bytes for safeStorage,
   * then re-imports as non-extractable for runtime security.
   */
  async initialize(
    password: string,
    wrappedPrivateKeyBase64: string,
    saltBase64: string
  ): Promise<void> {
    const saltBytes = new Uint8Array(base64ToArrayBuffer(saltBase64));

    // Derive extractable keys (single PBKDF2 pass each)
    const exportableWrapping = await deriveKeyFromPasswordExportable(password, saltBytes);
    const exportablePrefs = await derivePreferencesKeyExportable(password, saltBytes);

    // Export raw bytes for safeStorage persistence
    const wrappingRaw = await crypto.subtle.exportKey('raw', exportableWrapping);
    const prefsRaw = await crypto.subtle.exportKey('raw', exportablePrefs);

    // Re-import as non-extractable for runtime use (XSS protection)
    this.wrappingKey = await crypto.subtle.importKey(
      'raw',
      wrappingRaw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['wrapKey', 'unwrapKey']
    );
    this.preferencesKey = await crypto.subtle.importKey(
      'raw',
      prefsRaw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.wrappedPrivateKey = wrappedPrivateKeyBase64;

    // Cache exported keys for safeStorage (base64 for JSON serialization)
    this.sessionKeys = {
      wrappingKeyBase64: arrayBufferToBase64(wrappingRaw),
      preferencesKeyBase64: arrayBufferToBase64(prefsRaw),
      wrappedPrivateKeyBase64,
    };

    // Start cache cleanup
    if (this.cacheCleanupInterval) clearInterval(this.cacheCleanupInterval);
    this.cacheCleanupInterval = setInterval(() => this.cleanupCache(), 60_000);
  }

  /**
   * Initialize from stored session keys (restored from safeStorage).
   * Imports raw key bytes as non-extractable CryptoKey objects.
   */
  async initializeFromStoredKeys(keys: E2EESessionKeys): Promise<void> {
    const wrappingRaw = base64ToArrayBuffer(keys.wrappingKeyBase64);
    const prefsRaw = base64ToArrayBuffer(keys.preferencesKeyBase64);

    this.wrappingKey = await crypto.subtle.importKey(
      'raw',
      wrappingRaw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['wrapKey', 'unwrapKey']
    );
    this.preferencesKey = await crypto.subtle.importKey(
      'raw',
      prefsRaw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.wrappedPrivateKey = keys.wrappedPrivateKeyBase64;
    this.sessionKeys = keys;

    // Start cache cleanup
    if (this.cacheCleanupInterval) clearInterval(this.cacheCleanupInterval);
    this.cacheCleanupInterval = setInterval(() => this.cleanupCache(), 60_000);
  }

  /**
   * Get the exported session keys for safeStorage persistence.
   * Only available after initialize() has been called.
   */
  getSessionKeys(): E2EESessionKeys | null {
    return this.sessionKeys;
  }

  /**
   * Check if the service is initialized (user has logged in with E2EE)
   */
  get isInitialized(): boolean {
    return this.wrappingKey !== null;
  }

  /**
   * JIT: Derive the private key from the stored wrapped key.
   * Caller uses it for a single operation, then lets it fall out of scope.
   */
  private async derivePrivateKey(): Promise<CryptoKey> {
    if (!this.wrappingKey || !this.wrappedPrivateKey) {
      throw new Error('E2EE service not initialized');
    }
    const wrappedKeyBuffer = base64ToArrayBuffer(this.wrappedPrivateKey);
    return unwrapPrivateKey(wrappedKeyBuffer, this.wrappingKey);
  }

  /**
   * Get the unwrapped channel key for a channel (JIT).
   * Fetches the wrapped key from cache or server, unwraps with private key.
   * Uses pendingKeyFetches to prevent cache stampeding (concurrent fetches for the same channel).
   */
  async getChannelKey(channelId: string): Promise<CryptoKey> {
    // Check cache for wrapped key
    const cached = this.channelKeyCache.get(channelId);
    if (cached && Date.now() - cached.lastUsed < CHANNEL_KEY_CACHE_TTL) {
      cached.lastUsed = Date.now();
      const privateKey = await this.derivePrivateKey();
      return unwrapChannelKey(cached.wrappedKey, privateKey);
    }

    // Deduplicate concurrent fetches for the same channel
    const pending = this.pendingKeyFetches.get(channelId);
    if (pending) {
      return pending;
    }

    const fetchPromise = this.fetchAndUnwrapChannelKey(channelId);
    this.pendingKeyFetches.set(channelId, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.pendingKeyFetches.delete(channelId);
    }
  }

  /**
   * Internal: fetch wrapped key from server, cache it, and unwrap.
   */
  private async fetchAndUnwrapChannelKey(channelId: string): Promise<CryptoKey> {
    const res = await apiFetch(`/api/v1/e2ee/keys/${channelId}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.pending) {
        throw new Error('PENDING_KEY');
      }
      throw new Error('Failed to fetch channel key');
    }
    const data = await res.json();
    const wrappedKey: string = data.key.wrapped_key;
    const keyVersion: number = data.key.key_version || 1;

    // Cache the wrapped key
    this.channelKeyCache.set(channelId, {
      wrappedKey,
      keyVersion,
      lastUsed: Date.now(),
    });

    // JIT unwrap: derive private key, unwrap channel key, private key falls out of scope
    const privateKey = await this.derivePrivateKey();
    return unwrapChannelKey(wrappedKey, privateKey);
  }

  /**
   * Encrypt a message for a channel.
   * JIT: gets channel key, encrypts, key falls out of scope.
   */
  async encryptForChannel(channelId: string, plaintext: string): Promise<string> {
    const channelKey = await this.getChannelKey(channelId);
    return encryptMessage(plaintext, channelKey);
  }

  /**
   * Decrypt a message from a channel.
   * JIT: gets channel key, decrypts, key falls out of scope.
   */
  async decryptForChannel(channelId: string, ciphertext: string): Promise<string> {
    const channelKey = await this.getChannelKey(channelId);
    return decryptMessage(ciphertext, channelKey);
  }

  /**
   * Create channel keys for all members when creating an E2EE channel.
   * Generates a new CSK, wraps it for each member's public key.
   *
   * @param memberPublicKeys - Map of user_id → base64 public key
   * @returns Map of user_id → base64 wrapped CSK
   */
  async createChannelKeys(memberPublicKeys: Map<string, string>): Promise<Map<string, string>> {
    const channelKey = await generateChannelKey();
    const wrappedKeys = new Map<string, string>();

    for (const [userId, publicKeyBase64] of memberPublicKeys) {
      const publicKey = await importPublicKey(publicKeyBase64);
      const wrapped = await wrapChannelKey(channelKey, publicKey);
      wrappedKeys.set(userId, wrapped);
    }

    return wrappedKeys;
  }

  /**
   * Wrap the channel key for a new member (key distribution).
   * Used when an existing member distributes keys to a joining member.
   */
  async wrapKeyForMember(channelId: string, memberPublicKeyBase64: string): Promise<string> {
    // Get the unwrapped channel key
    const channelKey = await this.getChannelKey(channelId);
    const memberPublicKey = await importPublicKey(memberPublicKeyBase64);

    // Export and re-wrap for the new member
    const rawKey = await exportChannelKey(channelKey);
    const tempKey = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    return wrapChannelKey(tempKey, memberPublicKey);
  }

  /**
   * Process pending key requests — auto-wrap keys for new members.
   */
  async processPendingKeyRequests(): Promise<void> {
    if (!this.isInitialized) return;

    try {
      const res = await apiFetch('/api/v1/e2ee/pending-keys');
      if (!res.ok) {
        console.debug('[E2EE] pending-keys request failed:', res.status, res.statusText);
        return;
      }

      const data = await res.json();
      const requests = data.pending_requests || [];
      console.debug('[E2EE] Pending key requests:', requests.length);

      for (const req of requests) {
        try {
          // Fetch new member's public key
          const pkRes = await apiFetch(`/api/v1/users/${req.user_id}/public-key`);
          if (!pkRes.ok) {
            console.debug('[E2EE] Failed to fetch public key for', req.user_id, pkRes.status);
            continue;
          }

          const pkData = await pkRes.json();
          const wrappedKey = await this.wrapKeyForMember(req.channel_id, pkData.public_key);

          // Upload the wrapped key
          const uploadRes = await apiFetch(`/api/v1/e2ee/keys/${req.channel_id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wrapped_keys: { [req.user_id]: wrappedKey },
            }),
          });
          console.debug(
            '[E2EE] Key distributed for',
            req.user_id,
            'channel',
            req.channel_id,
            uploadRes.status
          );
        } catch (err) {
          console.debug('[E2EE] Failed to process key request:', err);
        }
      }
    } catch (err) {
      console.debug('[E2EE] processPendingKeyRequests error:', err);
    }
  }

  /**
   * Encrypt a preferences blob using the domain-separated preferences key.
   */
  async encryptPreferences<T>(data: T): Promise<string> {
    if (!this.preferencesKey) {
      throw new Error('E2EE service not initialized');
    }
    return encryptBlob(data, this.preferencesKey);
  }

  /**
   * Decrypt a preferences blob using the domain-separated preferences key.
   */
  async decryptPreferences<T>(ciphertextBase64: string): Promise<T> {
    if (!this.preferencesKey) {
      throw new Error('E2EE service not initialized');
    }
    return decryptBlob<T>(ciphertextBase64, this.preferencesKey);
  }

  /**
   * Get the current (latest) key version for a channel from cache.
   * Returns 1 if no key is cached yet.
   */
  getCurrentKeyVersion(channelId: string): number {
    const cached = this.channelKeyCache.get(channelId);
    return cached?.keyVersion ?? 1;
  }

  /**
   * Fetch and unwrap a specific key version for a channel (for decrypting old messages).
   * Results are cached in the versioned key cache.
   */
  async getChannelKeyByVersion(channelId: string, version: number): Promise<CryptoKey> {
    // Check if this is the current version — use main cache
    const mainCached = this.channelKeyCache.get(channelId);
    if (mainCached && mainCached.keyVersion === version) {
      mainCached.lastUsed = Date.now();
      const privateKey = await this.derivePrivateKey();
      return unwrapChannelKey(mainCached.wrappedKey, privateKey);
    }

    // Check versioned cache
    const versionMap = this.versionedKeyCache.get(channelId);
    const versionCached = versionMap?.get(version);
    if (versionCached && Date.now() - versionCached.lastUsed < CHANNEL_KEY_CACHE_TTL) {
      versionCached.lastUsed = Date.now();
      const privateKey = await this.derivePrivateKey();
      return unwrapChannelKey(versionCached.wrappedKey, privateKey);
    }

    // Fetch specific version from server
    const res = await apiFetch(`/api/v1/e2ee/keys/${channelId}?version=${version}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch channel key version ${version}`);
    }
    const data = await res.json();
    const wrappedKey: string = data.key.wrapped_key;

    // Cache in versioned cache
    if (!this.versionedKeyCache.has(channelId)) {
      this.versionedKeyCache.set(channelId, new Map());
    }
    this.versionedKeyCache.get(channelId)!.set(version, {
      wrappedKey,
      keyVersion: version,
      lastUsed: Date.now(),
    });

    const privateKey = await this.derivePrivateKey();
    return unwrapChannelKey(wrappedKey, privateKey);
  }

  /**
   * Decrypt a message using a specific key version.
   * Falls back to current key if version is 0 or 1 (legacy).
   */
  async decryptForChannelWithVersion(
    channelId: string,
    ciphertext: string,
    version: number
  ): Promise<string> {
    // Version 0 or 1 = use current key (legacy/default)
    if (!version || version <= 1) {
      return this.decryptForChannel(channelId, ciphertext);
    }

    // Check if the requested version matches current cached version
    const currentVersion = this.getCurrentKeyVersion(channelId);
    if (version === currentVersion) {
      return this.decryptForChannel(channelId, ciphertext);
    }

    // Fetch specific version
    const channelKey = await this.getChannelKeyByVersion(channelId, version);
    return decryptMessage(ciphertext, channelKey);
  }

  /**
   * Rotate the channel key: generate a new CSK, wrap for all members, and distribute.
   * Used after member removal or theft detection.
   *
   * @param channelId - The channel to rotate keys for
   * @param newKeyVersion - The new epoch/version number
   * @param memberPublicKeys - Map of user_id → base64 public key for remaining members
   */
  async rotateChannelKey(
    channelId: string,
    newKeyVersion: number,
    memberPublicKeys: Map<string, string>
  ): Promise<void> {
    const channelKey = await generateChannelKey();
    const wrappedKeys: Record<string, string> = {};

    for (const [userId, publicKeyBase64] of memberPublicKeys) {
      const publicKey = await importPublicKey(publicKeyBase64);
      const wrapped = await wrapChannelKey(channelKey, publicKey);
      wrappedKeys[userId] = wrapped;
    }

    const res = await apiFetch(`/api/v1/e2ee/keys/${channelId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wrapped_keys: wrappedKeys,
        key_version: newKeyVersion,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.debug('[E2EE] Key rotation distribution failed:', res.status, data);
      // Non-fatal: another client may have already distributed (first-response-wins)
    }

    // Invalidate current cache so next encrypt/decrypt fetches the new key
    this.invalidateChannelKey(channelId);
  }

  /**
   * Clear all keys on logout.
   */
  clearKeys(): void {
    this.wrappingKey = null;
    this.preferencesKey = null;
    this.wrappedPrivateKey = '';
    this.sessionKeys = null;
    this.channelKeyCache.clear();
    this.versionedKeyCache.clear();
    this.pendingKeyFetches.clear();
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = null;
    }
  }

  /**
   * Invalidate cached key for a specific channel (e.g., on key rotation).
   */
  invalidateChannelKey(channelId: string): void {
    this.channelKeyCache.delete(channelId);
  }

  /**
   * Clean up expired entries from the channel key cache.
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [channelId, cached] of this.channelKeyCache) {
      if (now - cached.lastUsed > CHANNEL_KEY_CACHE_TTL) {
        this.channelKeyCache.delete(channelId);
      }
    }
  }
}

// Singleton instance
export const e2eeService = new E2EEService();
