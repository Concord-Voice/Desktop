/**
 * Playwright runtime resolution test for the 19 CSS design tokens added in #1033.
 *
 * Why Playwright (not Vitest+jsdom): jsdom returns empty string for
 * getComputedStyle().getPropertyValue('--token-name') regardless of declarations —
 * a known limitation. Real Chromium via Playwright is the only place this assertion
 * is meaningful. The complementary Vitest file-parse test (design-tokens.test.ts)
 * catches typos in source CSS; this test catches runtime cascade failures.
 *
 * Stratified sample: 5 visually-distinct schemes (concord = brand baseline,
 * hacker = high-contrast monospace, spooky = warm orange, midnightsky = cool
 * deep blue, defacto = neutral graphite) × 2 modes = 10 combinations per spec
 * §6.3. Schema symmetry guarantees the other 9 schemes resolve identically; the
 * file-parse test covers them.
 *
 * The test navigates to '/' which renders the login/connection page — no auth
 * required, but styles/index.css is loaded as part of the React bundle.
 *
 * References: spec §4.6 + §6.3 at
 *   internal-reference
 * Issues: #1033 (design-token taxonomy), #795 (lock badge removal), #201 (E2EE epic)
 */

import { test, expect } from '@playwright/test';

const STRATIFIED_SAMPLE = [
  { scheme: 'concord', theme: null as string | null, label: 'concord-dark' },
  { scheme: 'concord', theme: 'light', label: 'concord-light' },
  { scheme: 'hacker', theme: null, label: 'hacker-dark' },
  { scheme: 'hacker', theme: 'light', label: 'hacker-light' },
  { scheme: 'spooky', theme: null, label: 'spooky-dark' },
  { scheme: 'spooky', theme: 'light', label: 'spooky-light' },
  { scheme: 'midnightsky', theme: null, label: 'midnightsky-dark' },
  { scheme: 'midnightsky', theme: 'light', label: 'midnightsky-light' },
  { scheme: 'defacto', theme: null, label: 'defacto-dark' },
  { scheme: 'defacto', theme: 'light', label: 'defacto-light' },
] as const;

const ALL_19_TOKENS = [
  // State (3)
  '--state-selected',
  '--state-focused',
  '--state-hover',
  // Typography (4)
  '--font-display-stack',
  '--font-body-stack',
  '--font-display-tracking',
  '--font-display-tracking-tight',
  // Scale (3)
  '--radius-base',
  '--radius-elevated',
  '--radius-modal',
  // Motion (5)
  '--motion-duration-fast',
  '--motion-duration-base',
  '--motion-duration-slow',
  '--motion-curve-base',
  '--motion-curve-decel',
  // Link (3)
  '--link-color',
  '--link-color-hover',
  '--link-color-visited',
  // Encryption (1)
  '--state-encryption-pending',
] as const;

for (const combo of STRATIFIED_SAMPLE) {
  test(
    `all 19 design tokens resolve in ${combo.label}`,
    { tag: '@renderer-only' },
    async ({ page }) => {
      // Navigate to the login page — no auth required; styles/index.css is loaded
      // as part of the React entry bundle.
      await page.goto('/');

      // Apply the stratified scheme/theme combination to the document root.
      // data-scheme selects the color scheme; data-theme selects dark/light mode.
      // Omitting data-theme keeps the scheme in its default (dark) mode.
      await page.evaluate(
        ({ scheme, theme }) => {
          document.documentElement.setAttribute('data-scheme', scheme);
          if (theme !== null) {
            document.documentElement.setAttribute('data-theme', theme);
          } else {
            document.documentElement.removeAttribute('data-theme');
          }
        },
        { scheme: combo.scheme, theme: combo.theme }
      );

      // Resolve every token and assert non-empty. An empty string indicates the
      // token is undeclared in the active cascade block — a schema-symmetry failure.
      for (const token of ALL_19_TOKENS) {
        const value = await page.evaluate(
          (tok) => getComputedStyle(document.documentElement).getPropertyValue(tok).trim(),
          token
        );
        expect(value, `Token ${token} must resolve in theme ${combo.label}`).not.toBe('');
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Per-scheme cascade override verification
// ---------------------------------------------------------------------------

/**
 * Catches the case where a future edit removes a `--link-color: var(--accent-primary)`
 * declaration from a scheme block — the cascade would silently fall back to :root
 * and the per-token non-emptiness test (above) would still pass. By asserting that
 * two schemes resolve --link-color to *different* values (via their per-scheme
 * --accent-primary), we prove each scheme block's per-token override is actually
 * winning the cascade.
 */
test(
  'per-scheme overrides win the cascade for var()-bound tokens',
  { tag: '@renderer-only' },
  async ({ page }) => {
    await page.goto('/');

    async function resolveToken(scheme: string, token: string): Promise<string> {
      await page.evaluate((s) => {
        document.documentElement.setAttribute('data-scheme', s);
        document.documentElement.removeAttribute('data-theme');
      }, scheme);
      return page.evaluate(
        (t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(),
        token
      );
    }

    // --link-color binds to var(--accent-primary), which is per-scheme distinct.
    // concord's --accent-primary is pink/brand; hacker's is green/monospace. They
    // MUST differ — if not, one scheme's override was lost from the cascade.
    const concordLink = await resolveToken('concord', '--link-color');
    const hackerLink = await resolveToken('hacker', '--link-color');
    expect(concordLink, 'concord --link-color must resolve').not.toBe('');
    expect(hackerLink, 'hacker --link-color must resolve').not.toBe('');
    expect(concordLink).not.toBe(hackerLink);
  }
);

// ---------------------------------------------------------------------------
// --state-encryption-pending direct value assertion
// ---------------------------------------------------------------------------

/**
 * Catches the case where the sole consumer of the new --state-encryption-pending
 * token (Message.css:175 — the .decrypt-failed.pending-keys color migration)
 * silently breaks via a token value change. The token is set to #faa61a literal
 * across all 26 blocks (per spec §5 + verified by file-parse test). Without this
 * runtime value assertion, a typo or scope-creep edit in the token's value would
 * not be caught by the per-token non-emptiness test.
 */
test(
  '--state-encryption-pending resolves to #faa61a (the sole-consumer color)',
  { tag: '@renderer-only' },
  async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-scheme', 'concord');
      document.documentElement.removeAttribute('data-theme');
    });

    // CSS custom property values returned by getPropertyValue are the raw
    // declaration text — '#faa61a' verbatim, not the normalized rgb() form.
    // (Normalization only happens when the value is consumed as a property.)
    const value = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--state-encryption-pending')
        .trim()
    );

    expect(value).toBe('#faa61a');
  }
);
