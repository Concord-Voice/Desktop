/**
 * SPA LKG cache — on-disk store + rename-based promotion (#1870).
 *
 * Filesystem layout (all under `app.getPath('userData')/spa-cache/`):
 *   live/     — the verified legacy (v1) cache served by the `spa-cache://` handler
 *   staging/  — the download target for an in-progress populate; promoted to
 *               live/ ONLY after every file has been hash-verified against a
 *               signature-verified manifest.
 *   v2/<channel>/{live,staging}/ — the dormant per-channel caches (stable,
 *               prerelease), with the same lifecycle and no shared files.
 *
 * Promotion renames live/ → live.old/, staging/ → live/, then removes live.old/.
 * Each `rename(2)` is atomic on the same filesystem and every directory is a
 * sibling under the same userData dir, so no rename crosses a mount point. A
 * crash between the two renames leaves no live/ (fails closed: no cache).
 *
 * This module performs filesystem I/O only — no network, no crypto. The trust
 * decisions (signature, hashes, size caps) live in verifyManifest.ts and
 * populateCache.ts. Path-safety on writes mirrors appProtocol.ts so a malicious
 * manifest path can never escape the staging tree (defense in depth — the
 * manifest schema also rejects traversal paths before populate ever runs).
 */

import { app } from 'electron';
import { isUpdateChannel, type RemoteSpaChannel } from '../../shared/updateChannel';
import fs from 'node:fs';
import path from 'node:path';
import {
  SPA_CHANNEL_MANIFEST_FILENAME,
  SPA_CHANNEL_MANIFEST_SIG_FILENAME,
  SPA_MANIFEST_FILENAME,
  SPA_MANIFEST_MAX_BYTES,
  SPA_MANIFEST_SIG_FILENAME,
} from './manifestSchema';

/** Root of the SPA cache tree under the pinned userData dir. */
function getCacheRoot(): string {
  return path.join(app.getPath('userData'), 'spa-cache');
}

/** The directory served by the `spa-cache://` protocol handler. */
export function getLiveDir(): string {
  return path.join(getCacheRoot(), 'live');
}

/** The download target for an in-progress populate. */
export function getStagingDir(): string {
  return path.join(getCacheRoot(), 'staging');
}

export interface LiveManifestBytes {
  manifestBytes: Buffer;
  signatureBase64: string;
}

/**
 * Read the live manifest + detached signature, or null if either is absent or
 * unreadable. The manifest read is bounded by the schema's max-bytes cap (DoS
 * guard) — a manifest larger than the cap is treated as no cache. The signature
 * is read as UTF-8 text (base64) and trimmed.
 *
 * Never throws: any fs error (missing dir, permission, oversize) yields null so
 * the caller cleanly falls back to remote/bundled.
 */
export function readLiveManifest(): LiveManifestBytes | null {
  return readManifestAt(getLiveDir(), SPA_MANIFEST_FILENAME, SPA_MANIFEST_SIG_FILENAME);
}

function readManifestAt(
  liveDir: string,
  manifestName: string,
  signatureName: string
): LiveManifestBytes | null {
  const manifestPath = path.join(liveDir, manifestName);
  const sigPath = path.join(liveDir, signatureName);
  try {
    // Open ONCE and stat + read through the SAME file descriptor so the size
    // check and the read operate on one inode — no path-based time-of-check /
    // time-of-use race (CodeQL js/file-system-race). fstat on the fd genuinely
    // bounds the allocation (read only after confirming size <= cap), unlike a
    // path stat followed by readFileSync (which reads the whole file regardless).
    const fd = fs.openSync(manifestPath, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > SPA_MANIFEST_MAX_BYTES) {
        return null;
      }
      const manifestBytes = Buffer.alloc(st.size);
      let offset = 0;
      while (offset < st.size) {
        const read = fs.readSync(fd, manifestBytes, offset, st.size - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      if (offset !== st.size) {
        return null; // short read — treat as no usable cache
      }
      // Signature is tiny (RSA-4096 base64 ~ 700 bytes); a bare read has no
      // preceding check, so no race. Missing/empty → no usable cache.
      const signatureBase64 = fs.readFileSync(sigPath, 'utf8').trim();
      if (signatureBase64.length === 0) {
        return null;
      }
      return { manifestBytes, signatureBase64 };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Missing files / permission errors / not-a-file → no usable cache.
    return null;
  }
}

/**
 * Promote the staged cache to live by renaming live → live.old, staging → live,
 * then removing live.old. Creates the cache root if needed. The caller is
 * responsible for having fully populated + verified staging first; this function
 * performs no validation.
 */
export function promoteStagingToLive(): void {
  promoteAt(getCacheRoot(), getStagingDir(), getLiveDir());
}

/**
 * Swap staging into live with renames only, so live/ is never deleted before
 * its replacement exists. If the final rename fails, the previous live tree is
 * restored. A crash between the two renames leaves `live.old/` and no `live/`,
 * which fails closed (no cache) and is cleaned up by the next promotion.
 */
function promoteAt(root: string, stagingDir: string, liveDir: string): void {
  const oldDir = `${liveDir}.old`;
  fs.mkdirSync(root, { recursive: true });
  fs.rmSync(oldDir, { recursive: true, force: true });
  const hadLive = fs.existsSync(liveDir);
  if (hadLive) fs.renameSync(liveDir, oldDir);
  try {
    fs.renameSync(stagingDir, liveDir);
  } catch (err) {
    if (hadLive) fs.renameSync(oldDir, liveDir);
    throw err;
  }
  fs.rmSync(oldDir, { recursive: true, force: true });
}

/**
 * Reset the staging directory to a fresh empty tree (rm then mkdir). Called at
 * the start of every populate so a previous aborted populate's partial bytes
 * are never reused.
 */
export function resetStaging(): void {
  const stagingDir = getStagingDir();
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
}

/**
 * Resolve a manifest-relative path safely inside the staging dir. Mirrors
 * appProtocol.ts: reject absolute paths, drive letters, backslashes, and any
 * `..` traversal segment, then confirm the resolved absolute path is inside the
 * staging root. Throws on any rejection — the caller treats that as a populate
 * abort (never promote).
 */
function resolveStagedPath(relPath: string, stagingDir: string): string {
  if (relPath.length === 0) {
    throw new Error('staged path is empty');
  }
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath) || relPath.includes('\\')) {
    throw new Error('staged path must be relative (no leading slash, drive letter, or backslash)');
  }
  if (relPath.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new Error('staged path must not contain traversal, empty, or dot segments');
  }
  const absolutePath = path.resolve(stagingDir, relPath);
  const insideStaging =
    absolutePath.startsWith(stagingDir + path.sep) || absolutePath === stagingDir;
  if (!insideStaging) {
    throw new Error('staged path escapes the staging directory');
  }
  return absolutePath;
}

/**
 * Write `bytes` to `relPath` under the staging directory, creating intermediate
 * directories. Path-safety is enforced via resolveStagedPath (throws on any
 * traversal / absolute / drive-letter input). Because the staging tree is
 * created fresh by resetStaging, there are no pre-existing symlinks to follow.
 */
export function writeStagedFile(relPath: string, bytes: Buffer): void {
  writeStagedFileAt(getStagingDir(), relPath, bytes);
}

function writeStagedFileAt(stagingDir: string, relPath: string, bytes: Buffer): void {
  const absolutePath = resolveStagedPath(relPath, stagingDir);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
}

/**
 * Resolve a manifest-relative path safely inside the LIVE dir. Mirrors
 * resolveStagedPath's path-safety (reject empty / leading-slash / drive-letter /
 * backslash / `..`/`.`/empty segments / escape-liveDir) but rooted at
 * getLiveDir(). Returns the absolute path, or null on any rejection — callers in
 * the serve path treat null as "reject" (403/404), so this does NOT throw.
 */
export function resolveLivePath(relPath: string): string | null {
  return resolveLivePathAt(getLiveDir(), relPath);
}

function resolveLivePathAt(liveDir: string, relPath: string): string | null {
  if (relPath.length === 0) {
    return null;
  }
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath) || relPath.includes('\\')) {
    return null;
  }
  if (relPath.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    return null;
  }
  const absolutePath = path.resolve(liveDir, relPath);
  const insideLive = absolutePath.startsWith(liveDir + path.sep) || absolutePath === liveDir;
  if (!insideLive) {
    return null;
  }
  return absolutePath;
}

/**
 * Read a live-tree file by manifest-relative path, fd-bounded and TOCTOU-safe.
 *
 * The size check and the read operate on the SAME file descriptor (fstat on the
 * fd, then readSync from that fd) so there is no path-based time-of-check /
 * time-of-use race (CodeQL js/file-system-race) — mirrors readLiveManifest. The
 * fd-based `isFile()` check also rejects directories and device files, and the
 * `st.size !== expectedSize` check rejects any wrong-size replacement (e.g. a
 * symlink to a differently-sized out-of-tree target) BEFORE allocating/reading.
 *
 * Returns the file bytes, or null on any rejection (resolve failure, missing
 * file, not a regular file, size mismatch, short read). Never throws — callers
 * treat null as "reject". No crypto here (the hash check lives in
 * cacheIntegrity.ts).
 */
export function readLiveFile(relPath: string, expectedSize: number): Buffer | null {
  return readFileAt(resolveLivePath(relPath), expectedSize);
}

function readFileAt(absolutePath: string | null, expectedSize: number): Buffer | null {
  if (absolutePath === null) {
    return null;
  }
  try {
    const fd = fs.openSync(absolutePath, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size !== expectedSize) {
        return null;
      }
      const bytes = Buffer.alloc(st.size);
      let offset = 0;
      while (offset < st.size) {
        const read = fs.readSync(fd, bytes, offset, st.size - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      if (offset !== st.size) {
        return null; // short read — treat as unreadable
      }
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Missing file / permission error / not-a-file → reject.
    return null;
  }
}

/** Validate before consulting userData; Pilot has no remote cache namespace. */
export function isRemoteCacheChannel(channel: unknown): channel is RemoteSpaChannel {
  return isUpdateChannel(channel) && channel !== 'pilot';
}

/**
 * Capture a single validated namespace for the entire operation. In particular,
 * an asynchronous populate must not switch roots if userData changes mid-flight.
 * No caller-supplied filesystem root is accepted.
 */
export function createChannelCacheStore(channel: RemoteSpaChannel) {
  if (!isRemoteCacheChannel(channel)) throw new Error('invalid remote cache channel');
  const root = path.join(getCacheRoot(), 'v2', channel);
  const liveDir = path.join(root, 'live');
  const stagingDir = path.join(root, 'staging');
  return {
    channel,
    getLiveDir: () => liveDir,
    getStagingDir: () => stagingDir,
    readLiveManifest: () =>
      readManifestAt(liveDir, SPA_CHANNEL_MANIFEST_FILENAME, SPA_CHANNEL_MANIFEST_SIG_FILENAME),
    resetStaging: () => {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir, { recursive: true });
    },
    writeStagedFile: (relPath: string, bytes: Buffer) =>
      writeStagedFileAt(stagingDir, relPath, bytes),
    promoteStagingToLive: () => promoteAt(root, stagingDir, liveDir),
    resolveLivePath: (relPath: string) => resolveLivePathAt(liveDir, relPath),
    readLiveFile: (relPath: string, expectedSize: number) =>
      readFileAt(resolveLivePathAt(liveDir, relPath), expectedSize),
  };
}

export type ChannelCacheStore = ReturnType<typeof createChannelCacheStore>;
