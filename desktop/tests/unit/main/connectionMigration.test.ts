// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root = '';
vi.mock('electron', () => ({ app: { getPath: () => root } }));

import {
  deriveInitialConnections,
  runConnectionMigration,
} from '../../../src/main/connectionMigration';
import { connectionsFilePath } from '../../../src/main/connectionsFile';
import { serviceIdForApiBase } from '../../../src/main/selfHostedProfile';

const SAAS_ORIGIN = 'https://api.concordvoice.chat';
const X = 'https://chat.example.org';
const deps = { isValidatedSelfHostedApiBase: (o: string) => o === X };

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isFile()) {
      out[d.name] = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(dir, d.name)))
        .digest('hex');
    }
  }
  return out;
}

const origins = (r: { entries: { origin: string }[] }) => r.entries.map((e) => e.origin);

describe('connection migration (P0/P1)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'connmig-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeMeta = () =>
    fs.writeFileSync(path.join(root, 'token-meta.json'), JSON.stringify({ apiBase: SAAS_ORIGIN }));
  const writePointer = (body: string) =>
    fs.writeFileSync(path.join(root, 'active-profile.json'), body);

  function run(): { entries: ReturnType<typeof deriveInitialConnections>; derived: boolean } {
    const before = snapshot(root);
    const result = runConnectionMigration(root, deps);
    const after = snapshot(root);
    for (const [name, hash] of Object.entries(before)) expect(after[name]).toBe(hash);
    return result;
  }

  it('fresh tree -> [saas], derived, file written with version 1', async () => {
    const r = run();
    expect(origins(r)).toEqual([SAAS_ORIGIN]);
    expect(r.entries[0].serviceId).toBe('saas');
    expect(r.entries[0].lastForegroundAt).toBeNull();
    expect(r.derived).toBe(true);
    await vi.waitFor(() => expect(fs.existsSync(connectionsFilePath(root))).toBe(true));
    const raw = JSON.parse(fs.readFileSync(connectionsFilePath(root), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.connections).toHaveLength(1);
  });

  it('root token-meta.json only (Remember-Me) -> [saas]', () => {
    writeMeta();
    expect(origins(run())).toEqual([SAAS_ORIGIN]);
  });

  it('active-profile.json -> approved X, no root meta -> [X]', () => {
    writePointer(JSON.stringify({ apiBase: X }));
    const r = run();
    expect(origins(r)).toEqual([X]);
    expect(r.entries[0].serviceId).toBe(serviceIdForApiBase(X));
  });

  it('both -> [X, saas]', () => {
    writeMeta();
    writePointer(JSON.stringify({ apiBase: X }));
    expect(origins(run())).toEqual([X, SAAS_ORIGIN]);
  });

  it('corrupt active-profile.json -> [saas], no throw', () => {
    writePointer('{{{ not json');
    expect(origins(run())).toEqual([SAAS_ORIGIN]);
  });

  it('active-profile.json naming an unapproved origin -> [saas] (dropped)', () => {
    writePointer(JSON.stringify({ apiBase: 'https://evil.example.net' }));
    expect(origins(run())).toEqual([SAAS_ORIGIN]);
  });

  it('canonicalises the pointer origin via URL.origin', () => {
    writePointer(JSON.stringify({ apiBase: `${X}/some/path` }));
    expect(origins(run())).toEqual([X]);
  });

  it('file already present -> P0 skipped, contents returned after validation', () => {
    const good = {
      serviceId: serviceIdForApiBase(X),
      origin: X,
      addedAt: '2026-11-01T00:00:00.000Z',
      lastForegroundAt: '2026-11-02T00:00:00.000Z',
    };
    const bad = { ...good, origin: 'https://evil.example.net' };
    fs.writeFileSync(
      connectionsFilePath(root),
      JSON.stringify({ version: 1, connections: [good, bad] })
    );
    writeMeta(); // would derive saas if P0 ran
    const r = run();
    expect(r.derived).toBe(false);
    expect(r.entries).toEqual([good]);
  });

  it('write failure (read-only dir) -> returns derived entries, warns, no throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.chmodSync(root, 0o500);
    const r = runConnectionMigration(root, deps);
    expect(origins(r)).toEqual([SAAS_ORIGIN]);
    expect(r.derived).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it('lastForegroundAt never feeds derivation: deriveInitialConnections ignores a present file', () => {
    fs.writeFileSync(
      connectionsFilePath(root),
      JSON.stringify({
        version: 1,
        connections: [
          {
            serviceId: serviceIdForApiBase(X),
            origin: X,
            addedAt: '2026-11-01T00:00:00.000Z',
            lastForegroundAt: '2030-01-01T00:00:00.000Z',
          },
        ],
      })
    );
    const entries = deriveInitialConnections(root, deps);
    expect(entries.map((e) => e.origin)).toEqual([SAAS_ORIGIN]);
    expect(entries.every((e) => e.lastForegroundAt === null)).toBe(true);
  });
});
