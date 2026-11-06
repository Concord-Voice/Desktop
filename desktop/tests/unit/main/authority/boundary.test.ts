// The authority module runs in the main process only (it decides account-key
// trust; the renderer is hot-updated). No code that ships to the renderer or
// the preload may reach it, directly or through another module. ESLint's
// no-restricted-imports catches the direct import as it is typed; this test
// resolves every static import transitively from the renderer, preload,
// shared and constants trees, so an import through a shared module (for
// example the IPC contract) or an odd spelling of the path is caught too.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP = resolve(__dirname, '../../../..');
const SRC = join(DESKTOP, 'src');
const SHARED = resolve(DESKTOP, '../shared'); // the @shared alias (vite.config.ts)
const AUTHORITY = join(SRC, 'main', 'authority') + sep;
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : CODE.test(n) ? [p] : [];
  });
}

/** Every module specifier written as a string literal: import/export from, import(), require(). */
function specifiers(code: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/g;
  return [...code.matchAll(re)].map((m) => m[2]);
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('@shared/')) base = join(SHARED, spec.slice(8));
  else return null; // a package
  for (const c of ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx']) {
    const p = resolve(base + c);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return resolve(base); // unresolved: still judged by its path
}

/** Each root's import path into the authority module, if any. */
function reachesAuthority(roots: string[]): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const queue = roots.map((r) => [r]);
  while (queue.length > 0) {
    const path = queue.shift() ?? [];
    const f = path[path.length - 1];
    if (seen.has(f)) continue;
    seen.add(f);
    if (!existsSync(f) || !CODE.test(f)) continue;
    for (const spec of specifiers(readFileSync(f, 'utf8'))) {
      const to = resolveSpec(f, spec);
      if (to === null) continue;
      if (to.startsWith(AUTHORITY) || to === AUTHORITY.slice(0, -1))
        offenders.push([...path, to].map((p) => p.replace(DESKTOP, '')).join(' -> '));
      else if (to.startsWith(SRC) || to.startsWith(SHARED)) queue.push([...path, to]);
    }
  }
  return offenders;
}

const ROOTS = ['renderer', 'preload', 'shared', 'constants']
  .map((d) => join(SRC, d))
  .filter(existsSync)
  .flatMap(files);

describe('authority module boundary', () => {
  it('is not reachable from the renderer, preload, shared or constants code', () => {
    expect(ROOTS.length).toBeGreaterThan(100);
    expect(reachesAuthority(ROOTS)).toEqual([]);
  });

  it('names no authority path in that code, however it is spelled', () => {
    const named = ROOTS.filter((f) =>
      /main\/+authority|['"`]authority\//.test(readFileSync(f, 'utf8'))
    );
    expect(named).toEqual([]);
  });

  it('would catch a direct, a transitive and an oddly spelled import', () => {
    const tmp = join(SRC, 'shared');
    const probe = (spec: string): string[] =>
      specifiers(`import { x } from '${spec}';`)
        .map((s) => resolveSpec(join(tmp, 'probe.ts'), s) ?? '')
        .filter((p) => p.startsWith(AUTHORITY));
    expect(probe('../main/authority/chain')).toHaveLength(1);
    expect(probe('../main//authority/chain')).toHaveLength(1);
    expect(probe('@/main/authority/chain')).toHaveLength(1);
    expect(specifiers("await import(`../main/authority/x`); require('../x');")).toEqual([
      '../main/authority/x',
      '../x',
    ]);
    // The walker reports what a root reaches: chain.ts reaches the rest of the module.
    expect(reachesAuthority([join(AUTHORITY, 'chain.ts')]).length).toBeGreaterThan(0);
  });
});
