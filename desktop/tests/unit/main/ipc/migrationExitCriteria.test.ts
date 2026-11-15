// @vitest-environment node
// #86 Task 7B exit criteria that are statements about the source tree: the Task 5 custody
// shims are gone (S1), no raw ipcMain registration survives outside the registry (X2), the
// eslint transitional list is empty (X2), spikes/** is ignored by lint (X3), and the stale
// v25 fallback-chain sentence is removed from the docs.
import fs, { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { userData } = vi.hoisted(() => ({ userData: { dir: '' } }));
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
  net: { fetch: vi.fn() },
}));
vi.mock('../../../../src/main/machineId', () => ({ getMachineId: vi.fn(() => 'mid') }));
vi.mock('../../../../src/main/attestationService', () => ({ clearAttestationToken: vi.fn() }));

import * as tokenManager from '../../../../src/main/tokenManager';
import {
  createProfileCustody,
  _resetAllCustodyForTesting,
} from '../../../../src/main/tokenManager';
import {
  profilePathsForApiBase,
  serviceIdForApiBase,
} from '../../../../src/main/selfHostedProfile';

const DESKTOP = path.resolve(__dirname, '../../../..');
const MAIN = path.join(DESKTOP, 'src/main');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const MAIN_FILES = walk(MAIN).map((file) => ({
  file: path.relative(MAIN, file),
  code: stripComments(readFileSync(file, 'utf8')),
}));

describe('S1: Task 5 custody shims are deleted', () => {
  it.each(['custodyForApiBase', 'liveCustody', 'restoreTargetCustody', 'getPersistedApiBase'])(
    '%s no longer appears in src/main/**',
    (name) => {
      const hits = MAIN_FILES.filter((f) => new RegExp(`\\b${name}\\b`).test(f.code)).map(
        (f) => f.file
      );
      expect(hits).toEqual([]);
    }
  );

  it('no module-level setProactiveRefreshCallback export remains (the custody method does)', () => {
    const tm = MAIN_FILES.find((f) => f.file === 'tokenManager.ts')!;
    expect(tm.code).not.toMatch(
      /export\s+(async\s+)?(function|const)\s+setProactiveRefreshCallback\b/
    );
  });

  it('no IPC handler file resolves custody by anything but the sender binding', () => {
    const handlerFiles = MAIN_FILES.filter(
      (f) => f.file === 'main.ts' || (f.file.startsWith('ipc/') && f.file !== 'ipc/connection.ts')
    );
    const offenders = handlerFiles.filter((f) => /\bcustodyFor(ApiBase)?\s*\(/.test(f.code));
    expect(offenders.map((f) => f.file)).toEqual([]);
  });
});

describe('X2: every registration goes through registerIpc', () => {
  it('no src/main file except ipc/registry.ts calls ipcMain.handle|on|once|handleOnce', () => {
    const offenders = MAIN_FILES.filter(
      (f) =>
        f.file !== path.join('ipc', 'registry.ts') &&
        /\bipcMain\s*\.\s*(handle|handleOnce|on|once)\s*\(/.test(f.code)
    );
    // connection:whoAmI is the one documented raw ipcMain.on (sendSync); it lives in connection.ts.
    expect(
      offenders.map((f) => f.file).filter((f) => f !== path.join('ipc', 'connection.ts'))
    ).toEqual([]);
  });

  it('TRANSITIONAL_RAW_IPCMAIN_FILES is deleted or empty in eslint.config.mjs', () => {
    const cfg = readFileSync(path.join(DESKTOP, 'eslint.config.mjs'), 'utf8');
    const m = /const TRANSITIONAL_RAW_IPCMAIN_FILES = \[([\s\S]*?)\];/.exec(cfg);
    expect(m === null || m[1].trim() === '').toBe(true);
  });
});

describe('X3: lint ignores the spikes', () => {
  it('eslint global ignores include spikes/**', () => {
    const cfg = readFileSync(path.join(DESKTOP, 'eslint.config.mjs'), 'utf8');
    expect(cfg).toMatch(/['"]spikes\/\*\*['"]/);
  });
});

describe('docs: the stale v25 fallback chain is gone', () => {
  it('electron.md no longer names the readActiveApiBase fallback chain', () => {
    const doc = readFileSync(path.join(DESKTOP, '../.claude/rules/domains/electron.md'), 'utf8');
    expect(doc).not.toContain('inMemoryApiBase || readActiveApiBase() || DEFAULT_PROFILE_API_BASE');
  });
});

describe('S1: the shims are not tokenManager exports', () => {
  it.each([
    'liveCustody',
    'restoreTargetCustody',
    'custodyForApiBase',
    'setProactiveRefreshCallback',
    'getPersistedApiBase',
  ])('%s is not exported', (name) => {
    expect(name in tokenManager).toBe(false);
  });
});

describe('S2/S3: custody isolation (runtime)', () => {
  const OA = 'https://a.example';
  const OB = 'https://b.example:8443';
  const KEYS = {
    wrappingKeyBase64: 'wk',
    preferencesKeyBase64: 'pk',
    wrappedPrivateKeyBase64: 'wpk', // pragma: allowlist secret
  };
  const mk = (o: string) => createProfileCustody(serviceIdForApiBase(o), o);

  beforeEach(() => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-7b-'));
    for (const m of ['log', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => {
    _resetAllCustodyForTesting();
    vi.restoreAllMocks();
    fs.rmSync(userData.dir, { recursive: true, force: true });
  });

  it('S2: keys staged by A are never adopted by B, even with the same owner number', async () => {
    const A = mk(OA);
    const B = mk(OB);
    expect(A.storeE2EEKeys(KEYS)).toBe(true);
    const ownerB = B.storeRefreshToken({ refreshToken: 'rt-b', rememberMe: true, apiBase: OB });
    await B._flushDiskWritesForTesting();
    // Same-number collision: A's own first credential mints the same owner as B's.
    const ownerA = A.storeRefreshToken({ refreshToken: 'rt-a', rememberMe: true, apiBase: OA });
    expect(ownerA).toBe(ownerB);
    await A._flushDiskWritesForTesting();
    expect(await B.restoreE2EEKeys()).toBeNull();
    expect(B.getCredentialCustodyState().pendingE2EEUnlock).toBe(true);
    const bDir = path.dirname(profilePathsForApiBase(OB).metaFile);
    const bFiles = fs.existsSync(bDir) ? fs.readdirSync(bDir) : [];
    expect(bFiles.filter((f) => /e2ee|key/i.test(f))).toEqual([]);
  });

  it('S3: an owner number minted by A is refused by B when it does not match', async () => {
    const A = mk(OA);
    const B = mk(OB);
    const ownerA = A.storeRefreshToken({ refreshToken: 'rt-a', rememberMe: false, apiBase: OA });
    B.storeRefreshToken({ refreshToken: 'rt-b', rememberMe: false, apiBase: OB });
    B.clearTokens();
    B.storeRefreshToken({ refreshToken: 'rt-b2', rememberMe: false, apiBase: OB });
    expect(B.clearTokensIfOwner(ownerA)).toBe(false);
    expect(await B.storeE2EEKeysIfOwner(KEYS, ownerA)).toBe(false);
  });

  it('S3: restore refuses a token meta whose apiBase origin differs from the custody apiOrigin', async () => {
    const A = mk(OA);
    A.storeRefreshToken({ refreshToken: 'rt-a', rememberMe: true, apiBase: OA });
    await A._flushDiskWritesForTesting();
    const { metaFile } = profilePathsForApiBase(OA);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, apiBase: OB }));
    A._resetForTesting(); // simulates a restart: memory gone, disk tampered
    const result = await A.restoreRefreshToken();
    expect(result.status).not.toBe('ok');
    expect(A.getApiBaseOrigin()).not.toBe(OB);
  });
});
