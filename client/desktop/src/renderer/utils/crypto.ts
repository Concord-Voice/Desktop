/**
 * Client-side cryptography utilities for E2EE
 * Uses Web Crypto API for secure key generation and management
 */

// Constants for PBKDF2 key derivation (matching backend expectations)
const PBKDF2_ITERATIONS = 600000; // 600k iterations (OWASP 2023)
const SALT_LENGTH = 16; // 16 bytes
const DERIVED_KEY_LENGTH = 32; // 32 bytes (256 bits)

// Constants for RSA key pair
const RSA_KEY_SIZE = 4096; // 4096-bit RSA keys (NIST secure through 2040+)
const RSA_PUBLIC_EXPONENT = new Uint8Array([1, 0, 1]); // 65537

/**
 * Generate a random salt for key derivation
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Derive an encryption key from a password using PBKDF2
 * This key is used to wrap/unwrap the user's private key
 *
 * @param password - User's password
 * @param salt - Salt for key derivation
 * @returns Promise<CryptoKey> - Derived AES-GCM key
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  // Import password as key material
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES-GCM key from password
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    {
      name: 'AES-GCM',
      length: DERIVED_KEY_LENGTH * 8, // bits
    },
    false, // not extractable
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Generate an RSA key pair for E2EE
 *
 * @returns Promise<CryptoKeyPair> - RSA-OAEP key pair
 */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: RSA_KEY_SIZE,
      publicExponent: RSA_PUBLIC_EXPONENT,
      hash: 'SHA-256',
    },
    true, // extractable
    ['encrypt', 'decrypt']
  );
}

/**
 * Wrap (encrypt) a private key using a password-derived key
 *
 * @param privateKey - RSA private key to wrap
 * @param wrappingKey - AES-GCM key derived from password
 * @returns Promise<ArrayBuffer> - Wrapped (encrypted) private key
 */
export async function wrapPrivateKey(
  privateKey: CryptoKey,
  wrappingKey: CryptoKey
): Promise<ArrayBuffer> {
  // Generate a random IV for AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Wrap the private key
  const wrappedKey = await crypto.subtle.wrapKey('pkcs8', privateKey, wrappingKey, {
    name: 'AES-GCM',
    iv: iv,
  });

  // Prepend IV to wrapped key (we'll need it for unwrapping)
  const result = new Uint8Array(iv.length + wrappedKey.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(wrappedKey), iv.length);

  return result.buffer;
}

/**
 * Unwrap (decrypt) a private key using a password-derived key
 *
 * @param wrappedKey - Wrapped private key (with IV prepended)
 * @param unwrappingKey - AES-GCM key derived from password
 * @returns Promise<CryptoKey> - Unwrapped RSA private key
 */
export async function unwrapPrivateKey(
  wrappedKey: ArrayBuffer,
  unwrappingKey: CryptoKey
): Promise<CryptoKey> {
  // Extract IV from the beginning of wrapped key
  const data = new Uint8Array(wrappedKey);
  const iv = data.slice(0, 12);
  const actualWrappedKey = data.slice(12);

  // Unwrap the private key
  return crypto.subtle.unwrapKey(
    'pkcs8',
    actualWrappedKey,
    unwrappingKey,
    {
      name: 'AES-GCM',
      iv: iv,
    },
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    true, // extractable
    ['decrypt']
  );
}

/**
 * Export a public key to base64 format (for storage/transmission)
 *
 * @param publicKey - RSA public key
 * @returns Promise<string> - Base64-encoded public key
 */
export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', publicKey);
  return arrayBufferToBase64(exported);
}

/**
 * Import a public key from base64 format
 *
 * @param base64Key - Base64-encoded public key
 * @returns Promise<CryptoKey> - RSA public key
 */
export async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  const keyData = base64ToArrayBuffer(base64Key);
  return crypto.subtle.importKey(
    'spki',
    keyData,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    true,
    ['encrypt']
  );
}

/**
 * Convert ArrayBuffer to base64 string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Complete registration flow: generate keys and wrap private key
 *
 * @param password - User's password
 * @returns Promise<RegistrationKeys> - Keys ready for registration
 */
export interface RegistrationKeys {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  wrappedPrivateKey: string; // base64
  keyDerivationSalt: string; // base64
}

export async function generateRegistrationKeys(password: string): Promise<RegistrationKeys> {
  // Generate salt
  const salt = generateSalt();

  // Derive wrapping key from password
  const wrappingKey = await deriveKeyFromPassword(password, salt);

  // Generate RSA key pair
  const keyPair = await generateKeyPair();

  // Wrap private key
  const wrappedKey = await wrapPrivateKey(keyPair.privateKey, wrappingKey);

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    wrappedPrivateKey: arrayBufferToBase64(wrappedKey),
    keyDerivationSalt: arrayBufferToBase64(salt.buffer),
  };
}

/**
 * Complete login flow: unwrap private key
 *
 * @param password - User's password
 * @param wrappedPrivateKeyBase64 - Wrapped private key from server
 * @param saltBase64 - Salt from server
 * @returns Promise<CryptoKey> - Unwrapped private key
 */
export async function unwrapLoginKeys(
  password: string,
  wrappedPrivateKeyBase64: string,
  saltBase64: string
): Promise<CryptoKey> {
  // Convert from base64
  const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
  const wrappedKey = base64ToArrayBuffer(wrappedPrivateKeyBase64);

  // Derive unwrapping key from password
  const unwrappingKey = await deriveKeyFromPassword(password, salt);

  // Unwrap private key
  return unwrapPrivateKey(wrappedKey, unwrappingKey);
}

// ========================================
// Channel Symmetric Key (CSK) operations
// ========================================

const AES_GCM_IV_LENGTH = 12; // 12-byte IV for AES-GCM

/**
 * Generate a new channel symmetric key (AES-256-GCM)
 */
export async function generateChannelKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable (needed for wrapping)
    ['encrypt', 'decrypt']
  );
}

/**
 * Export a channel key as raw bytes
 */
export async function exportChannelKey(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', key);
}

/**
 * Import a channel key from raw bytes
 */
export async function importChannelKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Wrap a channel key with a member's RSA-OAEP public key.
 * Returns base64-encoded wrapped key.
 */
export async function wrapChannelKey(channelKey: CryptoKey, publicKey: CryptoKey): Promise<string> {
  // Export the channel key as raw, then encrypt with RSA-OAEP
  const rawKey = await exportChannelKey(channelKey);
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey);
  return arrayBufferToBase64(encrypted);
}

/**
 * Unwrap a channel key using the user's RSA-OAEP private key.
 * Takes base64-encoded wrapped key, returns CryptoKey.
 */
export async function unwrapChannelKey(
  wrappedKeyBase64: string,
  privateKey: CryptoKey
): Promise<CryptoKey> {
  const wrappedData = base64ToArrayBuffer(wrappedKeyBase64);
  const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, wrappedData);
  return importChannelKey(rawKey);
}

/**
 * Encrypt a message with a channel key (AES-256-GCM).
 * Prepends 12-byte random IV to ciphertext. Returns base64.
 */
export async function encryptMessage(plaintext: string, channelKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, channelKey, encoded);

  // Prepend IV to ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);

  return arrayBufferToBase64(result.buffer);
}

/**
 * Decrypt a message with a channel key (AES-256-GCM).
 * Expects base64 input with 12-byte IV prepended to ciphertext.
 */
export async function decryptMessage(
  ciphertextBase64: string,
  channelKey: CryptoKey
): Promise<string> {
  const data = new Uint8Array(base64ToArrayBuffer(ciphertextBase64));
  const iv = data.slice(0, AES_GCM_IV_LENGTH);
  const ciphertext = data.slice(AES_GCM_IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, channelKey, ciphertext);

  return new TextDecoder().decode(plaintext);
}
