import { readdirSync, readFileSync } from 'node:fs';
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

// Recursively collect every .css file under `dir`.
function walkCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

// Strip /* ... */ comments so braces inside them can't confuse the rule scanner.
// Literal regex (not built from a variable) — Semgrep CWE-1333 ReDoS taint applies
// only to dynamic RegExp; `[\s\S]*?` is lazy + linear (no catastrophic backtracking).
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Yield { selector, body } per rule, recursing into at-rules (e.g. @media) so nested
// rules are reported with their own selector. Selector slices drop any leading
// at-statement (`@import ...;`) by taking the text after the last `;`.
function* cssRules(css: string): Generator<{ selector: string; body: string }> {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const raw = css.slice(i, open);
    const selector = raw.slice(raw.lastIndexOf(';') + 1).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (selector.startsWith('@')) yield* cssRules(body);
    else yield { selector, body };
    i = j;
  }
}

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

  it('every text-bearing --accent-fill surface is haloed under Pride, in the matching color group', () => {
    // Derived coverage guard (not a hardcoded list): scan the component CSS for rules
    // that paint static text on a rainbow --accent-fill background, and assert each
    // selector has a Pride legibility halo (WCAG 1.4.3) in the group matching its
    // foreground color — white text (--on-accent) → dark halo, dark text
    // (--bg-primary) → light halo. A future surface that adopts var(--accent-fill)
    // with text but no halo fails HERE, so the "regression-locked" claim is real and
    // stays in sync automatically.
    const rendererDir = resolve(stylesDir, '..');
    const componentCss = walkCssFiles(rendererDir).filter(
      (p) => !p.endsWith('index.css') && !p.endsWith('pride-flourishes.css')
    );

    const whiteText: string[] = [];
    const darkText: string[] = [];
    for (const file of componentCss) {
      for (const { selector, body } of cssRules(stripCssComments(readFileSync(file, 'utf-8')))) {
        if (!body.includes('var(--accent-fill)')) continue;
        const selectors = selector
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (body.includes('color: var(--on-accent)')) whiteText.push(...selectors);
        else if (body.includes('color: var(--bg-primary)')) darkText.push(...selectors);
      }
    }

    // Guard against a vacuous pass if the scanner ever silently finds nothing.
    expect(whiteText.length + darkText.length).toBeGreaterThanOrEqual(30);

    // Each Pride halo rule's selector list, keyed by its shadow color.
    const haloRules = [...cssRules(stripCssComments(prideCss))].filter((r) =>
      r.body.includes('text-shadow')
    );
    const darkHalo = haloRules.find((r) => r.body.includes('rgba(0, 0, 0'))?.selector ?? '';
    const lightHalo = haloRules.find((r) => r.body.includes('rgba(255, 255, 255'))?.selector ?? '';

    for (const sel of whiteText) {
      expect(
        darkHalo,
        `white-text --accent-fill surface "${sel}" is missing a Pride dark halo`
      ).toContain(sel);
    }
    for (const sel of darkText) {
      expect(
        lightHalo,
        `dark-text --accent-fill surface "${sel}" is missing a Pride light halo`
      ).toContain(sel);
    }
  });
});
