/**
 * E2EE Service — JIT key management with zero-persistence of raw secrets.
 *
 * Design: Keys are derived/unwrapped at the moment of use and cleared after.
 * WebCrypto CryptoKey objects are opaque (browser keeps material in protected memory).
 *
 * Cached state:
 * - wrappingKey: CryptoKey (derived, opaque, session lifetime)
 * - wrappedPrivateKey: string (encrypted blob, safe in memory)
 * - channelKeyCache: Map of wrapped keys (encrypted, safe in memory)
 *
 * NOT cached: unwrapped private key, unwrapped CSK — JIT only
 */

import {
  type KeyDerivationAlgorithm,
  deriveKeyFromPasswordExportable,
  deriveKeyArgon2idExportable,
  derivePreferencesKeyExportable,
  derivePreferencesKeyArgon2idExportable,
  encryptBlob,
  decryptBlob,
  unwrapPrivateKey,
  wrapPrivateKey,
  unwrapChannelKey,
  wrapChannelKey,
  encryptMessage,
  decryptMessage,
  generateChannelKey,
  exportChannelKey,
  generateSalt,
  importPublicKey,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from '../utils/crypto';
import { apiFetch, safeJson } from './apiClient';

// Session lifetime — keys cached until explicit invalidation (rotation) or logout/close.
// Lazy fetch + hold: each channel's key is fetched on first visit and held for the session.
const CHANNEL_KEY_CACHE_TTL = Number.MAX_SAFE_INTEGER;

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
  private readonly channelKeyCache: Map<string, CachedWrappedKey> = new Map();
  private readonly versionedKeyCache: Map<string, Map<number, CachedWrappedKey>> = new Map();
  private readonly pendingKeyFetches: Map<string, Promise<CryptoKey>> = new Map();
  private rateLimitedUntil: number = 0; // timestamp when rate limit expires

  /** Cached exported keys for safeStorage persistence (set during initialize) */
  private sessionKeys: E2EESessionKeys | null = null;

  /**
   * Initialize the E2EE service after login/registration.
   * Derives keys using the specified algorithm, exports raw bytes for safeStorage,
   * then re-imports as non-extractable for runtime security.
   *
   * If the user's keys are still PBKDF2-wrapped, this automatically migrates them
   * to Argon2id: unwrap with PBKDF2, re-derive with Argon2id, re-wrap, and upload.
   */
  async initialize(
    password: string,
    wrappedPrivateKeyBase64: string,
    saltBase64: string,
    keyDerivationAlg: KeyDerivationAlgorithm = 'argon2id'
  ): Promise<void> {
    const saltBytes = new Uint8Array(base64ToArrayBuffer(saltBase64));

    if (keyDerivationAlg === 'pbkdf2') {
      // Legacy user — derive with PBKDF2 first, then migrate to Argon2id
      await this.initializeWithPbkdf2AndMigrate(password, wrappedPrivateKeyBase64, saltBytes);
    } else {
      // Already on Argon2id — standard initialization
      await this.initializeWithArgon2id(password, wrappedPrivateKeyBase64, saltBytes);
    }

    // No periodic cleanup needed — session-scoped cache (keys stay until rotation or logout)
  }

  /**
   * Standard Argon2id initialization path.
   */
  private async initializeWithArgon2id(
    password: string,
    wrappedPrivateKeyBase64: string,
    salt: Uint8Array
  ): Promise<void> {
    const exportableWrapping = await deriveKeyArgon2idExportable(password, salt);
    const exportablePrefs = await derivePreferencesKeyArgon2idExportable(password, salt);

    await this.finalizeKeys(exportableWrapping, exportablePrefs, wrappedPrivateKeyBase64);
  }

  /**
   * Legacy PBKDF2 initialization with automatic migration to Argon2id.
   * 1. Derive PBKDF2 keys to unwrap existing private key
   * 2. Generate new Argon2id salt + keys
   * 3. Re-wrap private key with Argon2id-derived key
   * 4. Upload re-wrapped key + new salt + algorithm to server
   * 5. Continue session with new Argon2id keys
   */
  private async initializeWithPbkdf2AndMigrate(
    password: string,
    wrappedPrivateKeyBase64: string,
    oldSalt: Uint8Array
  ): Promise<void> {
    // Step 1: Derive PBKDF2 key to unwrap existing private key
    const pbkdf2Key = await deriveKeyFromPasswordExportable(password, oldSalt);
    const wrappedKeyBuffer = base64ToArrayBuffer(wrappedPrivateKeyBase64);

    // Unwrap private key using PBKDF2 key (need it extractable for re-wrapping)
    const privateKey = await crypto.subtle.unwrapKey(
      'pkcs8',
      new Uint8Array(wrappedKeyBuffer).slice(12),
      pbkdf2Key,
      { name: 'AES-GCM', iv: new Uint8Array(wrappedKeyBuffer).slice(0, 12) },
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true, // extractable — needed to re-wrap with new key
      ['decrypt']
    );

    // Step 2: Generate new salt and derive Argon2id keys
    const newSalt = generateSalt();
    const argon2WrappingKey = await deriveKeyArgon2idExportable(password, newSalt);
    const argon2PrefsKey = await derivePreferencesKeyArgon2idExportable(password, newSalt);

    // Step 3: Re-wrap private key with Argon2id-derived key
    const newWrappedKey = await wrapPrivateKey(privateKey, argon2WrappingKey);
    const newWrappedKeyBase64 = arrayBufferToBase64(newWrappedKey);
    const newSaltBase64 = arrayBufferToBase64(newSalt.buffer as ArrayBuffer);

    // Step 4: Upload migrated keys to server
    try {
      const res = await apiFetch('/api/v1/users/me/keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wrapped_private_key: newWrappedKeyBase64,
          key_derivation_salt: newSaltBase64,
          key_derivation_alg: 'argon2id',
        }),
      });
      if (res.ok) {
        console.debug('[E2EE] Migrated key derivation from PBKDF2 to Argon2id');
        // Re-encrypt preferences with new Argon2id key (they were encrypted with PBKDF2 key)
        await this.migratePreferences(password, oldSalt, argon2PrefsKey);
      } else {
        console.warn('[E2EE] Key migration upload failed, continuing with PBKDF2 keys');
        // Fall back to PBKDF2 keys for this session
        const pbkdf2Prefs = await derivePreferencesKeyExportable(password, oldSalt);
        await this.finalizeKeys(pbkdf2Key, pbkdf2Prefs, wrappedPrivateKeyBase64);
        return;
      }
    } catch {
      console.warn('[E2EE] Key migration network error, continuing with PBKDF2 keys');
      const pbkdf2Prefs = await derivePreferencesKeyExportable(password, oldSalt);
      await this.finalizeKeys(pbkdf2Key, pbkdf2Prefs, wrappedPrivateKeyBase64);
      return;
    }

    // Step 5: Continue session with new Argon2id keys
    await this.finalizeKeys(argon2WrappingKey, argon2PrefsKey, newWrappedKeyBase64);
  }

  /**
   * Re-encrypt server preferences from old PBKDF2 key to new Argon2id key.
   * Best-effort: failure is logged but does not block login.
   */
  private async migratePreferences(
    password: string,
    oldSalt: Uint8Array,
    newPrefsKey: CryptoKey
  ): Promise<void> {
    try {
      const res = await apiFetch('/api/v1/users/me/preferences');
      if (!res.ok) return;
      const data = await safeJson<{ preferences?: { encrypted_data?: string; version?: number } }>(
        res
      );
      if (!data.preferences?.encrypted_data) return;

      // Decrypt with old PBKDF2-derived preferences key
      const oldPrefsKey = await derivePreferencesKeyExportable(password, oldSalt);
      const plaintext = await decryptBlob(data.preferences.encrypted_data, oldPrefsKey);

      // Re-encrypt with new Argon2id-derived preferences key
      const newCiphertext = await encryptBlob(plaintext, newPrefsKey);

      // Push re-encrypted preferences back to server
      await apiFetch('/api/v1/users/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encrypted_data: newCiphertext,
          version: data.preferences.version,
        }),
      });
      console.debug('[E2EE] Re-encrypted preferences with Argon2id key');
    } catch (err) {
      console.warn('[E2EE] Preferences re-encryption failed (non-fatal):', err);
    }
  }

  /**
   * Shared finalization: export raw bytes for safeStorage, re-import as non-extractable.
   */
  private async finalizeKeys(
    exportableWrapping: CryptoKey,
    exportablePrefs: CryptoKey,
    wrappedPrivateKeyBase64: string
  ): Promise<void> {
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

    // No periodic cleanup needed — session-scoped cache (keys stay until rotation or logout)
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

    // If we're rate-limited, don't fire another request
    if (Date.now() < this.rateLimitedUntil) {
      throw new Error('Failed to fetch channel key');
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
      if (res.status === 429) {
        const retryAfter = Number.parseInt(res.headers.get('Retry-After') || '30', 10);
        this.rateLimitedUntil = Date.now() + retryAfter * 1000;
        throw new Error('Failed to fetch channel key');
      }
      const data = await safeJson<{ pending?: boolean }>(res).catch(
        () => ({}) as { pending?: boolean }
      );
      if (data.pending) {
        throw new Error('PENDING_KEY');
      }
      throw new Error('Failed to fetch channel key');
    }
    const data = await safeJson<{ key: { wrapped_key: string; key_version?: number } }>(res);
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
   * Decrypt a message using a pre-fetched channel key.
   * Avoids redundant getChannelKey() calls when batch-decrypting.
   */
  async decryptWithKey(ciphertext: string, channelKey: CryptoKey): Promise<string> {
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

      const data = await safeJson<{
        pending_requests?: Array<{ user_id: string; channel_id: string }>;
      }>(res);
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

          const pkData = await safeJson<{ public_key: string }>(pkRes);
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
    if (mainCached?.keyVersion === version) {
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

    // If we're rate-limited, don't fire another request
    if (Date.now() < this.rateLimitedUntil) {
      throw new Error(`Failed to fetch channel key version ${version}`);
    }

    // Fetch specific version from server
    const res = await apiFetch(`/api/v1/e2ee/keys/${channelId}?version=${version}`);
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number.parseInt(res.headers.get('Retry-After') || '30', 10);
        this.rateLimitedUntil = Date.now() + retryAfter * 1000;
      }
      throw new Error(`Failed to fetch channel key version ${version}`);
    }
    const data = await safeJson<{ key: { wrapped_key: string; key_version?: number } }>(res);
    const wrappedKey: string = data.key.wrapped_key;

    // Cache in versioned cache
    let versionMapForChannel = this.versionedKeyCache.get(channelId);
    if (!versionMapForChannel) {
      versionMapForChannel = new Map();
      this.versionedKeyCache.set(channelId, versionMapForChannel);
    }
    versionMapForChannel.set(version, {
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
      const data = await safeJson(res).catch(() => ({}));
      console.debug('[E2EE] Key rotation distribution failed:', res.status, data);
      // Non-fatal: another client may have already distributed (first-response-wins)
    }

    // Invalidate current cache so next encrypt/decrypt fetches the new key
    this.invalidateChannelKey(channelId);
  }

  /**
   * Get the password-derived wrapping key (for recovery key wrapping).
   * Returns null if the service is not initialized.
   */
  getWrappingKey(): CryptoKey | null {
    return this.wrappingKey;
  }

  /**
   * Get the wrapped (encrypted) private key blob (base64).
   * This is the password-wrapped private key stored on the server.
   */
  getWrappedPrivateKey(): string {
    return this.wrappedPrivateKey;
  }

  /**
   * Get the preferences key as base64 (for recovery key wrapping).
   * Returns the exported raw key bytes from the session keys cache.
   * Returns null if the service is not initialized or session keys are unavailable.
   */
  getPreferencesKeyBase64(): string | null {
    const keys = this.getSessionKeys();
    return keys?.preferencesKeyBase64 ?? null;
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
  }

  /**
   * Invalidate cached key for a specific channel (e.g., on key rotation).
   * Also clears historical versioned keys for the channel.
   */
  invalidateChannelKey(channelId: string): void {
    this.channelKeyCache.delete(channelId);
    this.versionedKeyCache.delete(channelId);
  }
}

// Singleton instance
export const e2eeService = new E2EEService();
