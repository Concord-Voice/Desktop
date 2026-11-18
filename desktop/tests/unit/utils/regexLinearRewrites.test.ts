import { describe, it, expect } from 'vitest';
import { bufferToBase64url } from '@/renderer/utils/crypto/base64url';
import { buildInviteUrl, extractInviteCodes } from '@/renderer/utils/messaging/inviteUrl';
import { errorMessage, errorName } from '@/renderer/utils/runtime/redactError';

// The pre-rewrite implementations, kept here as the reference the new code must match.
const legacyBase64url = (buf: ArrayBuffer): string => {
  let binary = '';
  for (const byte of new Uint8Array(buf)) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/g, '');
};

const legacyExtract = (text: string, max = 3): string[] => {
  const out: string[] = [];
  for (const cand of text.match(/https?:\/\/[^\s<>"')]+/gi) ?? []) {
    try {
      const u = new URL(cand.replace(/[.,!?;:'")\]}]+$/, ''));
      if (u.protocol !== 'https:' || u.host !== 'invite.concordvoice.chat') continue;
      const code = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
      if (/^[A-HJ-NP-Za-hj-km-np-z2-9]{8}$/.test(code) && !out.includes(code)) out.push(code);
      if (out.length >= max) break;
    } catch {
      // not a URL
    }
  }
  return out;
};

describe('bufferToBase64url matches the legacy encoder', () => {
  it('for every padding length', () => {
    for (let len = 0; len < 40; len++) {
      const buf = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff).buffer;
      expect(bufferToBase64url(buf)).toBe(legacyBase64url(buf));
    }
  });
});

describe('extractInviteCodes matches the legacy regex scan', () => {
  const url = buildInviteUrl('AbCdEf23');
  const cases = [
    `join ${url}`,
    `(${url}).`,
    `"${url}", then <${url}>`,
    `${url}!?;:'")]}`,
    `HTTPS://invite.concordvoice.chat/AbCdEf23 and http://${url.slice(8)}`,
    `xx${url}`,
    `https://https://invite.concordvoice.chat/AbCdEf23`,
    `http:// https:// ${url}`,
    `${buildInviteUrl('ZzYyXx99')} ${url} ${buildInviteUrl('HhJjKk22')} ${buildInviteUrl('MmNnPp33')}`,
    'no links here',
    '',
    // U+0130 lowercases to two code units; indexes from a lowered copy would shift.
    'İ'.repeat(21) + 'https://evil.example/https://invite.concordvoice.chat/AbCdEf23',
    `İ${url}`,
    `${url}///`,
  ];
  it.each(cases)('%s', (text) => {
    expect(extractInviteCodes(text)).toEqual(legacyExtract(text));
  });

  it('never accepts a link whose host is not the invite host', () => {
    const lookAlike =
      'İ'.repeat(21) + 'https://evil.example/https://invite.concordvoice.chat/AbCdEf23';
    expect(extractInviteCodes(lookAlike)).toEqual([]);
  });
});

describe('errorMessage scrubs line-forging characters', () => {
  it('replaces control, separator and bidi characters with spaces', () => {
    const raw = 'a\r\nb\u2028c\u2029d\u202Ee\u2066f\u0000g';
    expect(errorMessage(new Error(raw))).toBe('a  b c d e f g');
  });

  // Each end of every range, plus C1 (U+0085), DEL and the implicit bidi marks, so
  // narrowing a range fails. Code points, not literals: the characters are invisible.
  const scrubbed = [
    0x00, 0x1f, 0x7f, 0x85, 0x9f, 0x61c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c,
    0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  it.each(scrubbed)('scrubs U+%s', (cp) => {
    expect(errorMessage(new Error(`a${String.fromCodePoint(cp)}b`))).toBe('a b');
  });

  it('leaves ordinary text, including neighbours of the ranges, unchanged', () => {
    const plain = [
      'a',
      'b',
      'é',
      ...[0x2027, 0x202f, 0x2065, 0x206a, 0x200d].map((cp) => String.fromCodePoint(cp)),
    ].join(' ');
    expect(errorMessage(new Error(plain))).toBe(plain);
  });

  it('scrubs the error name too', () => {
    const err = new Error('x');
    err.name = `Type${String.fromCodePoint(0x0a)}Error`;
    expect(errorName(err)).toBe('Type Error');
  });

  it('does not throw on an Error whose message is not a string', () => {
    const err = new Error('x');
    (err as unknown as { message: unknown }).message = 42;
    expect(errorMessage(err)).toBe('42');
  });

  it('returns unknown_error for a non-Error value', () => {
    expect(errorMessage('a\nb')).toBe('unknown_error');
  });
});

describe('adversarial input stays linear', () => {
  it('handles long hostile runs quickly', () => {
    const n = 200_000;
    const hostile = [
      'https://' + 'a'.repeat(n) + '\u0000',
      'https://x' + '.'.repeat(n) + 'a',
      'http'.repeat(n / 4),
      'h' + 'ttps://'.repeat(n / 8),
      buildInviteUrl('a') + '/'.repeat(n / 4) + 'b',
    ];
    const start = performance.now();
    for (const text of hostile) extractInviteCodes(text);
    bufferToBase64url(new Uint8Array(n).buffer);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
