// @vitest-environment node
//
// tokenManager — synchronous storage/restore tests.
// performRefresh tests are skipped due to module-private mutable state
// (inMemoryRefreshToken, refreshPromise, proactive timers) that cannot be
// reliably reset between tests without an exported reset function.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

let safeStorageAvailable = true;
const fsWriteCalls: unknown[][] = [];
let fsUnlinkCount = 0;
const fsRead: { impl: (...a: unknown[]) => unknown } = { impl: () => Buffer.from('x') };

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/td' },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageAvailable,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  net: { fetch: vi.fn() },
}));
vi.mock('../../../src/main/machineId', () => ({ getMachineId: () => 'mid' }));
vi.mock('fs', () => ({
  default: {
    writeFileSync: (...a: unknown[]) => {
      fsWriteCalls.push(a);
    },
    readFileSync: (...a: unknown[]) => fsRead.impl(...a),
    unlinkSync: () => {
      fsUnlinkCount++;
    },
    existsSync: () => false,
  },
  writeFileSync: (...a: unknown[]) => {
    fsWriteCalls.push(a);
  },
  readFileSync: (...a: unknown[]) => fsRead.impl(...a),
  unlinkSync: () => {
    fsUnlinkCount++;
  },
  existsSync: () => false,
}));

import {
  storeRefreshToken,
  restoreRefreshToken,
  clearTokens,
  storeE2EEKeys,
  restoreE2EEKeys,
  getPersistedApiBase,
  getCapabilities,
  stopProactiveRefresh,
} from '@/main/tokenManager';

describe('tokenManager', () => {
  beforeEach(() => {
    safeStorageAvailable = true;
    fsWriteCalls.length = 0;
    fsUnlinkCount = 0;
    fsRead.impl = () => Buffer.from('x');
    clearTokens();
    stopProactiveRefresh();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('storeRefreshToken', () => {
    it('encrypts and writes to disk when rememberMe=true', () => {
      storeRefreshToken({
        refreshToken: 'my-token',
        rememberMe: true,
        apiBase: 'http://localhost:8080',
      });
      expect(fsWriteCalls.length).toBeGreaterThan(0);
      const paths = fsWriteCalls.map((c) => c[0] as string);
      expect(paths.some((p) => p.includes('secure-token.dat'))).toBe(true);
      expect(paths.some((p) => p.includes('token-meta.json'))).toBe(true);
    });

    it('deletes disk files when rememberMe=false', () => {
      storeRefreshToken({
        refreshToken: 'my-token',
        rememberMe: false,
        apiBase: 'http://localhost:8080',
      });
      expect(fsWriteCalls.length).toBe(0);
      expect(fsUnlinkCount).toBeGreaterThan(0);
    });

    it('memory-only when safeStorage unavailable', () => {
      safeStorageAvailable = false;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      storeRefreshToken({
        refreshToken: 'my-token',
        rememberMe: true,
        apiBase: 'http://localhost:8080',
      });
      expect(fsWriteCalls.length).toBe(0);
    });
  });

  describe('restoreRefreshToken', () => {
    it('returns unavailable when safeStorage off', () => {
      safeStorageAvailable = false;
      expect(restoreRefreshToken()).toEqual({ status: 'unavailable' });
    });

    it('returns no_session when meta file missing', () => {
      fsRead.impl = () => {
        throw new Error('ENOENT');
      };
      expect(restoreRefreshToken()).toEqual({ status: 'no_session' });
    });

    it('restores token successfully from disk', () => {
      let callNum = 0;
      fsRead.impl = () => {
        callNum++;
        if (callNum === 1)
          return JSON.stringify({ apiBase: 'http://localhost:8080', rememberMe: true });
        return Buffer.from('stored-token');
      };
      const result = restoreRefreshToken();
      expect(result).toEqual({
        status: 'ok',
        token: 'stored-token',
        apiBase: 'http://localhost:8080',
      });
    });

    it('returns tampered when decryption fails (read throws)', () => {
      let callNum = 0;
      fsRead.impl = () => {
        callNum++;
        if (callNum === 1)
          return JSON.stringify({ apiBase: 'http://localhost:8080', rememberMe: true });
        throw new Error('read error');
      };
      expect(restoreRefreshToken()).toEqual({ status: 'tampered' });
      expect(fsUnlinkCount).toBeGreaterThan(0);
    });
  });

  describe('clearTokens', () => {
    it('clears in-memory state and deletes disk files', () => {
      storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: false,
        apiBase: 'http://localhost:8080',
      });
      fsUnlinkCount = 0;
      clearTokens();
      expect(fsUnlinkCount).toBeGreaterThan(0);
    });
  });

  describe('E2EE keys', () => {
    it('storeE2EEKeys encrypts and writes when rememberMe=true', () => {
      storeRefreshToken({ refreshToken: 'tk', rememberMe: true, apiBase: 'http://localhost:8080' });
      fsWriteCalls.length = 0;
      storeE2EEKeys({
        wrappingKeyBase64: 'wk',
        preferencesKeyBase64: 'pk',
        wrappedPrivateKeyBase64: 'wpk',
      });
      expect(fsWriteCalls.length).toBeGreaterThan(0);
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

    it('storeE2EEKeys does nothing when rememberMe=false', () => {
      storeRefreshToken({
        refreshToken: 'tk',
        rememberMe: false,
        apiBase: 'http://localhost:8080',
      });
      fsWriteCalls.length = 0;
      storeE2EEKeys({
        wrappingKeyBase64: 'k',
        preferencesKeyBase64: 'k',
        wrappedPrivateKeyBase64: 'k',
      });
      expect(fsWriteCalls.length).toBe(0);
    });

    it('restoreE2EEKeys decrypts and returns keys', () => {
      const data = {
        wrappingKeyBase64: 'wk',
        preferencesKeyBase64: 'pk',
        wrappedPrivateKeyBase64: 'wpk',
      };
      fsRead.impl = () => Buffer.from(JSON.stringify(data));
      expect(restoreE2EEKeys()).toEqual(data);
    });

    it('restoreE2EEKeys returns null when safeStorage unavailable', () => {
      safeStorageAvailable = false;
      expect(restoreE2EEKeys()).toBeNull();
    });

    it('restoreE2EEKeys returns null on read failure', () => {
      fsRead.impl = () => {
        throw new Error('ENOENT');
      };
      expect(restoreE2EEKeys()).toBeNull();
    });
  });

  describe('getPersistedApiBase', () => {
    it('returns apiBase from meta file', () => {
      fsRead.impl = () => JSON.stringify({ apiBase: 'http://localhost:8080', rememberMe: true });
      expect(getPersistedApiBase()).toBe('http://localhost:8080');
    });

    it('returns null when meta file does not exist', () => {
      fsRead.impl = () => {
        throw new Error('ENOENT');
      };
      expect(getPersistedApiBase()).toBeNull();
    });
  });

  describe('getCapabilities', () => {
    it('returns persistAvailable=true when safeStorage works', () => {
      safeStorageAvailable = true;
      expect(getCapabilities()).toEqual({ persistAvailable: true });
    });

    it('returns persistAvailable=false when safeStorage unavailable', () => {
      safeStorageAvailable = false;
      expect(getCapabilities()).toEqual({ persistAvailable: false });
    });
  });

  describe('stopProactiveRefresh', () => {
    it('is safe to call when no timer exists', () => {
      expect(() => stopProactiveRefresh()).not.toThrow();
    });
  });
});
