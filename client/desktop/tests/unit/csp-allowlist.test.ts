// client/desktop/tests/unit/csp-allowlist.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('CSP allowlist (issue #817 regression guard)', () => {
  const indexHtml = readFileSync(resolve(__dirname, '../../index.html'), 'utf-8');
  const match = indexHtml.match(/connect-src([^;]+);/);
  const directive = (match?.[1] ?? '').trim();

  // Parse the connect-src directive into individual tokens (host patterns
  // and keywords like 'self'). Splits on whitespace and removes quotes.
  const tokens = directive
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/^'|'$/g, ''));

  /**
   * The closed allowlist of acceptable connect-src tokens.
   * Adding a token here requires a security review — see spec §3.
   * Anything not in this set is considered a regression.
   */
  const ALLOWED_TOKENS = new Set([
    'self',
    // Localhost variants for dev (Vite dev server, local backend)
    'ws://localhost:*',
    'http://localhost:*',
    'wss://localhost:*',
    'https://localhost:*',
    'ws://127.0.0.1:*',
    'http://127.0.0.1:*',
    // Bundled-app origin (app:// scheme — packaged builds)
    // app://concord (registered in main process; see internal-reference)
    // No connect-src entry needed because app:// pages have origin null
    // from a CSP standpoint and CSP enforcement is bypassed by Electron
    // for same-origin asar reads. Listed here for documentation only.
    // First-party concordvoice.chat surfaces (production + staging)
    'https://concordvoice.chat',
    'wss://concordvoice.chat',
    'https://*.concordvoice.chat',
    'wss://*.concordvoice.chat',
  ]);

  it('parses a connect-src directive from index.html', () => {
    expect(match).not.toBeNull();
    expect(directive.length).toBeGreaterThan(0);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('connect-src contains ONLY tokens in the closed allowlist', () => {
    // Positive allow-list: every directive token must be explicitly approved.
    // This catches ANY third-party host addition (Google, Apple, captive-portal
    // probes, CDN telemetry, etc.) without needing to enumerate the deny set.
    const unexpected = tokens.filter((t) => !ALLOWED_TOKENS.has(t));
    expect(unexpected).toEqual([]);
  });

  it('connect-src does not allow common third-party probe hosts', () => {
    // Belt-and-suspenders: explicitly assert known-bad hosts are absent
    // even if the allow-list above is later relaxed.
    const banned = [
      'clients3.google.com',
      'clients.google.com',
      'google.com',
      'captive.apple.com',
      'connectivitycheck',
      'msftconnecttest',
      'detectportal.firefox.com',
      'nmcheck.gnome.org',
      'cp.cloudflare.com',
    ];
    for (const host of banned) {
      expect(directive).not.toContain(host);
    }
  });
});
