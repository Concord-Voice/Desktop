// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { b64d, b64e, utf8 } from '@/renderer/services/e2ee/authority/bytes';
import { capOf, decode, encode, Malformed } from '@/renderer/services/e2ee/authority/codec';
import {
  checkPoint,
  importP384,
  parseU,
  verifyP384,
} from '@/renderer/services/e2ee/authority/primitives';

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

  it('refuses unsorted or duplicate set members on encode', () => {
    expect(() => encode('status-req', { account_ids: [ID, ID] })).toThrow('duplicate');
    expect(() => encode('status-req', { account_ids: [] })).toThrow('count');
  });
});
