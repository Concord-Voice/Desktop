import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Comments are stripped so a rule that follows one is still found by selector.
const gifEmbedCss = readFileSync(
  resolve(__dirname, '../../../src/renderer/components/Chat/GifEmbed.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = gifEmbedCss.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
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
    expect(ruleBody('.gif-embed')).toMatch(/line-height:\s*0;/);
    expect(ruleBody('.gif-embed-stopped')).toMatch(/line-height:\s*1\.3;/);
  });
});
