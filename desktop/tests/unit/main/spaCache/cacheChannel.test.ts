import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSignedManifest, makeKeypair, signBytes } from './manifestTestUtils';
import type { RemoteSpaChannel } from '@/shared/updateChannel';

const KP = makeKeypair();
let userDataDir = '';
const { fetchMock, getPathMock, contract } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getPathMock: vi.fn(),
  contract: { value: 16 },
}));
vi.mock('electron', () => ({ app: { getPath: getPathMock }, net: { fetch: fetchMock } }));
vi.mock('@/main/spaCache/spaManifestPublicKey', () => ({
  get SPA_MANIFEST_PUBLIC_KEYS_PEM() {
    return [KP.publicKeyPem];
  },
  isSpaManifestKeyConfigured: () => true,
}));
vi.mock('@/main/ipcContract', () => ({
  get IPC_CONTRACT_VERSION() {
    return contract.value;
  },
}));
import * as store from '@/main/spaCache/cacheStore';
import {
  populateChannelCacheFromRemote,
  __resetInFlightForTests,
} from '@/main/spaCache/populateCache';
import { resolveChannelCachedSpa } from '@/main/spaCache/resolveCachedSpa';
import {
  handleChannelCacheProtocolRequest,
  __resetCacheProtocolMemoForTests,
} from '@/main/spaCache/cacheProtocol';

const MANIFEST = 'spa-manifest.v2.json';
const SIGNATURE = 'spa-manifest.v2.json.sig';
const NOW = Date.parse('2026-10-25T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const BASE = 'https://spa.concordvoice.chat/';
const PRE_BASE = 'https://prerelease.example.test/';
function fixture(
  channel: RemoteSpaChannel,
  opts: { text?: string; legacy?: boolean; generatedAtMs?: number } = {}
) {
  const entry = { path: 'index.html', bytes: Buffer.from(opts.text ?? `<html>${channel}</html>`) };
  const asset = {
    path: 'assets/app.js',
    bytes: Buffer.from(`export const channel = '${channel}';`),
  };
  const legacy = buildSignedManifest(KP, {
    entry,
    assets: [asset],
    generatedAt: new Date(opts.generatedAtMs ?? NOW).toISOString(),
    spaIpcContract: 16,
  });
  const manifestBytes = opts.legacy
    ? legacy.manifestBytes
    : Buffer.from(
        JSON.stringify({
          ...legacy.manifestObject,
          schemaVersion: 2,
          channel,
        })
      );
  return {
    entry,
    asset,
    manifestBytes,
    signatureBase64: signBytes(manifestBytes, KP.privateKeyPem),
  };
}
type Fixture = ReturnType<typeof fixture>;
function install(channel: RemoteSpaChannel, files = fixture(channel)) {
  const cache = store.createChannelCacheStore(channel);
  cache.resetStaging();
  cache.writeStagedFile(MANIFEST, files.manifestBytes);
  cache.writeStagedFile(SIGNATURE, Buffer.from(files.signatureBase64));
  cache.writeStagedFile(files.entry.path, files.entry.bytes);
  cache.writeStagedFile(files.asset.path, files.asset.bytes);
  cache.promoteStagingToLive();
  return cache;
}
function request(channel: RemoteSpaChannel, relative = 'index.html', nowMs = NOW) {
  return handleChannelCacheProtocolRequest(
    new Request(`spa-cache://concord/${relative}`),
    channel,
    nowMs
  );
}
async function expectServed(
  channel: RemoteSpaChannel,
  expected: Buffer,
  relative = 'index.html',
  nowMs = NOW
) {
  const response = await request(channel, relative, nowMs);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
}
function routes(base: string, files: Fixture): Record<string, Buffer> {
  return {
    [new URL(MANIFEST, base).href]: files.manifestBytes,
    [new URL(SIGNATURE, base).href]: Buffer.from(files.signatureBase64),
    [new URL(files.entry.path, base).href]: files.entry.bytes,
    [new URL(files.asset.path, base).href]: files.asset.bytes,
  };
}
function serveRoutes(map: Record<string, Buffer>) {
  fetchMock.mockImplementation(async (url: string) => {
    const bytes = map[url];
    return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
  });
}
beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-channel-'));
  getPathMock.mockReset().mockReturnValue(userDataDir);
  fetchMock.mockReset();
  contract.value = 16;
  __resetInFlightForTests();
  __resetCacheProtocolMemoForTests();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('channel-bound cache consumers', () => {
  it('isolates live and staging paths and serves each stream when alternating channels', async () => {
    const stable = fixture('stable');
    const prerelease = fixture('prerelease');
    const stableStore = install('stable', stable);
    const preStore = install('prerelease', prerelease);
    for (const [channel, cache] of [
      ['stable', stableStore],
      ['prerelease', preStore],
    ] as const) {
      expect(cache.getLiveDir()).toBe(path.join(userDataDir, 'spa-cache', 'v2', channel, 'live'));
      expect(cache.getStagingDir()).toBe(
        path.join(userDataDir, 'spa-cache', 'v2', channel, 'staging')
      );
      expect(resolveChannelCachedSpa(channel, NOW)).toEqual({
        url: 'spa-cache://concord/index.html',
        channel,
      });
    }
    for (const channel of ['stable', 'prerelease', 'stable', 'prerelease'] as const) {
      const files = channel === 'stable' ? stable : prerelease;
      await expectServed(channel, files.entry.bytes);
      await expectServed(channel, files.asset.bytes, files.asset.path);
    }
    preStore.resetStaging();
    preStore.writeStagedFile('index.html', Buffer.from('incomplete replacement'));
    await expectServed('stable', stable.entry.bytes);
    await expectServed('prerelease', prerelease.entry.bytes);
    expect(store.getLiveDir()).toBe(path.join(userDataDir, 'spa-cache', 'live'));
  });
  it('never reuses a Stable memo for identical bytes in the Pre-Release root', async () => {
    const stable = fixture('stable');
    install('stable', stable);
    install('prerelease', stable);
    await expectServed('stable', stable.entry.bytes);
    expect(resolveChannelCachedSpa('prerelease', NOW)).toBeNull();
    expect((await request('prerelease')).status).toBe(404);
    await expectServed('stable', stable.entry.bytes);
  });
  it('does not discover legacy live cache or accept v1 bytes renamed as v2', async () => {
    const legacy = fixture('stable', { legacy: true });
    store.resetStaging();
    store.writeStagedFile('spa-manifest.json', legacy.manifestBytes);
    store.writeStagedFile('spa-manifest.json.sig', Buffer.from(legacy.signatureBase64));
    store.writeStagedFile(legacy.entry.path, legacy.entry.bytes);
    store.writeStagedFile(legacy.asset.path, legacy.asset.bytes);
    store.promoteStagingToLive();
    for (const channel of ['stable', 'prerelease'] as const) {
      expect(resolveChannelCachedSpa(channel, NOW)).toBeNull();
      expect((await request(channel)).status).toBe(404);
      install(channel, legacy);
      expect(resolveChannelCachedSpa(channel, NOW)).toBeNull();
      expect((await request(channel)).status).toBe(404);
    }
  });
  it.each([MANIFEST, SIGNATURE])(
    'invalidates a warmed memo when %s disappears and permits restored bytes',
    async (name) => {
      const files = fixture('stable');
      const cache = install('stable', files);
      await expectServed('stable', files.entry.bytes);
      const location = path.join(cache.getLiveDir(), name);
      const original = fs.readFileSync(location);
      fs.unlinkSync(location);
      expect(resolveChannelCachedSpa('stable', NOW)).toBeNull();
      expect((await request('stable')).status).toBe(404);
      fs.writeFileSync(location, original);
      await expectServed('stable', files.entry.bytes);
    }
  );
  it('normalizes signature whitespace but rejects changed signatures after memoization', async () => {
    const files = fixture('stable');
    const cache = install('stable', files);
    const location = path.join(cache.getLiveDir(), SIGNATURE);
    await expectServed('stable', files.entry.bytes);
    fs.writeFileSync(location, `\n${files.signatureBase64}\n`);
    await expectServed('stable', files.entry.bytes);
    const corrupted = Buffer.from(files.signatureBase64, 'base64');
    corrupted[0] ^= 1;
    fs.writeFileSync(location, corrupted.toString('base64'));
    expect(resolveChannelCachedSpa('stable', NOW)).toBeNull();
    expect((await request('stable')).status).toBe(404);
    fs.writeFileSync(location, files.signatureBase64);
    await expectServed('stable', files.entry.bytes);
  });
  it('refuses same-size asset tampering after memoization', async () => {
    const files = fixture('stable');
    const cache = install('stable', files);
    await expectServed('stable', files.asset.bytes, files.asset.path);
    const corrupted = Buffer.from(files.asset.bytes);
    corrupted[0] ^= 1;
    fs.writeFileSync(path.join(cache.getLiveDir(), files.asset.path), corrupted);
    expect(resolveChannelCachedSpa('stable', NOW)).toBeNull();
    expect((await request('stable', files.asset.path)).status).toBe(403);
    fs.writeFileSync(path.join(cache.getLiveDir(), files.asset.path), files.asset.bytes);
    await expectServed('stable', files.asset.bytes, files.asset.path);
  });
  it.each([
    ['stale', NOW + 31 * DAY],
    ['future', NOW - 2 * DAY],
  ] as const)(
    'rechecks %s bounds when only the clock changes after memoization',
    async (_label, nowMs) => {
      const files = fixture('stable');
      install('stable', files);
      await expectServed('stable', files.entry.bytes);
      expect(resolveChannelCachedSpa('stable', nowMs)).toBeNull();
      expect((await request('stable', 'index.html', nowMs)).status).toBe(404);
      await expectServed('stable', files.entry.bytes);
    }
  );
  it.each([NaN, Infinity, -Infinity])(
    'refuses non-finite clock %s before and after memoization',
    async (invalidNowMs) => {
      const files = fixture('stable');
      install('stable', files);
      expect(resolveChannelCachedSpa('stable', invalidNowMs)).toBeNull();
      expect((await request('stable', 'index.html', invalidNowMs)).status).toBe(404);
      await expectServed('stable', files.entry.bytes);
      expect(resolveChannelCachedSpa('stable', invalidNowMs)).toBeNull();
      expect((await request('stable', 'index.html', invalidNowMs)).status).toBe(404);
      await expectServed('stable', files.entry.bytes);
    }
  );
  it('rechecks IPC compatibility after memoization', async () => {
    const files = fixture('stable');
    install('stable', files);
    await expectServed('stable', files.entry.bytes);
    contract.value = 15;
    expect(resolveChannelCachedSpa('stable', NOW)).toBeNull();
    expect((await request('stable')).status).toBe(404);
    contract.value = 16;
    await expectServed('stable', files.entry.bytes);
  });
  it.each(['pilot', 'unknown', '../stable', 'Stable', '', null, 42])(
    'refuses runtime channel %s before filesystem or network access',
    async (input) => {
      const channel = input as RemoteSpaChannel;
      getPathMock.mockClear();
      expect(() => store.createChannelCacheStore(channel)).toThrow();
      expect(resolveChannelCachedSpa(channel, NOW)).toBeNull();
      expect((await request(channel)).status).toBe(404);
      expect((await populateChannelCacheFromRemote(BASE, channel)).populated).toBe(false);
      expect(getPathMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fs.readdirSync(userDataDir)).toEqual([]);
    }
  );
});

describe('channel cache population', () => {
  it('downloads v2 metadata and serves authenticated bytes from the selected stream', async () => {
    const files = fixture('prerelease');
    serveRoutes(routes(PRE_BASE, files));
    expect((await populateChannelCacheFromRemote(PRE_BASE, 'prerelease')).populated).toBe(true);
    expect(store.createChannelCacheStore('prerelease').readLiveManifest()?.manifestBytes).toEqual(
      files.manifestBytes
    );
    await expectServed('prerelease', files.entry.bytes);
    await expectServed('prerelease', files.asset.bytes, files.asset.path);
    expect(resolveChannelCachedSpa('stable', NOW)).toBeNull();
    expect((await request('stable')).status).toBe(404);
  });
  it.each(['opposite channel', 'v1'] as const)(
    'refuses %s before downloading assets and preserves live bytes',
    async (variant) => {
      const original = fixture('stable');
      install('stable', original);
      const replacement =
        variant === 'v1' ? fixture('stable', { legacy: true }) : fixture('prerelease');
      serveRoutes(routes(BASE, replacement));
      expect((await populateChannelCacheFromRemote(BASE, 'stable')).populated).toBe(false);
      const fetched = fetchMock.mock.calls.map(([url]) => url);
      expect(fetched).not.toContain(new URL(replacement.entry.path, BASE).href);
      expect(fetched).not.toContain(new URL(replacement.asset.path, BASE).href);
      await expectServed('stable', original.entry.bytes);
    }
  );
  it('does not promote corrupted downloads over a valid cache', async () => {
    const original = fixture('stable');
    install('stable', original);
    const replacement = fixture('stable', { text: '<html>replacement</html>' });
    const map = routes(BASE, replacement);
    map[new URL(replacement.asset.path, BASE).href] = Buffer.alloc(
      replacement.asset.bytes.length,
      65
    );
    serveRoutes(map);
    expect((await populateChannelCacheFromRemote(BASE, 'stable')).populated).toBe(false);
    await expectServed('stable', original.entry.bytes);
  });
  it('reverifies freshness before promotion when the manifest expires during download', async () => {
    const original = fixture('stable');
    install('stable', original);
    const replacement = fixture('stable', { text: '<html>replacement</html>' });
    const map = routes(BASE, replacement);
    fetchMock.mockImplementation(async (url: string) => {
      if (url === new URL(replacement.asset.path, BASE).href) {
        vi.mocked(Date.now).mockReturnValue(NOW + 31 * DAY);
      }
      const bytes = map[url];
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
    });
    expect((await populateChannelCacheFromRemote(BASE, 'stable')).populated).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
      new URL(replacement.asset.path, BASE).href
    );
    vi.mocked(Date.now).mockReturnValue(NOW);
    await expectServed('stable', original.entry.bytes);
  });
  it('deduplicates concurrent population of the same channel and userData root', async () => {
    const files = fixture('stable');
    const map = routes(BASE, files);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === new URL(MANIFEST, BASE).href) await gate;
      const bytes = map[url];
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
    });
    const first = populateChannelCacheFromRemote(BASE, 'stable');
    try {
      const second = populateChannelCacheFromRemote(BASE, 'stable');
      expect(second).toBe(first);
      release();
      expect((await first).populated).toBe(true);
      await expectServed('stable', files.entry.bytes);
      expect(
        fetchMock.mock.calls.filter(([url]) => url === new URL(MANIFEST, BASE).href)
      ).toHaveLength(1);
    } finally {
      release();
      await first;
    }
  });

  it('pins the original root throughout a pending population when userData changes', async () => {
    const oldRoot = path.join(userDataDir, 'original');
    const newRoot = path.join(userDataDir, 'replacement');
    const incoming = fixture('stable', { text: '<html>original-root download</html>' });
    const retained = fixture('stable', { text: '<html>replacement-root existing</html>' });
    getPathMock.mockReturnValue(newRoot);
    install('stable', retained);
    getPathMock.mockReturnValue(oldRoot);
    const originalStore = store.createChannelCacheStore('stable');
    const map = routes(BASE, incoming);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === new URL(MANIFEST, BASE).href) await gate;
      const bytes = map[url];
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
    });
    const pending = populateChannelCacheFromRemote(BASE, 'stable');
    try {
      getPathMock.mockReturnValue(newRoot);
      expect(originalStore.getLiveDir()).toBe(
        path.join(oldRoot, 'spa-cache', 'v2', 'stable', 'live')
      );
      expect(originalStore.readLiveManifest()).toBeNull();
      release();
      expect((await pending).populated).toBe(true);
      expect(originalStore.readLiveManifest()?.manifestBytes).toEqual(incoming.manifestBytes);
      await expectServed('stable', retained.entry.bytes);
      getPathMock.mockReturnValue(oldRoot);
      await expectServed('stable', incoming.entry.bytes);
    } finally {
      release();
      await pending;
    }
  });

  it('does not deduplicate the same channel and URL across different userData roots', async () => {
    const firstRoot = path.join(userDataDir, 'first');
    const secondRoot = path.join(userDataDir, 'second');
    const files = fixture('stable');
    const map = routes(BASE, files);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === new URL(MANIFEST, BASE).href) await gate;
      const bytes = map[url];
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
    });
    getPathMock.mockReturnValue(firstRoot);
    const first = populateChannelCacheFromRemote(BASE, 'stable');
    let second: ReturnType<typeof populateChannelCacheFromRemote> | undefined;
    try {
      getPathMock.mockReturnValue(secondRoot);
      second = populateChannelCacheFromRemote(BASE, 'stable');
      expect(second).not.toBe(first);
      release();
      expect((await Promise.all([first, second])).map((result) => result.populated)).toEqual([
        true,
        true,
      ]);
      for (const root of [firstRoot, secondRoot]) {
        getPathMock.mockReturnValue(root);
        await expectServed('stable', files.entry.bytes);
        await expectServed('stable', files.asset.bytes, files.asset.path);
      }
      expect(
        fetchMock.mock.calls.filter(([url]) => url === new URL(MANIFEST, BASE).href)
      ).toHaveLength(2);
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });

  it('does not share a pending population across channels', async () => {
    const stable = fixture('stable');
    const prerelease = fixture('prerelease');
    const map = { ...routes(BASE, stable), ...routes(PRE_BASE, prerelease) };
    let releaseStable!: () => void;
    const stableGate = new Promise<void>((resolve) => {
      releaseStable = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === new URL(MANIFEST, BASE).href) await stableGate;
      const bytes = map[url];
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
    });
    const pendingStable = populateChannelCacheFromRemote(BASE, 'stable');
    try {
      const pendingPre = populateChannelCacheFromRemote(PRE_BASE, 'prerelease');
      expect(pendingPre).not.toBe(pendingStable);
      releaseStable();
      const results = await Promise.all([pendingStable, pendingPre]);
      expect(results.map((result) => result.populated)).toEqual([true, true]);
      await expectServed('stable', stable.entry.bytes);
      await expectServed('prerelease', prerelease.entry.bytes);
    } finally {
      releaseStable();
      await pendingStable;
    }
  });

  it('refuses a signed but older manifest so the cache cannot be rolled back', async () => {
    const current = fixture('stable');
    install('stable', current);
    const older = fixture('stable', { text: '<html>older</html>', generatedAtMs: NOW - DAY });
    serveRoutes(routes(BASE, older));
    const result = await populateChannelCacheFromRemote(BASE, 'stable');
    expect(result).toEqual({
      populated: false,
      reason: 'manifest rejected: older than the live cache',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      new URL(older.entry.path, BASE).href
    );
    await expectServed('stable', current.entry.bytes);
  });

  it('accepts a newer manifest and replaces an unverifiable live cache', async () => {
    const stale = fixture('stable', { generatedAtMs: NOW - 40 * DAY });
    install('stable', stale);
    const newer = fixture('stable', { text: '<html>newer</html>' });
    serveRoutes(routes(BASE, newer));
    expect((await populateChannelCacheFromRemote(BASE, 'stable')).populated).toBe(true);
    await expectServed('stable', newer.entry.bytes);
    const liveDir = store.createChannelCacheStore('stable').getLiveDir();
    expect(fs.existsSync(`${liveDir}.old`)).toBe(false);
  });

  it('tells a caller for another origin that a population is already in flight', async () => {
    const stable = fixture('stable');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const map = routes(BASE, stable);
    fetchMock.mockImplementation(async (url: string) => {
      await gate;
      const bytes = map[url];
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
    });
    const first = populateChannelCacheFromRemote(BASE, 'stable');
    try {
      expect(await populateChannelCacheFromRemote(PRE_BASE, 'stable')).toEqual({
        populated: false,
        reason: 'populate in flight for another origin',
      });
    } finally {
      release();
    }
    expect((await first).populated).toBe(true);
  });

  it('reports an unavailable cache root instead of throwing', async () => {
    getPathMock.mockImplementation(() => {
      throw new Error('userData unavailable');
    });
    expect(await populateChannelCacheFromRemote(BASE, 'stable')).toEqual({
      populated: false,
      reason: 'cache root unavailable',
    });
    expect(resolveChannelCachedSpa('stable', NOW)).toBeNull();
    expect((await request('stable')).status).toBe(404);
  });
});

describe('channel cache promotion', () => {
  it('restores the previous live tree when the final rename fails', () => {
    const original = fixture('stable');
    const cache = install('stable', original);
    cache.resetStaging();
    cache.writeStagedFile('index.html', Buffer.from('<html>next</html>'));
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === cache.getStagingDir()) throw new Error('rename failed');
      return realRename(from, to);
    });
    expect(() => cache.promoteStagingToLive()).toThrow('rename failed');
    expect(fs.readFileSync(path.join(cache.getLiveDir(), 'index.html'))).toEqual(
      original.entry.bytes
    );
    expect(fs.existsSync(`${cache.getLiveDir()}.old`)).toBe(false);
  });
});

describe('channel protocol request routing', () => {
  it.each(['app://concord/index.html', 'https://concord/index.html'])(
    'returns 404 for non-cache URL %s even with a valid channel cache',
    async (url) => {
      install('stable');
      const response = await handleChannelCacheProtocolRequest(new Request(url), 'stable', NOW);
      expect(response.status).toBe(404);
    }
  );

  it('returns 404 for a path the manifest does not list', async () => {
    install('stable');
    expect((await request('stable', 'assets/unlisted.js')).status).toBe(404);
  });

  it('refuses an encoded traversal path', async () => {
    install('stable');
    expect((await request('stable', 'assets/..%2f..%2fsecret')).status).toBe(403);
  });
});
