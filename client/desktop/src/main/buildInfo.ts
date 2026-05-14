// Forensic build-tag observability for incident response (#920 §5.13).
//
// Reads the build tag from `buildtag.json` (packaged via forge's
// `extraResource` mechanism, see `forge.config.ts`). In packaged builds the
// file lives at `process.resourcesPath/buildtag.json`; in dev/test it falls
// back to the working directory. Missing-file or malformed-JSON paths fall
// back to 'unknown' so this surface is always callable.
//
// Threat-model rationale (per #920 spec §5.13): the build tag is exposed via
// MAIN-PROCESS IPC only — never via `window.__BUILD_TAG__` or via
// `import.meta.env.VITE_BUILD_TAG` in renderer code. A compromised renderer
// dependency cannot exfiltrate the tag without an explicit, auditable IPC
// call. Knowing the build tag does not unlock any capability — this is
// observability, not secrecy.

import fs from 'node:fs';
import path from 'node:path';

let cachedTag: string | null = null;

/**
 * Structural type predicate for the `buildtag.json` payload shape.
 * Extracted from inline narrowing for readability and reuse if future
 * fields are added (e.g., a `version` field).
 */
function isBuildtagPayload(value: unknown): value is { tag: string } {
  return (
    typeof value === 'object' && value !== null && 'tag' in value && typeof value.tag === 'string'
  );
}

/**
 * Resolve the on-disk path to `buildtag.json`.
 *
 * `process.resourcesPath` is set by Electron in packaged builds to the
 * Resources directory. The Electron type augmentation declares it as
 * `string` globally — in Vitest / `tsc` / direct-node contexts the value
 * is undefined at runtime despite the type, so guard with a truthy check
 * and fall back to the current working directory (matching where
 * `generate-buildtag.mjs` writes the file).
 *
 * **In packaged builds** the cwd fallback is unreachable because Electron
 * always sets `process.resourcesPath`. The fallback exists solely for
 * Vitest / dev / direct-node contexts.
 *
 * Parameterized with default args so unit tests can exercise both branches
 * without mocking process globals.
 */
export function resolveBuildtagPath(
  resourcesPath: string | undefined = process.resourcesPath,
  cwd: string = process.cwd()
): string {
  return resourcesPath
    ? path.join(resourcesPath, 'buildtag.json')
    : path.resolve(cwd, 'buildtag.json');
}

/**
 * Returns the build tag baked into the packaged app at build time, or
 * 'unknown' for local dev builds where the file is absent or malformed.
 *
 * Memoized after the first call — buildtag.json never changes during a
 * single process lifetime, so repeated reads are wasted I/O. The cache
 * pins on first call regardless of outcome (string or 'unknown'), which
 * means a transient `EBUSY` or other recoverable error at startup will
 * permanently degrade the IPC contract to 'unknown' for the process
 * lifetime. This is acceptable for forensic observability — "unknown is
 * better than crashed" is the right contract for incident-response
 * tooling — but logged below so genuine failures are diagnosable.
 */
export function getBuildTag(): string {
  if (cachedTag !== null) return cachedTag;

  try {
    const buildtagPath = resolveBuildtagPath();
    if (!fs.existsSync(buildtagPath)) {
      cachedTag = 'unknown';
      return cachedTag;
    }
    const content = fs.readFileSync(buildtagPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (isBuildtagPayload(parsed)) {
      cachedTag = parsed.tag;
    } else {
      cachedTag = 'unknown';
    }
  } catch (err) {
    // Non-empty catch so genuine failures (EACCES, EIO, malformed
    // buildtag.json in a production build) are diagnosable rather than
    // silently degrading to 'unknown'. Per internal-reference,
    // log only the error message — never the raw err object (Error.cause
    // can carry secret material upward).
    const message = err instanceof Error ? err.message : 'buildtag_read_failed';
    // String-concatenate the message into the format string so the rule
    // forbidding bare identifiers as the final console.warn argument is
    // satisfied (see internal-reference "Console error logging").
    console.warn(`buildInfo: buildtag.json read failed, defaulting to unknown: ${message}`);
    cachedTag = 'unknown';
  }
  return cachedTag;
}
