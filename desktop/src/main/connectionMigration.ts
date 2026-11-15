import fs from 'node:fs';
import path from 'node:path';
import { SAAS_SERVICE_ID } from '../shared/connectionIdentity';
import {
  connectionsFilePath,
  readConnectionsFile,
  writeConnectionsFile,
  type ConnectionAdmissionDeps,
  type ConnectionsFileEntry,
} from './connectionsFile';
import { serviceIdForApiBase } from './selfHostedProfile';

/**
 * #86 spec §3.6: a non-destructive migration to `connections.json`.
 *
 * P0 derives the first entries from the two legacy root files, `active-profile.json`
 * and `token-meta.json`. It only reads them: nothing is renamed, copied, rewritten or
 * deleted, so a downgraded shell finds them byte-identical. They are read directly,
 * never through a custody instance, because a custody would act on what it reads.
 * P1 writes `connections.json`, whose presence is the marker that P0 has run.
 */

const SAAS_ORIGIN = 'https://api.concordvoice.chat';

/** The `apiBase` a legacy root file names, canonicalised to its origin, or null. */
function readLegacyOrigin(file: string): { origin: string; json: Record<string, unknown> } | null {
  try {
    const json: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
    const record = json as Record<string, unknown>;
    const apiBase = record.apiBase;
    if (typeof apiBase !== 'string' || !URL.canParse(apiBase)) return null;
    const origin = new URL(apiBase).origin;
    return origin === 'null' ? null : { origin, json: record };
  } catch {
    return null;
  }
}

/**
 * Root `token-meta.json` exists only for a Remember-Me SaaS credential: tokenManager
 * writes a meta file only under Remember-Me. An explicit `rememberMe: false`, or a
 * meta naming another origin (a pre-#1618 layout), is not a SaaS credential.
 */
function rootHoldsSaasRememberMe(userDataRoot: string): boolean {
  const meta = readLegacyOrigin(path.join(userDataRoot, 'token-meta.json'));
  return meta !== null && meta.origin === SAAS_ORIGIN && meta.json.rememberMe !== false;
}

function freshEntry(origin: string, addedAt: string): ConnectionsFileEntry {
  return { serviceId: serviceIdForApiBase(origin), origin, addedAt, lastForegroundAt: null };
}

/**
 * P0. `[X]` when `active-profile.json` names an approved self-hosted origin X, with
 * `saas` after it when the root holds a Remember-Me SaaS credential; otherwise
 * `[saas]`. It never reads `connections.json`, and every entry it returns has a null
 * `lastForegroundAt`.
 */
export function deriveInitialConnections(
  userDataRoot: string,
  deps: ConnectionAdmissionDeps
): ConnectionsFileEntry[] {
  const addedAt = new Date().toISOString();
  const saas = freshEntry(SAAS_ORIGIN, addedAt);
  const pointer = readLegacyOrigin(path.join(userDataRoot, 'active-profile.json'));
  let approved = false;
  try {
    approved =
      pointer !== null &&
      serviceIdForApiBase(pointer.origin) !== SAAS_SERVICE_ID &&
      deps.isValidatedSelfHostedApiBase(pointer.origin);
  } catch {
    approved = false;
  }
  if (!pointer || !approved) return [saas];
  const selfHosted = freshEntry(pointer.origin, addedAt);
  return rootHoldsSaasRememberMe(userDataRoot) ? [selfHosted, saas] : [selfHosted];
}

/**
 * P0 + P1 when `connections.json` is absent; otherwise the file's validated entries.
 * Never throws and never blocks on the write: a failed write is logged and P0 simply
 * runs again on the next launch.
 */
export function runConnectionMigration(
  userDataRoot: string,
  deps: ConnectionAdmissionDeps
): { entries: ConnectionsFileEntry[]; derived: boolean } {
  if (fs.existsSync(connectionsFilePath(userDataRoot))) {
    return { entries: readConnectionsFile(userDataRoot, deps), derived: false };
  }
  const entries = deriveInitialConnections(userDataRoot, deps);
  writeConnectionsFile(userDataRoot, entries).catch(() => {
    // Fixed text: the error carries a path under the user's profile.
    console.warn(
      '[connections] connections.json could not be written; it is derived again next launch'
    );
  });
  return { entries, derived: true };
}
