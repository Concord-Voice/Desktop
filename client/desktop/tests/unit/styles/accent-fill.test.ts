import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Locks the --accent-fill button/highlight indirection shipped with the Pride scheme.
 *
 * 23 component CSS files swapped `background: var(--accent-primary)` for
 * `background: var(--accent-fill)` so Pride can recolor solid fills to the rainbow
 * gradient without per-component overrides. That swap is only safe — visually a
 * no-op for the other 14 schemes — BECAUSE --accent-fill falls back to
 * --accent-primary in :root and is overridden ONLY by Pride. These assertions are
 * the safety net for that invariant: a regression here would silently recolor every
 * theme's buttons (drop the :root default → buttons go transparent everywhere; add a
 * stray per-scheme override → that scheme's buttons diverge from accent-primary).
 */
describe('--accent-fill button/highlight indirection', () => {
  const stylesDir = resolve(__dirname, '../../../src/renderer/styles');
  const indexCss = readFileSync(resolve(stylesDir, 'index.css'), 'utf-8');
  const prideCss = readFileSync(resolve(stylesDir, 'pride-flourishes.css'), 'utf-8');

  it(':root defaults --accent-fill to --accent-primary (neutral for non-Pride schemes)', () => {
    expect(indexCss).toContain('--accent-fill: var(--accent-primary)');
  });

  it('--accent-fill is declared exactly once in index.css — only :root, no scheme block diverges', () => {
    // Literal regex (not constructed from variables) — Semgrep CWE-1333 ReDoS taint
    // applies only to dynamic RegExp construction. Matches the declaration form
    // (`--accent-fill:`), not the var(--accent-fill) usage sites.
    const declarations = indexCss.match(/--accent-fill\s*:/g) ?? [];
    expect(declarations.length).toBe(1);
  });

  it('Pride overrides --accent-fill to the rainbow brand gradient', () => {
    expect(prideCss).toContain('--accent-fill: var(--gradient-brand)');
  });

  it('the Pride override stylesheet is imported so the override actually loads', () => {
    const mainTsx = readFileSync(resolve(stylesDir, '../main.tsx'), 'utf-8');
    expect(mainTsx).toContain('pride-flourishes.css');
  });
});
