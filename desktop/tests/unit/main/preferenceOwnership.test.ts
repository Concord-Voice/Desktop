// @vitest-environment node
// #86 Task 9: preference ownership handles (spec §3.10). accountKey is
// hex16(sha256(compositeKey(serviceId, serverUserId))); the scope is null until the custody
// holds an account; the prefs directory never carries an origin or user id in clear.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AccountKey, ServiceId } from '../../../src/shared/connectionIdentity';
import {
  accountKeyFor,
  preferenceScopeFor,
  prefsDirFor,
} from '../../../src/main/preferenceOwnership';

const SAAS = 'saas' as ServiceId;
const SELF = 'selfhost-0123456789abcdef' as ServiceId;
const OTHER_SELF = 'selfhost-fedcba9876543210' as ServiceId;

function fakeCustody() {
  let key: AccountKey | null = null;
  return {
    getAccountKey: () => key,
    setAccountKey: (k: AccountKey | null) => {
      key = k;
    },
  };
}
const serviceWith = (serviceId: ServiceId, custody: ReturnType<typeof fakeCustody>) =>
  ({ serviceId, kind: serviceId === SAAS ? 'saas' : 'selfhost', custody }) as never;
const recordFor = (serviceId: ServiceId) => ({ serviceId }) as never;

describe('accountKeyFor', () => {
  it('differs for the same server user id under different services', () => {
    expect(accountKeyFor(SAAS, 'u1')).not.toBe(accountKeyFor(SELF, 'u1'));
    expect(accountKeyFor(SELF, 'u1')).not.toBe(accountKeyFor(OTHER_SELF, 'u1'));
  });

  it('is 16 lowercase hex characters', () => {
    expect(accountKeyFor(SAAS, 'u1')).toMatch(/^[0-9a-f]{16}$/);
    expect(accountKeyFor(SELF, 'a-very-long-user-id'.repeat(10))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic and differs per user', () => {
    expect(accountKeyFor(SAAS, 'u1')).toBe(accountKeyFor(SAAS, 'u1'));
    expect(accountKeyFor(SAAS, 'u1')).not.toBe(accountKeyFor(SAAS, 'u2'));
  });

  it('is the sha256 of the composite key, first 16 hex characters', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(`${SELF}\0u1`).digest('hex').slice(0, 16);
    expect(accountKeyFor(SELF, 'u1')).toBe(expected);
  });

  it('refuses a user id containing NUL (composite-key injectivity)', () => {
    expect(() => accountKeyFor(SAAS, 'u\0x')).toThrow(TypeError);
  });
});

describe('preferenceScopeFor', () => {
  it('is null before the custody holds an account', () => {
    const custody = fakeCustody();
    expect(preferenceScopeFor(recordFor(SELF), serviceWith(SELF, custody))).toBeNull();
  });

  it('is { serviceId, accountKey } once the custody has an account', () => {
    const custody = fakeCustody();
    const key = accountKeyFor(SELF, 'u1');
    custody.setAccountKey(key);
    expect(preferenceScopeFor(recordFor(SELF), serviceWith(SELF, custody))).toEqual({
      serviceId: SELF,
      accountKey: key,
    });
  });

  it('is null when the record names another service than the service record', () => {
    const custody = fakeCustody();
    custody.setAccountKey(accountKeyFor(SELF, 'u1'));
    expect(preferenceScopeFor(recordFor(OTHER_SELF), serviceWith(SELF, custody))).toBeNull();
  });

  it('is null again after the custody account is cleared', () => {
    const custody = fakeCustody();
    custody.setAccountKey(accountKeyFor(SELF, 'u1'));
    custody.setAccountKey(null);
    expect(preferenceScopeFor(recordFor(SELF), serviceWith(SELF, custody))).toBeNull();
  });
});

describe('prefsDirFor', () => {
  const root = path.join(path.sep, 'tmp', 'concord-userdata');
  const dirKey = '0123456789abcdef';
  const scope = { serviceId: SELF, accountKey: accountKeyFor(SELF, 'user-secret-id') };

  it('is <root>/profiles/<dirKey>/prefs/<accountKey>', () => {
    expect(prefsDirFor(root, dirKey, scope)).toBe(
      path.join(root, 'profiles', dirKey, 'prefs', scope.accountKey)
    );
  });

  it('stays beneath <root>/profiles/<dirKey>/', () => {
    const rel = path.relative(
      path.join(root, 'profiles', dirKey),
      prefsDirFor(root, dirKey, scope)
    );
    expect(rel.startsWith('..')).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);
  });

  it('carries no origin or user id in clear', () => {
    const dir = prefsDirFor(root, dirKey, scope);
    expect(dir).not.toContain('user-secret-id');
    expect(dir).not.toContain('https');
    expect(dir).not.toContain('example');
  });

  it('refuses a dirKey that is not the scope service (no cross-service directory)', () => {
    expect(() => prefsDirFor(root, 'fedcba9876543210', scope)).toThrow(TypeError);
    expect(() => prefsDirFor(root, '', scope)).toThrow(TypeError);
  });

  it('refuses a dirKey that could leave profiles/<dirKey>/', () => {
    expect(() => prefsDirFor(root, '..', { ...scope, serviceId: SAAS })).toThrow(TypeError);
    expect(() => prefsDirFor(root, '../x', { ...scope, serviceId: SAAS })).toThrow(TypeError);
  });

  it('refuses a malformed accountKey', () => {
    const bad = { serviceId: SELF, accountKey: '../../etc' as AccountKey };
    expect(() => prefsDirFor(root, dirKey, bad)).toThrow(TypeError);
  });

  it('accepts saas with the packaged empty dirKey', () => {
    const saas = { serviceId: SAAS, accountKey: accountKeyFor(SAAS, 'u1') };
    expect(prefsDirFor(root, '', saas)).toBe(path.join(root, 'profiles', 'prefs', saas.accountKey));
  });

  it('differs per account', () => {
    const other = { serviceId: SELF, accountKey: accountKeyFor(SELF, 'someone-else') };
    expect(prefsDirFor(root, dirKey, other)).not.toBe(prefsDirFor(root, dirKey, scope));
  });
});
