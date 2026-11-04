// @vitest-environment node
/**
 * Signer ↔ verifier byte-parity guard for the signed SPA LKG cache (#1870).
 *
 * This is the producer/consumer cross-check (analogous to the age-claim A↔B
 * fixture): the PRODUCER is `desktop/scripts/sign-spa-manifest.mjs`
 * (CI/deploy), the CONSUMER is `src/main/spaCache/verifyManifest.ts` (Electron
 * main). The signature is detached over the RAW manifest bytes, so any drift in
 * serialization, algorithm parameters, or path/hash computation between the two
 * sides would surface here as a verification failure.
 *
 * Keys are EPHEMERAL (generated in-test) and never written to disk / committed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildManifest,
  signManifestBytes,
  signSpaDist,
  SPA_MANIFEST_FILENAME,
  SPA_MANIFEST_SIG_FILENAME,
} from '../../../../scripts/sign-spa-manifest.mjs';
import { verifyChannelManifest, verifyManifest } from '@/main/spaCache/verifyManifest';

// Absolute path to the signer CLI, resolved relative to THIS test file (no cwd
// assumptions) so the subprocess fail-safe tests below work from any runner cwd.
const SIGNER_SCRIPT = fileURLToPath(
  new URL('../../../../scripts/sign-spa-manifest.mjs', import.meta.url)
);

const IPC_CONTRACT = 18; // stamped value (mirrors ipcContract.ts IPC_CONTRACT_VERSION)
const ENTRY_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';
const ASSET_JS = 'console.log("concord spa bundle");\n';
const ASSET_CSS = ':root{--x:1}\n';

let distDir: string;
let privateKeyPem: string;
let publicKeyPem: string;

beforeEach(() => {
  // Ephemeral RSA-4096 keypair — never persisted.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKeyPem = privateKey as string;
  publicKeyPem = publicKey as string;

  // Temp dist resembling a Vite build: index.html at root + a couple assets.
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-signer-crosscheck-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), ENTRY_HTML);
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'assets', 'x-abc123.js'), ASSET_JS);
  fs.writeFileSync(path.join(distDir, 'assets', 'x-def456.css'), ASSET_CSS);
});

afterEach(() => {
  if (distDir) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

describe('signerVerifier crosscheck (#1870)', () => {
  it('verifyManifest accepts a manifest signed by sign-spa-manifest.mjs', async () => {
    const generatedAt = new Date().toISOString();
    await signSpaDist(distDir, privateKeyPem, {
      buildId: 'abc1234',
      spaIpcContract: IPC_CONTRACT,
      generatedAt,
    });

    const manifestBytes = fs.readFileSync(path.join(distDir, SPA_MANIFEST_FILENAME));
    const signatureBase64 = fs
      .readFileSync(path.join(distDir, SPA_MANIFEST_SIG_FILENAME), 'utf8')
      .trim();

    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const result = verifyManifest({
      manifestBytes,
      signatureBase64,
      publicKeyPems: [publicKeyPem],
      shellIpcContract: IPC_CONTRACT,
      nowMs: Date.parse(manifest.generatedAt),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS

    // Manifest fields match the dist exactly.
    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.buildId).toBe('abc1234');
    expect(result.manifest.spaIpcContract).toBe(IPC_CONTRACT);
    expect(result.manifest.entry.path).toBe('index.html');
    expect(result.manifest.entry.size).toBe(Buffer.byteLength(ENTRY_HTML));
    // Two assets, sorted by path (css sorts before js: "assets/x-d..." < "assets/x-a..."? no — 'a'<'d').
    expect(result.manifest.assets.map((a) => a.path)).toEqual([
      'assets/x-abc123.js',
      'assets/x-def456.css',
    ]);
    const expectedTotal =
      Buffer.byteLength(ENTRY_HTML) + Buffer.byteLength(ASSET_JS) + Buffer.byteLength(ASSET_CSS);
    expect(result.manifest.totalSize).toBe(expectedTotal);
  });

  it('buildManifest produces bytes that signManifestBytes signs to a verifiable signature', async () => {
    const generatedAt = new Date().toISOString();
    const { manifest, manifestBytes } = buildManifest(distDir, {
      buildId: 'build-99',
      spaIpcContract: IPC_CONTRACT,
      generatedAt,
    });
    const signatureBase64 = signManifestBytes(manifestBytes, privateKeyPem);

    const result = verifyManifest({
      manifestBytes,
      signatureBase64,
      publicKeyPems: [publicKeyPem],
      shellIpcContract: IPC_CONTRACT,
      nowMs: Date.parse(manifest.generatedAt),
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a manifest whose bytes were tampered after signing', async () => {
    const generatedAt = new Date().toISOString();
    await signSpaDist(distDir, privateKeyPem, {
      buildId: 'abc1234',
      spaIpcContract: IPC_CONTRACT,
      generatedAt,
    });

    const manifestPath = path.join(distDir, SPA_MANIFEST_FILENAME);
    const original = fs.readFileSync(manifestPath);
    // Flip one byte in the middle of the manifest JSON.
    const tampered = Buffer.from(original);
    const flipIndex = Math.floor(tampered.length / 2);
    tampered[flipIndex] = tampered[flipIndex] ^ 0xff;
    fs.writeFileSync(manifestPath, tampered);

    const manifestBytes = fs.readFileSync(manifestPath);
    const signatureBase64 = fs
      .readFileSync(path.join(distDir, SPA_MANIFEST_SIG_FILENAME), 'utf8')
      .trim();

    const result = verifyManifest({
      manifestBytes,
      signatureBase64,
      publicKeyPems: [publicKeyPem],
      shellIpcContract: IPC_CONTRACT,
      nowMs: Date.parse(generatedAt),
    });

    expect(result.ok).toBe(false);
  });

  it('rejects when verified against the wrong public key', async () => {
    const generatedAt = new Date().toISOString();
    const { manifest, manifestBytes } = buildManifest(distDir, {
      buildId: 'abc1234',
      spaIpcContract: IPC_CONTRACT,
      generatedAt,
    });
    const signatureBase64 = signManifestBytes(manifestBytes, privateKeyPem);

    const { publicKey: otherPublicKey } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const result = verifyManifest({
      manifestBytes,
      signatureBase64,
      publicKeyPems: [otherPublicKey as string],
      shellIpcContract: IPC_CONTRACT,
      nowMs: Date.parse(manifest.generatedAt),
    });

    expect(result.ok).toBe(false);
  });
});

// ── Fail-safe-skip (Finding E2) ─────────────────────────────────────────────
// The signer's no-key fail-safe lives in the CLI `main()` (not the exported
// helpers), so it is exercised by invoking the script as a subprocess. With
// SPA_MANIFEST_SIGNING_KEY unset/empty the script must exit 0 and write NEITHER
// the manifest NOR the signature (the SPA still deploys; the cache stays dormant
// — remote → bundled as before the feature). Paired with a present-key run that
// asserts BOTH files ARE written. Hermetic: temp dist, cleaned up; never commit
// a key.
describe('sign-spa-manifest.mjs CLI fail-safe (#1870 Finding E2)', () => {
  let cliDistDir: string;

  beforeEach(() => {
    cliDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-signer-cli-'));
    fs.writeFileSync(path.join(cliDistDir, 'index.html'), ENTRY_HTML);
    fs.mkdirSync(path.join(cliDistDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(cliDistDir, 'assets', 'x-abc123.js'), ASSET_JS);
  });

  afterEach(() => {
    if (cliDistDir) {
      fs.rmSync(cliDistDir, { recursive: true, force: true });
    }
  });

  function runSigner(env: Record<string, string | undefined>): number {
    try {
      execFileSync(
        process.execPath,
        [
          SIGNER_SCRIPT,
          '--dist',
          cliDistDir,
          '--build-id',
          'abc1234',
          '--ipc-contract',
          String(IPC_CONTRACT),
        ],
        { env: { ...process.env, ...env }, stdio: 'pipe' }
      );
      return 0;
    } catch (err) {
      // execFileSync throws on non-zero exit; surface the status.
      const status = (err as { status?: number }).status;
      return typeof status === 'number' ? status : 1;
    }
  }

  it('exits 0 and writes NEITHER file when SPA_MANIFEST_SIGNING_KEY is empty', () => {
    const exitCode = runSigner({ SPA_MANIFEST_SIGNING_KEY: '' });
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(cliDistDir, SPA_MANIFEST_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(cliDistDir, SPA_MANIFEST_SIG_FILENAME))).toBe(false);
  });

  it('exits 0 and writes NEITHER file when SPA_MANIFEST_SIGNING_KEY is unset', () => {
    // Explicitly remove the var (subprocess inherits process.env otherwise).
    const exitCode = runSigner({ SPA_MANIFEST_SIGNING_KEY: undefined });
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(cliDistDir, SPA_MANIFEST_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(cliDistDir, SPA_MANIFEST_SIG_FILENAME))).toBe(false);
  });

  it('writes BOTH files when a valid signing key IS present', () => {
    // Ephemeral key minted in-test, passed via env only — never written to disk.
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const exitCode = runSigner({ SPA_MANIFEST_SIGNING_KEY: privateKey as string });
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(cliDistDir, SPA_MANIFEST_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(cliDistDir, SPA_MANIFEST_SIG_FILENAME))).toBe(true);
  });
});

const CHANNEL_METADATA = [
  'spa-manifest.json',
  'spa-manifest.json.sig',
  'spa-manifest.v2.json',
  'spa-manifest.v2.json.sig',
];

describe('channel signer contract', () => {
  const options = {
    buildId: 'channel-fixture',
    spaIpcContract: IPC_CONTRACT,
    generatedAt: '2026-10-25T12:00:00.000Z',
  };

  function runChannelSigner(channel: string, key = privateKeyPem) {
    return spawnSync(
      process.execPath,
      [
        SIGNER_SCRIPT,
        '--dist',
        distDir,
        '--build-id',
        options.buildId,
        '--ipc-contract',
        String(IPC_CONTRACT),
        '--channel',
        channel,
      ],
      { env: { ...process.env, SPA_MANIFEST_SIGNING_KEY: key }, encoding: 'utf8' }
    );
  }
  function readSigned(filename: string) {
    return {
      manifestBytes: fs.readFileSync(path.join(distDir, filename)),
      signatureBase64: fs.readFileSync(path.join(distDir, filename + '.sig'), 'utf8').trim(),
    };
  }

  it('CLI emits verifiable v1 and stable v2 artifacts', () => {
    {
      const channel = 'stable' as const;
      const result = runChannelSigner(channel);
      expect(result.status, result.stderr).toBe(0);
      for (const filename of CHANNEL_METADATA)
        expect(fs.existsSync(path.join(distDir, filename))).toBe(true);
      const legacy = readSigned('spa-manifest.json');
      const signed = readSigned('spa-manifest.v2.json');
      const legacyObject = JSON.parse(legacy.manifestBytes.toString());
      expect(legacyObject.schemaVersion).toBe(1);
      expect(legacyObject).not.toHaveProperty('channel');
      expect(JSON.parse(signed.manifestBytes.toString())).toEqual({
        ...legacyObject,
        schemaVersion: 2,
        channel,
      });
      const params = {
        publicKeyPems: [publicKeyPem],
        shellIpcContract: IPC_CONTRACT,
        nowMs: Date.parse(legacyObject.generatedAt),
      };
      expect(verifyManifest({ ...legacy, ...params }).ok).toBe(true);
      expect(verifyChannelManifest({ ...signed, ...params, expectedChannel: channel }).ok).toBe(
        true
      );
      const opposite = verifyChannelManifest({
        ...signed,
        ...params,
        expectedChannel: channel === 'stable' ? 'prerelease' : 'stable',
      });
      expect(opposite.ok).toBe(false);
      if (!opposite.ok) expect(opposite.reason).toMatch(/channel/i);
      const swapped = verifyChannelManifest({
        ...signed,
        ...params,
        signatureBase64: legacy.signatureBase64,
        expectedChannel: channel,
      });
      expect(swapped.ok).toBe(false);
      if (!swapped.ok) expect(swapped.reason).toMatch(/signature/i);
    }
  });

  it('CLI emits only the prerelease v2 artifacts (no channel-less v1)', () => {
    const result = runChannelSigner('prerelease');
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(distDir, 'spa-manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'spa-manifest.json.sig'))).toBe(false);
    expect(result.stdout).toContain('spa-manifest.v2.json.sig');
    const signed = readSigned('spa-manifest.v2.json');
    const object = JSON.parse(signed.manifestBytes.toString());
    expect(object).toMatchObject({ schemaVersion: 2, channel: 'prerelease' });
    const params = {
      publicKeyPems: [publicKeyPem],
      shellIpcContract: IPC_CONTRACT,
      nowMs: Date.parse(object.generatedAt),
    };
    expect(verifyChannelManifest({ ...signed, ...params, expectedChannel: 'prerelease' }).ok).toBe(
      true
    );
    expect(verifyChannelManifest({ ...signed, ...params, expectedChannel: 'stable' }).ok).toBe(
      false
    );
  });

  it('deletes metadata the selected mode does not write', async () => {
    await signSpaDist(distDir, privateKeyPem, { ...options, channel: 'stable' });
    await signSpaDist(distDir, privateKeyPem, options);
    expect(fs.existsSync(path.join(distDir, 'spa-manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(distDir, 'spa-manifest.v2.json'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'spa-manifest.v2.json.sig'))).toBe(false);

    await signSpaDist(distDir, privateKeyPem, { ...options, channel: 'stable' });
    const { written } = await signSpaDist(distDir, privateKeyPem, {
      ...options,
      channel: 'prerelease',
    });
    expect(fs.existsSync(path.join(distDir, 'spa-manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'spa-manifest.json.sig'))).toBe(false);
    expect(written.map((file: string) => path.basename(file))).toEqual([
      'spa-manifest.v2.json',
      'spa-manifest.v2.json.sig',
    ]);
  });

  it('accepts a symlinked dist root and writes into its target', async () => {
    const link = `${distDir}-link`;
    fs.symlinkSync(distDir, link, 'dir');
    try {
      await signSpaDist(link, privateKeyPem, options);
      expect(fs.existsSync(path.join(distDir, 'spa-manifest.json'))).toBe(true);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it.each(['pilot', 'nightly', 'Stable', '../stable', ''])(
    'rejects invalid channel %j before changing artifacts',
    (channel) => {
      for (const filename of CHANNEL_METADATA)
        fs.writeFileSync(path.join(distDir, filename), 'previous-generation');
      const result = runChannelSigner(channel);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/invalid.*channel|channel.*(stable|prerelease|required)/i);
      for (const filename of CHANNEL_METADATA) {
        expect(fs.readFileSync(path.join(distDir, filename), 'utf8')).toBe('previous-generation');
      }
    }
  );

  it('programmatic signing refuses an unknown channel before writing artifacts', async () => {
    await expect(
      signSpaDist(distDir, privateKeyPem, { ...options, channel: 'pilot' })
    ).rejects.toThrow(/channel/i);
    for (const filename of CHANNEL_METADATA)
      expect(fs.existsSync(path.join(distDir, filename))).toBe(false);
  });

  it.each([undefined, '', '   '])(
    'programmatic channel signing refuses missing key %j without output',
    async (key) => {
      await expect(signSpaDist(distDir, key, { ...options, channel: 'stable' })).rejects.toThrow(
        /key|signing/i
      );
      for (const filename of CHANNEL_METADATA)
        expect(fs.existsSync(path.join(distDir, filename))).toBe(false);
    }
  );

  it('requires a signing key for explicit channel publication', () => {
    const result = runChannelSigner('stable', '');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/key|signing/i);
    for (const filename of CHANNEL_METADATA)
      expect(fs.existsSync(path.join(distDir, filename))).toBe(false);
  });

  it('excludes all four metadata files from the legacy asset enumerator', () => {
    for (const filename of CHANNEL_METADATA)
      fs.writeFileSync(path.join(distDir, filename), 'old-metadata');
    const { manifest } = buildManifest(distDir, options);
    expect(manifest.assets.map((asset: { path: string }) => asset.path)).toEqual([
      'assets/x-abc123.js',
      'assets/x-def456.css',
    ]);
    expect(manifest.totalSize).toBe(Buffer.byteLength(ENTRY_HTML + ASSET_JS + ASSET_CSS));
  });

  it('repeat channel signing preserves both asset sets without self-inclusion', async () => {
    await signSpaDist(distDir, privateKeyPem, { ...options, channel: 'stable' });
    for (const filename of CHANNEL_METADATA)
      expect(fs.existsSync(path.join(distDir, filename))).toBe(true);
    const beforeV1 = readSigned('spa-manifest.json').manifestBytes;
    const beforeV2 = readSigned('spa-manifest.v2.json').manifestBytes;
    await signSpaDist(distDir, privateKeyPem, { ...options, channel: 'stable' });
    expect(readSigned('spa-manifest.json').manifestBytes).toEqual(beforeV1);
    expect(readSigned('spa-manifest.v2.json').manifestBytes).toEqual(beforeV2);
    for (const filename of ['spa-manifest.json', 'spa-manifest.v2.json']) {
      const manifest = JSON.parse(readSigned(filename).manifestBytes.toString());
      expect(manifest.assets.map((asset: { path: string }) => asset.path)).toEqual([
        'assets/x-abc123.js',
        'assets/x-def456.css',
      ]);
    }
  });

  it.each(['entry', 'asset', 'directory', 'metadata'] as const)(
    'rejects a %s symlink in legacy and channel signing',
    async (kind) => {
      if (kind === 'entry') {
        fs.unlinkSync(path.join(distDir, 'index.html'));
        fs.symlinkSync('assets/x-abc123.js', path.join(distDir, 'index.html'));
      } else if (kind === 'asset') {
        fs.symlinkSync('x-abc123.js', path.join(distDir, 'assets', 'linked.js'));
      } else if (kind === 'directory') {
        fs.symlinkSync('assets', path.join(distDir, 'linked-assets'), 'dir');
      } else {
        fs.symlinkSync('index.html', path.join(distDir, 'spa-manifest.v2.json'));
      }
      expect(() => buildManifest(distDir, options)).toThrow(/symlink|symbolic/i);
      await expect(
        signSpaDist(distDir, privateKeyPem, { ...options, channel: 'stable' })
      ).rejects.toThrow(/symlink|symbolic/i);
      expect(fs.readFileSync(path.join(distDir, 'assets', 'x-abc123.js'), 'utf8')).toBe(ASSET_JS);
      if (kind === 'metadata') {
        expect(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')).toBe(ENTRY_HTML);
        expect(fs.existsSync(path.join(distDir, 'spa-manifest.json'))).toBe(false);
        expect(fs.lstatSync(path.join(distDir, 'spa-manifest.v2.json')).isSymbolicLink()).toBe(
          true
        );
      }
    }
  );
});
