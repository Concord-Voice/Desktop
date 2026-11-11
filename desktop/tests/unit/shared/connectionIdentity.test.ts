// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  compositeKey,
  isAccountKey,
  isConnectionId,
  isGeneration,
  isServiceId,
  parseConnectionIdentity,
  type ServiceId,
} from '../../../src/shared/connectionIdentity';

const SELF = 'selfhost-0123456789abcdef' as ServiceId;
const SAAS = 'saas' as ServiceId;
const CID = 'A'.repeat(22);

describe('isServiceId', () => {
  it('accepts saas and selfhost ids', () => {
    expect(isServiceId('saas')).toBe(true);
    expect(isServiceId('selfhost-0123456789abcdef')).toBe(true);
  });
  it('rejects malformed values', () => {
    // pragma: allowlist nextline secret
    for (const v of ['selfhost-0123456789ABCDEF', 'selfhost-0123456789abcde', '', 42]) {
      expect(isServiceId(v)).toBe(false);
    }
  });
});

describe('isConnectionId', () => {
  it('accepts a 22-char base64url string', () => {
    expect(isConnectionId('abcDEF012-_xyzABC123456')).toBe(false); // 23 chars
    expect(isConnectionId('abcDEF012-_xyzABC12345')).toBe(true);
    expect(isConnectionId(CID)).toBe(true);
  });
  it('rejects wrong length and non-base64url chars', () => {
    expect(isConnectionId('A'.repeat(21))).toBe(false);
    expect(isConnectionId('A'.repeat(23))).toBe(false);
    expect(isConnectionId('A'.repeat(21) + '+')).toBe(false);
    expect(isConnectionId('A'.repeat(21) + '/')).toBe(false);
    expect(isConnectionId('A'.repeat(21) + '=')).toBe(false);
  });
});

describe('isGeneration', () => {
  it('accepts positive safe integers', () => {
    expect(isGeneration(1)).toBe(true);
    expect(isGeneration(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const v of [0, 1.5, -1, NaN, 2 ** 53]) expect(isGeneration(v)).toBe(false);
  });
});

describe('isAccountKey', () => {
  it('accepts 16 lowercase hex chars only', () => {
    expect(isAccountKey('0123456789abcdef')).toBe(true);
    expect(isAccountKey('0123456789ABCDEF')).toBe(false);
    expect(isAccountKey('abc')).toBe(false);
  });
});

describe('compositeKey', () => {
  it('distinguishes services and contains a NUL separator', () => {
    const a = compositeKey(SAAS, 'u1');
    const b = compositeKey(SELF, 'u1');
    expect(a).not.toBe(b);
    expect(a).toContain('\0');
    expect(b).toContain('\0');
  });
  it('throws when localId contains NUL', () => {
    expect(() => compositeKey(SAAS, 'x\0y')).toThrow();
  });
});

describe('parseConnectionIdentity', () => {
  const valid = {
    connectionId: CID,
    generation: 1,
    serviceId: SELF,
    kind: 'selfhost',
    apiOrigin: 'https://chat.example.com',
  };
  it('round-trips a valid identity', () => {
    expect(parseConnectionIdentity(valid)).toEqual(valid);
  });
  it('returns null for an extra key', () => {
    expect(parseConnectionIdentity({ ...valid, extra: 1 })).toBeNull();
  });
  it('returns null for a missing apiOrigin', () => {
    const { apiOrigin: _omit, ...rest } = valid;
    expect(parseConnectionIdentity(rest)).toBeNull();
  });
  it('returns null for a non-origin apiOrigin', () => {
    expect(parseConnectionIdentity({ ...valid, apiOrigin: 'https://a.example/path' })).toBeNull();
  });
  it('returns null when kind disagrees with serviceId', () => {
    expect(parseConnectionIdentity({ ...valid, kind: 'saas' })).toBeNull();
  });
  it('returns null for non-objects', () => {
    expect(parseConnectionIdentity(null)).toBeNull();
    expect(parseConnectionIdentity('x')).toBeNull();
  });
});
