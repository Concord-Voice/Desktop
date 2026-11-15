// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runGoogleSignIn,
  cancelActiveGoogleFlow,
  GOOGLE_FLOW_TIMEOUT_MS,
} from '../../../../../src/main/oauth/google/googleFlow';
import type { GoogleFlowDeps } from '../../../../../src/main/oauth/google/googleFlow';

function makeLoopback() {
  let resolveCb!: (v: { code: string; state: string }) => void;
  let rejectCb!: (e: Error) => void;
  const promise = new Promise<{ code: string; state: string }>((res, rej) => {
    resolveCb = res;
    rejectCb = rej;
  });
  promise.catch(() => undefined);
  return {
    handle: {
      port: 5123,
      redirectURI: 'http://127.0.0.1:5123/oauth/callback',
      bindAddress: '127.0.0.1',
      promise,
      close: vi.fn(() => rejectCb(new Error('oauth_cancelled'))),
    },
    resolveCb,
    rejectCb,
  };
}

function makeDeps(
  lo: ReturnType<typeof makeLoopback>,
  over: Partial<GoogleFlowDeps> = {}
): GoogleFlowDeps {
  return {
    apiBase: 'https://api.test',
    clientSecret: 'sek',
    controlPlaneFetch: vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/auth/sso/google?'))
        return new Response(
          JSON.stringify({
            auth_url:
              'https://accounts.google.com/o/oauth2/v2/auth?client_id=gid&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Foauth%2Fcallback&x=1',
            state: 'STATE',
            nonce: 'NONCE',
          }),
          { status: 200 }
        );
      if (url.endsWith('/auth/sso/google/session'))
        return new Response(
          JSON.stringify({
            status: 'authenticated',
            access_token: 'AT',
            refresh_token: 'RT',
            session_id: 'SID',
          }),
          { status: 200 }
        );
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch,
    googleFetch: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    openExternal: vi.fn(async () => {}),
    startLoopback: vi.fn(async () => lo.handle) as unknown as GoogleFlowDeps['startLoopback'],
    googleTokenCall: vi.fn(async () => ({ idToken: 'IDT' })),
    verifyIdToken: vi.fn(async () => ({ sub: 'g-sub', email: 'a@b.com', email_verified: true })),
    flowTimeoutMs: 1000,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cancelActiveGoogleFlow());

describe('runGoogleSignIn', () => {
  it('uses a fresh client binding on each sign-in attempt', async () => {
    const bindings: string[] = [];
    for (let i = 0; i < 2; i++) {
      const lo = makeLoopback();
      lo.resolveCb({ code: 'CODE', state: 'STATE' });
      const deps = makeDeps(lo);
      expect((await runGoogleSignIn(deps)).kind).toBe('tokens');
      bindings.push(
        new Headers(vi.mocked(deps.controlPlaneFetch).mock.calls[0][1]?.headers).get(
          'X-Concord-SSO-Client-Binding'
        )!
      );
    }
    expect(bindings[0]).not.toBe(bindings[1]);
  });

  it('installs the initiated state before opening the browser', async () => {
    const lo = makeLoopback();
    lo.resolveCb({ code: 'CODE', state: 'STATE' });
    const deps = makeDeps(lo);
    vi.mocked(deps.openExternal).mockImplementation(async () => {
      expect(vi.mocked(deps.startLoopback).mock.calls[0][0]?.expectedState?.()).toBe('STATE');
    });
    expect((await runGoogleSignIn(deps)).kind).toBe('tokens');
    expect(deps.openExternal).toHaveBeenCalledOnce();
  });

  it('rejects an empty initiated state before opening the browser', async () => {
    const lo = makeLoopback();
    const deps = makeDeps(lo, {
      controlPlaneFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              auth_url:
                'https://accounts.google.com/o/oauth2/v2/auth?client_id=gid&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Foauth%2Fcallback&x=1',
              state: '',
              nonce: 'NONCE',
            })
          )
      ) as unknown as typeof fetch,
    });
    expect(await runGoogleSignIn(deps)).toEqual({ kind: 'error', code: 'sso_initiate_failed' });
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('reports cancellation while the initiation body is stalled', async () => {
    const lo = makeLoopback();
    const controlPlaneFetch = vi.fn(
      async () => new Response(new ReadableStream<Uint8Array>({}))
    ) as unknown as typeof fetch;
    const deps = makeDeps(lo, { controlPlaneFetch });
    const pending = runGoogleSignIn(deps);
    await vi.waitFor(() => expect(controlPlaneFetch).toHaveBeenCalledOnce());
    cancelActiveGoogleFlow();
    expect(await pending).toEqual({ kind: 'error', code: 'sso_cancelled' });
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('rejects an oversized initiation before opening the browser', async () => {
    const lo = makeLoopback();
    const deps = makeDeps(lo, {
      controlPlaneFetch: vi.fn(
        async () => new Response(JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }))
      ) as unknown as typeof fetch,
    });
    expect(await runGoogleSignIn(deps)).toEqual({ kind: 'error', code: 'sso_initiate_failed' });
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('rejects a phishing authorization URL before opening the browser', async () => {
    const lo = makeLoopback();
    lo.resolveCb({ code: 'CODE', state: 'STATE' });
    const deps = makeDeps(lo, {
      controlPlaneFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              auth_url:
                'https://evil.example/?client_id=gid&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Foauth%2Fcallback',
              state: 'STATE',
              nonce: 'NONCE',
            }),
            { status: 200 }
          )
      ) as unknown as typeof fetch,
    });
    expect(await runGoogleSignIn(deps)).toEqual({ kind: 'error', code: 'sso_initiate_failed' });
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(deps.googleTokenCall).not.toHaveBeenCalled();
    expect(lo.handle.close).toHaveBeenCalledOnce();
  });

  it('rejects a Google URL that redirects to an attacker-controlled callback', async () => {
    const lo = makeLoopback();
    lo.resolveCb({ code: 'CODE', state: 'STATE' });
    const deps = makeDeps(lo, {
      controlPlaneFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              auth_url:
                'https://accounts.google.com/o/oauth2/v2/auth?client_id=attacker&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback',
              state: 'STATE',
              nonce: 'NONCE',
            })
          )
      ) as unknown as typeof fetch,
    });
    expect(await runGoogleSignIn(deps)).toEqual({ kind: 'error', code: 'sso_initiate_failed' });
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    'https://accounts.google.com.evil.example/o/oauth2/v2/auth?client_id=gid',
    'https://accounts.google.com@evil.example/o/oauth2/v2/auth?client_id=gid',
    'https://user:password@accounts.google.com/o/oauth2/v2/auth?client_id=gid',
    'https://accounts.google.com:444/o/oauth2/v2/auth?client_id=gid',
    'https://accounts.google.com/o/oauth2/v2/auth/other?client_id=gid',
    'https://appleid.apple.com/auth/authorize?client_id=gid',
    'http://accounts.google.com/o/oauth2/v2/auth?client_id=gid',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=gid#fragment',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=gid#',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=gid&client_%69d=other',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=gid&state=one&state=two',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=gid&nonce=%zz',
    'not a URL',
  ])('rejects an unsafe Google authorization URL: %s', async (authUrl) => {
    const lo = makeLoopback();
    lo.resolveCb({ code: 'CODE', state: 'STATE' });
    const fragment = authUrl.indexOf('#');
    const beforeFragment = fragment < 0 ? authUrl : authUrl.slice(0, fragment);
    const withRedirect = `${beforeFragment}${beforeFragment.includes('?') ? '&' : '?'}redirect_uri=${encodeURIComponent(lo.handle.redirectURI)}${fragment < 0 ? '' : authUrl.slice(fragment)}`;
    const deps = makeDeps(lo, {
      controlPlaneFetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ auth_url: withRedirect, state: 'STATE', nonce: 'NONCE' }))
      ) as unknown as typeof fetch,
    });
    expect(await runGoogleSignIn(deps)).toEqual({ kind: 'error', code: 'sso_initiate_failed' });
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(deps.googleTokenCall).not.toHaveBeenCalled();
    expect(lo.handle.close).toHaveBeenCalledOnce();
  });

  it('opens the canonical validated Google URL', async () => {
    const lo = makeLoopback();
    lo.resolveCb({ code: 'CODE', state: 'STATE' });
    const deps = makeDeps(lo, {
      controlPlaneFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              auth_url:
                'HTTPS://ACCOUNTS.GOOGLE.COM:443/o/oauth2/v2/auth?client_id=gid&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Foauth%2Fcallback',
              state: 'STATE',
              nonce: 'NONCE',
            })
          )
      ) as unknown as typeof fetch,
    });
    await runGoogleSignIn(deps);
    expect(deps.openExternal).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=gid&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Foauth%2Fcallback'
    );
  });

  it('completes the happy path → tokens', async () => {
    const lo = makeLoopback();
    const deps = makeDeps(lo);
    const p = runGoogleSignIn(deps);
    await vi.waitFor(() => expect(deps.openExternal).toHaveBeenCalled());
    lo.resolveCb({ code: 'CODE', state: 'STATE' });
    const result = await p;
    expect(result).toEqual({
      kind: 'tokens',
      accessToken: 'AT',
      refreshToken: 'RT',
      sessionId: 'SID',
    });
    const calls = vi.mocked(deps.controlPlaneFetch).mock.calls;
    const binding = new Headers(calls[0][1]?.headers).get('X-Concord-SSO-Client-Binding');
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Headers(calls[1][1]?.headers).get('X-Concord-SSO-Client-Binding')).toBe(binding);
    expect(String(calls[0][0])).not.toContain(binding!);
    expect(String(calls[1][1]?.body)).not.toContain(binding!);
    expect(deps.googleTokenCall).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: 'sek', clientId: 'gid' })
    );
  });

  it('fails when the server auth_url lacks client_id', async () => {
    const lo = makeLoopback();
    const deps = makeDeps(lo, {
      controlPlaneFetch: vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/auth/sso/google?'))
          return new Response(
            JSON.stringify({
              auth_url:
                'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Foauth%2Fcallback&x=1',
              state: 'STATE',
              nonce: 'NONCE',
            }),
            { status: 200 }
          );
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch,
    });
    const result = await runGoogleSignIn(deps);
    expect(result).toEqual({ kind: 'error', code: 'sso_initiate_failed' });
    expect(deps.googleTokenCall).not.toHaveBeenCalled();
  });

  it('rejects a state mismatch with oauth_provider_error:state_mismatch (mirrors appleFlow)', async () => {
    const lo = makeLoopback();
    const deps = makeDeps(lo);
    const p = runGoogleSignIn(deps);
    await vi.waitFor(() => expect(deps.openExternal).toHaveBeenCalled());
    lo.resolveCb({ code: 'CODE', state: 'WRONG' });
    const result = await p;
    expect(result).toEqual({ kind: 'error', code: 'oauth_provider_error:state_mismatch' });
  });

  it('exports a 5-minute default flow timeout constant', () => {
    expect(GOOGLE_FLOW_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});
