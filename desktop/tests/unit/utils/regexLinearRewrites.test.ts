import { describe, it, expect } from 'vitest';
import { bufferToBase64url } from '@/renderer/utils/crypto/base64url';
import { buildInviteUrl, extractInviteCodes } from '@/renderer/utils/messaging/inviteUrl';

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
  ];
  it.each(cases)('%s', (text) => {
    expect(extractInviteCodes(text)).toEqual(legacyExtract(text));
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
    ];
    const start = performance.now();
    for (const text of hostile) extractInviteCodes(text);
    bufferToBase64url(new Uint8Array(n).buffer);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
