// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { b64d, b64e, utf8 } from '@/main/authority/bytes';
import {
  CAPS,
  capOf,
  decode,
  encode,
  LAYOUTS,
  Malformed,
} from '@/main/authority/codec';
import {
  checkEkSpkiWebCrypto,
  checkPoint,
  importP384,
  parseU,
  populationDigest,
  verifyLegacyPSS,
  verifyP384,
} from '@/main/authority/primitives';

const ID = '11111111-1111-4111-8111-111111111111';

describe('authority codec edge inputs', () => {
  it('refuses non-canonical base64', () => {
    for (const s of ['AA', 'AA=', 'A-==', 'AB==']) expect(() => b64d(s), s).toThrow(Malformed);
    expect(b64e(b64d('AA=='))).toBe('AA==');
  });

  it('refuses integers with leading zeros or above MAX_SAFE_INTEGER', () => {
    expect(() => parseU('01')).toThrow(Malformed);
    expect(() => parseU('9007199254740992')).toThrow(Malformed);
    expect(parseU('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses hybrid and off-curve points before import', async () => {
    const p = new Uint8Array(97);
    p[0] = 0x06;
    expect(() => checkPoint(p)).toThrow(Malformed);
    await expect(importP384(p)).rejects.toThrow(Malformed);
    p[0] = 0x04;
    expect(() => checkPoint(p)).toThrow('point not on curve');
    expect(await verifyP384(p, new Uint8Array(1), new Uint8Array(96))).toBe(false);
  });

  it('round-trips a message and refuses a tampered byte', async () => {
    const bytes = encode('refused', { request_id: ID, code: 'stale_seq' });
    expect(await decode('refused', bytes)).toEqual({ request_id: ID, code: 'stale_seq' });
    await expect(
      decode('refused', utf8(new TextDecoder().decode(bytes).replace('"stale_seq"', '"stale-seq"')))
    ).rejects.toThrow(Malformed);
  });

  it('refuses a byte outside EN2, a wrong tag, an over-long message and an unknown layout', async () => {
    const bytes = encode('error', { code: 'busy' });
    const spaced = utf8(new TextDecoder().decode(bytes).replace(',', ', '));
    await expect(decode('error', spaced)).rejects.toThrow('EN2');
    await expect(decode('refused', bytes)).rejects.toThrow(Malformed);
    await expect(decode('error', bytes, bytes.length - 1)).rejects.toThrow('length');
    await expect(decode('toString', bytes)).rejects.toThrow('unknown layout');
    expect(() => encode('constructor', {})).toThrow('unknown layout');
    expect(capOf('error')).toBeGreaterThan(bytes.length);
  });

  it('sorts set members on encode; refuses unsorted on decode and duplicate or empty sets', async () => {
    const ID2 = '22222222-2222-4222-8222-222222222222';
    const sorted = encode('status-req', { account_ids: [ID, ID2] });
    expect(encode('status-req', { account_ids: [ID2, ID] })).toEqual(sorted);
    const swapped = new TextDecoder()
      .decode(sorted)
      .replace(`"${ID}","${ID2}"`, `"${ID2}","${ID}"`);
    await expect(decode('status-req', utf8(swapped))).rejects.toThrow('not strictly ascending');
    expect(() => encode('status-req', { account_ids: [ID, ID] })).toThrow('duplicate');
    expect(() => encode('status-req', { account_ids: [] })).toThrow('count');
  });

  it('refuses an empty required string', () => {
    expect(() => encode('refused', { request_id: '', code: 'stale_seq' })).toThrow('empty');
  });

  it('never lets a caller raise the cap, and freezes the contract tables', async () => {
    const bytes = encode('error', { code: 'busy' });
    const big = utf8(new TextDecoder().decode(bytes).padEnd(capOf('error') + 1, ' '));
    await expect(decode('error', big, 1e9)).rejects.toThrow('length');
    expect(() => capOf('constructor')).toThrow('unknown layout');
    expect(Object.isFrozen(CAPS) && Object.isFrozen(LAYOUTS.error[0][1])).toBe(true);
  });
});

describe('authority primitives error paths', () => {
  const vectors = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../../docs/design/account-key-authority-vectors.json'),
      'utf8'
    )
  ) as { vectors: { name: string; input?: { spki_b64?: string } }[] };
  const ek = b64d(
    vectors.vectors.find((v) => v.name === 'prim/ek-spki/valid')?.input?.spki_b64 ?? ''
  );

  it('refuses an EK SPKI whose Web Crypto export differs from the input', async () => {
    await expect(checkEkSpkiWebCrypto(ek)).resolves.toBeUndefined();
    const spy = vi
      .spyOn(globalThis.crypto.subtle, 'exportKey')
      .mockResolvedValueOnce(new Uint8Array(550).buffer);
    await expect(checkEkSpkiWebCrypto(ek)).rejects.toThrow('ek spki not canonical');
    spy.mockRestore();
  });

  it('returns false for a legacy PSS check on a bad SPKI or a refused import', async () => {
    expect(await verifyLegacyPSS(new Uint8Array(550), new Uint8Array(1), new Uint8Array(512))).toBe(
      false
    );
    const real = globalThis.crypto.subtle.importKey.bind(globalThis.crypto.subtle);
    const spy = vi
      .spyOn(globalThis.crypto.subtle, 'importKey')
      .mockImplementation((...a: Parameters<SubtleCrypto['importKey']>) =>
        (a[2] as RsaHashedImportParams).name === 'RSA-PSS'
          ? Promise.reject(new Error('refused'))
          : real(...a)
      );
    expect(await verifyLegacyPSS(ek, new Uint8Array(1), new Uint8Array(512))).toBe(false);
    spy.mockRestore();
  });

  it('refuses a malformed population record', async () => {
    await expect(
      populationDigest([{ account_id: 'nope', legacy_ek_digest: new Uint8Array(48) }])
    ).rejects.toThrow('population record');
    await expect(
      populationDigest([
        { account_id: ID, legacy_ek_digest: new Uint8Array(48) },
        { account_id: ID, legacy_ek_digest: new Uint8Array(48) },
      ])
    ).rejects.toThrow('duplicate account');
  });
});
