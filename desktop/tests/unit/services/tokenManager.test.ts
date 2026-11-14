// @vitest-environment node
//
// tokenManager — storage/restore + proactive refresh + performRefresh tests.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const { mockGetMachineId, mockNetFetch } = vi.hoisted(() => ({
  mockGetMachineId: vi.fn(() => 'mid'),
  mockNetFetch: vi.fn(),
}));

let safeStorageAvailable = true;
let appIsPackaged = false;
let storageBackend = 'gnome_libsecret';
// Tag prepended to "ciphertext". 'v11' is a keyring key; 'v10' on Linux is
// Chromium's hardcoded-key fallback, which secureStorage.ts refuses.
let ciphertextTag = 'v11';
const fsWriteCalls: unknown[][] = [];
const fsFiles = new Map<string, unknown>();
let fsUnlinkCount = 0;
const fsUnlinkCalls: string[] = [];
const fsRead: { impl: (...a: unknown[]) => unknown } = { impl: () => Buffer.from('x') };
const fsRenameCalls: [string, string][] = [];
const fsRmCalls: string[] = [];
const fsRename = { fail: false };

// The atomic write lands on a temp path and is renamed into place. Report the
// write under its final path, as a direct write would have, so assertions on
// fsWriteCalls keep reading destinations.
function mockRename(from: string, to: string): void {
  fsRenameCalls.push([from, to]);
  if (fsRename.fail || !fsFiles.has(from)) throw new Error('EXDEV');
  fsFiles.set(to, fsFiles.get(from));
  fsFiles.delete(from);
  for (const call of fsWriteCalls) if (call[0] === from) call[0] = to;
}

function mockRm(path: string): void {
  fsRmCalls.push(path);
  fsFiles.delete(path);
}

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/td',
    get isPackaged() {
      return appIsPackaged;
    },
  },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => safeStorageAvailable,
    getSelectedStorageBackend: () => storageBackend,
    encryptStringAsync: async (s: string) => Buffer.from(`${ciphertextTag}${s}`),
    decryptStringAsync: async (b: Buffer) => ({
      shouldReEncrypt: false,
      result: b.toString().replace(/^v1[01]/, ''),
    }),
  },
  net: { fetch: mockNetFetch },
}));
vi.mock('../../../src/main/machineId', () => ({ getMachineId: mockGetMachineId }));
const mockClearAttestationToken = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/attestationService', () => ({
  clearAttestationToken: mockClearAttestationToken,
}));
vi.mock('fs', () => ({
  default: {
    writeFileSync: (...a: unknown[]) => {
      fsWriteCalls.push(a);
      fsFiles.set(String(a[0]), a[1]);
    },
    readFileSync: (...a: unknown[]) => fsRead.impl(...a),
    unlinkSync: (path: string) => {
      fsUnlinkCount++;
      fsUnlinkCalls.push(path);
      fsFiles.delete(path);
    },
    existsSync: (path: string) => fsFiles.has(path),
    mkdirSync: () => undefined,
    renameSync: (from: string, to: string) => mockRename(from, to),
    rmSync: (path: string) => mockRm(path),
  },
  writeFileSync: (...a: unknown[]) => {
    fsWriteCalls.push(a);
    fsFiles.set(String(a[0]), a[1]);
  },
  readFileSync: (...a: unknown[]) => fsRead.impl(...a),
  unlinkSync: (path: string) => {
    fsUnlinkCount++;
    fsUnlinkCalls.push(path);
    fsFiles.delete(path);
  },
  existsSync: (path: string) => fsFiles.has(path),
  mkdirSync: () => undefined,
  renameSync: (from: string, to: string) => mockRename(from, to),
  rmSync: (path: string) => mockRm(path),
}));

import { createProfileCustody } from '@/main/tokenManager';
import type { ProfileCustody } from '@/main/tokenManager';
import { preferenceScopeFor } from '@/main/preferenceOwnership';

// The suite runs once per custody instance (#1618): every former module-level
// call now goes through the instance created in beforeEach.
let custody: ProfileCustody;
const viaCustody = new Proxy({} as ProfileCustody, {
  get:
    (_t, key: string) =>
    (...args: unknown[]) =>
      (custody as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args),
});
const {
  storeRefreshToken,
  restoreRefreshToken,
  clearTokens,
  clearTokensIfOwner,
  releaseCredentialReservation,
  reserveCredentialOwner,
  credentialOwnerIsCurrent,
  storeRefreshTokenIfOwner,
  storeE2EEKeys,
  storeE2EEKeysIfOwner,
  restoreE2EEKeys,
  getCredentialCustodyState,
  getCredentialApiBase,
  getCapabilities,
  stopProactiveRefresh,
  performRefresh,
  performLogout,
  setProactiveRefreshCallback,
  onSystemResume,
  getCachedAccessToken,
  _resetForTesting,
  _flushDiskWritesForTesting,
} = viaCustody;
// Mocked via vi.mock('electron') above — imported here so tests can spy the
// async encrypt/decrypt to simulate a locked keychain or hold one in flight.
import { safeStorage } from 'electron';
import {
  profilePathsForApiBase,
  serviceIdForApiBase,
  commitSelfHostedApproval,
  _resetSelfHostedProfileForTesting,
} from '@/main/selfHostedProfile';
import { _resetApprovalsCacheForTesting } from '@/main/selfHostedApprovals';
import { SAAS_SERVICE_ID } from '../../../src/shared/connectionIdentity';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// ─── JWT Test Helper ────────────────────────────────────────────────
// Creates a minimal JWT with a given exp claim (seconds since epoch).
function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user1', exp })).toString('base64url');
  const sig = 'test-sig';
  return `${header}.${payload}.${sig}`;
}

// ─── Response Factory ───────────────────────────────────────────────
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const flushDiskWrites = () => _flushDiskWritesForTesting();

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** A promise the test settles by hand, to hold an encrypt/decrypt in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Writes that carry credential material (the active-profile pointer holds none). */
function credentialWrites(): string[] {
  return fsWriteCalls
    .map(([path]) => String(path))
    .filter((p) => !p.endsWith('active-profile.json'));
}

function diskFile(suffix: string): unknown {
  return [...fsFiles.entries()].find(([path]) => path.endsWith(suffix))?.[1];
}

const TEST_BINDING = '01234567-89ab-4def-8123-456789abcdef';
function tokenEnvelope(token: string, apiBase = 'http://localhost:8080', owner = 7): string {
  return JSON.stringify({ version: 1, token, apiBase, owner, binding: TEST_BINDING });
}
function tokenFromCiphertext(value: unknown): string {
  return (JSON.parse(String(value).slice(3)) as { token: string }).token;
}

function readMockDisk(path: unknown): unknown {
  const value = fsFiles.get(String(path));
  if (value === undefined) throw new Error('ENOENT');
  return value;
}

describe.each([
  ['saas', 'https://api.concordvoice.chat'],
  ['selfhost-A', 'https://a.example'],
  ['selfhost-B', 'https://b.example:8443'],
])('tokenManager (%s)', (_label, origin) => {
  beforeEach(() => {
    custody = createProfileCustody(serviceIdForApiBase(origin), origin);
    safeStorageAvailable = true;
    appIsPackaged = false;
    storageBackend = 'gnome_libsecret';
    ciphertextTag = 'v11';
    fsWriteCalls.length = 0;
    fsFiles.clear();
    fsUnlinkCount = 0;
    fsUnlinkCalls.length = 0;
    fsRenameCalls.length = 0;
    fsRmCalls.length = 0;
    fsRename.fail = false;
    fsRead.impl = () => Buffer.from('x');
    _resetForTesting();
    _resetSelfHostedProfileForTesting();
    _resetApprovalsCacheForTesting();
    mockGetMachineId.mockClear();
    mockNetFetch.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setPlatform(originalPlatform);
  });

  describe('persisted token destination binding', () => {
    // #175 (merged from main) re-expressed for #86: custody is per service, and a
    // custody refuses a meta naming another origin before any decrypt. Each case
    // therefore runs against the custody of the API base it persists; the
    // assertions are main's.
    const useCustodyFor = (apiBase: string) => {
      const apiOrigin = new URL(apiBase).origin;
      custody = createProfileCustody(serviceIdForApiBase(apiOrigin), apiOrigin);
      _resetForTesting();
    };

    it('restores a currently approved self-hosted destination in packaged builds', async () => {
      fsRead.impl = readMockDisk;
      const apiBase = 'https://approved.example';
      useCustodyFor(apiBase);
      expect(commitSelfHostedApproval(apiBase, '8.8.8.8')).toBe(true);
      storeRefreshToken({ refreshToken: 'secret', rememberMe: true, apiBase });
      await flushDiskWrites();
      _resetForTesting();
      appIsPackaged = true;
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'secret', apiBase });
    });

    it('refuses a no-longer-approved self-hosted destination in packaged builds', async () => {
      fsRead.impl = readMockDisk;
      useCustodyFor('https://unapproved.example');
      storeRefreshToken({
        refreshToken: 'secret',
        rememberMe: true,
        apiBase: 'https://unapproved.example',
      });
      await flushDiskWrites();
      _resetForTesting();
      appIsPackaged = true;
      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
      await performRefresh();
      expect(mockNetFetch).not.toHaveBeenCalled();
    });

    it('restores the rotated token and its E2EE keys after restart', async () => {
      const apiBase = 'https://example.test';
      const keys = {
        wrappingKeyBase64: 'wk',
        preferencesKeyBase64: 'pk',
        wrappedPrivateKeyBase64: 'wpk',
      };
      fsRead.impl = readMockDisk;
      useCustodyFor(apiBase);
      const owner = storeRefreshToken({ refreshToken: 'old', rememberMe: true, apiBase });
      expect(await storeE2EEKeysIfOwner(keys, owner)).toBe(true);
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({ access_token: 'access', refresh_token: 'new' })
      );
      expect((await performRefresh()).status).toBe('ok');
      await flushDiskWrites();
      _resetForTesting();
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'new', apiBase });
      expect(await restoreE2EEKeys()).toEqual(keys);
    });

    it('refuses token-only legacy data without a network request', async () => {
      useCustodyFor('http://localhost:8080');
      fsRead.impl = (path) =>
        String(path).endsWith('active-profile.json')
          ? (() => {
              throw new Error('ENOENT');
            })()
          : String(path).endsWith('token-meta.json')
            ? JSON.stringify({ apiBase: 'http://localhost:8080', rememberMe: true })
            : Buffer.from('v11legacy-token');
      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
      await performRefresh();
      expect(mockNetFetch).not.toHaveBeenCalled();
    });

    it('refuses E2EE keys from another credential even when metadata and owner match', async () => {
      const apiBase = 'https://example.test';
      const keys = {
        wrappingKeyBase64: 'wk',
        preferencesKeyBase64: 'pk',
        wrappedPrivateKeyBase64: 'wpk',
      };
      fsRead.impl = readMockDisk;
      useCustodyFor(apiBase);
      const owner = storeRefreshToken({ refreshToken: 'secret', rememberMe: true, apiBase });
      await storeE2EEKeysIfOwner(keys, owner);
      const profile = profilePathsForApiBase(apiBase);
      const diskKeys = JSON.parse(String(fsFiles.get(profile.e2eeFile)).slice(3));
      diskKeys.binding = TEST_BINDING;
      fsFiles.set(profile.e2eeFile, Buffer.from(`v11${JSON.stringify(diskKeys)}`));
      fsFiles.set(
        profile.metaFile,
        JSON.stringify({ apiBase, rememberMe: true, credentialOwner: owner, e2eeState: 'ready' })
      );
      _resetForTesting();
      expect((await restoreRefreshToken()).status).toBe('ok');
      expect(await restoreE2EEKeys()).toBeNull();
    });

    it.each(['https://attacker.example', 'https://example.test/other'])(
      'rejects a token relocated to %s without sending a refresh',
      async (forgedBase) => {
        const originalBase = 'https://example.test';
        fsRead.impl = readMockDisk;
        useCustodyFor(originalBase);
        storeRefreshToken({ refreshToken: 'secret', rememberMe: true, apiBase: originalBase });
        await flushDiskWrites();
        const source = profilePathsForApiBase(originalBase);
        const target = profilePathsForApiBase(forgedBase);
        fsFiles.set(target.tokenFile, fsFiles.get(source.tokenFile));
        fsFiles.set(
          target.metaFile,
          JSON.stringify({
            apiBase: forgedBase,
            rememberMe: true,
            credentialOwner: 1,
            e2eeState: 'ready',
          })
        );
        fsFiles.set('/tmp/td/active-profile.json', JSON.stringify({ apiBase: forgedBase }));
        // The forged destination's own custody reads the relocated files.
        useCustodyFor(forgedBase);
        expect((await restoreRefreshToken()).status).not.toBe('ok');
        await performRefresh();
        expect(mockNetFetch).not.toHaveBeenCalled();
      }
    );
  });

  describe('storeRefreshToken', () => {
    it('returns a distinct opaque owner for each stored lifecycle', () => {
      const firstOwner = storeRefreshToken({
        refreshToken: 'first-token',
        rememberMe: false,
        apiBase: origin,
      });
      const secondOwner = storeRefreshToken({
        refreshToken: 'second-token',
        rememberMe: false,
        apiBase: origin,
      });

      expect(Number.isSafeInteger(firstOwner)).toBe(true);
      expect(secondOwner).not.toBe(firstOwner);
    });

    it('encrypts and writes to disk when rememberMe=true', async () => {
      storeRefreshToken({
        refreshToken: 'my-token',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      expect(tokenFromCiphertext(diskFile('secure-token.dat'))).toBe('my-token');
      expect(fsWriteCalls.length).toBeGreaterThan(0);
      const paths = fsWriteCalls.map((c) => c[0] as string);
      expect(paths.some((p) => p.includes('secure-token.dat'))).toBe(true);
      expect(paths.some((p) => p.includes('token-meta.json'))).toBe(true);
    });

    it('writes self-hosted tokens under a per-origin profile namespace', async () => {
      storeRefreshToken({
        refreshToken: 'my-token',
        rememberMe: true,
        apiBase: 'https://homelab.lan',
      });
      await flushDiskWrites();

      // #86: the custody's own origin selects the namespace (brief step 1).
      const own = profilePathsForApiBase(origin);
      const paths = fsWriteCalls.map((c) => c[0] as string);
      expect(paths).toContainEqual(own.tokenFile);
      expect(paths).toContainEqual(own.metaFile);
      const metaWrite = fsWriteCalls.find((c) => String(c[0]).endsWith('token-meta.json'));
      expect(JSON.parse(metaWrite?.[1] as string)).toMatchObject({
        apiBase: 'https://homelab.lan',
        rememberMe: true,
        profileId: expect.stringMatching(/^selfhost-[0-9a-f]{16}$/),
      });
    });

    it('deletes disk files when rememberMe=false', () => {
      storeRefreshToken({
        refreshToken: 'my-token',
        rememberMe: false,
        apiBase: origin,
      });
      expect(fsWriteCalls.length).toBe(0);
      expect(fsUnlinkCount).toBeGreaterThan(0);
    });

    it('memory-only when safeStorage unavailable', async () => {
      safeStorageAvailable = false;
      storeRefreshToken({
        refreshToken: 'my-token',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      expect(credentialWrites()).toEqual([]);
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'my-token' });
    });

    it('removes partial successor metadata when the meta write fails midway', async () => {
      fsRead.impl = readMockDisk;
      storeRefreshToken({
        refreshToken: 'predecessor-token',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      const originalWrite = fs.writeFileSync;
      // token-meta.json lands, then the active-profile pointer write fails.
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
        if (String(file).includes('active-profile.json')) throw new Error('disk full');
        return originalWrite(file, ...args);
      });

      storeRefreshToken({
        refreshToken: 'successor-token',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();

      expect(diskFile('token-meta.json')).toBeUndefined();
      expect(diskFile('secure-token.dat')).toBeUndefined();
      expect(await restoreRefreshToken()).toMatchObject({
        status: 'ok',
        token: 'successor-token',
      });
    });

    it('removes partial successor state when the encrypted token write fails', async () => {
      fsRead.impl = readMockDisk;
      storeRefreshToken({
        refreshToken: 'predecessor-token',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      fsUnlinkCalls.length = 0;
      const originalWrite = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
        if (String(file).includes('secure-token.dat')) throw new Error('disk full');
        return originalWrite(file, ...args);
      });

      storeRefreshToken({
        refreshToken: 'successor-token',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();

      // The successor's meta was written before the token write failed; only
      // the failure branch removes it.
      expect(diskFile('token-meta.json')).toBeUndefined();
      expect(diskFile('secure-token.dat')).toBeUndefined();
      expect(await restoreRefreshToken()).toMatchObject({
        status: 'ok',
        token: 'successor-token',
      });
    });
  });

  // #86 Task 9: the custody's account handle. serverUserId is hashed with the custody's
  // serviceId; neither it nor the origin is persisted in clear.
  describe('accountKey', () => {
    const expectedKey = (userId: string) =>
      createHash('sha256')
        .update(`${serviceIdForApiBase(origin)}\0${userId}`)
        .digest('hex')
        .slice(0, 16);

    it('is null before any login', () => {
      expect(custody.getAccountKey()).toBeNull();
    });

    it('is derived from serverUserId on storeRefreshToken', () => {
      storeRefreshToken({
        refreshToken: 't',
        rememberMe: false,
        apiBase: origin,
        serverUserId: 'user-1',
      } as never);
      expect(custody.getAccountKey()).toBe(expectedKey('user-1'));
      expect(custody.getAccountKey()).toMatch(/^[0-9a-f]{16}$/);
    });

    it('persists accountKey in token-meta.json without the user id in clear', async () => {
      storeRefreshToken({
        refreshToken: 't',
        rememberMe: true,
        apiBase: origin,
        serverUserId: 'user-1',
      } as never);
      await flushDiskWrites();
      const meta = String(diskFile('token-meta.json'));
      expect(JSON.parse(meta)).toMatchObject({ accountKey: expectedKey('user-1') });
      expect(meta).not.toContain('user-1');
    });

    it('restores the persisted accountKey after a main-process restart', async () => {
      storeRefreshToken({
        refreshToken: 't',
        rememberMe: true,
        apiBase: origin,
        serverUserId: 'user-1',
      } as never);
      await flushDiskWrites();
      _resetForTesting();
      expect(custody.getAccountKey()).toBeNull();
      fsRead.impl = readMockDisk;
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 't' });
      expect(custody.getAccountKey()).toBe(expectedKey('user-1'));
    });

    it('still restores a meta without accountKey, with a null accountKey', async () => {
      fsRead.impl = (path) => {
        const file = String(path);
        if (file.endsWith('active-profile.json')) throw new Error('ENOENT');
        if (file.endsWith('token-meta.json')) {
          return JSON.stringify({ apiBase: origin, rememberMe: true });
        }
        return Buffer.from(`v11${tokenEnvelope('stored-token', origin)}`);
      };
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'stored-token' });
      expect(custody.getAccountKey()).toBeNull();
    });

    // pragma: allowlist nextline secret
    it.each(['ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0', 'zzzzzzzzzzzzzzzz', 7])(
      'ignores a malformed persisted accountKey (%s) but still restores',
      async (bad) => {
        fsRead.impl = (path) => {
          const file = String(path);
          if (file.endsWith('active-profile.json')) throw new Error('ENOENT');
          if (file.endsWith('token-meta.json')) {
            return JSON.stringify({ apiBase: origin, rememberMe: true, accountKey: bad });
          }
          return Buffer.from(`v11${tokenEnvelope('stored-token', origin)}`);
        };
        expect(await restoreRefreshToken()).toMatchObject({ status: 'ok' });
        expect(custody.getAccountKey()).toBeNull();
      }
    );

    it('setAccountKey is read back by getAccountKey', () => {
      const key = expectedKey('user-2') as never;
      custody.setAccountKey(key);
      expect(custody.getAccountKey()).toBe(key);
    });

    it('is cleared by clearTokens', () => {
      storeRefreshToken({
        refreshToken: 't',
        rememberMe: false,
        apiBase: origin,
        serverUserId: 'user-1',
      } as never);
      clearTokens();
      expect(custody.getAccountKey()).toBeNull();
    });

    it('is cleared by clearTokensIfOwner', () => {
      const owner = storeRefreshToken({
        refreshToken: 't',
        rememberMe: false,
        apiBase: origin,
        serverUserId: 'user-1',
      } as never);
      expect(clearTokensIfOwner(owner)).toBe(true);
      expect(custody.getAccountKey()).toBeNull();
    });

    it('is cleared by performLogout, so the preference scope is null again', async () => {
      storeRefreshToken({
        refreshToken: 't',
        rememberMe: false,
        apiBase: origin,
        serverUserId: 'user-1',
      } as never);
      const sid = serviceIdForApiBase(origin);
      const record = { serviceId: sid } as never;
      const service = { serviceId: sid, custody } as never;
      expect(preferenceScopeFor(record, service)).toEqual({
        serviceId: sid,
        accountKey: expectedKey('user-1'),
      });
      mockNetFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
      await performLogout('access-tok');
      expect(custody.getAccountKey()).toBeNull();
      expect(preferenceScopeFor(record, service)).toBeNull();
    });

    it('refuses a serverUserId the IPC guard refuses, before any state moves', () => {
      const owner = storeRefreshToken({
        refreshToken: 't',
        rememberMe: false,
        apiBase: origin,
        serverUserId: 'user-1',
      } as never);
      expect(() =>
        storeRefreshToken({
          refreshToken: 't2',
          rememberMe: false,
          apiBase: origin,
          serverUserId: 'user\0x',
        } as never)
      ).toThrow(TypeError);
      expect(credentialOwnerIsCurrent(owner)).toBe(true);
      expect(custody.getAccountKey()).toBe(expectedKey('user-1'));
    });

    it('is derived on an owner-scoped (SSO) publish too', () => {
      const owner = reserveCredentialOwner();
      expect(
        storeRefreshTokenIfOwner(
          {
            refreshToken: 't',
            rememberMe: false,
            apiBase: origin,
            serverUserId: 'user-3',
          } as never,
          owner
        )
      ).toBe(owner);
      expect(custody.getAccountKey()).toBe(expectedKey('user-3'));
    });

    it.each(['ABCDEF0123456789', 'short', 7])('setAccountKey refuses %s', (bad) => {
      expect(() => custody.setAccountKey(bad as never)).toThrow(TypeError);
      expect(custody.getAccountKey()).toBeNull();
    });

    it('is replaced, not kept, when the next login carries no serverUserId', () => {
      storeRefreshToken({
        refreshToken: 't',
        rememberMe: false,
        apiBase: origin,
        serverUserId: 'user-1',
      } as never);
      storeRefreshToken({ refreshToken: 't2', rememberMe: false, apiBase: origin });
      expect(custody.getAccountKey()).toBeNull();
    });
  });

  describe('restoreRefreshToken', () => {
    it('restores rememberMe=false session from main-process memory only', async () => {
      storeRefreshToken({
        refreshToken: 'memory-token',
        rememberMe: false,
        apiBase: origin,
      });
      fsRead.impl = () => {
        throw new Error('disk should not be read for memory session');
      };

      expect(await restoreRefreshToken()).toEqual({
        status: 'ok',
        token: 'memory-token',
        apiBase: origin,
        rememberMe: false,
      });
      expect(fsWriteCalls.length).toBe(0);
    });

    it('returns memory API base for rememberMe=false sessions', () => {
      storeRefreshToken({
        refreshToken: 'memory-token',
        rememberMe: false,
        apiBase: origin,
      });
      fsRead.impl = () => {
        throw new Error('disk should not be read for memory session');
      };

      expect(getCredentialApiBase()).toBe(origin);
    });

    it('returns unavailable when safeStorage off', async () => {
      safeStorageAvailable = false;
      expect(await restoreRefreshToken()).toEqual({ status: 'unavailable' });
    });

    it('returns no_session when meta file missing', async () => {
      fsRead.impl = () => {
        throw new Error('ENOENT');
      };
      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
    });

    it('restores token successfully from disk', async () => {
      fsRead.impl = (path) => {
        const file = String(path);
        if (file.endsWith('active-profile.json')) throw new Error('ENOENT');
        if (file.endsWith('token-meta.json')) {
          return JSON.stringify({ apiBase: origin, rememberMe: true });
        }
        return Buffer.from(`v11${tokenEnvelope('stored-token', origin)}`);
      };
      const result = await restoreRefreshToken();
      expect(result).toEqual({
        status: 'ok',
        token: 'stored-token',
        apiBase: origin,
        rememberMe: true,
      });
    });

    it('restores a remembered token after main-process restart', async () => {
      storeRefreshToken({
        refreshToken: 'self-token',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      _resetForTesting();
      fsRead.impl = readMockDisk;

      expect(await restoreRefreshToken()).toEqual({
        status: 'ok',
        token: 'self-token',
        apiBase: origin,
        rememberMe: true,
      });
      expect(getCredentialApiBase()).toBe(origin);
    });

    // #86 Task 7B (S3): a meta naming another server is not this profile's credential.
    it('refuses to restore a token whose meta names another origin', async () => {
      storeRefreshToken({
        refreshToken: 'self-token',
        rememberMe: true,
        apiBase: 'https://homelab.lan',
      });
      await flushDiskWrites();
      _resetForTesting();
      fsRead.impl = readMockDisk;

      expect(await restoreRefreshToken()).toEqual({ status: 'tampered' });
      expect(getCachedAccessToken()).toBeNull();
      expect(getCredentialApiBase()).toBeNull();
    });

    it('returns tampered when decryption fails (read throws)', async () => {
      fsRead.impl = (path) => {
        const file = String(path);
        if (file.endsWith('active-profile.json')) throw new Error('ENOENT');
        if (file.endsWith('token-meta.json')) {
          return JSON.stringify({ apiBase: origin, rememberMe: true });
        }
        throw new Error('read error');
      };
      expect(await restoreRefreshToken()).toEqual({ status: 'tampered' });
      expect(fsUnlinkCount).toBeGreaterThan(0);
    });
  });

  describe('clearTokens', () => {
    it('clears in-memory state and deletes disk files', () => {
      storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: false,
        apiBase: origin,
      });
      fsUnlinkCount = 0;
      clearTokens();
      expect(fsUnlinkCount).toBeGreaterThan(0);
    });

    it('clears the active self-hosted profile files, not the SaaS root files', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: true,
        apiBase: 'https://homelab.lan',
      });
      await storeE2EEKeysIfOwner(
        {
          wrappingKeyBase64: 'wk',
          preferencesKeyBase64: 'pk',
          wrappedPrivateKeyBase64: 'wpk',
        },
        owner
      );
      fsUnlinkCalls.length = 0;

      clearTokens();

      // #86: the custody's own files, and nothing outside its own directory.
      const own = profilePathsForApiBase(origin);
      expect(fsUnlinkCalls).toContainEqual(own.tokenFile);
      expect(fsUnlinkCalls).toContainEqual(own.metaFile);
      expect(fsUnlinkCalls).toContainEqual(own.e2eeFile);
      const ownDir = own.tokenFile.slice(0, own.tokenFile.lastIndexOf('/'));
      expect(
        fsUnlinkCalls
          .filter((p) => !p.endsWith('active-profile.json'))
          .every((p) => p.slice(0, p.lastIndexOf('/')) === ownDir)
      ).toBe(true);
    });

    it('clearTokensIfOwner preserves a successor lifecycle', async () => {
      const staleOwner = storeRefreshToken({
        refreshToken: 'rt-old',
        rememberMe: false,
        apiBase: origin,
      });
      const successorOwner = storeRefreshToken({
        refreshToken: 'rt-successor',
        rememberMe: false,
        apiBase: origin,
      });

      expect(clearTokensIfOwner(staleOwner)).toBe(false);
      expect(await restoreRefreshToken()).toEqual({
        status: 'ok',
        token: 'rt-successor',
        apiBase: origin,
        rememberMe: false,
      });
      expect(clearTokensIfOwner(successorOwner)).toBe(true);
      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
    });

    it('keeps the same owner across a successful refresh-token rotation', async () => {
      const owner = storeRefreshToken({
        refreshToken: 'rt-old',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
          refresh_token: 'rt-rotated',
        })
      );

      await expect(performRefresh()).resolves.toMatchObject({ status: 'ok' });
      expect(
        await storeE2EEKeysIfOwner(
          {
            wrappingKeyBase64: 'wk',
            preferencesKeyBase64: 'pk',
            wrappedPrivateKeyBase64: 'wpk',
          },
          owner
        )
      ).toBe(true);
      expect(clearTokensIfOwner(owner)).toBe(true);
      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
    });

    it('lets password credentials and keys win while a reserved SSO exchange waits', async () => {
      const ssoOwner = reserveCredentialOwner(origin);
      const passwordOwner = storeRefreshToken({
        refreshToken: 'rt-password',
        rememberMe: false,
        apiBase: origin,
        accessToken: 'at-password',
      });
      const passwordKeys = {
        wrappingKeyBase64: 'password-wk',
        preferencesKeyBase64: 'password-pk',
        wrappedPrivateKeyBase64: 'password-wpk', // pragma: allowlist secret
      };
      expect(await storeE2EEKeysIfOwner(passwordKeys, passwordOwner)).toBe(true);

      expect(
        storeRefreshTokenIfOwner(
          {
            refreshToken: 'rt-stale-sso',
            rememberMe: true,
            apiBase: origin,
            accessToken: 'at-stale-sso',
          },
          ssoOwner
        )
      ).toBeNull();
      expect(await restoreRefreshToken()).toMatchObject({ token: 'rt-password' });
      expect(await restoreE2EEKeys()).toEqual(passwordKeys);
      expect(getCredentialCustodyState()).toEqual({
        credentialOwner: passwordOwner,
        pendingE2EEUnlock: false,
      });
    });
  });

  describe('E2EE keys', () => {
    it('storeE2EEKeysIfOwner does not overwrite successor-owned key custody', async () => {
      const staleOwner = storeRefreshToken({
        refreshToken: 'rt-old',
        rememberMe: false,
        apiBase: origin,
      });
      const successorOwner = storeRefreshToken({
        refreshToken: 'rt-successor',
        rememberMe: false,
        apiBase: origin,
      });
      const staleKeys = {
        wrappingKeyBase64: 'stale-wk',
        preferencesKeyBase64: 'stale-pk',
        wrappedPrivateKeyBase64: 'stale-wpk', // pragma: allowlist secret
      };
      const successorKeys = {
        wrappingKeyBase64: 'successor-wk',
        preferencesKeyBase64: 'successor-pk',
        wrappedPrivateKeyBase64: 'successor-wpk', // pragma: allowlist secret
      };

      expect(await storeE2EEKeysIfOwner(staleKeys, staleOwner)).toBe(false);
      expect(await restoreE2EEKeys()).toBeNull();
      expect(await storeE2EEKeysIfOwner(successorKeys, successorOwner)).toBe(true);
      expect(await restoreE2EEKeys()).toEqual(successorKeys);
    });

    it('storeE2EEKeysIfOwner encrypts and writes when rememberMe=true', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      fsWriteCalls.length = 0;
      await storeE2EEKeysIfOwner(
        {
          wrappingKeyBase64: 'wk',
          preferencesKeyBase64: 'pk',
          wrappedPrivateKeyBase64: 'wpk',
        },
        owner
      );
      expect(fsWriteCalls.length).toBeGreaterThan(0);
    });

    it('writes self-hosted E2EE keys under the active profile namespace', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: true,
        apiBase: 'https://homelab.lan',
      });
      await flushDiskWrites();
      fsWriteCalls.length = 0;

      await storeE2EEKeysIfOwner(
        {
          wrappingKeyBase64: 'wk',
          preferencesKeyBase64: 'pk',
          wrappedPrivateKeyBase64: 'wpk',
        },
        owner
      );

      // #86: the custody's own origin selects the namespace (brief step 1).
      expect(fsWriteCalls.map((c) => c[0] as string)).toContainEqual(
        profilePathsForApiBase(origin).e2eeFile
      );
    });

    it('storeE2EEKeys does nothing when safeStorage unavailable', () => {
      safeStorageAvailable = false;
      storeE2EEKeys({
        wrappingKeyBase64: 'k',
        preferencesKeyBase64: 'k',
        wrappedPrivateKeyBase64: 'k',
      });
      expect(fsWriteCalls.length).toBe(0);
    });

    it('storeE2EEKeys keeps keys in main-process memory (never disk) when rememberMe=false', async () => {
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: false,
        apiBase: origin,
      });
      fsWriteCalls.length = 0;
      const keys = {
        wrappingKeyBase64: 'wk',
        preferencesKeyBase64: 'pk',
        wrappedPrivateKeyBase64: 'wpk',
      };
      await storeE2EEKeysIfOwner(keys, owner);
      // Session-only key material is NEVER written to disk (#1870)...
      expect(fsWriteCalls.length).toBe(0);
      // ...but it IS held in main-process memory so it survives a soft reload.
      fsRead.impl = () => {
        throw new Error('disk should not be read for memory-only E2EE keys');
      };
      expect(await restoreE2EEKeys()).toEqual(keys);
    });

    it('restoreE2EEKeys prefers the in-memory copy over disk', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: true,
        apiBase: origin,
      });
      const memKeys = {
        wrappingKeyBase64: 'mem',
        preferencesKeyBase64: 'mem',
        wrappedPrivateKeyBase64: 'mem', // pragma: allowlist secret
      };
      await storeE2EEKeysIfOwner(memKeys, owner);
      // Disk would decode to a DIFFERENT set; the memory copy must win.
      fsRead.impl = () =>
        Buffer.from(
          JSON.stringify({
            wrappingKeyBase64: 'disk',
            preferencesKeyBase64: 'disk',
            wrappedPrivateKeyBase64: 'disk', // pragma: allowlist secret
          })
        );
      expect(await restoreE2EEKeys()).toEqual(memKeys);
    });

    it('clearTokens wipes the in-memory E2EE keys (no heap residue after logout)', async () => {
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: false,
        apiBase: origin,
      });
      await storeE2EEKeysIfOwner(
        {
          wrappingKeyBase64: 'wk',
          preferencesKeyBase64: 'pk',
          wrappedPrivateKeyBase64: 'wpk',
        },
        owner
      );
      // Present before clear (from memory; no disk file for a session-only user).
      fsRead.impl = () => {
        throw new Error('ENOENT');
      };
      expect(await restoreE2EEKeys()).not.toBeNull();
      clearTokens();
      // Gone after clear — memory wiped, disk has nothing.
      expect(await restoreE2EEKeys()).toBeNull();
    });

    it('restores only an owner-matched E2EE blob after a process restart', async () => {
      const data = {
        wrappingKeyBase64: 'wk',
        preferencesKeyBase64: 'pk',
        wrappedPrivateKeyBase64: 'wpk',
      };
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: true,
        apiBase: origin,
      });
      expect(await storeE2EEKeysIfOwner(data, owner)).toBe(true);

      _resetForTesting();
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'tk' });
      expect(await restoreE2EEKeys()).toEqual(data);
      expect(getCredentialCustodyState()).toMatchObject({ pendingE2EEUnlock: false });
    });

    it('does not restore predecessor keys in the new-credential crash window', async () => {
      fsRead.impl = readMockDisk;
      const predecessorOwner = storeRefreshToken({
        refreshToken: 'rt-predecessor',
        rememberMe: true,
        apiBase: origin,
      });
      expect(
        await storeE2EEKeysIfOwner(
          {
            wrappingKeyBase64: 'predecessor-wk',
            preferencesKeyBase64: 'predecessor-pk',
            wrappedPrivateKeyBase64: 'predecessor-wpk', // pragma: allowlist secret
          },
          predecessorOwner
        )
      ).toBe(true);

      storeRefreshToken({
        refreshToken: 'rt-successor',
        rememberMe: true,
        apiBase: origin,
      });
      // Crash after the successor token landed but before its key write.
      await flushDiskWrites();
      _resetForTesting();

      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'rt-successor' });
      expect(await restoreE2EEKeys()).toBeNull();
      expect(getCredentialCustodyState()).toMatchObject({ pendingE2EEUnlock: true });
    });

    it('keeps a new owner pending across a soft reload until its matching key write', async () => {
      const owner = storeRefreshToken({
        refreshToken: 'rt-successor',
        rememberMe: false,
        apiBase: origin,
      });

      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'rt-successor' });
      expect(await restoreE2EEKeys()).toBeNull();
      expect(getCredentialCustodyState()).toEqual({
        credentialOwner: owner,
        pendingE2EEUnlock: true,
      });

      expect(
        await storeE2EEKeysIfOwner(
          {
            wrappingKeyBase64: 'successor-wk',
            preferencesKeyBase64: 'successor-pk',
            wrappedPrivateKeyBase64: 'successor-wpk', // pragma: allowlist secret
          },
          owner
        )
      ).toBe(true);
      expect(getCredentialCustodyState()).toMatchObject({ pendingE2EEUnlock: false });
    });

    it('rejects an unowned E2EE write once credentials exist', async () => {
      storeRefreshToken({
        refreshToken: 'rt',
        rememberMe: false,
        apiBase: origin,
      });
      expect(
        storeE2EEKeys({
          wrappingKeyBase64: 'unowned-wk',
          preferencesKeyBase64: 'unowned-pk',
          wrappedPrivateKeyBase64: 'unowned-wpk', // pragma: allowlist secret
        })
      ).toBe(false);
      expect(await restoreE2EEKeys()).toBeNull();
    });

    it('restoreE2EEKeys returns null when safeStorage unavailable', async () => {
      safeStorageAvailable = false;
      expect(await restoreE2EEKeys()).toBeNull();
    });

    it('restoreE2EEKeys returns null on read failure', async () => {
      fsRead.impl = () => {
        throw new Error('ENOENT');
      };
      expect(await restoreE2EEKeys()).toBeNull();
    });

    it('restoreE2EEKeys returns null when the stored blob fails to decrypt', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: true,
        apiBase: origin,
      });
      expect(
        await storeE2EEKeysIfOwner(
          { wrappingKeyBase64: 'wk', preferencesKeyBase64: 'pk', wrappedPrivateKeyBase64: 'wpk' },
          owner
        )
      ).toBe(true);
      _resetForTesting();
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'tk' });
      vi.spyOn(safeStorage, 'decryptStringAsync').mockRejectedValueOnce(
        new Error('Error while decrypting the ciphertext')
      );

      await expect(restoreE2EEKeys()).resolves.toBeNull();
      expect(safeStorage.decryptStringAsync).toHaveBeenCalled();
    });
  });

  // ─── E2EE persist-failure signalling (regression #1288) ─────────────
  // storeE2EEKeys used to swallow keychain/disk write failures and return
  // void, so the IPC handler always resolved and the renderer persist-catch
  // (Register / SSOPassphraseSetup / Login) was dead code for a genuine
  // keychain-locked write. Contract now: return `true` when persistence is in
  // its expected state (written, or intentionally skipped for session-only /
  // no-safeStorage), `false` ONLY when a disk write was attempted and failed.
  // In-memory key custody is preserved regardless (the #1278 invariant).
  describe('storeE2EEKeys persist-failure signalling (#1288)', () => {
    const keys = {
      wrappingKeyBase64: 'wk',
      preferencesKeyBase64: 'pk',
      wrappedPrivateKeyBase64: 'wpk',
    };

    it('returns false when the keychain write genuinely fails', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: true,
        apiBase: origin,
      });
      // Keychain locked → safeStorage.encryptStringAsync rejects (the #1288
      // failure mode). Drain the token write first so only the E2EE encrypt
      // hits the rejection.
      await flushDiskWrites();
      vi.spyOn(safeStorage, 'encryptStringAsync').mockRejectedValueOnce(
        new Error('keychain locked')
      );

      expect(await storeE2EEKeysIfOwner(keys, owner)).toBe(false);
      // #1278 invariant: a persistence failure must NEVER drop the in-memory
      // session — keys stay usable in-session; only restart-survival is lost.
      expect(await restoreE2EEKeys()).toEqual(keys);
    });

    it('returns true on a successful disk persist', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      fsWriteCalls.length = 0;

      expect(await storeE2EEKeysIfOwner(keys, owner)).toBe(true);
      expect(fsWriteCalls.length).toBeGreaterThan(0);
    });

    it('returns true when disk persist is intentionally skipped (session-only)', async () => {
      const owner = storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: false,
        apiBase: origin,
      });
      fsWriteCalls.length = 0;

      // Session-only skip is not a failure — the renderer must not warn.
      expect(await storeE2EEKeysIfOwner(keys, owner)).toBe(true);
      expect(fsWriteCalls.length).toBe(0);
    });
  });

  describe('releaseCredentialReservation (#2394)', () => {
    const API = origin;
    const keys = {
      wrappingKeyBase64: 'wk',
      preferencesKeyBase64: 'pk',
      wrappedPrivateKeyBase64: 'wpk', // pragma: allowlist secret
    };

    it('reopens the generic staging lane after an orphaned SSO reservation', () => {
      reserveCredentialOwner(API);
      expect(storeE2EEKeys(keys)).toBe(false);

      expect(releaseCredentialReservation()).toBe(true);
      expect(storeE2EEKeys(keys)).toBe(true);
    });

    it('lets the staged keys survive to storeRefreshToken adoption', async () => {
      reserveCredentialOwner(API);
      releaseCredentialReservation();
      expect(storeE2EEKeys(keys)).toBe(true);

      storeRefreshToken({ refreshToken: 'rt-new', rememberMe: true, apiBase: API });

      expect(await restoreE2EEKeys()).toEqual(keys);
    });

    // Asserts the outcome that matters — a published credential survives an
    // abandon — but be precise about WHY it passes: publishRefreshToken nulls
    // reservedCredentialOwner, so the release short-circuits on the FIRST
    // guard clause. This is NOT a lock on the inMemoryRefreshToken clause, and
    // it would NOT catch a rewrite to `if (reserved === null) return false;
    // return clearTokensIfOwner(reserved)`. That rewrite is ruled out by the
    // reasoning in the primitive's docstring, not by this test — the state it
    // would need (reserved set AND a token published) is unreachable through
    // the public API, so no test can construct it.
    it('is a no-op after a credential is published (cannot wipe a live session)', async () => {
      const owner = reserveCredentialOwner(API);
      expect(
        storeRefreshTokenIfOwner({ refreshToken: 'rt-live', rememberMe: true, apiBase: API }, owner)
      ).not.toBeNull();

      expect(releaseCredentialReservation()).toBe(false);
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'rt-live' });
    });

    it('is a no-op when no reservation exists', () => {
      expect(releaseCredentialReservation()).toBe(false);
    });

    it('bumps the credential generation so straggler continuations fail their CAS', () => {
      const owner = reserveCredentialOwner(API);
      expect(credentialOwnerIsCurrent(owner)).toBe(true);

      expect(releaseCredentialReservation()).toBe(true);

      expect(credentialOwnerIsCurrent(owner)).toBe(false);
    });

    it('is idempotent — a second release is a no-op', () => {
      reserveCredentialOwner(API);
      expect(releaseCredentialReservation()).toBe(true);
      expect(releaseCredentialReservation()).toBe(false);
      expect(storeE2EEKeys(keys)).toBe(true);
    });

    it('warns without leaking key material or the owner value when the lane is held', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const owner = reserveCredentialOwner(API);

      expect(storeE2EEKeys(keys)).toBe(false);

      const emitted = warn.mock.calls.flat().join(' ');
      expect(emitted).toContain('storeE2EEKeys');
      expect(emitted).not.toContain(String(owner));
      // Iterate every component rather than spot-checking one: a future log
      // leak of ANY key field must fail this test, not just the wrapped
      // private key. (CodeRabbit, PR #2655 — CWE-532.)
      for (const value of Object.values(keys)) {
        expect(emitted).not.toContain(value);
      }
      warn.mockRestore();
    });
  });

  describe('getCredentialApiBase', () => {
    it('returns apiBase from meta file', () => {
      fsRead.impl = () => JSON.stringify({ apiBase: origin, rememberMe: true });
      expect(getCredentialApiBase()).toBe(origin);
    });

    it('returns null when meta file does not exist', () => {
      fsRead.impl = () => {
        throw new Error('ENOENT');
      };
      expect(getCredentialApiBase()).toBeNull();
    });
  });

  describe('getCapabilities', () => {
    it('returns persistAvailable=true when safeStorage works', async () => {
      safeStorageAvailable = true;
      expect(await getCapabilities()).toEqual({ persistAvailable: true });
    });

    it('returns persistAvailable=false when safeStorage unavailable', async () => {
      safeStorageAvailable = false;
      expect(await getCapabilities()).toEqual({ persistAvailable: false });
    });
  });

  describe('stopProactiveRefresh', () => {
    it('is safe to call when no timer exists', () => {
      expect(() => stopProactiveRefresh()).not.toThrow();
    });
  });

  // ─── performRefresh ─────────────────────────────────────────────────

  describe('performRefresh', () => {
    it('rejects an oversized refresh response without accepting its token', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: 'http://localhost:8080',
      });
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({ access_token: 'synthetic-access', padding: 'x'.repeat(2 * 1024 * 1024) })
      );
      expect(await performRefresh()).toEqual({ status: 'refresh_failed' });
      expect(getCachedAccessToken()).toBeNull();
    });

    it('aborts a stalled refresh body and permits a subsequent refresh', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: 'http://localhost:8080',
      });
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
      const cancel = vi.fn();
      mockNetFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
      const pending = performRefresh();
      await vi.waitFor(() => expect(mockNetFetch).toHaveBeenCalledOnce());
      controller.abort();
      expect(await pending).toEqual({ status: 'refresh_failed' });
      expect(cancel).toHaveBeenCalledOnce();
      expect(getCachedAccessToken()).toBeNull();
      timeout.mockRestore();
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'next-token' }));
      expect(await performRefresh()).toMatchObject({ status: 'ok', accessToken: 'next-token' });
    });

    it('returns no_token when no refresh token is stored', async () => {
      const result = await performRefresh();
      expect(result).toEqual({ status: 'no_token' });
      expect(mockNetFetch).not.toHaveBeenCalled();
    });

    it('makes POST with correct headers on success', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: jwt,
          session_id: 'sid1',
          previous_session_id: 'sid0',
        })
      );

      const result = await performRefresh();

      expect(result).toEqual({
        status: 'ok',
        accessToken: jwt,
        sessionId: 'sid1',
        previousSessionId: 'sid0',
      });
      expect(mockNetFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockNetFetch.mock.calls[0];
      expect(url).toBe(`${origin}/api/v1/auth/refresh`);
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-Refresh-Token']).toBe('rt-abc');
      expect(opts.headers['X-Machine-Id']).toBe('mid');
      expect(opts.credentials).toBe('omit');
      expect(mockGetMachineId).toHaveBeenCalledWith(origin);
    });

    // The attestation cache is app-global and minted for the SaaS control plane
    // only, so only the SaaS custody's session rotation may clear it: a
    // self-hosted refresh naming a new session leaves it alone.
    it('clears the attestation token on a new session only from the SaaS custody', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({ access_token: jwt, session_id: 'sid1', previous_session_id: 'sid0' })
      );
      mockClearAttestationToken.mockClear();

      expect((await performRefresh()).status).toBe('ok');
      const isSaas = serviceIdForApiBase(origin) === SAAS_SERVICE_ID;
      expect(mockClearAttestationToken).toHaveBeenCalledTimes(isSaas ? 1 : 0);
    });

    it('keeps the attestation token when the refresh names no new session', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockClearAttestationToken.mockClear();
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt }));

      expect((await performRefresh()).status).toBe('ok');
      expect(mockClearAttestationToken).not.toHaveBeenCalled();
    });

    it('returns refresh_failed on non-ok HTTP status', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      const result = await performRefresh();
      expect(result).toEqual({ status: 'refresh_failed' });
    });

    it('returns mfa_required on 403 with MFA challenge', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'suspicious_session_mfa',
            mfa_challenge_token: 'chal-tok',
            methods: ['totp'],
            recovery_only_methods: ['recovery_code'],
          },
          403
        )
      );

      const result = await performRefresh();
      expect(result).toEqual({
        status: 'mfa_required',
        mfaChallengeToken: 'chal-tok',
        mfaMethods: ['totp'],
        mfaRecoveryOnlyMethods: ['recovery_code'],
        // The server that issued the challenge: the one main refreshed against.
        mfaApiBase: origin,
      });
    });

    it('passes the challenge WebAuthn options through unparsed', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      const webauthnOptions = { publicKey: { challenge: 'AQID', rpId: 'localhost' } };
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'mfa_upgrade_required',
            mfa_challenge_token: 'chal-wa',
            methods: ['webauthn'],
            webauthn_options: webauthnOptions,
          },
          403
        )
      );

      const result = await performRefresh();
      expect(result.status).toBe('mfa_required');
      expect(result.mfaWebauthnOptions).toEqual(webauthnOptions);
      expect(result.mfaApiBase).toBe(origin);
    });

    // #3663 review. Mutant: the default dropped, so the modal always opens on
    // the strongest method; or the lists cast, so a string reaches the renderer.
    it('carries default_method, and keeps only strings from the method lists', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'suspicious_session_mfa',
            mfa_challenge_token: 'chal-default',
            methods: 'totp',
            recovery_only_methods: ['backup_code', 7],
            default_method: 'totp',
          },
          403
        )
      );

      const result = await performRefresh();
      expect(result.mfaMethods).toEqual([]);
      expect(result.mfaRecoveryOnlyMethods).toEqual(['backup_code']);
      expect(result.mfaDefaultMethod).toBe('totp');
    });

    it('drops a default_method that is not a string', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'suspicious_session_mfa',
            mfa_challenge_token: 'chal-default',
            methods: ['totp'],
            default_method: 42,
          },
          403
        )
      );

      const result = await performRefresh();
      expect(result.mfaDefaultMethod).toBeUndefined();
    });

    it('returns refresh_failed on 403 without MFA data', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));

      const result = await performRefresh();
      expect(result).toEqual({ status: 'refresh_failed' });
    });

    it('returns refresh_failed when response missing access_token', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ session_id: 'sid1' }));

      const result = await performRefresh();
      expect(result).toEqual({ status: 'refresh_failed' });
    });

    it('returns refresh_failed on network error', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockRejectedValueOnce(new Error('network down'));

      const result = await performRefresh();
      expect(result).toEqual({ status: 'refresh_failed' });
    });

    it('deduplicates concurrent calls (single-flight)', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt }));

      const [r1, r2, r3] = await Promise.all([
        performRefresh(),
        performRefresh(),
        performRefresh(),
      ]);

      expect(mockNetFetch).toHaveBeenCalledOnce();
      expect(r1).toEqual(r2);
      expect(r2).toEqual(r3);
    });

    it('refreshes a successor owner while its predecessor is still in flight', async () => {
      const oldApiBase = origin;
      const successorApiBase = 'https://successor.example';
      const successorAccessToken = makeJwt(Math.floor(Date.now() / 1000) + 900);

      let resolveOldRefresh: (response: Response) => void = () => {
        throw new Error('old refresh did not start');
      };
      let resolveSuccessorRefresh: (response: Response) => void = () => {
        throw new Error('successor refresh did not start');
      };
      mockNetFetch
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveOldRefresh = resolve;
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveSuccessorRefresh = resolve;
            })
        );

      storeRefreshToken({
        refreshToken: 'rt-old',
        rememberMe: false,
        apiBase: oldApiBase,
      });
      const oldRefresh = performRefresh();

      storeRefreshToken({
        refreshToken: 'rt-successor',
        rememberMe: false,
        apiBase: successorApiBase,
      });
      const successorRefresh = performRefresh();

      expect(mockNetFetch).toHaveBeenCalledTimes(2);
      expect(mockNetFetch).toHaveBeenNthCalledWith(
        2,
        `${successorApiBase}/api/v1/auth/refresh`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Refresh-Token': 'rt-successor' }),
        })
      );

      // Settling the predecessor must neither commit its response nor clear the
      // still-pending successor operation's single-flight pointer.
      resolveOldRefresh(
        jsonResponse({
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 1800),
          refresh_token: 'rt-old-rotated',
        })
      );
      await expect(oldRefresh).resolves.toEqual({ status: 'refresh_failed' });

      const successorJoin = performRefresh();
      expect(mockNetFetch).toHaveBeenCalledTimes(2);

      resolveSuccessorRefresh(
        jsonResponse({
          access_token: successorAccessToken,
          refresh_token: 'rt-successor-rotated',
          session_id: 'sid-successor',
        })
      );
      const [successorResult, joinedResult] = await Promise.all([successorRefresh, successorJoin]);

      expect(successorResult).toEqual({
        status: 'ok',
        accessToken: successorAccessToken,
        sessionId: 'sid-successor',
        previousSessionId: undefined,
      });
      expect(joinedResult).toEqual(successorResult);
      expect(getCachedAccessToken()).toBe(successorAccessToken);
    });

    it('rotates refresh token and persists to disk when rememberMe=true', async () => {
      storeRefreshToken({
        refreshToken: 'rt-old',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      fsWriteCalls.length = 0; // clear storeRefreshToken writes
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({ access_token: jwt, refresh_token: 'rt-new' })
      );

      const result = await performRefresh();
      expect(result.status).toBe('ok');
      await flushDiskWrites();
      // Should have written the rotated token to disk
      const tokenWrites = fsWriteCalls.filter((c) => (c[0] as string).includes('secure-token.dat'));
      expect(tokenFromCiphertext(tokenWrites.at(-1)?.[1])).toBe('rt-new');
    });

    it('does not persist rotated token when rememberMe=false', async () => {
      storeRefreshToken({
        refreshToken: 'rt-old',
        rememberMe: false,
        apiBase: origin,
      });
      fsWriteCalls.length = 0;
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({ access_token: jwt, refresh_token: 'rt-new' })
      );

      await performRefresh();
      await flushDiskWrites();
      const tokenWrites = fsWriteCalls.filter((c) => (c[0] as string).includes('secure-token.dat'));
      expect(tokenWrites.length).toBe(0);
    });

    it('handles mfa_upgrade_required variant', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'mfa_upgrade_required',
            mfa_challenge_token: 'chal2',
            methods: ['webauthn'],
          },
          403
        )
      );

      const result = await performRefresh();
      expect(result.status).toBe('mfa_required');
      expect(result.mfaChallengeToken).toBe('chal2');
      expect(result.mfaMethods).toEqual(['webauthn']);
      expect(result.mfaRecoveryOnlyMethods).toEqual([]);
    });
  });

  // ─── Proactive Refresh (timer scheduling via performRefresh) ──────

  describe('proactive refresh scheduling', () => {
    it('schedules proactive timer after successful refresh', async () => {
      vi.useFakeTimers();
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });

      // First refresh — returns JWT expiring in 900s (15min)
      const exp = Math.floor(Date.now() / 1000) + 900;
      const jwt = makeJwt(exp);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt }));
      await performRefresh();

      // Register callback to capture proactive refresh
      const cb = vi.fn();
      setProactiveRefreshCallback(cb);

      // Second refresh (proactive) — triggered by timer at ~840s
      const jwt2 = makeJwt(Math.floor(Date.now() / 1000) + 900 + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt2 }));

      // Advance to just before the 60s buffer (840s = 900-60)
      await vi.advanceTimersByTimeAsync(839_000);
      expect(cb).not.toHaveBeenCalled();

      // Advance past the trigger point
      await vi.advanceTimersByTimeAsync(2_000);
      expect(cb).toHaveBeenCalledWith(jwt2, undefined, undefined);
    });

    it('calls proactive callback with refresh-session lineage when present', async () => {
      vi.useFakeTimers();
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });

      const exp = Math.floor(Date.now() / 1000) + 120; // expires in 2min
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: makeJwt(exp) }));
      await performRefresh();

      const cb = vi.fn();
      setProactiveRefreshCallback(cb);

      // Proactive fires at 60s (120 - 60 buffer)
      const jwt2 = makeJwt(Math.floor(Date.now() / 1000) + 1000);
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: jwt2,
          session_id: 'sid-new',
          previous_session_id: 'sid-old',
        })
      );

      await vi.advanceTimersByTimeAsync(61_000);
      expect(cb).toHaveBeenCalledWith(jwt2, 'sid-new', 'sid-old');
    });

    it('retries proactive refresh after failure', async () => {
      vi.useFakeTimers();
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });

      const exp = Math.floor(Date.now() / 1000) + 120;
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: makeJwt(exp) }));
      await performRefresh();

      const cb = vi.fn();
      setProactiveRefreshCallback(cb);

      // Proactive fires but fails
      mockNetFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(cb).not.toHaveBeenCalled();

      // Retry after 10s cooldown should succeed
      const jwt3 = makeJwt(Math.floor(Date.now() / 1000) + 1000);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt3 }));
      await vi.advanceTimersByTimeAsync(11_000);
      expect(cb).toHaveBeenCalledWith(jwt3, undefined, undefined);
    });

    it.each([401, 403])('stops proactive retries after an HTTP %i rejection', async (status) => {
      vi.useFakeTimers();
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: true,
        apiBase: origin,
      });

      const exp = Math.floor(Date.now() / 1000) + 120;
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: makeJwt(exp) }));
      await performRefresh();

      const cb = vi.fn();
      setProactiveRefreshCallback(cb);

      // A revoked token: the proactive refresh is refused and must not loop.
      mockNetFetch.mockResolvedValue(new Response('Unauthorized', { status }));
      await vi.advanceTimersByTimeAsync(61_000);
      const callsAfterRejection = mockNetFetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockNetFetch.mock.calls.length).toBe(callsAfterRejection);
      expect(cb).not.toHaveBeenCalled();
    });

    it('rate-limits immediate refresh for near-expiry tokens', async () => {
      vi.useFakeTimers();
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });

      // Token that expires in 30s (within the 60s buffer → immediate refresh)
      const exp = Math.floor(Date.now() / 1000) + 30;
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: makeJwt(exp) }));
      await performRefresh(); // This triggers scheduleProactiveRefresh with delay ≤ 0

      // Second immediate refresh would be rate-limited
      const cb = vi.fn();
      setProactiveRefreshCallback(cb);

      // The immediate proactive fires right away (but is rate-limited since
      // performRefresh just ran — within 10s window), so it schedules after cooldown
      const jwt2 = makeJwt(Math.floor(Date.now() / 1000) + 1000);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt2 }));

      await vi.advanceTimersByTimeAsync(11_000);
      expect(cb).toHaveBeenCalled();
    });
  });

  // ─── onSystemResume ─────────────────────────────────────────────────

  describe('onSystemResume', () => {
    it('is a no-op when no credentials are stored', async () => {
      onSystemResume();
      expect(mockNetFetch).not.toHaveBeenCalled();
    });

    it('triggers immediate refresh on wake', async () => {
      vi.useFakeTimers();
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });

      const cb = vi.fn();
      setProactiveRefreshCallback(cb);

      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt }));

      onSystemResume();
      // Let the async doProactiveRefresh() complete
      await vi.advanceTimersByTimeAsync(0);

      expect(mockNetFetch).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(jwt, undefined, undefined);
    });

    it('uses generation to drop an old response after identical credentials are re-stored', async () => {
      vi.useFakeTimers();
      const apiBase = origin;
      const refreshToken = 'rt-same';
      storeRefreshToken({
        refreshToken,
        rememberMe: true,
        apiBase,
        accessToken: makeJwt(Math.floor(Date.now() / 1000) + 120),
      });

      let resolveOldRefresh: (response: Response) => void = () => {
        throw new Error('old refresh did not start');
      };
      mockNetFetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOldRefresh = resolve;
          })
      );
      const cb = vi.fn();
      setProactiveRefreshCallback(cb);

      onSystemResume();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockNetFetch).toHaveBeenCalledWith(
        `${apiBase}/api/v1/auth/refresh`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Refresh-Token': refreshToken }),
        })
      );

      const successorAccessToken = makeJwt(Math.floor(Date.now() / 1000) + 900);
      storeRefreshToken({
        refreshToken,
        rememberMe: true,
        apiBase,
        accessToken: successorAccessToken,
      });
      const successorTimerCount = vi.getTimerCount();
      expect(successorTimerCount).toBe(1);

      resolveOldRefresh(
        jsonResponse({
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 1800),
          refresh_token: 'rt-old-rotated',
          session_id: 'sid-old-2',
          previous_session_id: 'sid-old-1',
        })
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(cb).not.toHaveBeenCalled();
      expect(getCachedAccessToken()).toBe(successorAccessToken);
      expect(await restoreRefreshToken()).toEqual({
        status: 'ok',
        token: refreshToken,
        apiBase,
        rememberMe: true,
      });
      const tokenWrites = fsWriteCalls.filter((call) =>
        String(call[0]).endsWith('secure-token.dat')
      );
      expect(tokenFromCiphertext(tokenWrites.at(-1)?.[1])).toBe(refreshToken);
      expect(vi.getTimerCount()).toBe(successorTimerCount);

      // The stale response carried a later-expiring access token. If it had
      // replaced the successor's timer, no refresh would fire at this exact
      // successor deadline (900s expiry minus the 60s buffer).
      const timerRefreshAccessToken = makeJwt(Math.floor(Date.now() / 1000) + 1800);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: timerRefreshAccessToken }));
      await vi.advanceTimersByTimeAsync(839_999);
      expect(mockNetFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockNetFetch).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenCalledWith(timerRefreshAccessToken, undefined, undefined);
    });

    it('rate-limits refresh if recently refreshed', async () => {
      vi.useFakeTimers();
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });

      // Do a normal refresh first (sets lastProactiveRefreshTimestamp)
      const jwt1 = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt1 }));

      // Trigger the proactive path to set lastProactiveRefreshTimestamp
      const cb = vi.fn();
      setProactiveRefreshCallback(cb);

      // Simulate: advance to trigger the proactive timer, which sets the timestamp
      // Instead, call onSystemResume to set the timestamp via doProactiveRefresh
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt1 }));
      onSystemResume();
      await vi.advanceTimersByTimeAsync(0);
      expect(cb).toHaveBeenCalledTimes(1);
      cb.mockClear();
      mockNetFetch.mockClear();

      // Call onSystemResume again immediately — should be rate-limited
      const jwt2 = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt2 }));
      onSystemResume();

      // Should NOT have fired immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(mockNetFetch).not.toHaveBeenCalled();

      // Advance past rate-limit cooldown (10s)
      await vi.advanceTimersByTimeAsync(11_000);
      expect(cb).toHaveBeenCalledWith(jwt2, undefined, undefined);
    });
  });

  // ─── performLogout ──────────────────────────────────────────────────

  describe('performLogout', () => {
    it('calls server logout endpoint with correct headers', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: true,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      await performLogout('access-tok');

      expect(mockNetFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockNetFetch.mock.calls[0];
      expect(url).toBe(`${origin}/api/v1/auth/logout`);
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer access-tok');
      expect(opts.headers['X-Refresh-Token']).toBe('rt-abc');
    });

    it('clears tokens even if logout HTTP call fails', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: true,
        apiBase: origin,
      });
      fsUnlinkCount = 0;
      mockNetFetch.mockRejectedValueOnce(new Error('network down'));

      await performLogout('access-tok');

      // clearTokens should still have been called (disk files deleted)
      expect(fsUnlinkCount).toBeGreaterThan(0);
    });

    it('invalidates local credentials before the logout request settles', async () => {
      vi.useFakeTimers();
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: true,
        apiBase: origin,
        accessToken: makeJwt(Math.floor(Date.now() / 1000) + 900),
      });
      expect(vi.getTimerCount()).toBe(1);

      let resolveLogout: (response: Response) => void = () => {
        throw new Error('logout did not start');
      };
      mockNetFetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveLogout = resolve;
          })
      );

      const logout = performLogout('access-tok');

      expect(getCachedAccessToken()).toBeNull();
      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
      expect(vi.getTimerCount()).toBe(0);

      resolveLogout(new Response('', { status: 200 }));
      await logout;
    });

    it('is a no-op when no apiBase is set', async () => {
      await performLogout('access-tok');
      expect(mockNetFetch).not.toHaveBeenCalled();
    });

    it('omits Authorization header when no accessToken provided', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      await performLogout();

      const [, opts] = mockNetFetch.mock.calls[0];
      expect(opts.headers['Authorization']).toBeUndefined();
      expect(opts.headers['X-Refresh-Token']).toBe('rt-abc');
    });
  });

  // ─── getCachedAccessToken (#626) ──────────────────────────────────

  describe('getCachedAccessToken', () => {
    it('returns null before any refresh', () => {
      expect(getCachedAccessToken()).toBeNull();
    });

    it('returns access token after successful performRefresh', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt }));

      await performRefresh();

      expect(getCachedAccessToken()).toBe(jwt);
    });

    it('returns null after clearTokens', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt }));
      await performRefresh();

      clearTokens();

      expect(getCachedAccessToken()).toBeNull();
    });

    it('returns null after _resetForTesting', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt }));
      await performRefresh();

      _resetForTesting();

      expect(getCachedAccessToken()).toBeNull();
    });

    it('does not cache token on failed refresh', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      mockNetFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      await performRefresh();

      expect(getCachedAccessToken()).toBeNull();
    });

    it('caches token passed via storeRefreshToken accessToken field', () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
        accessToken: 'initial-jwt',
      });

      expect(getCachedAccessToken()).toBe('initial-jwt');
    });

    it('does not cache when accessToken field is omitted', () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });

      expect(getCachedAccessToken()).toBeNull();
    });

    it('clears stale token when storeRefreshToken called without accessToken', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
        accessToken: 'old-jwt',
      });
      expect(getCachedAccessToken()).toBe('old-jwt');

      storeRefreshToken({
        refreshToken: 'rt-def',
        rememberMe: false,
        apiBase: origin,
      });
      expect(getCachedAccessToken()).toBeNull();
    });

    it('updates cached token on successive refreshes', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
      });
      const jwt1 = makeJwt(Math.floor(Date.now() / 1000) + 900);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt1 }));
      await performRefresh();
      expect(getCachedAccessToken()).toBe(jwt1);

      const jwt2 = makeJwt(Math.floor(Date.now() / 1000) + 1800);
      mockNetFetch.mockResolvedValueOnce(jsonResponse({ access_token: jwt2 }));
      await performRefresh();
      expect(getCachedAccessToken()).toBe(jwt2);
    });

    it('clears cached token via performLogout', async () => {
      storeRefreshToken({
        refreshToken: 'rt-abc',
        rememberMe: false,
        apiBase: origin,
        accessToken: 'my-jwt',
      });
      expect(getCachedAccessToken()).toBe('my-jwt');

      mockNetFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
      await performLogout('my-jwt');
      expect(getCachedAccessToken()).toBeNull();
    });
  });

  // ─── Async safeStorage: weak keys and await-point fencing ──────────
  // The sync API ran each persist as one uninterruptible block. The async API
  // awaits an encrypt/decrypt, so every disk write and delete after an await
  // must re-check that its credential still owns custody.
  describe('async safeStorage persistence', () => {
    const API = origin;
    const keys = {
      wrappingKeyBase64: 'wk',
      preferencesKeyBase64: 'pk',
      wrappedPrivateKeyBase64: 'wpk', // pragma: allowlist secret
    };

    it('keeps a Remember-Me session in memory only under the Linux basic_text backend', async () => {
      setPlatform('linux');
      storageBackend = 'basic_text';
      const owner = storeRefreshToken({ refreshToken: 'rt-weak', rememberMe: true, apiBase: API });
      expect(await storeE2EEKeysIfOwner(keys, owner)).toBe(true);
      await flushDiskWrites();

      expect(credentialWrites()).toEqual([]);
      expect(await getCapabilities()).toEqual({ persistAvailable: false });
      // Still restorable across a soft reload, like rememberMe=false.
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'rt-weak' });
      expect(await restoreE2EEKeys()).toEqual(keys);
    });

    it('keeps a Remember-Me session in memory only when Linux encrypts with the hardcoded v10 key', async () => {
      setPlatform('linux');
      ciphertextTag = 'v10';
      const owner = storeRefreshToken({ refreshToken: 'rt-weak', rememberMe: true, apiBase: API });
      expect(await storeE2EEKeysIfOwner(keys, owner)).toBe(true);
      await flushDiskWrites();

      expect(credentialWrites()).toEqual([]);
      expect(await getCapabilities()).toEqual({ persistAvailable: false });
    });

    it('restores as unavailable without reading disk when only the hardcoded key exists', async () => {
      setPlatform('linux');
      storageBackend = 'basic_text';
      fsRead.impl = () => {
        throw new Error('disk must not be read');
      };
      expect(await restoreRefreshToken()).toEqual({ status: 'unavailable' });
      expect(fsUnlinkCalls).toEqual([]);
    });

    it('removes every predecessor file before the successor encrypt can be interrupted', async () => {
      fsRead.impl = readMockDisk;
      const predecessor = storeRefreshToken({
        refreshToken: 'rt-old',
        rememberMe: true,
        apiBase: API,
      });
      await storeE2EEKeysIfOwner(keys, predecessor);
      await flushDiskWrites();
      expect(diskFile('secure-token.dat')).toBeDefined();

      // Crash while the successor's encrypt is still in flight.
      storeRefreshToken({ refreshToken: 'rt-new', rememberMe: true, apiBase: API });
      _resetForTesting();
      await flushDiskWrites();

      expect(diskFile('secure-token.dat')).toBeUndefined();
      expect(diskFile('secure-e2ee.dat')).toBeUndefined();
      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
    });

    it('writes nothing when a logout lands during the token encrypt', async () => {
      const pending = deferred<Buffer>();
      vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(pending.promise);
      storeRefreshToken({ refreshToken: 'rt-1', rememberMe: true, apiBase: API });
      await vi.waitFor(() => expect(safeStorage.encryptStringAsync).toHaveBeenCalled());

      clearTokens();
      pending.resolve(Buffer.from('v11rt-1'));
      await flushDiskWrites();

      expect(credentialWrites()).toEqual([]);
    });

    it('lets only the newest login reach disk when two encrypts overlap', async () => {
      const first = deferred<Buffer>();
      vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(first.promise);
      storeRefreshToken({ refreshToken: 'rt-first', rememberMe: true, apiBase: API });
      await vi.waitFor(() => expect(safeStorage.encryptStringAsync).toHaveBeenCalled());

      const secondOwner = storeRefreshToken({
        refreshToken: 'rt-second',
        rememberMe: true,
        apiBase: API,
      });
      first.resolve(Buffer.from('v11rt-first'));
      await flushDiskWrites();

      expect(tokenFromCiphertext(diskFile('secure-token.dat'))).toBe('rt-second');
      expect(JSON.parse(String(diskFile('token-meta.json')))).toMatchObject({
        credentialOwner: secondOwner,
      });
      expect(fsWriteCalls.some(([, data]) => String(data) === 'v11rt-first')).toBe(false);
    });

    it('persists the rotated token, not the published one, when a refresh lands during the encrypt', async () => {
      const publish = deferred<Buffer>();
      vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(publish.promise);
      const owner = storeRefreshToken({
        refreshToken: 'rt-published',
        rememberMe: true,
        apiBase: API,
      });
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
          refresh_token: 'rt-rotated',
        })
      );
      await performRefresh();

      publish.resolve(Buffer.from('v11rt-published'));
      await flushDiskWrites();

      expect(tokenFromCiphertext(diskFile('secure-token.dat'))).toBe('rt-rotated');
      expect(JSON.parse(String(diskFile('token-meta.json')))).toMatchObject({
        credentialOwner: owner,
      });
      // The superseded token never reached disk, even transiently.
      expect(fsWriteCalls.some(([, data]) => String(data) === 'v11rt-published')).toBe(false);
    });

    it('restores as unavailable and keeps the file when the decrypt key is temporarily unavailable', async () => {
      fsRead.impl = (path) =>
        String(path).endsWith('token-meta.json')
          ? JSON.stringify({ apiBase: API, rememberMe: true })
          : Buffer.from('v11stored');
      vi.spyOn(safeStorage, 'decryptStringAsync').mockRejectedValueOnce(
        new Error('safeStorage.decryptStringAsync is temporarily unavailable. Please try again.')
      );

      expect(await restoreRefreshToken()).toEqual({ status: 'unavailable' });
      expect(fsUnlinkCalls).toEqual([]);
    });

    it('does not let a stale restore overwrite or delete a login that lands during its decrypt', async () => {
      fsRead.impl = (path) =>
        String(path).endsWith('token-meta.json')
          ? JSON.stringify({ apiBase: API, rememberMe: true })
          : Buffer.from('v11tampered');
      const decrypt = deferred<{ shouldReEncrypt: boolean; result: string }>();
      vi.spyOn(safeStorage, 'decryptStringAsync').mockReturnValueOnce(decrypt.promise);
      const restoring = restoreRefreshToken();
      await vi.waitFor(() => expect(safeStorage.decryptStringAsync).toHaveBeenCalled());

      storeRefreshToken({ refreshToken: 'rt-login', rememberMe: false, apiBase: API });
      const unlinksAfterLogin = fsUnlinkCalls.length;
      decrypt.reject(new Error('Error while decrypting the ciphertext'));

      expect(await restoring).toMatchObject({ status: 'ok', token: 'rt-login' });
      expect(fsUnlinkCalls.length).toBe(unlinksAfterLogin);
    });

    it('re-encrypts a restored token when safeStorage reports a rotated key', async () => {
      fsRead.impl = (path) =>
        String(path).endsWith('token-meta.json')
          ? JSON.stringify({
              apiBase: API,
              rememberMe: true,
              credentialOwner: 7,
              e2eeState: 'ready',
            })
          : Buffer.from('v11stored');
      vi.spyOn(safeStorage, 'decryptStringAsync').mockResolvedValueOnce({
        shouldReEncrypt: true,
        result: tokenEnvelope('rt-stored', API),
      });

      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok', token: 'rt-stored' });
      await flushDiskWrites();
      expect(tokenFromCiphertext(diskFile('secure-token.dat'))).toBe('rt-stored');
    });

    it('reports a key write superseded by a newer key write as not persisted', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await flushDiskWrites();
      const staleKeys = { ...keys, wrappingKeyBase64: 'stale-wk' };
      const pending = deferred<Buffer>();
      vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(pending.promise);
      const staleWrite = storeE2EEKeysIfOwner(staleKeys, owner);
      await vi.waitFor(() => expect(safeStorage.encryptStringAsync).toHaveBeenCalled());

      const freshWrite = storeE2EEKeysIfOwner(keys, owner);
      pending.resolve(
        Buffer.from(`v11${JSON.stringify({ credentialOwner: owner, keys: staleKeys })}`)
      );

      expect(await staleWrite).toBe(false);
      expect(await freshWrite).toBe(true);
      expect(fsWriteCalls.some(([, data]) => String(data).includes('stale-wk'))).toBe(false);
    });

    it('writes no keys when a logout lands during their encrypt', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await flushDiskWrites();
      const pending = deferred<Buffer>();
      vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(pending.promise);
      const storing = storeE2EEKeysIfOwner(keys, owner);
      await vi.waitFor(() => expect(safeStorage.encryptStringAsync).toHaveBeenCalled());

      clearTokens();
      pending.resolve(Buffer.from('v11keys'));

      expect(await storing).toBe(false);
      expect(diskFile('secure-e2ee.dat')).toBeUndefined();
    });

    it('does not let a successful stale restore overwrite a login that lands during its decrypt', async () => {
      fsRead.impl = (path) =>
        String(path).endsWith('token-meta.json')
          ? JSON.stringify({ apiBase: API, rememberMe: true })
          : Buffer.from('v11rt-disk');
      const decrypt = deferred<{ shouldReEncrypt: boolean; result: string }>();
      vi.spyOn(safeStorage, 'decryptStringAsync').mockReturnValueOnce(decrypt.promise);
      const restoring = restoreRefreshToken();
      await vi.waitFor(() => expect(safeStorage.decryptStringAsync).toHaveBeenCalled());

      const loginOwner = storeRefreshToken({
        refreshToken: 'rt-login',
        rememberMe: false,
        apiBase: API,
      });
      decrypt.resolve({ shouldReEncrypt: false, result: 'rt-disk' });

      expect(await restoring).toMatchObject({ status: 'ok', token: 'rt-login' });
      expect(getCredentialCustodyState().credentialOwner).toBe(loginOwner);
      expect(await restoreRefreshToken()).toMatchObject({ token: 'rt-login' });
    });

    it('keeps keys written during a key decrypt instead of the older disk copy', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await storeE2EEKeysIfOwner(keys, owner);
      _resetForTesting();
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok' });
      const restoredOwner = getCredentialCustodyState().credentialOwner as number;

      const decrypt = deferred<{ shouldReEncrypt: boolean; result: string }>();
      vi.spyOn(safeStorage, 'decryptStringAsync').mockReturnValueOnce(decrypt.promise);
      const restoring = restoreE2EEKeys();
      await vi.waitFor(() => expect(safeStorage.decryptStringAsync).toHaveBeenCalled());

      const freshKeys = { ...keys, wrappingKeyBase64: 'fresh-wk' };
      await storeE2EEKeysIfOwner(freshKeys, restoredOwner);
      decrypt.resolve({
        shouldReEncrypt: false,
        result: JSON.stringify({ credentialOwner: restoredOwner, keys }),
      });

      expect(await restoring).toEqual(freshKeys);
      expect(await restoreE2EEKeys()).toEqual(freshKeys);
    });

    it('returns no keys when a newer login lands during the key decrypt', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await storeE2EEKeysIfOwner(keys, owner);
      _resetForTesting();
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok' });

      const decrypt = deferred<{ shouldReEncrypt: boolean; result: string }>();
      vi.spyOn(safeStorage, 'decryptStringAsync').mockReturnValueOnce(decrypt.promise);
      const restoring = restoreE2EEKeys();
      await vi.waitFor(() => expect(safeStorage.decryptStringAsync).toHaveBeenCalled());

      storeRefreshToken({ refreshToken: 'rt-next', rememberMe: false, apiBase: API });
      decrypt.resolve({
        shouldReEncrypt: false,
        result: JSON.stringify({ credentialOwner: owner, keys }),
      });

      expect(await restoring).toBeNull();
    });

    it('refuses a Linux token file under the hardcoded key as tampered, without decrypting it', async () => {
      setPlatform('linux');
      fsRead.impl = (path) =>
        String(path).endsWith('token-meta.json')
          ? JSON.stringify({
              apiBase: API,
              rememberMe: true,
              credentialOwner: 3,
              e2eeState: 'ready',
            })
          : Buffer.from('v10rt-forged');
      const decrypt = vi.spyOn(safeStorage, 'decryptStringAsync');

      expect(await restoreRefreshToken()).toEqual({ status: 'tampered' });
      expect(decrypt).not.toHaveBeenCalled();
      expect(fsUnlinkCalls).toContainEqual(expect.stringContaining('secure-token.dat'));
    });

    it('refuses a Linux E2EE blob under the hardcoded key', async () => {
      setPlatform('linux');
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await storeE2EEKeysIfOwner(keys, owner);
      _resetForTesting();
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok' });
      const e2eePath = [...fsFiles.keys()].find((path) => path.endsWith('secure-e2ee.dat'));
      fsFiles.set(
        String(e2eePath),
        Buffer.from(`v10${JSON.stringify({ credentialOwner: owner, keys })}`)
      );

      expect(await restoreE2EEKeys()).toBeNull();
    });

    it('writes credential files through a 0o600 temp file and a rename', async () => {
      fsRead.impl = readMockDisk;
      storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await flushDiskWrites();

      const tokenPath = [...fsFiles.keys()].find((path) => path.endsWith('secure-token.dat'));
      expect(tokenPath).toBeDefined();
      expect(fsRenameCalls).toContainEqual([`${tokenPath}.${process.pid}.tmp`, tokenPath]);
      expect(fsWriteCalls.find(([path]) => path === tokenPath)?.[2]).toEqual({ mode: 0o600 });
      expect([...fsFiles.keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
    });

    it('removes the temp file and writes no credential when the rename fails', async () => {
      fsRead.impl = readMockDisk;
      fsRename.fail = true;
      storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await flushDiskWrites();

      expect(diskFile('secure-token.dat')).toBeUndefined();
      expect(fsRmCalls.some((path) => path.endsWith('.tmp'))).toBe(true);
      expect([...fsFiles.keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
    });

    it('restores no session, and falls back to no profile, when the pointer is not a URL', async () => {
      fsRead.impl = readMockDisk;
      // This profile's own credential exists, so a fallback past the pointer would restore it.
      storeRefreshToken({
        refreshToken: 'rt-default',
        rememberMe: true,
        apiBase: origin,
      });
      await flushDiskWrites();
      const pointer = [...fsFiles.keys()].find((path) => path.endsWith('active-profile.json'));
      fsFiles.set(String(pointer), JSON.stringify({ apiBase: ':://// not a url' }));
      _resetForTesting();

      // #86: a custody never reads the pointer; choosing which profile a restart
      // restores moved to the transitional router, which must choose none here.
      // It reports its own credential's origin, and never another profile's.
      expect(getCredentialApiBase()).toBe(origin);
      expect(() => clearTokens()).not.toThrow();
    });

    it('restores no session when the meta file names an API base that is not a URL', async () => {
      fsRead.impl = (path) =>
        String(path).endsWith('token-meta.json')
          ? JSON.stringify({
              apiBase: 'not a url',
              rememberMe: true,
              credentialOwner: 7,
              e2eeState: 'ready',
            })
          : Buffer.from('v11stored');

      await expect(restoreRefreshToken()).resolves.toEqual({ status: 'no_session' });
    });

    it('treats a decrypt that rejects with a non-Error as tampered, without throwing', async () => {
      fsRead.impl = (path) =>
        String(path).endsWith('token-meta.json')
          ? JSON.stringify({
              apiBase: API,
              rememberMe: true,
              credentialOwner: 7,
              e2eeState: 'ready',
            })
          : Buffer.from('v11stored');
      vi.spyOn(safeStorage, 'decryptStringAsync').mockRejectedValueOnce(undefined);

      await expect(restoreRefreshToken()).resolves.toEqual({ status: 'tampered' });
    });

    it('re-encrypts a restored E2EE blob when safeStorage reports a rotated key', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await storeE2EEKeysIfOwner(keys, owner);
      _resetForTesting();
      expect(await restoreRefreshToken()).toMatchObject({ status: 'ok' });
      const blob = String(diskFile('secure-e2ee.dat')).slice(3);
      vi.spyOn(safeStorage, 'decryptStringAsync').mockResolvedValueOnce({
        shouldReEncrypt: true,
        result: blob,
      });
      ciphertextTag = 'v12';

      expect(await restoreE2EEKeys()).toEqual(keys);
      await flushDiskWrites();
      expect(String(diskFile('secure-e2ee.dat'))).toBe(`v12${blob}`);
    });

    it('encrypts only the newest of a burst of logins queued behind an encrypt', async () => {
      fsRead.impl = readMockDisk;
      const held = deferred<Buffer>();
      const encrypt = vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(held.promise);
      storeRefreshToken({ refreshToken: 'rt-first', rememberMe: true, apiBase: API });
      await vi.waitFor(() => expect(encrypt).toHaveBeenCalledTimes(1));
      storeRefreshToken({ refreshToken: 'rt-middle', rememberMe: true, apiBase: API });
      storeRefreshToken({ refreshToken: 'rt-last', rememberMe: true, apiBase: API });

      held.resolve(Buffer.from('v11rt-first'));
      await flushDiskWrites();

      expect(encrypt.mock.calls.map(([plain]) => JSON.parse(plain).token)).toEqual([
        'rt-first',
        'rt-last',
      ]);
      expect(tokenFromCiphertext(diskFile('secure-token.dat'))).toBe('rt-last');
    });

    it('encrypts only the newest of a burst of key writes queued behind an encrypt', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      await flushDiskWrites();
      const held = deferred<Buffer>();
      const encrypt = vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(held.promise);
      const first = storeE2EEKeysIfOwner({ ...keys, wrappingKeyBase64: 'wk-first' }, owner);
      await vi.waitFor(() => expect(encrypt).toHaveBeenCalledTimes(1));
      const middle = storeE2EEKeysIfOwner({ ...keys, wrappingKeyBase64: 'wk-middle' }, owner);
      const last = storeE2EEKeysIfOwner({ ...keys, wrappingKeyBase64: 'wk-last' }, owner);

      held.resolve(Buffer.from('v11first'));

      expect(await first).toBe(false);
      expect(await middle).toBe(false);
      expect(await last).toBe(true);
      const plaintexts = encrypt.mock.calls.map(([plain]) => String(plain));
      expect(plaintexts).toHaveLength(2);
      expect(plaintexts.some((plain) => plain.includes('wk-middle'))).toBe(false);
      expect(String(diskFile('secure-e2ee.dat'))).toContain('wk-last');
    });

    it('restores no other profile when a crash interrupts a login to a new server', async () => {
      fsRead.impl = readMockDisk;
      storeRefreshToken({
        refreshToken: 'rt-saas',
        rememberMe: true,
        apiBase: 'https://api.concordvoice.chat',
      });
      await flushDiskWrites();

      storeRefreshToken({
        refreshToken: 'rt-homelab',
        rememberMe: true,
        apiBase: 'https://homelab.lan',
      });
      _resetForTesting(); // crash before the homelab write lands

      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
    });

    it('abandons a restore when registration stages keys during its decrypt', async () => {
      fsRead.impl = (path) =>
        String(path).endsWith('token-meta.json')
          ? JSON.stringify({ apiBase: API, rememberMe: true })
          : Buffer.from('v11rt-disk');
      const decrypt = deferred<{ shouldReEncrypt: boolean; result: string }>();
      vi.spyOn(safeStorage, 'decryptStringAsync').mockReturnValueOnce(decrypt.promise);
      const restoring = restoreRefreshToken();
      await vi.waitFor(() => expect(safeStorage.decryptStringAsync).toHaveBeenCalled());

      expect(storeE2EEKeys(keys)).toBe(true);
      decrypt.resolve({ shouldReEncrypt: false, result: 'rt-disk' });
      expect(await restoring).toEqual({ status: 'no_session' });

      // The staged keys still reach the credential registration mints.
      storeRefreshToken({ refreshToken: 'rt-registered', rememberMe: false, apiBase: API });
      expect(await restoreE2EEKeys()).toEqual(keys);
    });

    it('reports both of two identical key writes as persisted', async () => {
      fsRead.impl = readMockDisk;
      const owner = storeRefreshToken({ refreshToken: 'rt', rememberMe: true, apiBase: API });
      // IPC deserialises a fresh object per call: equal values, distinct identity.
      const first = storeE2EEKeysIfOwner({ ...keys }, owner);
      const second = storeE2EEKeysIfOwner({ ...keys }, owner);

      expect(await first).toBe(true);
      expect(await second).toBe(true);
    });

    it('keeps a rotated token off disk when a logout lands during its encrypt', async () => {
      fsRead.impl = readMockDisk;
      storeRefreshToken({ refreshToken: 'rt-old', rememberMe: true, apiBase: API });
      await flushDiskWrites();
      const rotation = deferred<Buffer>();
      vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(rotation.promise);
      mockNetFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
          refresh_token: 'rt-rotated',
        })
      );
      await performRefresh();
      await vi.waitFor(() => expect(safeStorage.encryptStringAsync).toHaveBeenCalled());

      clearTokens();
      rotation.resolve(Buffer.from('v11rt-rotated'));
      await flushDiskWrites();

      expect(diskFile('secure-token.dat')).toBeUndefined();
      expect(await restoreRefreshToken()).toEqual({ status: 'no_session' });
    });

    it('returns a login that lands during the availability probe', async () => {
      const probe = deferred<Buffer>();
      vi.spyOn(safeStorage, 'encryptStringAsync').mockReturnValueOnce(probe.promise);
      fsRead.impl = () => {
        throw new Error('ENOENT');
      };
      const restoring = restoreRefreshToken();
      await vi.waitFor(() => expect(safeStorage.encryptStringAsync).toHaveBeenCalled());

      storeRefreshToken({ refreshToken: 'rt-login', rememberMe: false, apiBase: API });
      probe.resolve(Buffer.from('v11secure-storage-probe'));

      expect(await restoring).toMatchObject({ status: 'ok', token: 'rt-login' });
    });
  });
});
