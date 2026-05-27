/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

describe('SPA_VERSION detection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Cleanup env stubs so VITE_SPA_VERSION doesn't leak into other tests
    // in the same worker (Copilot review on #1204 caught this — without
    // unstubAllEnvs, vi.stubEnv state persists across tests).
    vi.unstubAllEnvs();
  });

  it('prefers VITE_SPA_VERSION when set', async () => {
    vi.stubEnv('VITE_SPA_VERSION', 'abc1234');
    const { SPA_VERSION } = await import('@/renderer/config');
    expect(SPA_VERSION).toBe('abc1234');
  });

  it('falls back to URL-extracted SHA when env var is missing', async () => {
    vi.stubEnv('VITE_SPA_VERSION', '');
    // Production SPA URL contract per ADR-0001: `/spa/<sha>/...` (NOT
    // `/<sha>/...` — Copilot review on #1204 caught the earlier mistake).
    Object.defineProperty(window, 'location', {
      value: new URL('https://spa.concordvoice.chat/spa/7683eb1/index.html'),
      writable: true,
      configurable: true,
    });
    const { SPA_VERSION } = await import('@/renderer/config');
    expect(SPA_VERSION).toBe('7683eb1');
  });

  it('returns "bundled" when URL has no /spa/<sha>/ segment', async () => {
    vi.stubEnv('VITE_SPA_VERSION', '');
    Object.defineProperty(window, 'location', {
      value: new URL('app://concord/index.html'),
      writable: true,
      configurable: true,
    });
    const { SPA_VERSION } = await import('@/renderer/config');
    expect(SPA_VERSION).toBe('bundled');
  });

  it('returns "bundled" on localhost dev server', async () => {
    vi.stubEnv('VITE_SPA_VERSION', '');
    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost:3001/'),
      writable: true,
      configurable: true,
    });
    const { SPA_VERSION } = await import('@/renderer/config');
    expect(SPA_VERSION).toBe('bundled');
  });

  it('returns "bundled" when SHA appears without /spa/ prefix (defense)', async () => {
    // Regression guard: an attacker-controlled or misconfigured URL that
    // happens to have hex chars right after the host MUST NOT be treated
    // as the SPA hash. The /spa/ literal in the regex prevents this.
    vi.stubEnv('VITE_SPA_VERSION', '');
    Object.defineProperty(window, 'location', {
      value: new URL('https://spa.concordvoice.chat/7683eb1/index.html'),
      writable: true,
      configurable: true,
    });
    const { SPA_VERSION } = await import('@/renderer/config');
    expect(SPA_VERSION).toBe('bundled');
  });
});
