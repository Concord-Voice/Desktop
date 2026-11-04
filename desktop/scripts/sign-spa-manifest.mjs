#!/usr/bin/env node
/**
 * sign-spa-manifest.mjs — SPA last-known-good (LKG) cache PRODUCER (#1870).
 *
 * Walks the built renderer dist, builds a `spa-manifest.json` describing every
 * file (sha256 + size), and writes a DETACHED RSA-PSS signature over the EXACT
 * bytes of that manifest to a sibling `spa-manifest.json.sig`. With
 * `--channel stable|prerelease` it also writes a channel-bound schema-v2
 * `spa-manifest.v2.json` (+ `.sig`) over the same asset set. Stable keeps the v1
 * pair for existing clients; Pre-Release writes v2 ONLY, because v1 carries no
 * channel and a v1 client must never cache Pre-Release bytes. Each mode deletes
 * the metadata files it does not write, so a dist re-signed in another mode
 * never publishes a stale manifest. The `--dist` root may be a symlink (it is
 * resolved first); symlinks inside it are rejected. The Electron
 * verifier (`src/main/spaCache/verifyManifest.ts`) checks the signature over the
 * bytes it fetched VERBATIM before parsing the JSON, so there is no
 * canonicalization to drift between this signer and the verifier.
 *
 * The field shape + algorithm parameters are the contract declared in
 * `src/main/spaCache/manifestSchema.ts` (the single source of truth). This file
 * intentionally re-declares the small constants it needs rather than importing
 * the TypeScript module — it runs as plain Node ESM in the deploy path, with no
 * build step and no third-party deps (Node built-ins only).
 *
 * FAIL-SAFE: the CLI skips signing (exit 0) when `SPA_MANIFEST_SIGNING_KEY` is
 * unset/empty in legacy mode — the SPA still deploys and the client cache stays dormant
 * (remote → bundled exactly as before this feature shipped). The private key is
 * NEVER logged. Explicit --channel publication requires a key and writes v2 too.
 *
 * Contract and activation status: docs/policies/update-trust-model.md.
 */

import { readFileSync, readdirSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { constants as cryptoConstants, createHash, sign as cryptoSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ── Contract constants (mirror src/main/spaCache/manifestSchema.ts) ────────
const SPA_MANIFEST_SCHEMA_VERSION = 1;
const SPA_MANIFEST_FILENAME = 'spa-manifest.json';
const SPA_MANIFEST_SIG_FILENAME = 'spa-manifest.json.sig';
const SPA_CHANNEL_MANIFEST_FILENAME = 'spa-manifest.v2.json';
const SPA_CHANNEL_MANIFEST_SIG_FILENAME = 'spa-manifest.v2.json.sig';
const METADATA_FILENAMES = new Set([
  SPA_MANIFEST_FILENAME,
  SPA_MANIFEST_SIG_FILENAME,
  SPA_CHANNEL_MANIFEST_FILENAME,
  SPA_CHANNEL_MANIFEST_SIG_FILENAME,
]);
const SPA_MANIFEST_SIGN_ALGORITHM = 'sha256';
const SPA_MANIFEST_SIGN_SALT_LENGTH = 32;
/** The dist-root entry HTML treated as the manifest `entry` (all else = assets). */
const ENTRY_FILENAME = 'index.html';

const LOG_PREFIX = '[sign-spa-manifest]';

/** sha256 of a file's bytes, lowercase hex (matches the verifier's SHA256_HEX). */
function sha256HexOfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Recursively walk `distDir` and return every file as a relative POSIX path
 * from distDir. Reject symlinks before filtering metadata or hashing any assets.
 */
function walkFiles(distDir) {
  const out = [];
  function walk(absDir) {
    if (lstatSync(absDir).isSymbolicLink()) throw new Error('symlink directory is not allowed');
    for (const entry of readdirSync(absDir)) {
      const abs = path.join(absDir, entry);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error('symlink input is not allowed');
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        // Relative POSIX path from distDir (forward slashes on every platform).
        const rel = path.relative(distDir, abs).split(path.sep).join('/');
        if (!METADATA_FILENAMES.has(rel)) out.push(rel);
      }
    }
  }
  walk(distDir);
  return out;
}

/**
 * Build the manifest object + the exact bytes that will be signed and written.
 * The dist-root `index.html` is the `entry`; every other file is an asset.
 * Assets are sorted by path for deterministic output. The signature is over
 * `manifestBytes`, so any stable serialization is acceptable — we pick
 * 2-space-pretty JSON + trailing newline and stick to it.
 *
 * @returns {{ manifest: object, manifestBytes: Buffer }}
 */
export function buildManifest(distDir, { buildId, spaIpcContract, generatedAt }) {
  const resolvedDist = resolveDist(distDir);
  const files = walkFiles(resolvedDist);
  const entryAbs = path.join(resolvedDist, ENTRY_FILENAME);
  let entryStat;
  try {
    entryStat = lstatSync(entryAbs);
  } catch {
    throw new Error(`${ENTRY_FILENAME} not found at dist root: ${resolvedDist}`);
  }
  if (!entryStat.isFile()) {
    throw new Error(`${ENTRY_FILENAME} at dist root is not a regular file: ${resolvedDist}`);
  }

  const entry = {
    path: ENTRY_FILENAME,
    sha256: sha256HexOfFile(entryAbs),
    size: entryStat.size,
  };

  const assets = files
    .filter((rel) => rel !== ENTRY_FILENAME)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((rel) => {
      const abs = path.join(resolvedDist, rel);
      return { path: rel, sha256: sha256HexOfFile(abs), size: lstatSync(abs).size };
    });

  const totalSize = entry.size + assets.reduce((acc, a) => acc + a.size, 0);

  const manifest = {
    schemaVersion: SPA_MANIFEST_SCHEMA_VERSION,
    buildId,
    spaIpcContract,
    generatedAt,
    entry,
    assets,
    totalSize,
  };

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestBytes };
}

/** Resolve the dist root itself (a symlinked --dist is fine); contents are walked with lstat. */
function resolveDist(distDir) {
  return realpathSync(path.resolve(distDir));
}

/**
 * Sign the exact manifest bytes with RSA-PSS / SHA-256 / saltLength 32 and
 * return the signature as base64. Mirrors `crypto.verify(...)` in
 * verifyManifest.ts exactly.
 */
export function signManifestBytes(manifestBytes, privateKeyPem) {
  const signature = cryptoSign(SPA_MANIFEST_SIGN_ALGORITHM, manifestBytes, {
    key: privateKeyPem,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: SPA_MANIFEST_SIGN_SALT_LENGTH,
  });
  return signature.toString('base64');
}

/**
 * Build + sign + write the manifest envelopes for the selected mode into distDir:
 *   - legacy (no channel): v1 `spa-manifest.json` + `.sig`
 *   - stable:              v1 pair + v2 `spa-manifest.v2.json` + `.sig`
 *   - prerelease:          v2 pair only
 * Metadata files the mode does not write are deleted. Every envelope is signed
 * before any file is written, so a failed signature publishes nothing.
 *
 * @returns {{ manifest: object, written: string[] }}
 */
export async function signSpaDist(distDir, privateKeyPem, opts) {
  const { buildId, spaIpcContract, generatedAt, channel } = opts;
  if (channel !== undefined) {
    assertChannel(channel);
    if (!privateKeyPem?.trim())
      throw new Error('channel signing requires SPA_MANIFEST_SIGNING_KEY');
  }
  const { manifest, manifestBytes } = buildManifest(distDir, {
    buildId,
    spaIpcContract,
    generatedAt,
  });

  const envelopes = [];
  if (channel !== 'prerelease') {
    envelopes.push([SPA_MANIFEST_FILENAME, SPA_MANIFEST_SIG_FILENAME, manifestBytes]);
  }
  if (channel !== undefined) {
    const channelBytes = Buffer.from(
      `${JSON.stringify({ ...manifest, schemaVersion: 2, channel }, null, 2)}\n`,
      'utf8'
    );
    envelopes.push([
      SPA_CHANNEL_MANIFEST_FILENAME,
      SPA_CHANNEL_MANIFEST_SIG_FILENAME,
      channelBytes,
    ]);
  }
  const signed = envelopes.map(([name, sigName, bytes]) => ({
    name,
    sigName,
    bytes,
    signature: signManifestBytes(bytes, privateKeyPem),
  }));

  const resolvedDist = resolveDist(distDir);
  const keep = new Set(signed.flatMap(({ name, sigName }) => [name, sigName]));
  for (const name of METADATA_FILENAMES) {
    if (!keep.has(name)) rmSync(path.join(resolvedDist, name), { force: true });
  }
  const written = [];
  for (const { name, sigName, bytes, signature } of signed) {
    // Write the EXACT bytes that were signed (no re-serialization).
    writeFileSync(path.join(resolvedDist, name), bytes);
    writeFileSync(path.join(resolvedDist, sigName), `${signature}\n`, 'utf8');
    written.push(path.join(resolvedDist, name), path.join(resolvedDist, sigName));
  }
  return { manifest, written };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function assertChannel(channel) {
  if (channel !== 'stable' && channel !== 'prerelease') {
    throw new Error('invalid channel: must be stable or prerelease');
  }
}

function parseArgs(argv) {
  const opts = { dist: '', buildId: '', ipcContract: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dist') opts.dist = argv[(i += 1)] ?? '';
    else if (arg.startsWith('--dist=')) opts.dist = arg.slice('--dist='.length);
    else if (arg === '--build-id') opts.buildId = argv[(i += 1)] ?? '';
    else if (arg.startsWith('--build-id=')) opts.buildId = arg.slice('--build-id='.length);
    else if (arg === '--channel') opts.channel = argv[(i += 1)] ?? '';
    else if (arg.startsWith('--channel=')) opts.channel = arg.slice('--channel='.length);
    else if (arg === '--ipc-contract') opts.ipcContract = argv[(i += 1)] ?? '';
    else if (arg.startsWith('--ipc-contract='))
      opts.ipcContract = arg.slice('--ipc-contract='.length);
    else {
      console.error(`${LOG_PREFIX} unknown arg '${arg}'`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const { dist, buildId, ipcContract, channel } = parseArgs(process.argv.slice(2));

  if (channel !== undefined) assertChannel(channel);

  if (!dist || !buildId || !ipcContract) {
    console.error(
      `${LOG_PREFIX} usage: sign-spa-manifest.mjs --dist <dir> --build-id <id> --ipc-contract <n> [--channel stable|prerelease]`
    );
    process.exit(2);
  }

  const spaIpcContract = Number.parseInt(ipcContract, 10);
  if (!Number.isInteger(spaIpcContract) || spaIpcContract <= 0) {
    console.error(`${LOG_PREFIX} --ipc-contract must be a positive integer, got '${ipcContract}'`);
    process.exit(2);
  }

  // Legacy mode remains dormant without a key; channel publication must fail closed.
  const privateKeyPem = process.env.SPA_MANIFEST_SIGNING_KEY ?? '';
  if (privateKeyPem.trim().length === 0) {
    if (channel !== undefined) throw new Error('channel signing requires SPA_MANIFEST_SIGNING_KEY');
    console.error(
      `${LOG_PREFIX} no SPA_MANIFEST_SIGNING_KEY; skipping manifest signing (cache stays dormant)`
    );
    process.exit(0);
  }

  const generatedAt = new Date().toISOString();
  const { manifest, written } = await signSpaDist(dist, privateKeyPem, {
    buildId,
    spaIpcContract,
    generatedAt,
    channel,
  });

  // NEVER log the key or its bytes. Log only the non-secret manifest summary.
  console.log(
    `${LOG_PREFIX} signed SPA manifest: buildId=${manifest.buildId} ipc=${manifest.spaIpcContract} ` +
      `assets=${manifest.assets.length} totalSize=${manifest.totalSize}`
  );
  for (const file of written) console.log(`${LOG_PREFIX} wrote ${file}`);
}

/* istanbul ignore next -- thin CLI entry shim; the exported core is unit-tested. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`${LOG_PREFIX} ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

// Re-export the filename constants so callers/tests can assert against them.
export { SPA_MANIFEST_FILENAME, SPA_MANIFEST_SIG_FILENAME };
