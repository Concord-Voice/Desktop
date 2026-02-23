/**
 * Media E2EE — Insertable Streams frame encryption for voice/video.
 *
 * When a channel has is_encrypted: true, all media frames are encrypted with
 * AES-128-GCM before being sent to the SFU. The SFU forwards encrypted RTP
 * payloads transparently — it never sees plaintext audio/video.
 *
 * Key derivation:
 *   frameKey = HKDF-SHA256(channelCSK, salt="concord-voice-e2ee", info=senderUserId)
 *
 * Frame format:
 *   [unencrypted codec header (variable)][AES-GCM ciphertext][16-byte auth tag][1-byte keyId][12-byte IV]
 *
 * Epoch-based key rotation (#96):
 *   On member join/leave → new epoch → new keys derived
 *   Receivers keep old keys for 10 seconds (overlap window)
 *   Ratchet: newKey = HKDF(oldKey, "concord-e2ee-ratchet")
 *
 * Uses RTCRtpScriptTransform where supported (Chrome 120+, Electron 40+),
 * falls back to legacy createEncodedStreams for older Chromium.
 */

const SALT = new TextEncoder().encode('concord-voice-e2ee');
const RATCHET_INFO = new TextEncoder().encode('concord-e2ee-ratchet');

// Number of unencrypted header bytes per codec
// VP8: 1 byte, VP9: 1 byte, H264: varies, Opus: 1 byte (TOC)
const UNENCRYPTED_BYTES: Record<string, number> = {
  opus: 1,
  vp8: 1,
  vp9: 1,
  h264: 2,
  h265: 2,
  av1: 1,
};

/** Derive an AES-128-GCM key from a channel CSK + sender userId via HKDF */
async function deriveFrameKey(
  channelCSK: CryptoKey,
  senderUserId: string
): Promise<CryptoKey> {
  // Export the CSK to raw bytes for use as HKDF input key material
  const cskBytes = await crypto.subtle.exportKey('raw', channelCSK);

  // Import as HKDF key
  const hkdfKey = await crypto.subtle.importKey('raw', cskBytes, 'HKDF', false, [
    'deriveKey',
  ]);

  // Derive AES-128-GCM frame key
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: SALT,
      info: new TextEncoder().encode(senderUserId),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Ratchet a key forward (for epoch rotation) */
async function ratchetKey(currentKey: CryptoKey): Promise<CryptoKey> {
  const keyBytes = await crypto.subtle.exportKey('raw', currentKey);
  const hkdfKey = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: SALT,
      info: RATCHET_INFO,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// MediaEncryption class
// ---------------------------------------------------------------------------

export class MediaEncryption {
  private currentKeyId = 0;
  private encryptKey: CryptoKey | null = null;
  private decryptKeys: Map<string, { key: CryptoKey; expires: number }> = new Map();
  private frameCounter = 0;

  /** Initialize encryption for a channel with the given CSK and local userId */
  async init(channelCSK: CryptoKey, localUserId: string): Promise<void> {
    this.encryptKey = await deriveFrameKey(channelCSK, localUserId);
    this.currentKeyId = 0;
    this.frameCounter = 0;
  }

  /** Add a decryption key for a remote sender */
  async addDecryptKey(
    channelCSK: CryptoKey,
    senderUserId: string,
    keyId = 0
  ): Promise<void> {
    const key = await deriveFrameKey(channelCSK, senderUserId);
    this.decryptKeys.set(`${senderUserId}:${keyId}`, {
      key,
      expires: Date.now() + 3600_000, // 1 hour
    });
  }

  /** Rotate keys (new epoch) — ratchet forward, keep old keys for overlap */
  async rotateKeys(): Promise<void> {
    if (!this.encryptKey) return;

    const oldKeyId = this.currentKeyId;
    this.currentKeyId++;
    this.encryptKey = await ratchetKey(this.encryptKey);

    // Keep old decrypt keys for 10 second overlap window
    for (const [id, entry] of this.decryptKeys) {
      if (id.endsWith(`:${oldKeyId}`)) {
        entry.expires = Date.now() + 10_000;
      }
    }

    // Clean expired keys
    const now = Date.now();
    for (const [id, entry] of this.decryptKeys) {
      if (entry.expires < now) {
        this.decryptKeys.delete(id);
      }
    }
  }

  /** Encrypt a media frame (called by Insertable Streams transform) */
  async encryptFrame(
    frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame
  ): Promise<void> {
    if (!this.encryptKey) return;

    const data = new Uint8Array(frame.data);
    const isVideo = 'type' in frame; // RTCEncodedVideoFrame has `type`
    const headerBytes = isVideo ? 2 : 1; // Conservative default

    // Split: header (unencrypted for SFU routing) + payload (encrypted)
    const header = data.slice(0, headerBytes);
    const payload = data.slice(headerBytes);

    // Generate IV: 12 bytes = 4-byte counter + 8-byte random
    const iv = new Uint8Array(12);
    const counterView = new DataView(iv.buffer);
    counterView.setUint32(0, this.frameCounter++);
    crypto.getRandomValues(iv.subarray(4));

    // Encrypt payload with AES-128-GCM
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header },
      this.encryptKey,
      payload
    );

    // Compose: [header][ciphertext + 16-byte tag][1-byte keyId][12-byte IV]
    const result = new Uint8Array(
      header.length + ciphertext.byteLength + 1 + 12
    );
    result.set(header);
    result.set(new Uint8Array(ciphertext), header.length);
    result[header.length + ciphertext.byteLength] = this.currentKeyId;
    result.set(iv, header.length + ciphertext.byteLength + 1);

    frame.data = result.buffer;
  }

  /** Decrypt a media frame (called by Insertable Streams transform) */
  async decryptFrame(
    frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
    senderUserId: string
  ): Promise<void> {
    const data = new Uint8Array(frame.data);
    if (data.length < 14) return; // Too small to be encrypted

    const isVideo = 'type' in frame;
    const headerBytes = isVideo ? 2 : 1;

    // Extract components from the end
    const iv = data.slice(data.length - 12);
    const keyId = data[data.length - 13];
    const header = data.slice(0, headerBytes);
    const ciphertext = data.slice(headerBytes, data.length - 13);

    // Find the right decryption key
    const keyEntry = this.decryptKeys.get(`${senderUserId}:${keyId}`);
    if (!keyEntry) {
      console.warn('No decrypt key for sender', senderUserId, 'keyId', keyId);
      return;
    }

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: header },
        keyEntry.key,
        ciphertext
      );

      // Reconstruct: [header][plaintext]
      const result = new Uint8Array(header.length + plaintext.byteLength);
      result.set(header);
      result.set(new Uint8Array(plaintext), header.length);
      frame.data = result.buffer;
    } catch {
      // Decryption failed — likely wrong key or corrupted frame
      // Leave frame as-is (will produce garbled output, not a crash)
    }
  }

  /** Clean up */
  destroy(): void {
    this.encryptKey = null;
    this.decryptKeys.clear();
    this.frameCounter = 0;
  }
}
