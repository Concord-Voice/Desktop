// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root = '';
vi.mock('electron', () => ({ app: { getPath: () => root } }));

import {
  CONNECTIONS_FILE_VERSION,
  MAX_CONNECTIONS_ENTRIES,
  connectionsFilePath,
  readConnectionsFile,
  writeConnectionsFile,
  type ConnectionsFileEntry,
} from '../../../src/main/connectionsFile';
import { serviceIdForApiBase } from '../../../src/main/selfHostedProfile';
import { SAAS_SERVICE_ID } from '../../../src/shared/connectionIdentity';

const SAAS_ORIGIN = 'https://api.concordvoice.chat';
const X = 'https://chat.example.org';
const NOW = '2026-11-09T00:00:00.000Z';

function entry(origin: string, extra: Partial<ConnectionsFileEntry> = {}): ConnectionsFileEntry {
  return {
    serviceId: serviceIdForApiBase(origin),
    origin,
    addedAt: NOW,
    lastForegroundAt: null,
    ...extra,
  };
}

const approveX = { isValidatedSelfHostedApiBase: (o: string) => o === X };

function writeRaw(body: unknown): void {
  fs.writeFileSync(
    connectionsFilePath(root),
    typeof body === 'string' ? body : JSON.stringify(body)
  );
}

describe('connectionsFile', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'connfile-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exposes the v1 constants and path', () => {
    expect(CONNECTIONS_FILE_VERSION).toBe(1);
    expect(MAX_CONNECTIONS_ENTRIES).toBe(16);
    expect(connectionsFilePath(root)).toBe(path.join(root, 'connections.json'));
  });

  it('round-trips valid saas and approved self-hosted entries', () => {
    const entries = [entry(SAAS_ORIGIN), entry(X, { lastForegroundAt: NOW })];
    writeRaw({ version: 1, connections: entries });
    expect(readConnectionsFile(root, approveX)).toEqual(entries);
    expect(entries[0].serviceId).toBe(SAAS_SERVICE_ID);
  });

  it('returns [] for a missing, unparsable, or wrong-version file without throwing', () => {
    expect(readConnectionsFile(root, approveX)).toEqual([]);
    writeRaw('{not json');
    expect(readConnectionsFile(root, approveX)).toEqual([]);
    writeRaw({ version: 2, connections: [entry(SAAS_ORIGIN)] });
    expect(readConnectionsFile(root, approveX)).toEqual([]);
    writeRaw({ version: 1, connections: 'nope' });
    expect(readConnectionsFile(root, approveX)).toEqual([]);
  });

  it('drops an entry with an extra key', () => {
    writeRaw({ version: 1, connections: [{ ...entry(SAAS_ORIGIN), token: 'leak' }, entry(X)] });
    expect(readConnectionsFile(root, approveX)).toEqual([entry(X)]);
  });

  it('drops an entry with a missing key', () => {
    const { addedAt: _drop, ...partial } = entry(X);
    writeRaw({ version: 1, connections: [partial, entry(SAAS_ORIGIN)] });
    expect(readConnectionsFile(root, approveX)).toEqual([entry(SAAS_ORIGIN)]);
  });

  it('drops an entry whose origin does not re-canonicalise to its serviceId', () => {
    const forged = entry(X, { serviceId: serviceIdForApiBase('https://other.example.org') });
    writeRaw({ version: 1, connections: [forged, entry(SAAS_ORIGIN)] });
    expect(readConnectionsFile(root, approveX)).toEqual([entry(SAAS_ORIGIN)]);
  });

  it('drops a non-canonical origin', () => {
    writeRaw({ version: 1, connections: [entry(`${X}/`), entry(SAAS_ORIGIN)] });
    expect(readConnectionsFile(root, approveX)).toEqual([entry(SAAS_ORIGIN)]);
  });

  it('drops an unapproved self-hosted origin but keeps saas', () => {
    writeRaw({ version: 1, connections: [entry('https://evil.example.net'), entry(SAAS_ORIGIN)] });
    expect(readConnectionsFile(root, approveX)).toEqual([entry(SAAS_ORIGIN)]);
  });

  it('drops entries with non-ISO timestamps or non-string fields', () => {
    writeRaw({
      version: 1,
      connections: [
        entry(X, { addedAt: 'yesterday' }),
        entry(X, { lastForegroundAt: 5 as unknown as string }),
        entry(SAAS_ORIGIN),
      ],
    });
    expect(readConnectionsFile(root, approveX)).toEqual([entry(SAAS_ORIGIN)]);
  });

  it('keeps only the first 16 of 17 entries', () => {
    const many = Array.from({ length: 17 }, (_, i) => entry(`https://h${i}.example.org`));
    writeRaw({ version: 1, connections: many });
    const out = readConnectionsFile(root, { isValidatedSelfHostedApiBase: () => true });
    expect(out).toHaveLength(16);
    expect(out[15].origin).toBe('https://h15.example.org');
  });

  describe('writeConnectionsFile', () => {
    it('writes version 1 JSON with mode 0o600', async () => {
      await writeConnectionsFile(root, [entry(SAAS_ORIGIN)]);
      const raw = JSON.parse(fs.readFileSync(connectionsFilePath(root), 'utf8'));
      expect(raw).toEqual({ version: 1, connections: [entry(SAAS_ORIGIN)] });
      expect(fs.statSync(connectionsFilePath(root)).mode & 0o777).toBe(0o600);
    });

    it('two concurrent writes: the second content wins, no .tmp left behind', async () => {
      const a = writeConnectionsFile(root, [entry(SAAS_ORIGIN)]);
      const b = writeConnectionsFile(root, [entry(SAAS_ORIGIN), entry(X)]);
      await Promise.all([a, b]);
      const raw = JSON.parse(fs.readFileSync(connectionsFilePath(root), 'utf8'));
      expect(raw.connections).toHaveLength(2);
      expect(fs.readdirSync(root).filter((f) => f.includes('.tmp'))).toEqual([]);
      expect(fs.statSync(connectionsFilePath(root)).mode & 0o777).toBe(0o600);
    });

    it('rejects and leaves no .tmp when the directory is unwritable', async () => {
      const missing = path.join(root, 'nope', 'deeper');
      await expect(writeConnectionsFile(missing, [entry(SAAS_ORIGIN)])).rejects.toThrow();
      expect(fs.readdirSync(root)).toEqual([]);
    });

    it('a failed write does not poison the queue for the next write', async () => {
      await expect(
        writeConnectionsFile(path.join(root, 'nope'), [entry(SAAS_ORIGIN)])
      ).rejects.toThrow();
      await writeConnectionsFile(root, [entry(SAAS_ORIGIN)]);
      expect(fs.existsSync(connectionsFilePath(root))).toBe(true);
    });
  });
});
