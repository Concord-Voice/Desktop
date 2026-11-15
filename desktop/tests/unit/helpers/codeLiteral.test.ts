/**
 * Guards for `codeLiteral`, the only way the connection-isolation e2e spec puts a
 * value into source it runs in a view (CodeQL js/bad-code-sanitization, PR 206).
 *
 * `webContents.executeJavaScript` takes source text and no arguments, so a value can
 * reach the page only inside that text. A bare `JSON.stringify` there is "improper code
 * sanitization": it leaves `<`, `>` and `/` (a `</script>` or `<!--` that ends or
 * comments out the surrounding code wherever the text is ever embedded in markup) and
 * the U+2028 / U+2029 line terminators raw. The escapes are backslash-u forms, which are
 * valid in both JSON and JavaScript string literals, so the value still round-trips.
 *
 * The separators are built with `String.fromCharCode` and matched with `\p{Zl}` /
 * `\p{Zp}` so this file holds no raw U+2028 / U+2029 of its own.
 */
import { describe, expect, it } from 'vitest';

import { codeLiteral } from '../../e2e/codeLiteral';

const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const HOSTILE = `</script><!--a/b-->${SEPARATORS}`;
const UNSAFE = /[<>/\p{Zl}\p{Zp}]/u;
const esc = (hex: string): string => '\\u' + hex;

describe('codeLiteral', () => {
  it('leaves no raw <, >, / or U+2028 / U+2029 in the literal', () => {
    const literal = codeLiteral(HOSTILE);
    expect(literal).not.toMatch(UNSAFE);
    expect(literal).toBe(
      `"${esc('003c')}${esc('002f')}script${esc('003e')}${esc('003c')}!--a${esc('002f')}b--` +
        `${esc('003e')}${esc('2028')}${esc('2029')}"`
    );
  });

  it('escapes inside nested object values too', () => {
    const literal = codeLiteral({ apiBase: 'http://localhost:1/', note: [HOSTILE] });
    expect(literal).not.toMatch(UNSAFE);
  });

  it('round-trips every value it accepts', () => {
    for (const value of [
      HOSTILE,
      'ws://localhost:3001/ws',
      'window:1234:0',
      { refreshToken: 'seed-http://127.0.0.1:1', rememberMe: false, n: 3 },
      ['a\\b', 'c"d', '\n'],
      null,
      42,
    ]) {
      expect(JSON.parse(codeLiteral(value))).toEqual(value);
    }
  });

  it('refuses a value with no JSON form instead of splicing "undefined"', () => {
    expect(() => codeLiteral(undefined)).toThrow(TypeError);
    expect(() => codeLiteral(() => 1)).toThrow(TypeError);
  });
});
