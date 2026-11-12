// @vitest-environment node
// Classification audit (plan Task 7A step 2): every channel passed to registerIpc is
// classified, every classified channel is registered, and no raw ipcMain registration
// survives outside the registry.
//
// EXPECTED TO STAY RED after 7A: the 77 existing handlers still call ipcMain directly
// until Task 7B migrates them. 7B's commit turns this green.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNEL_CLASSES } from '../../../../src/main/ipc/channelClassification';

const ROOT = path.resolve(__dirname, '../../../..');
const MAIN = path.join(ROOT, 'src/main');
const SHARED = path.join(ROOT, 'src/shared');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const constants = new Map<string, string>();
for (const f of [path.join(MAIN, 'ipcContract.ts'), ...tsFiles(SHARED)]) {
  const src = stripComments(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/export const (\w+)\s*(?::[^=]+)?=\s*(['"`])([^'"`$]+)\2/g)) {
    constants.set(m[1]!, m[3]!);
  }
}

const mainFiles = tsFiles(MAIN);
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
const REGISTRY = 'src/main/ipc/registry.ts';
const CONNECTION = 'src/main/ipc/connection.ts';
/** `connection:whoAmI` is a synchronous `ipcMain.on` + returnValue, so it never goes through registerIpc. */
const WHO_AM_I = 'connection:whoAmI';

describe('IPC channel classification audit', () => {
  it('registerIpc call sites and CHANNEL_CLASSES name exactly the same channels', () => {
    const registered = new Set<string>();
    const unresolved: string[] = [];
    for (const f of mainFiles) {
      if (rel(f) === REGISTRY) continue;
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/\bregisterIpc\(\s*(?:(['"`])([^'"`]+)\1|([A-Za-z_]\w*))/g)) {
        const literal = m[2];
        const id = m[3];
        const channel = literal ?? (id ? constants.get(id) : undefined);
        if (channel === undefined) unresolved.push(`${rel(f)}: ${id}`);
        else registered.add(channel);
      }
    }
    expect(unresolved).toEqual([]);
    const classified = new Set(Object.keys(CHANNEL_CLASSES).filter((c) => c !== WHO_AM_I));
    expect([...registered].filter((c) => !classified.has(c)).sort()).toEqual([]);
    expect([...classified].filter((c) => !registered.has(c)).sort()).toEqual([]);
  });

  it('has no raw ipcMain.handle/on/once/handleOnce outside the registry', () => {
    const offenders: string[] = [];
    for (const f of mainFiles) {
      const r = rel(f);
      if (r === REGISTRY) continue;
      const src = stripComments(readFileSync(f, 'utf8'));
      const hits = [
        ...src.matchAll(/\bipcMain\.(handle|on|once|handleOnce)\(\s*(['"`])([^'"`]+)\2/g),
      ];
      for (const h of hits) {
        if (r === CONNECTION && h[3] === WHO_AM_I) continue;
        offenders.push(`${r}: ${h[3]}`);
      }
      // Non-literal first arguments are raw registrations too.
      const any = [...src.matchAll(/\bipcMain\.(handle|on|once|handleOnce)\(/g)].length;
      if (any > hits.length) offenders.push(`${r}: non-literal ipcMain registration`);
    }
    expect(offenders).toEqual([]);
  });

  it('classifies the #87 capture lease invokes connection-bound (contract v35)', () => {
    // A primary may release from the background and a holder may re-acquire there; the
    // foreground-only rule for a FRESH acquire is the lease's (captureLease.ts), not the
    // admission's, so the rows are connection-bound rather than app-global-mutate.
    expect(CHANNEL_CLASSES['capture:acquire']).toBe('connection-bound');
    expect(CHANNEL_CLASSES['capture:release']).toBe('connection-bound');
  });
});
