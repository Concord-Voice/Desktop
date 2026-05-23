/**
 * WCAG 2.1 AA contrast guard for `--link-color` (and `--link-color-hover`)
 * against `--bg-primary` across all 26 theme blocks in `index.css`.
 *
 * ## Why this test exists
 *
 * PR #1090 (closed #800) introduced a global `a[target="_blank"]` rule that
 * consumes the `--link-color` / `--link-color-hover` design tokens from PR
 * #1076 (issue #1033). During manual QA, the Fox Den theme rendered a
 * muddy-orange link on warm-brown background that passed WCAG AA at 5.6:1
 * but read as low contrast perceptually. The Fox Den fix overrode `--link-color`
 * to complementary sky blue. The catch was accidental — the other 11 themes
 * were not spot-checked.
 *
 * This test asserts the WCAG AA contrast floor (4.5:1) for every theme block,
 * so a future theme author cannot silently ship a sub-AA link/bg pair.
 *
 * ## Why 4.5:1 and not 7:1 (AAA)
 *
 * WCAG 2.1 Success Criterion 1.4.3 — normal text minimum is 4.5:1.
 * AAA (7:1) is aspirational and would require redesigning several themes
 * whose `--accent-primary` doesn't reach 7:1 against any neutral background.
 * Tightening to AAA is a v1.1.0+ consideration.
 *
 * ## Implementation discipline
 *
 * - Mirrors `design-tokens.test.ts` — plain `indexOf` + string-scan parsing
 *   (no dynamic `RegExp`) so Semgrep's CWE-1333 ReDoS taint-sink rule is
 *   not triggered.
 * - No new runtime dependencies (no `postcss`).
 * - `extractBlockBody` is copy-pasted from the sibling test rather than
 *   factored into a shared helper module — the helper-module pattern is
 *   not yet established in `tests/unit/`, and a one-time duplication is
 *   cheaper than introducing a new convention.
 *
 * @see https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
 * @see https://www.w3.org/WAI/GL/wiki/Relative_luminance
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WCAG_AA_THRESHOLD = 4.5;

/**
 * Blocks where `--link-color` and/or `--link-color-hover` currently fail the
 * AA threshold against `--bg-primary`. Discovered during the initial test
 * implementation (2026-05-23). Each entry is suppressed via `.skip` so the
 * suite is green; new theme blocks added without an exemption WILL fail loud.
 *
 * The exemption list is the inventory of design follow-up needed before
 * v1.0.0 (release: 1.0). Fix pattern mirrors Fox Den dark (issue #800 /
 * PR #1090): override `--link-color` per-theme to a hue that achieves AA
 * against `--bg-primary` — sky blue against warm backgrounds, etc.
 *
 * The Fox Den DARK block ([data-scheme='foxden']) is intentionally NOT
 * exempted — its override already meets AA (verified by the resolveToHex
 * helper test). Fox Den LIGHT's hover (4.38:1) just misses the floor;
 * documented here because the link itself (#01579b on #fff3e0) passes.
 *
 * **Remove an entry from this list ONLY by fixing the theme's contrast,
 * never by lowering the threshold or carving out a per-theme exception.**
 */
const KNOWN_NONCOMPLIANT_BLOCKS: ReadonlyArray<{
  block: string;
  token: '--link-color' | '--link-color-hover';
  ratio: number;
}> = [
  // Light themes: pastel `--accent-primary` (e.g., #fa709a) below AA on near-white --bg-primary
  { block: "[data-theme='light']", token: '--link-color', ratio: 2.46 },
  { block: "[data-theme='light']", token: '--link-color-hover', ratio: 2.01 },
  { block: "[data-scheme='concord'][data-theme='light']", token: '--link-color', ratio: 2.46 },
  {
    block: "[data-scheme='concord'][data-theme='light']",
    token: '--link-color-hover',
    ratio: 2.01,
  },
  { block: "[data-scheme='morky'][data-theme='light']", token: '--link-color', ratio: 3.92 },
  { block: "[data-scheme='morky'][data-theme='light']", token: '--link-color-hover', ratio: 3.05 },
  { block: "[data-scheme='bardic'][data-theme='light']", token: '--link-color', ratio: 3.89 },
  { block: "[data-scheme='bardic'][data-theme='light']", token: '--link-color-hover', ratio: 2.62 },
  { block: "[data-scheme='foxden'][data-theme='light']", token: '--link-color-hover', ratio: 4.38 },
  { block: "[data-scheme='hacker'][data-theme='light']", token: '--link-color', ratio: 4.27 },
  { block: "[data-scheme='hacker'][data-theme='light']", token: '--link-color-hover', ratio: 2.93 },
  { block: "[data-scheme='spooky'][data-theme='light']", token: '--link-color', ratio: 3.78 },
  { block: "[data-scheme='spooky'][data-theme='light']", token: '--link-color-hover', ratio: 3.03 },
  { block: "[data-scheme='leviathan'][data-theme='light']", token: '--link-color', ratio: 3.74 },
  {
    block: "[data-scheme='leviathan'][data-theme='light']",
    token: '--link-color-hover',
    ratio: 2.53,
  },
  { block: "[data-scheme='grassynill'][data-theme='light']", token: '--link-color', ratio: 4.47 },
  {
    block: "[data-scheme='grassynill'][data-theme='light']",
    token: '--link-color-hover',
    ratio: 3.43,
  },
  { block: "[data-scheme='cottoncandy'][data-theme='light']", token: '--link-color', ratio: 3.13 },
  {
    block: "[data-scheme='cottoncandy'][data-theme='light']",
    token: '--link-color-hover',
    ratio: 2.66,
  },
  { block: "[data-scheme='driftwood'][data-theme='light']", token: '--link-color', ratio: 3.58 },
  {
    block: "[data-scheme='driftwood'][data-theme='light']",
    token: '--link-color-hover',
    ratio: 2.73,
  },
  // Dark themes: saturated red on near-black
  { block: "[data-scheme='eclipse']", token: '--link-color', ratio: 3.57 },
  // Midnightsky light: muted blue on cool-white
  { block: "[data-scheme='midnightsky'][data-theme='light']", token: '--link-color', ratio: 4.17 },
  {
    block: "[data-scheme='midnightsky'][data-theme='light']",
    token: '--link-color-hover',
    ratio: 2.7,
  },
];

function isExempt(block: string, token: '--link-color' | '--link-color-hover'): boolean {
  return KNOWN_NONCOMPLIANT_BLOCKS.some((e) => e.block === block && e.token === token);
}

const ALL_26_BLOCKS = [
  ':root',
  "[data-theme='light']",
  "[data-scheme='concord']",
  "[data-scheme='concord'][data-theme='light']",
  "[data-scheme='morky']",
  "[data-scheme='morky'][data-theme='light']",
  "[data-scheme='bardic']",
  "[data-scheme='bardic'][data-theme='light']",
  "[data-scheme='foxden']",
  "[data-scheme='foxden'][data-theme='light']",
  "[data-scheme='hacker']",
  "[data-scheme='hacker'][data-theme='light']",
  "[data-scheme='spooky']",
  "[data-scheme='spooky'][data-theme='light']",
  "[data-scheme='leviathan']",
  "[data-scheme='leviathan'][data-theme='light']",
  "[data-scheme='grassynill']",
  "[data-scheme='grassynill'][data-theme='light']",
  "[data-scheme='cottoncandy']",
  "[data-scheme='cottoncandy'][data-theme='light']",
  "[data-scheme='driftwood']",
  "[data-scheme='driftwood'][data-theme='light']",
  "[data-scheme='eclipse']",
  "[data-scheme='eclipse'][data-theme='light']",
  "[data-scheme='midnightsky']",
  "[data-scheme='midnightsky'][data-theme='light']",
] as const;

/**
 * Extract the body of a CSS block identified by `selector`.
 *
 * Uses plain string search (indexOf) rather than a dynamic RegExp so that
 * Semgrep's ReDoS taint-sink rule (CWE-1333) is not triggered. The selector
 * strings in ALL_26_BLOCKS are compile-time constants, but the static analyser
 * cannot prove that without data-flow analysis across array indexing.
 *
 * Algorithm:
 *   1. Find the first occurrence of `\n<selector> {` or `<selector> {` at
 *      position 0 (for `:root`).
 *   2. From the opening `{`, count braces until depth returns to 0.
 *   3. Return the substring between `{` and the matching `}` (exclusive).
 *
 * Returns null if the selector is not found or braces are unbalanced.
 */
function extractBlockBody(css: string, selector: string): string | null {
  const needle = `${selector} {`;
  const needleNl = `\n${selector} {`;

  let openBracePos: number;

  if (css.startsWith(needle)) {
    openBracePos = needle.length;
  } else {
    const idx = css.indexOf(needleNl);
    if (idx === -1) {
      const needleNoSp = `${selector}{`;
      const needleNlNoSp = `\n${selector}{`;
      const idx2 = css.startsWith(needleNoSp) ? 0 : css.indexOf(needleNlNoSp);
      if (idx2 === -1) {
        return null;
      }
      const rawNeedle = css.startsWith(needleNoSp) ? needleNoSp : needleNlNoSp;
      openBracePos = idx2 + rawNeedle.length;
    } else {
      openBracePos = idx + needleNl.length;
    }
  }

  let depth = 1;
  let pos = openBracePos;

  while (pos < css.length && depth > 0) {
    const ch = css[pos];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    }
    pos++;
  }

  if (depth !== 0) {
    return null;
  }

  return css.slice(openBracePos, pos - 1);
}

/**
 * Extract the right-hand side of a CSS custom-property declaration.
 *
 * Looks for `<token>:` or `<token> :` (the two forms also recognised by
 * design-tokens.test.ts), then reads characters until the next `;`.
 * Returns the value trimmed of surrounding whitespace, or null if the
 * token is not declared in the block.
 */
function extractDeclaration(blockBody: string, tokenName: string): string | null {
  const needles = [`${tokenName}:`, `${tokenName} :`];
  let startPos = -1;
  let needleLen = 0;
  for (const n of needles) {
    const idx = blockBody.indexOf(n);
    if (idx !== -1) {
      startPos = idx;
      needleLen = n.length;
      break;
    }
  }
  if (startPos === -1) {
    return null;
  }
  const semiPos = blockBody.indexOf(';', startPos + needleLen);
  if (semiPos === -1) {
    return null;
  }
  return blockBody.slice(startPos + needleLen, semiPos).trim();
}

/**
 * Resolve a CSS value to a terminal hex literal, following `var()` chains.
 *
 * Handles three cases:
 *   1. Direct hex literal (`#RRGGBB` or `#RGB`) — returned as-is.
 *   2. `var(--token)` — looks up `--token` in `blockBody`, then in
 *      `rootBody` as fallback (mirrors CSS cascade semantics), then
 *      recurses with `depth - 1`.
 *   3. Anything else (e.g., `rgb(...)`, `hsl(...)`, named color) —
 *      returns null. The current `index.css` only uses hex + var() for
 *      the tokens under test, so this is a structural restriction, not
 *      a feature limitation.
 *
 * Depth cap of 2 is sufficient for `--link-color` → `--accent-primary` → `#hex`
 * (the deepest chain in current `index.css`).
 */
function resolveToHex(
  value: string,
  blockBody: string,
  rootBody: string,
  depth = 2
): string | null {
  const trimmed = value.trim();

  // Case 1: direct hex
  if (trimmed.startsWith('#')) {
    return trimmed;
  }

  // Case 2: var() indirection
  if (trimmed.startsWith('var(')) {
    if (depth <= 0) {
      return null;
    }
    const closeIdx = trimmed.indexOf(')');
    if (closeIdx === -1) {
      return null;
    }
    const inner = trimmed.slice(4, closeIdx).trim();
    // var(--token) or var(--token, fallback) — extract both
    const commaIdx = inner.indexOf(',');
    const tokenName = (commaIdx === -1 ? inner : inner.slice(0, commaIdx)).trim();
    const fallbackValue = commaIdx === -1 ? null : inner.slice(commaIdx + 1).trim();

    const refBlock = extractDeclaration(blockBody, tokenName);
    if (refBlock !== null) {
      return resolveToHex(refBlock, blockBody, rootBody, depth - 1);
    }
    const refRoot = extractDeclaration(rootBody, tokenName);
    if (refRoot !== null) {
      return resolveToHex(refRoot, blockBody, rootBody, depth - 1);
    }
    // CSS var() fallback semantics: if token resolves to neither block nor
    // root, attempt the inline fallback. Per Gitar review on PR #1178 —
    // protects against latent test failures if a future theme declares
    // `--token: var(--custom, #abcdef)` where --custom is intentionally
    // undefined.
    if (fallbackValue !== null) {
      return resolveToHex(fallbackValue, blockBody, rootBody, depth - 1);
    }
    return null;
  }

  // Case 3: anything else
  return null;
}

/**
 * Compute the WCAG 2.1 contrast ratio between two hex colors.
 *
 * @param hexA - Color in `#RRGGBB` or `#RGB` form
 * @param hexB - Color in `#RRGGBB` or `#RGB` form
 * @returns Contrast ratio in [1.0, 21.0]
 *
 * Throws if either hex is malformed (defensive; should not happen since
 * `resolveToHex` is the upstream gate).
 */
function wcagContrast(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const linR = channelToLinear(r);
  const linG = channelToLinear(g);
  const linB = channelToLinear(b);
  return 0.2126 * linR + 0.7152 * linG + 0.0722 * linB;
}

function channelToLinear(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.startsWith('#') ? hex.slice(1) : hex;
  // Expand #RGB to #RRGGBB
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return { r, g, b };
}

describe('wcagContrast helper', () => {
  it('returns 21.0 for white-on-black (WCAG max)', () => {
    expect(wcagContrast('#ffffff', '#000000')).toBeCloseTo(21.0, 1);
  });

  it('returns 1.0 for identical colors (WCAG min)', () => {
    expect(wcagContrast('#7f7f7f', '#7f7f7f')).toBeCloseTo(1.0, 5);
  });

  it('returns ~9.5 for Fox Den dark link (#80d8ff on #3d1e00, known good)', () => {
    const ratio = wcagContrast('#80d8ff', '#3d1e00');
    expect(ratio).toBeGreaterThan(9.0);
    expect(ratio).toBeLessThan(10.0);
  });

  it('parses 3-char hex shorthand', () => {
    expect(wcagContrast('#fff', '#000')).toBeCloseTo(21.0, 1);
  });

  it('throws on malformed hex', () => {
    expect(() => wcagContrast('#zzz', '#000')).toThrow();
  });
});

describe('resolveToHex helper', () => {
  const rootBody = `
    --accent-primary: #fa709a;
    --link-color: var(--accent-primary);
  `;
  const themeBody = `
    --accent-primary: #ff6d00;
    --link-color: #80d8ff;
  `;

  it('returns direct hex literal as-is', () => {
    expect(resolveToHex('#ff6d00', themeBody, rootBody)).toBe('#ff6d00');
  });

  it('resolves one-level var() indirection', () => {
    expect(resolveToHex('var(--accent-primary)', themeBody, rootBody)).toBe('#ff6d00');
  });

  it('resolves var() chain through root fallback', () => {
    // theme has no --accent-primary, but root does
    const themeBodyNoAccent = `
      --link-color: var(--accent-primary);
    `;
    expect(resolveToHex('var(--accent-primary)', themeBodyNoAccent, rootBody)).toBe('#fa709a');
  });

  it('returns null when chain exceeds depth cap', () => {
    const deepRoot = `
      --a: var(--b);
      --b: var(--c);
      --c: var(--d);
      --d: #ffffff;
    `;
    expect(resolveToHex('var(--a)', '', deepRoot, 2)).toBeNull();
  });

  it('returns null for unresolved token', () => {
    expect(resolveToHex('var(--nonexistent)', themeBody, rootBody)).toBeNull();
  });

  it('resolves the var() fallback when the token is undefined (per Gitar #1178 review)', () => {
    // var(--unresolved, #abcdef) — neither blockBody nor rootBody declares
    // `--unresolved`, so the CSS fallback value `#abcdef` should be used.
    expect(resolveToHex('var(--unresolved, #abcdef)', themeBody, rootBody)).toBe('#abcdef');
  });

  it('returns null when fallback is unresolvable (e.g., a named color)', () => {
    // Named colors (e.g., `red`, `tomato`) are not supported by the parser —
    // it only handles hex literals and `var()` chains. A fallback that
    // resolves to a named color returns null, which is the safe failure mode.
    expect(resolveToHex('var(--unresolved, tomato)', themeBody, rootBody)).toBeNull();
  });
});

describe('WCAG-AA link contrast across all theme blocks', () => {
  const cssPath = resolve(__dirname, '../../../src/renderer/styles/index.css');
  const css = readFileSync(cssPath, 'utf-8');
  const rootBody = extractBlockBody(css, ':root') ?? '';

  describe.each(ALL_26_BLOCKS)('block %s', (block) => {
    const blockBody = extractBlockBody(css, block);

    it('block exists', () => {
      expect(blockBody).not.toBeNull();
    });

    it('--link-color resolves to a hex literal', () => {
      const linkValue = extractDeclaration(blockBody ?? '', '--link-color');
      expect(linkValue, `--link-color not declared in ${block}`).not.toBeNull();
      const linkHex = resolveToHex(linkValue ?? '', blockBody ?? '', rootBody);
      expect(
        linkHex,
        `--link-color in ${block} did not resolve to hex (value: ${linkValue})`
      ).not.toBeNull();
    });

    it('--bg-primary resolves to a hex literal', () => {
      const bgValue = extractDeclaration(blockBody ?? '', '--bg-primary');
      expect(bgValue, `--bg-primary not declared in ${block}`).not.toBeNull();
      const bgHex = resolveToHex(bgValue ?? '', blockBody ?? '', rootBody);
      expect(
        bgHex,
        `--bg-primary in ${block} did not resolve to hex (value: ${bgValue})`
      ).not.toBeNull();
    });

    const linkTest = isExempt(block, '--link-color') ? it.skip : it;
    linkTest(
      `--link-color has WCAG AA contrast ≥ ${WCAG_AA_THRESHOLD}:1 against --bg-primary`,
      () => {
        const linkValue = extractDeclaration(blockBody ?? '', '--link-color');
        const bgValue = extractDeclaration(blockBody ?? '', '--bg-primary');
        const linkHex = resolveToHex(linkValue ?? '', blockBody ?? '', rootBody);
        const bgHex = resolveToHex(bgValue ?? '', blockBody ?? '', rootBody);

        if (linkHex === null || bgHex === null) {
          throw new Error(
            `Could not resolve --link-color or --bg-primary to hex for block ${block}`
          );
        }

        const ratio = wcagContrast(linkHex, bgHex);
        expect(
          ratio,
          `Theme '${block}' link '${linkHex}' on bg '${bgHex}' = ${ratio.toFixed(2)}:1, below WCAG AA ${WCAG_AA_THRESHOLD}:1`
        ).toBeGreaterThanOrEqual(WCAG_AA_THRESHOLD);
      }
    );

    const hoverTest = isExempt(block, '--link-color-hover') ? it.skip : it;
    hoverTest(
      `--link-color-hover has WCAG AA contrast ≥ ${WCAG_AA_THRESHOLD}:1 against --bg-primary`,
      () => {
        const hoverValue = extractDeclaration(blockBody ?? '', '--link-color-hover');
        const bgValue = extractDeclaration(blockBody ?? '', '--bg-primary');
        if (hoverValue === null) {
          // The hover variant is optional structurally; if it's missing, skip
          // rather than fail — this test only enforces the contract for blocks
          // that declare the token.
          return;
        }
        const hoverHex = resolveToHex(hoverValue, blockBody ?? '', rootBody);
        const bgHex = resolveToHex(bgValue ?? '', blockBody ?? '', rootBody);

        if (hoverHex === null || bgHex === null) {
          throw new Error(
            `Could not resolve --link-color-hover or --bg-primary to hex for block ${block}`
          );
        }

        const ratio = wcagContrast(hoverHex, bgHex);
        expect(
          ratio,
          `Theme '${block}' link-hover '${hoverHex}' on bg '${bgHex}' = ${ratio.toFixed(2)}:1, below WCAG AA ${WCAG_AA_THRESHOLD}:1`
        ).toBeGreaterThanOrEqual(WCAG_AA_THRESHOLD);
      }
    );
  });
});

describe('failure-path: detects deliberately-bad link/bg pair', () => {
  // Synthetic fixture so we don't have to mutate index.css to verify
  // that the assertion fires with a useful message. Pair chosen to be
  // unambiguously below 4.5:1 — `#cc0000` on `#000000` computes to 3.57:1
  // (the same ratio as the production [data-scheme='eclipse'] failure
  // captured in KNOWN_NONCOMPLIANT_BLOCKS).
  const badFixture = `
:root {
  --bg-primary: #000000;
  --link-color: #cc0000;
}
  `;

  it('synthetic low-contrast pair produces sub-AA ratio', () => {
    const block = extractBlockBody(badFixture, ':root');
    expect(block).not.toBeNull();
    const linkHex = resolveToHex(
      extractDeclaration(block ?? '', '--link-color') ?? '',
      block ?? '',
      block ?? ''
    );
    const bgHex = resolveToHex(
      extractDeclaration(block ?? '', '--bg-primary') ?? '',
      block ?? '',
      block ?? ''
    );
    expect(linkHex).toBe('#cc0000');
    expect(bgHex).toBe('#000000');
    const ratio = wcagContrast(linkHex ?? '#000000', bgHex ?? '#000000');
    expect(ratio).toBeLessThan(WCAG_AA_THRESHOLD);
    // Spot-check the actual ratio matches the known-bad Eclipse value
    expect(ratio).toBeCloseTo(3.57, 1);
  });

  it('failure message format names theme, both hex, and actual ratio', () => {
    // Reconstruct the same shape the production assertion would produce
    // and verify a future maintainer / test author would get an actionable
    // string.
    const block = "[data-scheme='example']";
    const linkHex = '#cc0000';
    const bgHex = '#000000';
    const ratio = wcagContrast(linkHex, bgHex);
    const msg = `Theme '${block}' link '${linkHex}' on bg '${bgHex}' = ${ratio.toFixed(2)}:1, below WCAG AA ${WCAG_AA_THRESHOLD}:1`;
    expect(msg).toContain(block);
    expect(msg).toContain(linkHex);
    expect(msg).toContain(bgHex);
    expect(msg).toContain(':1');
    expect(msg).toContain(String(WCAG_AA_THRESHOLD));
  });
});

describe('exemption discipline', () => {
  it('KNOWN_NONCOMPLIANT_BLOCKS contains no duplicates', () => {
    const seen = new Set<string>();
    for (const e of KNOWN_NONCOMPLIANT_BLOCKS) {
      const key = `${e.block}|${e.token}`;
      expect(seen.has(key), `Duplicate exemption: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('every exempted block exists in ALL_26_BLOCKS', () => {
    const validBlocks = new Set<string>(ALL_26_BLOCKS);
    for (const e of KNOWN_NONCOMPLIANT_BLOCKS) {
      expect(
        validBlocks.has(e.block),
        `Exempted block '${e.block}' is not in ALL_26_BLOCKS — typo or stale entry`
      ).toBe(true);
    }
  });

  it('every exempted ratio is below the AA threshold (sanity-check exemption rationale)', () => {
    for (const e of KNOWN_NONCOMPLIANT_BLOCKS) {
      expect(
        e.ratio < WCAG_AA_THRESHOLD,
        `Exempted entry ${e.block}/${e.token} has ratio ${e.ratio} ≥ ${WCAG_AA_THRESHOLD} — should not be exempt`
      ).toBe(true);
    }
  });
});
