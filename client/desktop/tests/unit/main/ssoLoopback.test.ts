/**
 * @vitest-environment node
 *
 * Loopback HTTP server for SSO OAuth callback capture.
 *
 * Runs in node environment because it binds an actual TCP listener on
 * 127.0.0.1 and uses fetch() against it — jsdom's fetch shim does not
 * proxy to the real network stack.
 */
import { describe, expect, it } from 'vitest';
import { startLoopback } from '../../../src/main/ssoLoopback';

describe('startLoopback', () => {
  it('resolves with code+state on /oauth/callback', async () => {
    const handle = await startLoopback();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.redirectURI).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    // Simulate provider redirect
    const callbackURL = `${handle.redirectURI}?code=test-code&state=test-state`;
    const fetchPromise = fetch(callbackURL);

    const result = await handle.promise;
    expect(result.code).toBe('test-code');
    expect(result.state).toBe('test-state');

    const resp = await fetchPromise;
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('Signed in');
  });

  it('rejects with oauth_provider_error when ?error= present', async () => {
    const handle = await startLoopback();
    const errURL = `${handle.redirectURI}?error=access_denied`;
    void fetch(errURL).catch(() => {});

    await expect(handle.promise).rejects.toThrow(/access_denied/);
  });

  it('rejects with oauth_timeout after TIMEOUT_MS', async () => {
    const handle = await startLoopback({ timeoutMs: 200 });
    await expect(handle.promise).rejects.toThrow(/oauth_timeout/);
  }, 10_000);

  it('returns 404 for non-callback paths', async () => {
    const handle = await startLoopback();
    try {
      const resp = await fetch(`http://127.0.0.1:${handle.port}/some/other/path`);
      expect(resp.status).toBe(404);
    } finally {
      handle.close();
    }
  });

  it('binds 127.0.0.1 only — not externally reachable', async () => {
    const handle = await startLoopback();
    try {
      // Loopback binding means 0.0.0.0 reachability is implementation-defined,
      // but on most stacks attempts to connect via the host's external IP fail.
      // We assert that the listen address is exactly 127.0.0.1.
      expect(handle.bindAddress).toBe('127.0.0.1');
    } finally {
      handle.close();
    }
  });

  it('close() rejects pending promise with oauth_cancelled', async () => {
    // Without this, a renderer that calls cancelLoopback (e.g. user backed
    // out of SSO) would leave the handle.promise pending forever — the
    // awaiting IPC handler would also hang. close() must settle the promise.
    const handle = await startLoopback({ timeoutMs: 60_000 });
    handle.close();
    await expect(handle.promise).rejects.toThrow(/oauth_cancelled/);
  });

  it('close() is idempotent after a successful resolve', async () => {
    // The settled flag prevents close()-after-resolve from rejecting an
    // already-fulfilled promise (which would surface as an unhandled
    // rejection in tests + a stuck modal in production).
    const handle = await startLoopback();
    void fetch(`${handle.redirectURI}?code=ok&state=ok`).catch(() => {});
    const result = await handle.promise;
    expect(result.code).toBe('ok');
    // Idempotent close — must not throw or change the resolved value.
    expect(() => handle.close()).not.toThrow();
  });
});
