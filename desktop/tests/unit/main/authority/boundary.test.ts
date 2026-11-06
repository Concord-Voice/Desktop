// The authority module runs in the main process only (it decides account-key
// trust; the renderer is hot-updated). Nothing under src/renderer or
// src/preload may import it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe('authority module boundary', () => {
  it('is not imported by the renderer or the preload', () => {
    const offenders = ['renderer', 'preload']
      .flatMap((d) => files(join(SRC, d)))
      .filter((f) => /main\/authority/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
