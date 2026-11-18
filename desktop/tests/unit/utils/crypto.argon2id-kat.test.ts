// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deriveKeyArgon2idExportable } from '@/renderer/utils/crypto/crypto';

/**
 * Known-answer test for the Argon2id wrapping-key derivation.
 *
 * This pins wrapping-key derivation across hash-wasm upgrades. It deliberately
 * does NOT mock hash-wasm (mocked crypto tests never exercise the real WASM).
 * It calls the production helper in src/renderer/utils/crypto/crypto.ts
 * (m=64MiB, t=3, p=4, 32-byte output) and pins the exact output, so any
 * hash-wasm change that alters derived bytes (and would make stored wrapped
 * private keys impossible to unwrap) fails CI.
 *
 * Expected value was computed with hash-wasm 4.12.0. The inputs are fake.
 */
const FAKE_PASSWORD = 'correct horse battery staple (test only)';
const FAKE_SALT = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const EXPECTED_HEX = '09e300a07034529da9644afcb376b5d85aaf563e993b46d0e68795cbd4ab059d';

describe('argon2id wrapping-key known answer', () => {
  it('derives the pinned key bytes with production parameters', async () => {
    const key = await deriveKeyArgon2idExportable(FAKE_PASSWORD, FAKE_SALT);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    const hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(EXPECTED_HEX);
  }, 60_000);
});
