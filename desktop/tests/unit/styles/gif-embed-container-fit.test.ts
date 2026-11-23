import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Comments are stripped so a rule that follows one is still found by selector.
const gifEmbedCss = readFileSync(
  resolve(__dirname, '../../../src/renderer/components/Chat/GifEmbed.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of every rule whose selector is exactly `selector`. */
function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return [...gifEmbedCss.matchAll(pattern)].map((match) => match[1]);
}

/** The declarations of the one rule whose selector is exactly `selector`. A
 *  second rule for the same selector would win the cascade for whatever it
 *  redeclares while the first still satisfied these tests, so it is an error. */
function ruleBody(selector: string): string {
  const bodies = ruleBodies(selector);
  if (bodies.length !== 1) {
    throw new Error(`expected one rule for ${selector}, found ${bodies.length}`);
  }
  return bodies[0];
}

// jsdom runs no layout, so nothing in a component test can see an embed
// overflow its parent. These pin the two stylesheet halves of the fix; the
// component half (width + aspect-ratio, no pixel height) is in GifEmbed.test.tsx.
describe('Desktop#14 GIF embed fits its container', () => {
  it('caps the embed at its container width as well as at 400px', () => {
    // `max-width: 400px` alone let a 400px embed overflow the ~290px
    // pinned-messages panel in both channels and DMs.
    expect(ruleBody('.gif-embed')).toMatch(/max-width:\s*min\(400px,\s*100%\);/);
  });

  it('sizes the paused stand-in from the container, not from pixels', () => {
    const rule = ruleBody('.gif-embed-stopped');
    expect(rule).toMatch(/width:\s*100%;/);
    expect(rule).toMatch(/height:\s*100%;/);
    // The rule has horizontal padding, which 100% width must include.
    expect(rule).toMatch(/box-sizing:\s*border-box;/);
  });

  it('gives the paused stand-in a real line height', () => {
    // `.gif-embed` zeroes line-height for its media and the stand-in inherited
    // it, so its text overlapped itself once it wrapped inside a narrow GIF.
    expect(ruleBody('.gif-embed-stopped')).toMatch(/line-height:\s*1\.3;/);
  });

  // The reserved box is a width plus an aspect ratio. It only works while each
  // thing rendered inside it takes its size from the box.
  it.each(['.gif-embed-image', '.gif-embed-video', '.gif-embed-skeleton'])(
    'sizes %s from the reserved box',
    (selector) => {
      const rule = ruleBody(selector);
      expect(rule).toMatch(/(?:^|[\s;])width:\s*100%;/);
      expect(rule).toMatch(/(?:^|[\s;])height:\s*100%;/);
    }
  );

  it('gives the skeleton no minimum size of its own', () => {
    // A 250x180 minimum was clipped, not scaled, in a box narrower than itself.
    expect(ruleBody('.gif-embed-skeleton')).not.toMatch(/min-(?:width|height)\s*:/);
  });

  it('declares the embed cap once', () => {
    // No other rule in this stylesheet may reset the cap on the embed itself.
    const capDeclarations = gifEmbedCss.match(/max-width\s*:/g) ?? [];
    expect(capDeclarations).toHaveLength(1);
  });
});
