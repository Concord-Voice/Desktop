import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Asserted against the stylesheet SOURCE: Vitest runs with `css: false`, so
// computed-style checks would be vacuous (same approach as
// EmojiPicker.stylesheet.test.ts).
//
// Bug: with Settings scrolled down, clicking a picker option (Menu Bar Icon,
// GIF playback, …) focused its visually hidden radio. Those radios and their
// legends are `position: absolute` with no positioned ancestor inside the
// scroller, so they anchored to the overlay <dialog> at their un-scrolled
// position below the fold. Focusing one scrolled the `overflow: hidden` dialog,
// shifting the whole page up and leaving a blank band at the bottom.
function ruleBody(file: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const css = readFileSync(
    resolve(__dirname, '../../../../src/renderer/components/Settings', file),
    'utf-8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  // One rule only, so a later override (e.g. inside @media) cannot silently win.
  const all = css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{`, 'g')) ?? [];
  if (all.length !== 1) throw new Error(`expected exactly one ${selector} rule in ${file}`);
  const m = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`selector ${selector} not found in ${file}`);
  return m[2];
}

describe('Settings scroll containment', () => {
  it('makes the settings scroller the containing block for absolutely positioned content', () => {
    expect(ruleBody('SettingsPage.css', '.settings-page-content')).toMatch(
      /position:\s*relative\s*;/
    );
  });

  it('clips the overlay dialog instead of leaving it programmatically scrollable', () => {
    const body = ruleBody('SettingsOverlayHost.css', '.settings-overlay-host');
    expect(body).toMatch(/overflow:\s*clip\s*;/);
    expect(body).not.toMatch(/overflow(-[xy])?:\s*(hidden|auto|scroll)/);
  });
});
