// @vitest-environment node
/**
 * #86 Phase-4 red-team RT1/RT2: SSO sign-in authority across connections.
 *
 * Unlike sso.test.ts, the REAL googleFlow / appleFlow orchestrators run here: their
 * process-wide single-flight `activeFlow` is the subject. Only the provider endpoints
 * (token call, id-token verify, Apple client-secret broker) and the loopback listener are
 * stubbed.
 *
 * Threat model: connection B is a malicious self-hosted server that fully controls its own
 * renderer. Connection A is CVNet (saas), in the foreground.
 *   RT1: B starting its own sign-in must not supersede (cancel) A's in-flight flow, and a
 *        disposed owner must release the provider.
 *   RT2: a hidden (background) connection must not be able to start a sign-in at all.
 */
import { shell } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  interface FakeHandle {
    port: number;
    redirectURI: string;
    bindAddress: string;
    promise: Promise<{ code: string; state: string }>;
    close: () => void;
    __resolve: (v: { code: string; state: string }) => void;
    __closeCalls: number;
  }
  const handleSpy = vi.fn();
  const onSpy = vi.fn();
  const fakeHandles: FakeHandle[] = [];
  let nextPort = 52000;
  const startLoopback = vi.fn(async () => {
    let resolveFn!: (v: { code: string; state: string }) => void;
    let rejectFn!: (e: Error) => void;
    const promise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    promise.catch(() => undefined);
    const port = nextPort++;
    const handle: FakeHandle = {
      port,
      redirectURI: `http://127.0.0.1:${port}/oauth/callback`,
      bindAddress: '127.0.0.1',
      promise,
      close: () => {
        handle.__closeCalls += 1;
        rejectFn(new Error('oauth_cancelled'));
      },
      __resolve: (v) => resolveFn(v),
      __closeCalls: 0,
    };
    fakeHandles.push(handle);
    return handle;
  });
  return { handleSpy, onSpy, fakeHandles, startLoopback };
});

vi.mock('electron', () => ({
  ipcMain: { handle: mocked.handleSpy, on: mocked.onSpy },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
}));
vi.mock('../../../../src/main/ssoLoopback', () => ({ startLoopback: mocked.startLoopback }));
vi.mock('../../../../src/main/oauth/google/googleTokenCall', () => ({
  googleTokenCall: vi.fn(async () => ({ idToken: 'google-id-token-concord-aud' })),
}));
vi.mock('../../../../src/main/oauth/google/idTokenVerifier', () => ({
  verifyGoogleIDToken: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/main/oauth/google/clientSecret', () => ({
  loadGoogleClientSecret: vi.fn(() => 'embedded-google-client-secret'),
}));
vi.mock('../../../../src/main/oauth/apple/appleTokenCall', () => ({
  appleTokenCall: vi.fn(async () => ({ idToken: 'apple-id-token' })),
}));
vi.mock('../../../../src/main/oauth/apple/idTokenVerifier', () => ({
  verifyAppleIDToken: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/main/oauth/apple/signClientSecret', () => ({
  signClientSecret: vi.fn(async () => 'apple-client-secret'),
}));
vi.mock('../../../../src/main/apiBaseUrl', () => ({
  PRODUCTION_API_BASE: 'https://api.concordvoice.chat',
  getApiBaseUrl: vi.fn(() => 'https://api.concordvoice.chat'),
}));
vi.mock('../../../../src/main/selfHostedProfile', async (orig) => ({
  ...(await orig<object>()),
  isValidatedSelfHostedApiBase: vi.fn((apiBase: string) => apiBase === 'https://evil.example'),
  isTier2DialApproved: vi.fn(() => true),
}));
vi.mock('../../../../src/main/guardedRequest', () => ({
  guardedRequest: vi.fn(async () => ({ ok: true, status: 200, url: '', json: async () => ({}) })),
  EgressDeniedError: class EgressDeniedError extends Error {},
}));
vi.mock('../../../../src/main/tokenManager', () => ({
  custodyForApiBase: vi.fn(),
  liveCustody: vi.fn(),
}));
vi.mock('../../../../src/main/machineId', () => ({
  getMachineId: vi.fn(() => '33333333-3333-4333-8333-333333333333'),
}));

import {
  _resetConnectionRegistryForTesting,
  bindSender,
  advanceGeneration,
  disposeConnection,
  openConnection,
  registerService,
  setForeground,
} from '../../../../src/main/connectionRegistry';
import {
  _resetIpcRegistryForTesting,
  setRemoteSpaOriginSource,
} from '../../../../src/main/ipc/registry';
import { registerSSOIPC } from '../../../../src/main/ipc/sso';
import { cancelActiveAppleFlow } from '../../../../src/main/oauth/apple/appleFlow';
import { cancelActiveGoogleFlow } from '../../../../src/main/oauth/google/googleFlow';
import { googleTokenCall } from '../../../../src/main/oauth/google/googleTokenCall';
import { accountKeyFor } from '../../../../src/main/preferenceOwnership';

const A_ORIGIN = 'https://api.concordvoice.chat'; // CVNet (saas), the foreground view
const B_ORIGIN = 'https://evil.example'; // malicious self-hosted
const VICTIM_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function accessToken(claims: Record<string, unknown>): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(claims)}.sig`;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function tokensBody(tag: string, userId: string, sessionId: string): Record<string, unknown> {
  return {
    access_token: accessToken({ user_id: userId }),
    refresh_token: `rt-${tag}`,
    session_id: sessionId,
  };
}

interface Svc {
  sessionBody: Record<string, unknown>;
  sessionPosts: Array<{ url: string; body: unknown }>;
  mfaVerifyPosts: number;
}

function makeServiceFetch(tag: string, svc: Svc) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const u = new URL(url);
    if (u.pathname === '/api/v1/auth/sso/google') {
      // A malicious server is free to name ANY client_id, including the Concord one.
      const q = new URLSearchParams({
        client_id: 'concord-google-client',
        redirect_uri: u.searchParams.get('redirect_uri') ?? '',
        response_type: 'code',
        scope: 'openid email',
        state: `state-${tag}`,
        nonce: `nonce-${tag}`,
        code_challenge: u.searchParams.get('code_challenge') ?? '',
        code_challenge_method: 'S256',
      });
      return json({
        auth_url: `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`,
        state: `state-${tag}`,
        nonce: `nonce-${tag}`,
      });
    }
    if (u.pathname === '/api/v1/auth/sso/apple') {
      const q = new URLSearchParams({
        client_id: 'concord-apple-client',
        redirect_uri: 'https://api.concordvoice.chat/auth/sso/apple/callback',
        response_type: 'code',
        response_mode: 'form_post',
        scope: 'name email',
        state: `state-${tag}`,
        nonce: `nonce-${tag}`,
      });
      return json({
        auth_url: `https://appleid.apple.com/auth/authorize?${q.toString()}`,
        state: `state-${tag}`,
        nonce: `nonce-${tag}`,
      });
    }
    if (/^\/api\/v1\/auth\/sso\/(google|apple)\/session$/.test(u.pathname)) {
      svc.sessionPosts.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
      return json(svc.sessionBody);
    }
    if (u.pathname === '/api/v1/auth/mfa/verify') svc.mfaVerifyPosts += 1;
    return json({});
  });
}

function makeCustody() {
  let current = 100;
  let reserved: number | null = null;
  let hasToken = false;
  const stored: Array<Record<string, unknown>> = [];
  const custody = {
    reserveCredentialOwner: vi.fn(() => {
      current += 1;
      reserved = current;
      hasToken = false;
      return current;
    }),
    credentialOwnerIsCurrent: vi.fn((o: number) => o === current),
    storeRefreshTokenIfOwner: vi.fn((data: Record<string, unknown>, o: number) => {
      if (o !== current || reserved !== o || hasToken) return null;
      hasToken = true;
      reserved = null;
      stored.push(data);
      return o;
    }),
    clearTokensIfOwner: vi.fn((o: number) => {
      if (o !== current) return false;
      current += 1;
      reserved = null;
      hasToken = false;
      return true;
    }),
    releaseCredentialReservation: vi.fn(() => false),
    getAccountKey: vi.fn(() => null),
  };
  return { custody, stored };
}

let nextWcId = 600;
function bindConnection(origin: string, tag: string, sessionBody: Record<string, unknown>) {
  const svc: Svc = { sessionBody, sessionPosts: [], mfaVerifyPosts: 0 };
  const fetchFn = makeServiceFetch(tag, svc);
  const { custody, stored } = makeCustody();
  const r = registerService(origin, {
    makeSession: () => ({ fetch: fetchFn }) as never,
    makeCustody: () => custody as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  const id = nextWcId++;
  const wc = { id, mainFrame: { frameTreeNodeId: id } } as never;
  const o = openConnection(r.service.serviceId, wc, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc, o.record.connectionId, 'primary');
  return {
    svc,
    fetchFn,
    custody,
    stored,
    serviceId: r.service.serviceId,
    connectionId: o.record.connectionId,
    event: () =>
      ({
        sender: wc,
        senderFrame: {
          url: 'app://concord/index.html',
          parent: null,
          frameTreeNodeId: id,
          detached: false,
        },
      }) as never,
  };
}

type Handler = (event: unknown, ...args: unknown[]) => unknown;
function handler(channel: string): Handler {
  const call = [...mocked.handleSpy.mock.calls, ...mocked.onSpy.mock.calls].find(
    (c) => c[0] === channel
  );
  if (!call) throw new Error(`${channel} not registered`);
  return call[1] as Handler;
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe('#86 RT1/RT2: SSO sign-in authority across connections (real provider flows)', () => {
  let A: ReturnType<typeof bindConnection>;
  let B: ReturnType<typeof bindConnection>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.fakeHandles.length = 0;
    _resetConnectionRegistryForTesting();
    _resetIpcRegistryForTesting();
    setRemoteSpaOriginSource(() => null);
    A = bindConnection(A_ORIGIN, 'A', tokensBody('A', VICTIM_USER_ID, UUID_A));
    B = bindConnection(B_ORIGIN, 'B', tokensBody('B', VICTIM_USER_ID, UUID_B));
    setForeground(A.connectionId); // the user is looking at CVNet; B is hidden
    registerSSOIPC();
  });

  afterEach(async () => {
    cancelActiveGoogleFlow();
    cancelActiveAppleFlow();
    await settle();
  });

  // ------------------------------------------------------------------- RT1
  it.each([
    ['google, B hidden', 'sso:googleSignIn', false],
    ['apple, B hidden', 'sso:appleSignIn', false],
    ['google, user switched to B mid-consent', 'sso:googleSignIn', true],
    ['apple, user switched to B mid-consent', 'sso:appleSignIn', true],
  ])(
    "RT1 [%s]: B starting its own sign-in does not cancel A's in-flight sign-in",
    async (_case, channel, bForeground) => {
      const signIn = handler(channel as string);
      const aResult = signIn(A.event(), A_ORIGIN) as Promise<unknown>;
      // A is at the browser-consent stage: consent tab open, loopback listening.
      await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
      const aLoopback = mocked.fakeHandles[0];
      if (bForeground) setForeground(B.connectionId);

      // B starts its OWN sign-in. It names nothing of A's.
      const bResult = (signIn(B.event(), B_ORIGIN) as Promise<unknown>).catch((e: unknown) => e);
      await settle();

      const aClosedByB = aLoopback.__closeCalls;
      aLoopback.__resolve({ code: 'code-for-A', state: 'state-A' });

      // A's sign-in completes into A's custody; B's start never touched A's listener.
      await expect(aResult).resolves.toMatchObject({ kind: 'tokens' });
      expect(aClosedByB).toBe(0);
      expect(A.stored).toHaveLength(1);
      // B was refused before any custody effect or consent tab of its own.
      expect(await bResult).toBeInstanceOf(Error);
      expect(B.custody.reserveCredentialOwner).not.toHaveBeenCalled();
      expect(shell.openExternal).toHaveBeenCalledTimes(1);
    }
  );

  it('R1: a connection may still restart its OWN flow (double-click)', async () => {
    const signIn = handler('sso:googleSignIn');
    const first = signIn(A.event(), A_ORIGIN) as Promise<unknown>;
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    const second = signIn(A.event(), A_ORIGIN) as Promise<unknown>;
    await expect(first).resolves.toMatchObject({ kind: 'error', code: 'sso_cancelled' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));
    mocked.fakeHandles[1].__resolve({ code: 'code-for-A', state: 'state-A' });
    await expect(second).resolves.toMatchObject({ kind: 'tokens' });
  });

  it('R2: once A has finished, B (now foreground) can start its own flow', async () => {
    const signIn = handler('sso:googleSignIn');
    const aResult = signIn(A.event(), A_ORIGIN) as Promise<unknown>;
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    mocked.fakeHandles[0].__resolve({ code: 'code-for-A', state: 'state-A' });
    await expect(aResult).resolves.toMatchObject({ kind: 'tokens' });
    setForeground(B.connectionId);
    const bResult = signIn(B.event(), B_ORIGIN) as Promise<unknown>;
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));
    mocked.fakeHandles[1].__resolve({ code: 'code-for-B', state: 'state-B' });
    await expect(bResult).resolves.toMatchObject({ kind: 'tokens' });
  });

  it.each(['sso:googleSignIn', 'sso:appleSignIn'])(
    'R3 [%s]: disposing the flow owner ends its flow and releases the provider',
    async (channel) => {
      const signIn = handler(channel);
      const aResult = signIn(A.event(), A_ORIGIN) as Promise<unknown>;
      await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
      disposeConnection(A.connectionId as never);
      // The disposal itself ends A's flow; nothing else has started.
      await vi.waitFor(() => expect(mocked.fakeHandles[0].__closeCalls).toBeGreaterThan(0));
      await expect(aResult).resolves.toMatchObject({ kind: 'error', code: 'sso_cancelled' });
      setForeground(B.connectionId);
      const bResult = signIn(B.event(), B_ORIGIN) as Promise<unknown>;
      await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));
      mocked.fakeHandles[1].__resolve({ code: 'code-for-B', state: 'state-B' });
      await expect(bResult).resolves.toMatchObject({ kind: 'tokens' });
    }
  );

  it.each([
    ['sso:googleSignIn', 'document'],
    ['sso:appleSignIn', 'document'],
    ['sso:googleSignIn', 'renderer-gone'],
    ['sso:appleSignIn', 'renderer-gone'],
  ] as const)(
    'R4 [%s, %s]: any advance of the flow owner ends its flow and releases the provider',
    async (channel, reason) => {
      const signIn = handler(channel);
      const aResult = signIn(A.event(), A_ORIGIN) as Promise<unknown>;
      await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
      // A reloads (or loses its renderer) mid-consent: its finish is fenced anyway.
      advanceGeneration(A.connectionId as never, reason);
      await vi.waitFor(() => expect(mocked.fakeHandles[0].__closeCalls).toBeGreaterThan(0));
      await expect(aResult).resolves.toMatchObject({ kind: 'error', code: 'sso_cancelled' });
      setForeground(B.connectionId);
      const bResult = signIn(B.event(), B_ORIGIN) as Promise<unknown>;
      await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));
      mocked.fakeHandles[1].__resolve({ code: 'code-for-B', state: 'state-B' });
      await expect(bResult).resolves.toMatchObject({ kind: 'tokens' });
    }
  );

  // ------------------------------------------------------------------- RT2
  it.each(['sso:googleSignIn', 'sso:appleSignIn'])(
    'RT2 [%s]: a HIDDEN connection cannot start a sign-in (no consent tab, no id_token)',
    async (channel) => {
      const bResult = (handler(channel)(B.event(), B_ORIGIN) as Promise<unknown>).catch(
        (e: unknown) => e
      );
      await settle();
      // If B got a loopback, the user completes the consent tab that just popped up.
      mocked.fakeHandles[0]?.__resolve({ code: 'code-user-thought-was-cvnet', state: 'state-B' });
      const out = await bResult;
      await settle();

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(googleTokenCall).not.toHaveBeenCalled();
      expect(B.svc.sessionPosts).toEqual([]);
      expect(B.custody.reserveCredentialOwner).not.toHaveBeenCalled();
      expect(out).toBeInstanceOf(Error);
      expect((out as Error).message).toBe(
        `${channel} rejected: untrusted sender frame (not-foreground)`
      );
    }
  );

  // ------------------------------------------------------------------- defended paths
  it("D1: B's sso:googleCancel / sso:appleCancel cannot cancel A's in-flight flow", async () => {
    const signIn = handler('sso:googleSignIn');
    const aResult = signIn(A.event(), A_ORIGIN) as Promise<unknown>;
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    const aLoopback = mocked.fakeHandles[0];
    handler('sso:googleCancel')(B.event());
    handler('sso:appleCancel')(B.event());
    expect(aLoopback.__closeCalls).toBe(0);
    aLoopback.__resolve({ code: 'code-for-A', state: 'state-A' });
    await expect(aResult).resolves.toMatchObject({ kind: 'tokens' });
  });

  it("D2: B cannot await or cancel A's renderer-driven loopback port", async () => {
    const started = (await handler('sso:startLoopback')(A.event())) as { port: number };
    const aHandle = mocked.fakeHandles.find((h) => h.port === started.port);
    await expect(
      handler('sso:awaitCallback')(B.event(), started.port) as Promise<unknown>
    ).rejects.toThrow('unknown port');
    handler('sso:cancelLoopback')(B.event(), started.port);
    expect(aHandle?.__closeCalls).toBe(0);
  });

  it("D3: A's pending MFA challenge cannot be completed or cleared by B", async () => {
    A.svc.sessionBody = { mfa_challenge_token: 'mfa-A', methods: ['totp'] };
    const aResult = handler('sso:googleSignIn')(A.event(), A_ORIGIN) as Promise<{
      kind: string;
      credentialOwner?: number;
    }>;
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    mocked.fakeHandles[0].__resolve({ code: 'code-for-A', state: 'state-A' });
    const challenge = await aResult;
    expect(challenge.kind).toBe('mfa_challenge');
    const proof = {
      provider: 'google',
      mfaChallengeToken: 'mfa-A',
      credentialOwner: challenge.credentialOwner,
      method: 'totp',
      code: '123456',
    };
    await expect(
      handler('sso:completeMFA')(B.event(), B_ORIGIN, proof) as Promise<unknown>
    ).resolves.toMatchObject({ kind: 'error', status: 409 });
    await expect(
      handler('sso:completeMFA')(B.event(), A_ORIGIN, proof) as Promise<unknown>
    ).resolves.toMatchObject({ kind: 'error', status: 400 });
    expect(handler('sso:abandonReservation')(B.event())).toBe(false);
    expect(A.svc.mfaVerifyPosts + B.svc.mfaVerifyPosts).toBe(0);
    expect(A.custody.clearTokensIfOwner).not.toHaveBeenCalled();
  });

  it("D4: B's server-chosen user_id claim lands only in B's custody and B's account key", async () => {
    setForeground(B.connectionId);
    const bResult = handler('sso:googleSignIn')(B.event(), B_ORIGIN) as Promise<unknown>;
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    mocked.fakeHandles[0].__resolve({ code: 'c', state: 'state-B' });
    await expect(bResult).resolves.toMatchObject({ kind: 'tokens' });
    expect(B.stored[0]).toMatchObject({ apiBase: B_ORIGIN, serverUserId: VICTIM_USER_ID });
    expect(A.stored).toHaveLength(0);
    expect(A.custody.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
    expect(accountKeyFor(A.serviceId, VICTIM_USER_ID)).not.toBe(
      accountKeyFor(B.serviceId, VICTIM_USER_ID)
    );
  });

  it('D5: B cannot name A for sso:completeLink', async () => {
    const link = { provider: 'google', ssoToken: 't', password: 'p' }; // pragma: allowlist secret
    await expect(
      handler('sso:completeLink')(B.event(), A_ORIGIN, link) as Promise<unknown>
    ).resolves.toMatchObject({ kind: 'error', status: 400 });
    expect(A.fetchFn).not.toHaveBeenCalled();
  });
});
