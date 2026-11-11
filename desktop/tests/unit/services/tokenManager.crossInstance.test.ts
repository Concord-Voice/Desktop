// @vitest-environment node
//
// tokenManager — cross-instance isolation (#1618). One ProfileCustody per
// service: nothing one instance does may touch another's memory or disk.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockNetFetch, userData } = vi.hoisted(() => ({
  mockNetFetch: vi.fn(),
  userData: { dir: '' },
}));

vi.mock('electron', () => ({
  app: { getPath: () => userData.dir },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (s: string) => Buffer.from(`v11${s}`),
    decryptStringAsync: async (b: Buffer) => ({
      shouldReEncrypt: false,
      result: b.toString().replace(/^v1[01]/, ''),
    }),
  },
  net: { fetch: mockNetFetch },
}));
vi.mock('../../../src/main/machineId', () => ({ getMachineId: vi.fn(() => 'mid') }));
vi.mock('../../../src/main/attestationService', () => ({ clearAttestationToken: vi.fn() }));

import {
  createProfileCustody,
  custodyFor,
  _resetAllCustodyForTesting,
} from '@/main/tokenManager';
import type { ProfileCustody } from '@/main/tokenManager';
import { profilePathsForApiBase, serviceIdForApiBase } from '@/main/selfHostedProfile';

const SAAS = 'https://api.concordvoice.chat';
const ORIGIN_A = 'https://a.example';
const ORIGIN_B = 'https://b.example:8443';

const KEYS = {
  wrappingKeyBase64: 'wk',
  preferencesKeyBase64: 'pk',
  wrappedPrivateKeyBase64: 'wpk',
};

function makeJwt(exp: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'u', exp })}.sig`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function make(origin: string): ProfileCustody {
  return createProfileCustody(serviceIdForApiBase(origin), origin);
}

/** Every file under dir, relative path -> bytes (hex). */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full).toString('hex');
    }
  };
  walk(dir);
  return out;
}

describe('tokenManager cross-instance isolation', () => {
  let A: ProfileCustody;
  let B: ProfileCustody;

  beforeEach(() => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cross-'));
    mockNetFetch.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    A = make(ORIGIN_A);
    B = make(ORIGIN_B);
  });

  afterEach(() => {
    A._resetForTesting();
    B._resetForTesting();
    _resetAllCustodyForTesting();
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(userData.dir, { recursive: true, force: true });
  });

  async function seed(c: ProfileCustody, origin: string, token: string) {
    const owner = c.storeRefreshToken({
      refreshToken: token,
      rememberMe: true,
      apiBase: origin,
      accessToken: makeJwt(Math.floor(Date.now() / 1000) + 900),
    });
    await c._flushDiskWritesForTesting();
    return owner;
  }

  it('A.clearTokens leaves B memory and disk intact', async () => {
    await seed(A, ORIGIN_A, 'rt-a');
    const ownerB = await seed(B, ORIGIN_B, 'rt-b');
    expect(await B.storeE2EEKeysIfOwner(KEYS, ownerB)).toBe(true);
    await B._flushDiskWritesForTesting();
    const bTokenBefore = B.getCachedAccessToken();
    const bFiles = profilePathsForApiBase(ORIGIN_B);
    const bDiskBefore = snapshotTree(path.dirname(bFiles.tokenFile));
    expect(bTokenBefore).not.toBeNull();
    expect(fs.existsSync(bFiles.tokenFile)).toBe(true);

    A.clearTokens();
    await A._flushDiskWritesForTesting();

    expect(B.getCachedAccessToken()).toBe(bTokenBefore);
    expect(snapshotTree(path.dirname(bFiles.tokenFile))).toEqual(bDiskBefore);
    expect(fs.existsSync(profilePathsForApiBase(ORIGIN_A).tokenFile)).toBe(false);
  });

  it("fires only the owning instance's proactive callback", async () => {
    vi.useFakeTimers();
    const cbA = vi.fn();
    const cbB = vi.fn();
    A.setProactiveRefreshCallback(cbA);
    B.setProactiveRefreshCallback(cbB);
    mockNetFetch.mockResolvedValue(
      jsonResponse({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
        refresh_token: 'rt-rotated',
      })
    );
    A.storeRefreshToken({
      refreshToken: 'rt-a',
      rememberMe: false,
      apiBase: ORIGIN_A,
      accessToken: makeJwt(Math.floor(Date.now() / 1000) + 120),
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(cbA).toHaveBeenCalled();
    expect(cbB).not.toHaveBeenCalled();
  });

  it('refuses an owner minted by another instance even when the numbers collide', async () => {
    const ownerA = A.storeRefreshToken({
      refreshToken: 'rt-a',
      rememberMe: false,
      apiBase: ORIGIN_A,
    });
    const ownerB = B.storeRefreshToken({
      refreshToken: 'rt-b',
      rememberMe: false,
      apiBase: ORIGIN_B,
    });
    expect(ownerA).toBe(ownerB);

    expect(await B.storeE2EEKeysIfOwner(KEYS, ownerA)).toBe(true); // same number: B's own owner
    // A different-instance owner must be refused: advance B past A's number.
    B.clearTokens();
    const ownerB2 = B.storeRefreshToken({
      refreshToken: 'rt-b2',
      rememberMe: false,
      apiBase: ORIGIN_B,
    });
    expect(ownerB2).not.toBe(ownerA);
    expect(await B.storeE2EEKeysIfOwner(KEYS, ownerA)).toBe(false);
    expect(B.clearTokensIfOwner(ownerA)).toBe(false);
    expect(B.credentialOwnerIsCurrent(ownerB2)).toBe(true);
  });

  it('A.storeE2EEKeys / clear never reach B in memory', async () => {
    const ownerB = B.storeRefreshToken({
      refreshToken: 'rt-b',
      rememberMe: false,
      apiBase: ORIGIN_B,
    });
    expect(await B.storeE2EEKeysIfOwner(KEYS, ownerB)).toBe(true);
    expect(A.storeE2EEKeys(KEYS)).toBe(true); // A has no credential: staging lane open
    A.clearTokens();
    expect(await B.restoreE2EEKeys()).toEqual(KEYS);
  });

  it('removed fallback: an empty instance never deletes the active-profile root', async () => {
    const saasPaths = profilePathsForApiBase(SAAS);
    fs.mkdirSync(userData.dir, { recursive: true });
    fs.writeFileSync(saasPaths.tokenFile, 'saas-token');
    fs.writeFileSync(saasPaths.metaFile, '{"apiBase":"https://api.concordvoice.chat"}');
    fs.writeFileSync(saasPaths.e2eeFile, 'saas-e2ee');
    fs.writeFileSync(
      path.join(userData.dir, 'active-profile.json'),
      JSON.stringify({ apiBase: SAAS })
    );
    const before = snapshotTree(userData.dir);

    A.clearTokens();
    await A._flushDiskWritesForTesting();

    expect(snapshotTree(userData.dir)).toEqual(before);
  });

  it('removed fallback: an empty instance never reports or restores another profile', async () => {
    const saas = make(SAAS);
    try {
      await seed(saas, SAAS, 'rt-saas');
      expect(fs.existsSync(profilePathsForApiBase(SAAS).tokenFile)).toBe(true);

      expect(A.getCredentialApiBase()).toBeNull();
      await expect(A.restoreRefreshToken()).resolves.toEqual({ status: 'no_session' });
      expect(A.getCredentialCustodyState()).toEqual({
        credentialOwner: null,
        pendingE2EEUnlock: false,
      });
    } finally {
      saas._resetForTesting();
    }
  });

  describe('onCredentialEvent', () => {
    it('fires credential-start on store/reserve and credential-end on clear/logout, not on rotation', async () => {
      const events: string[] = [];
      const unsub = A.onCredentialEvent((phase) => events.push(phase));

      const owner = A.storeRefreshToken({
        refreshToken: 'rt-1',
        rememberMe: false,
        apiBase: ORIGIN_A,
      });
      expect(events).toEqual(['credential-start']);

      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
          refresh_token: 'rt-2',
        })
      );
      await expect(A.performRefresh()).resolves.toMatchObject({ status: 'ok' });
      expect(events).toEqual(['credential-start']);

      expect(A.clearTokensIfOwner(owner)).toBe(true);
      expect(events).toEqual(['credential-start', 'credential-end']);

      A.reserveCredentialOwner(ORIGIN_A);
      expect(events).toEqual(['credential-start', 'credential-end', 'credential-start']);

      A.clearTokens();
      expect(events.at(-1)).toBe('credential-end');

      A.storeRefreshToken({ refreshToken: 'rt-3', rememberMe: false, apiBase: ORIGIN_A });
      mockNetFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const before = events.length;
      await A.performLogout();
      expect(events.slice(before)).toEqual(['credential-end']);

      unsub();
      A.storeRefreshToken({ refreshToken: 'rt-4', rememberMe: false, apiBase: ORIGIN_A });
      expect(events.length).toBe(before + 1);
    });
  });

  describe('custodyFor', () => {
    it('returns the same instance per service until reset', () => {
      const id = serviceIdForApiBase(ORIGIN_A);
      const first = custodyFor(id, ORIGIN_A);
      expect(custodyFor(id, ORIGIN_A)).toBe(first);
      _resetAllCustodyForTesting();
      expect(custodyFor(id, ORIGIN_A)).not.toBe(first);
    });

    it('refuses a cached service id bound to a different origin', () => {
      const id = serviceIdForApiBase(ORIGIN_A);
      custodyFor(id, ORIGIN_A);
      expect(() => custodyFor(id, ORIGIN_B)).toThrow(/service-id-collision/);
    });

    it('refuses an id and origin that do not name one profile', () => {
      const id = serviceIdForApiBase(ORIGIN_A);
      expect(() => createProfileCustody(id, ORIGIN_B)).toThrow(TypeError);
      expect(() => createProfileCustody(id, `${ORIGIN_A}/`)).toThrow(TypeError);
    });
  });
});
