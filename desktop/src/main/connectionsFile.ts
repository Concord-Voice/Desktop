import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SAAS_SERVICE_ID, isServiceId, type ServiceId } from '../shared/connectionIdentity';
import { serviceIdForApiBase } from './selfHostedProfile';

/**
 * `connections.json` v1 (#86 spec §3.2): which connections the shell restores at
 * startup. It holds no secrets and mints no trust. Every entry is re-validated on
 * read: its origin must re-canonicalise to its own `serviceId`, and a self-hosted
 * origin is admitted only while the approvals ledger still holds it. `lastForegroundAt`
 * restores layout only; no admission decision reads it.
 */
export const CONNECTIONS_FILE_VERSION = 1;
export const MAX_CONNECTIONS_ENTRIES = 16;

export interface ConnectionsFileEntry {
  serviceId: ServiceId;
  origin: string;
  /** ISO-8601, `Date#toISOString` form. */
  addedAt: string;
  /** ISO-8601, or null when the connection has never been brought to the foreground. */
  lastForegroundAt: string | null;
}

export interface ConnectionsFile {
  version: 1;
  connections: ConnectionsFileEntry[];
}

/** The approvals ledger, the only thing that admits a self-hosted origin. */
export interface ConnectionAdmissionDeps {
  isValidatedSelfHostedApiBase(origin: string): boolean;
}

const ENTRY_KEYS = ['serviceId', 'origin', 'addedAt', 'lastForegroundAt'] as const;
const FILE_KEYS = ['version', 'connections'] as const;

export function connectionsFilePath(userDataRoot: string): string {
  return path.join(userDataRoot, 'connections.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}

/** Only the canonical `toISOString` spelling, so a value round-trips byte-for-byte. */
function isIsoTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return false;
  return new Date(v).toISOString() === v;
}

function canonicalOrigin(v: string): string | null {
  if (!URL.canParse(v)) return null;
  const url = new URL(v);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin === v ? v : null;
}

/** A fresh entry carrying only the four v1 keys, or null when anything is off. */
function parseEntry(raw: unknown, deps: ConnectionAdmissionDeps): ConnectionsFileEntry | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ENTRY_KEYS)) return null;
  const { serviceId, origin, addedAt, lastForegroundAt } = raw;
  if (!isServiceId(serviceId) || typeof origin !== 'string') return null;
  if (canonicalOrigin(origin) === null) return null;
  // The id must be the one this origin derives, never one the file asserts.
  if (serviceIdForApiBase(origin) !== serviceId) return null;
  if (serviceId !== SAAS_SERVICE_ID && !deps.isValidatedSelfHostedApiBase(origin)) return null;
  if (!isIsoTimestamp(addedAt)) return null;
  if (lastForegroundAt !== null && !isIsoTimestamp(lastForegroundAt)) return null;
  return { serviceId, origin, addedAt, lastForegroundAt };
}

/**
 * The validated entries, or `[]` for a missing, unreadable, unparsable or wrong-version
 * file. Never throws. Only the first {@link MAX_CONNECTIONS_ENTRIES} entries are
 * considered; a malformed entry is dropped alone, and a repeated `serviceId` keeps
 * its first occurrence.
 */
export function readConnectionsFile(
  userDataRoot: string,
  deps: ConnectionAdmissionDeps
): ConnectionsFileEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(connectionsFilePath(userDataRoot), 'utf-8'));
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !hasExactKeys(parsed, FILE_KEYS)) return [];
  if (parsed.version !== CONNECTIONS_FILE_VERSION || !Array.isArray(parsed.connections)) return [];

  const out: ConnectionsFileEntry[] = [];
  const seen = new Set<ServiceId>();
  for (const raw of parsed.connections.slice(0, MAX_CONNECTIONS_ENTRIES)) {
    let entry: ConnectionsFileEntry | null;
    try {
      entry = parseEntry(raw, deps);
    } catch {
      entry = null; // a throwing predicate drops the entry, never the startup
    }
    if (entry === null || seen.has(entry.serviceId)) continue;
    seen.add(entry.serviceId);
    out.push(entry);
  }
  return out;
}

function serialize(entries: readonly ConnectionsFileEntry[]): string {
  const file: ConnectionsFile = {
    version: CONNECTIONS_FILE_VERSION,
    // Copy the four keys by name, so nothing a caller attached can reach the disk.
    connections: entries.slice(0, MAX_CONNECTIONS_ENTRIES).map((e) => ({
      serviceId: e.serviceId,
      origin: e.origin,
      addedAt: e.addedAt,
      lastForegroundAt: e.lastForegroundAt,
    })),
  };
  return JSON.stringify(file);
}

/** A fresh, uniquely named 0o600 temp file and a same-directory rename. */
function writeAtomic(dest: string, body: string): void {
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing was created, or the directory is gone; there is nothing to remove.
    }
    throw err;
  }
}

let writeTail: Promise<void> = Promise.resolve();

/**
 * The one writer. Calls land in call order, so the last call's content wins. The
 * content is captured when the call is made, not when it runs. A failed write
 * rejects its own promise and does not stop the writes queued behind it.
 */
export function writeConnectionsFile(
  userDataRoot: string,
  entries: readonly ConnectionsFileEntry[]
): Promise<void> {
  const dest = connectionsFilePath(userDataRoot);
  const body = serialize(entries);
  const run = writeTail.then(() => writeAtomic(dest, body));
  writeTail = run.catch(() => undefined);
  return run;
}
