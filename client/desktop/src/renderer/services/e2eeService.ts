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
  deriveKeyFromPassword,
  derivePreferencesKey,
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
  base64ToArrayBuffer,
} from '../utils/crypto';
import { apiFetch } from './apiClient';

const CHANNEL_KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedWrappedKey {
  wrappedKey: string;
  lastUsed: number;
}

class E2EEService {
  private wrappingKey: CryptoKey | null = null;
  private preferencesKey: CryptoKey | null = null;
  private wrappedPrivateKey: string = '';
  private channelKeyCache: Map<string, CachedWrappedKey> = new Map();
  private pendingKeyFetches: Map<string, Promise<CryptoKey>> = new Map();
  private cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Initialize the E2EE service after login.
   * Derives the PBKDF2 wrapping key once per session.
   */
  async initialize(
    password: string,
    wrappedPrivateKeyBase64: string,
    saltBase64: string
  ): Promise<void> {
    const saltBytes = new Uint8Array(base64ToArrayBuffer(saltBase64));
    this.wrappingKey = await deriveKeyFromPassword(password, saltBytes);
    this.preferencesKey = await derivePreferencesKey(password, saltBytes);
    this.wrappedPrivateKey = wrappedPrivateKeyBase64;

    // Start cache cleanup
    this.cacheCleanupInterval = setInterval(() => this.cleanupCache(), 60_000);
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
    const res = await apiFetch(`/api/v1/channels/${channelId}/keys`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.pending) {
        throw new Error('PENDING_KEY');
      }
      throw new Error('Failed to fetch channel key');
    }
    const data = await res.json();
    const wrappedKey: string = data.key.wrapped_key;

    // Cache the wrapped key
    this.channelKeyCache.set(channelId, {
      wrappedKey,
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
          const uploadRes = await apiFetch(`/api/v1/channels/${req.channel_id}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wrapped_keys: { [req.user_id]: wrappedKey },
            }),
          });
          console.debug('[E2EE] Key distributed for', req.user_id, 'channel', req.channel_id, uploadRes.status);
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
   * Clear all keys on logout.
   */
  clearKeys(): void {
    this.wrappingKey = null;
    this.preferencesKey = null;
    this.wrappedPrivateKey = '';
    this.channelKeyCache.clear();
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
