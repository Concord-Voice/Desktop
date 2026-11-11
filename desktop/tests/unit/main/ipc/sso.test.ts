/**
 * Unit tests for the sso:* IPC handlers (#270 review).
 *
 * Coverage:
 *   - sender-frame validation rejects untrusted origins on all three channels
 *   - active-map cleanup removes entries on awaitCallback / cancelLoopback /
 *     promise-settle
 *   - awaitCallback against an unknown port throws a stable error rather than
 *     hanging
 *
 * The loopback server itself is mocked — these tests exercise the IPC plumbing,
 * not the HTTP listener (that's covered by ssoLoopback.test.ts). The mock lets
 * us verify the cleanup contract deterministically without binding real ports.
 */
import { net } from 'electron';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above ALL `const` declarations, so any references to
// outer-scope state from inside a vi.mock factory must come from vi.hoisted —
// regular module-scope values are not yet initialized when the factory runs.
const mocked = vi.hoisted(() => {
  interface FakeHandle {
    port: number;
    redirectURI: string;
    bindAddress: string;
    promise: Promise<{ code: string; state: string }>;
    close: () => void;
    __resolve: (v: { code: string; state: string }) => void;
    __reject: (e: Error) => void;
    __closeCalls: number;
  }
  const handleSpy = vi.fn();
  const onSpy = vi.fn();
  const fakeHandles: FakeHandle[] = [];
  let nextPort = 51000;
  const startLoopback = vi.fn(async () => {
    let resolveFn!: (v: { code: string; state: string }) => void;
    let rejectFn!: (e: Error) => void;
    const promise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    // Suppress unhandled-rejection noise — close() may reject, and tests
    // that don't await the promise would otherwise pollute test output.
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
      __resolve: resolveFn,
      __reject: rejectFn,
      __closeCalls: 0,
    };
    fakeHandles.push(handle);
    return handle;
  });
  return { handleSpy, onSpy, fakeHandles, startLoopback };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocked.handleSpy,
    on: mocked.onSpy,
  },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../../../../src/main/ssoLoopback', () => ({
  startLoopback: mocked.startLoopback,
}));

// #86: an access token shaped like the control plane's (header.payload.signature)
// whose payload carries the given claims. Only the payload matters to main.
function accessTokenWithClaims(claims: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}.signature`;
}

const appleMocks = vi.hoisted(() => ({
  runAppleSignIn: vi.fn(async () => ({
    kind: 'tokens' as const,
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    sessionId: 'sid-1',
  })),
  cancelActiveAppleFlow: vi.fn(),
}));

vi.mock('../../../../src/main/oauth/apple/appleFlow', () => ({
  runAppleSignIn: appleMocks.runAppleSignIn,
  cancelActiveAppleFlow: appleMocks.cancelActiveAppleFlow,
}));

// idTokenVerifier pulls in jose (ESM/WebCrypto) — stub it so this jsdom
// suite never loads it; the real module has its own node-env suite.
vi.mock('../../../../src/main/oauth/apple/idTokenVerifier', () => ({
  verifyAppleIDToken: vi.fn(),
}));

const googleMocks = vi.hoisted(() => ({
  runGoogleSignIn: vi.fn(async () => ({
    kind: 'tokens' as const,
    accessToken: 'g-at-1',
    refreshToken: 'g-rt-1',
    sessionId: 'g-sid-1',
  })),
  cancelActiveGoogleFlow: vi.fn(),
}));

vi.mock('../../../../src/main/oauth/google/googleFlow', () => ({
  runGoogleSignIn: googleMocks.runGoogleSignIn,
  cancelActiveGoogleFlow: googleMocks.cancelActiveGoogleFlow,
}));

// Google idTokenVerifier also pulls in jose — stub for jsdom.
vi.mock('../../../../src/main/oauth/google/idTokenVerifier', () => ({
  verifyGoogleIDToken: vi.fn(),
}));

// loadGoogleClientSecret reads a bundled resource — stub so the test never
// touches the filesystem. Returns a test placeholder.
vi.mock('../../../../src/main/oauth/google/clientSecret', () => ({
  loadGoogleClientSecret: vi.fn(() => 'test-google-client-secret'),
}));

vi.mock('../../../../src/main/apiBaseUrl', () => ({
  PRODUCTION_API_BASE: 'https://api.concordvoice.chat',
  getApiBaseUrl: vi.fn(() => 'http://localhost:8080'),
}));

const profileMocks = vi.hoisted(() => ({
  isValidatedSelfHostedApiBase: vi.fn((apiBase: string) => apiBase === 'https://voice.example'),
  // sso.ts imports this too. Omitting it left the export `undefined`, so the
  // `isOriginApproved` callback would have thrown a TypeError the instant it ran —
  // which nothing noticed, because guardedRequest is mocked and never runs it. The
  // predicate is only testable once its own dependency exists here.
  isTier2DialApproved: vi.fn((apiBase: string) => apiBase === 'https://voice.example'),
}));

vi.mock('../../../../src/main/selfHostedProfile', async (orig) => ({
  // Passthrough so connectionRegistry (serviceIdForApiBase etc.) keeps working (#86 7B).
  ...(await orig<object>()),
  isValidatedSelfHostedApiBase: profileMocks.isValidatedSelfHostedApiBase,
  isTier2DialApproved: profileMocks.isTier2DialApproved,
}));

// #2354 §6.4: revokeExplicitSession (credentials:'omit') moves onto the guarded Node
// transport. The four credentials:'include' sites cannot follow it — Node has no cookie
// jar — so they stay on Electron net.fetch and are gated by the approval ceremony.
const guardedMocks = vi.hoisted(() => ({
  guardedRequest: vi.fn(async () => ({
    ok: true,
    status: 200,
    url: '',
    json: () => Promise.resolve({}),
  })),
}));

vi.mock('../../../../src/main/guardedRequest', () => ({
  guardedRequest: guardedMocks.guardedRequest,
  EgressDeniedError: class EgressDeniedError extends Error {},
}));

const tokenMocks = vi.hoisted(() => {
  let currentOwner = 40;
  let reservedOwner: number | null = null;
  let hasToken = false;

  const reserveCredentialOwner = vi.fn(() => {
    currentOwner += 1;
    reservedOwner = currentOwner;
    hasToken = false;
    return currentOwner;
  });
  const credentialOwnerIsCurrent = vi.fn((owner: number) => owner === currentOwner);
  const storeRefreshTokenIfOwner = vi.fn((_data: unknown, owner: number) => {
    if (owner !== currentOwner || reservedOwner !== owner || hasToken) return null;
    hasToken = true;
    reservedOwner = null;
    return owner;
  });
  const clearTokensIfOwner = vi.fn((owner: number) => {
    if (owner !== currentOwner) return false;
    currentOwner += 1;
    reservedOwner = null;
    hasToken = false;
    return true;
  });
  // #2394: mirrors the real primitive's triple guard — reserved, current
  // generation, and NO published credential. The published-credential clause is
  // what stops a stale abandon from wiping a live session (the D2 footgun).
  const releaseCredentialReservation = vi.fn(() => {
    if (reservedOwner === null || reservedOwner !== currentOwner || hasToken) return false;
    currentOwner += 1;
    reservedOwner = null;
    hasToken = false;
    return true;
  });

  const custody = {
    reserveCredentialOwner,
    credentialOwnerIsCurrent,
    storeRefreshTokenIfOwner,
    clearTokensIfOwner,
    releaseCredentialReservation,
  };
  // #86 Task 5: sso.ts reaches custody through custodyForApiBase(apiBase). The
  // reservation records which API base's custody it was made in, so the
  // reserveCredentialOwner assertions keep naming the API base.
  const custodyForApiBase = vi.fn((apiBase: string) => ({
    ...custody,
    reserveCredentialOwner: () => reserveCredentialOwner(apiBase),
  }));
  const liveCustody = vi.fn(() => custody);

  return {
    reserveCredentialOwner,
    credentialOwnerIsCurrent,
    storeRefreshTokenIfOwner,
    clearTokensIfOwner,
    releaseCredentialReservation,
    custodyForApiBase,
    liveCustody,
    reset: () => {
      currentOwner = 40;
      reservedOwner = null;
      hasToken = false;
    },
    supersedeCredential: () => {
      currentOwner += 1;
      reservedOwner = null;
      hasToken = true;
      return currentOwner;
    },
  };
});

vi.mock('../../../../src/main/tokenManager', () => ({
  custodyForApiBase: tokenMocks.custodyForApiBase,
  liveCustody: tokenMocks.liveCustody,
}));

// #2424: sso:completeMFA supplies X-Machine-Id via getMachineId; mock it to a
// fixed UUID so the MFA-verify POST is deterministic and touches no real file.
const TEST_MACHINE_ID = '33333333-3333-4333-8333-333333333333';
vi.mock('../../../../src/main/machineId', () => ({
  getMachineId: vi.fn(() => TEST_MACHINE_ID),
}));

import { __revokeExplicitSessionForTest, approvedApiBase, registerSSOIPC } from '@/main/ipc/sso';

interface FakeInvokeEvent {
  senderFrame: { url: string };
}

const TRUSTED = 'http://localhost:3001';
const UNTRUSTED = 'https://attacker.example';
const SAAS_API_BASE = 'https://api.concordvoice.chat';
const DEV_API_BASE = 'http://localhost:8080';
const SELF_HOSTED_API_BASE = 'https://voice.example';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SUCCESS_SESSION_ID = '22222222-2222-4222-8222-222222222222';

const registrationPayload = {
  provider: 'apple' as const,
  ssoToken: 'sso-token-1',
  username: 'alice',
  passphrase: 'correct horse battery staple', // pragma: allowlist secret
  wrappedPrivateKey: 'wrapped-key', // pragma: allowlist secret
  keyDerivationSalt: 'salt',
  publicKey: 'public-key',
};

const linkPayload = {
  provider: 'apple' as const,
  ssoToken: 'sso-token-1',
  password: 'account-password', // pragma: allowlist secret
};

// Ignored since #86 7B (admission reads the registry's remote-SPA source); the 7B
// describe below still passes it.
const getSpaBaseUrl = () => null;

describe('sso IPC handlers', () => {
  let startLoopbackHandler: (event: FakeInvokeEvent) => Promise<{
    port: number;
    redirectURI: string;
  }>;
  let awaitCallbackHandler: (
    event: FakeInvokeEvent,
    port: number
  ) => Promise<{ code: string; state: string }>;
  let cancelLoopbackHandler: (event: FakeInvokeEvent, port: number) => void;
  let appleSignInHandler: (event: FakeInvokeEvent, apiBase: unknown) => Promise<unknown>;
  let appleCancelHandler: (event: FakeInvokeEvent) => void;
  let googleSignInHandler: (event: FakeInvokeEvent, apiBase: unknown) => Promise<unknown>;
  let googleCancelHandler: (event: FakeInvokeEvent) => void;
  let completeRegistrationHandler: (
    event: FakeInvokeEvent,
    apiBase: unknown,
    payload: unknown
  ) => Promise<unknown>;
  let completeLinkHandler: (
    event: FakeInvokeEvent,
    apiBase: unknown,
    payload: unknown
  ) => Promise<unknown>;
  let completeMFAHandler: (
    event: FakeInvokeEvent,
    apiBase: unknown,
    payload: unknown
  ) => Promise<unknown>;
  let abandonReservationHandler: (event: FakeInvokeEvent) => boolean;

  // #86 Task 7B: the handlers are registerIpc admission wrappers, so a call must come
  // from a sender bound in the main-held connection registry. Each fake event keeps
  // its own senderFrame URL (TRUSTED / UNTRUSTED / null still decides admission) and
  // is re-pointed at the bound connection whose service origin the call names (the
  // saas connection otherwise). Each service has its own custody and session: the
  // custody forwards into tokenMocks with the service origin recorded on the
  // reservation, and the session fetch forwards into the net.fetch mock, so the
  // request-shape assertions below now pin the service session's fetch.
  const boundByOrigin = new Map<string, { id: number; contents: unknown }>();
  const bindFakeConnection = (origin: string, id: number): void => {
    const r = registerService(origin, {
      makeSession: () =>
        ({ fetch: (url: string, init?: RequestInit) => vi.mocked(net.fetch)(url, init) }) as never,
      makeCustody: (_serviceId: unknown, serviceOrigin: string) =>
        ({
          reserveCredentialOwner: () => tokenMocks.reserveCredentialOwner(serviceOrigin),
          credentialOwnerIsCurrent: tokenMocks.credentialOwnerIsCurrent,
          storeRefreshTokenIfOwner: tokenMocks.storeRefreshTokenIfOwner,
          clearTokensIfOwner: tokenMocks.clearTokensIfOwner,
          releaseCredentialReservation: tokenMocks.releaseCredentialReservation,
        }) as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!r.ok) throw new Error(r.reason);
    const contents = { id, mainFrame: { frameTreeNodeId: id } } as never;
    const o = openConnection(r.service.serviceId, contents, null);
    if (!o.ok) throw new Error(o.reason);
    bindSender(contents, o.record.connectionId, 'primary');
    boundByOrigin.set(r.service.origin, { id, contents });
  };
  const originOf = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const asBound = (fake: { senderFrame: { url: string } | null }, apiBase: unknown) => {
    const target = boundByOrigin.get(originOf(apiBase) ?? '') ?? boundByOrigin.get(SAAS_API_BASE);
    if (!target) throw new Error('no bound saas connection');
    return {
      sender: target.contents,
      senderFrame:
        fake.senderFrame === null
          ? null
          : {
              url: fake.senderFrame.url,
              parent: null,
              frameTreeNodeId: target.id,
              detached: false,
            },
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rebind =
    (raw: (...a: any[]) => any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: { senderFrame: { url: string } | null }, ...args: any[]) =>
      raw(asBound(event, args[0]), ...args);

  beforeEach(() => {
    vi.clearAllMocks();
    tokenMocks.reset();
    mocked.fakeHandles.length = 0;
    _resetConnectionRegistryForTesting();
    _resetIpcRegistryForTesting();
    setRemoteSpaOriginSource(() => null);
    boundByOrigin.clear();
    bindFakeConnection(SAAS_API_BASE, 41);
    bindFakeConnection(DEV_API_BASE, 42);
    bindFakeConnection(SELF_HOSTED_API_BASE, 43);
    registerSSOIPC();

    // Pull each handler out of the mocked ipcMain.handle / on calls.
    const startCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:startLoopback');
    const awaitCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:awaitCallback');
    const cancelCall = mocked.onSpy.mock.calls.find((c) => c[0] === 'sso:cancelLoopback');
    if (!startCall || !awaitCall || !cancelCall) {
      throw new Error('IPC handlers not registered');
    }
    startLoopbackHandler = rebind(startCall[1]);
    awaitCallbackHandler = rebind(awaitCall[1]);
    cancelLoopbackHandler = rebind(cancelCall[1]);

    const appleSignInCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:appleSignIn');
    const appleCancelCall = mocked.onSpy.mock.calls.find((c) => c[0] === 'sso:appleCancel');
    if (!appleSignInCall || !appleCancelCall) {
      throw new Error('apple IPC handlers not registered');
    }
    appleSignInHandler = rebind(appleSignInCall[1]);
    appleCancelHandler = rebind(appleCancelCall[1]);

    const googleSignInCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:googleSignIn');
    const googleCancelCall = mocked.onSpy.mock.calls.find((c) => c[0] === 'sso:googleCancel');
    if (!googleSignInCall || !googleCancelCall) {
      throw new Error('google IPC handlers not registered');
    }
    googleSignInHandler = rebind(googleSignInCall[1]);
    googleCancelHandler = rebind(googleCancelCall[1]);

    const completeRegistrationCall = mocked.handleSpy.mock.calls.find(
      (c) => c[0] === 'sso:completeRegistration'
    );
    const completeLinkCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:completeLink');
    const completeMFACall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:completeMFA');
    if (!completeRegistrationCall || !completeLinkCall || !completeMFACall) {
      throw new Error('SSO completion IPC handlers not registered');
    }
    completeRegistrationHandler = rebind(completeRegistrationCall[1]);
    completeLinkHandler = rebind(completeLinkCall[1]);
    completeMFAHandler = rebind(completeMFACall[1]);

    const abandonCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:abandonReservation');
    if (!abandonCall) throw new Error('sso:abandonReservation handler not registered');
    abandonReservationHandler = rebind(abandonCall[1]);
  });

  describe('sender-frame validation', () => {
    it('sso:startLoopback rejects untrusted sender frames', async () => {
      await expect(startLoopbackHandler({ senderFrame: { url: UNTRUSTED } })).rejects.toThrow(
        /untrusted/i
      );
      // Loopback must not even be started — the active map is empty.
      expect(mocked.fakeHandles.length).toBe(0);
    });

    it('sso:awaitCallback rejects untrusted sender frames', async () => {
      // Need a real entry in `active` first so we can prove the rejection
      // happens before the lookup; start a trusted loopback then attack
      // awaitCallback from a different frame URL.
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      await expect(awaitCallbackHandler({ senderFrame: { url: UNTRUSTED } }, port)).rejects.toThrow(
        /untrusted/i
      );
    });

    it('sso:cancelLoopback silently no-ops for untrusted sender frames', async () => {
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      // Capture pre-call state.
      const before = mocked.fakeHandles[0].__closeCalls;
      cancelLoopbackHandler({ senderFrame: { url: UNTRUSTED } }, port);
      // Untrusted cancel must not call close() on the active handle.
      expect(mocked.fakeHandles[0].__closeCalls).toBe(before);
    });
  });

  describe('active-map lifecycle', () => {
    it('sso:awaitCallback returns the loopback result and removes the active entry', async () => {
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      const handle = mocked.fakeHandles[0];

      // Simulate the OAuth provider redirect resolving the loopback promise.
      handle.__resolve({ code: 'auth-code', state: 'state-x' });

      const result = await awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, port);
      expect(result).toEqual({ code: 'auth-code', state: 'state-x' });

      // After awaitCallback returns, a second await on the same port should
      // fail with "unknown port" — the active map entry is gone. (Re-issuing
      // a fresh attempt would create a new entry under a new ephemeral port.)
      await expect(awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, port)).rejects.toThrow(
        /unknown port/i
      );
    });

    it('sso:cancelLoopback closes the handle and removes the active entry', async () => {
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      cancelLoopbackHandler({ senderFrame: { url: TRUSTED } }, port);
      expect(mocked.fakeHandles[0].__closeCalls).toBe(1);
      // Subsequent await on the cancelled port → unknown.
      await expect(awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, port)).rejects.toThrow(
        /unknown port/i
      );
    });

    it('cancelLoopback for an unknown port is a silent no-op', () => {
      // No-op behavior matters: a renderer that races cancel after the
      // promise has auto-cleaned up must not crash the main process.
      expect(() => cancelLoopbackHandler({ senderFrame: { url: TRUSTED } }, 99999)).not.toThrow();
    });

    it('auto-cleans the active entry when the loopback promise settles outside awaitCallback', async () => {
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      const handle = mocked.fakeHandles[0];

      // Reject the loopback promise (e.g. timeout) before awaitCallback is invoked.
      handle.__reject(new Error('oauth_timeout'));
      // Allow the .finally on the handler's auto-cleanup to flush.
      await new Promise((r) => setImmediate(r));

      // The active map entry must have been removed.
      await expect(awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, port)).rejects.toThrow(
        /unknown port/i
      );
    });
  });

  describe('unknown-port rejection', () => {
    it('sso:awaitCallback throws for a port that was never started', async () => {
      await expect(awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, 12345)).rejects.toThrow(
        /unknown port/i
      );
    });
  });

  describe('apple sign-in channels (#974)', () => {
    it('sso:appleSignIn rejects untrusted sender frames without starting a flow', async () => {
      await expect(
        appleSignInHandler({ senderFrame: { url: UNTRUSTED } }, SAAS_API_BASE)
      ).rejects.toThrow(/untrusted/i);
      expect(appleMocks.runAppleSignIn).not.toHaveBeenCalled();
    });

    it('stores the refresh credential before returning a sanitized SaaS result', async () => {
      const result = await appleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
      expect(tokenMocks.reserveCredentialOwner).toHaveBeenCalledWith(SAAS_API_BASE);
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledWith(
        {
          refreshToken: 'rt-1',
          rememberMe: true,
          apiBase: SAAS_API_BASE,
          accessToken: 'at-1',
        },
        41
      );
      expect(result).toEqual({
        kind: 'tokens',
        accessToken: 'at-1',
        sessionId: 'sid-1',
        credentialOwner: 41,
      });
      expect(result).not.toHaveProperty('refreshToken');
      expect(appleMocks.runAppleSignIn).toHaveBeenCalledTimes(1);
      const deps = appleMocks.runAppleSignIn.mock.calls[0][0];
      expect(deps.apiBase).toBe(SAAS_API_BASE);
      expect(typeof deps.controlPlaneFetch).toBe('function');
      expect(typeof deps.openExternal).toBe('function');
    });

    it.each([undefined, 3, 'not a URL', `${SAAS_API_BASE}/`, 'https://unapproved.example'])(
      'rejects invalid or unapproved API origin %j',
      async (apiBase) => {
        await expect(
          appleSignInHandler({ senderFrame: { url: TRUSTED } }, apiBase)
        ).rejects.toThrow(/unapproved API origin/i);
        expect(appleMocks.runAppleSignIn).not.toHaveBeenCalled();
      }
    );

    it('#86: passes the access token user_id claim as serverUserId on a direct SSO publish', async () => {
      const accessToken = accessTokenWithClaims({ user_id: 'sso-user-42', exp: 9_999_999_999 });
      appleMocks.runAppleSignIn.mockResolvedValueOnce({
        kind: 'tokens',
        accessToken,
        refreshToken: 'rt-claim',
        sessionId: 'sid-claim',
      });

      await appleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);

      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledWith(
        {
          refreshToken: 'rt-claim',
          rememberMe: true,
          apiBase: SAAS_API_BASE,
          accessToken,
          serverUserId: 'sso-user-42',
        },
        41
      );
    });

    it.each([
      ['an opaque token', 'opaque-access'],
      ['no user_id claim', accessTokenWithClaims({ sub: 'x' })],
      ['a non-string user_id', accessTokenWithClaims({ user_id: 42 })],
      ['an empty user_id', accessTokenWithClaims({ user_id: '' })],
      ['a control character in user_id', accessTokenWithClaims({ user_id: 'a\u0000b' })],
      ['an over-long user_id', accessTokenWithClaims({ user_id: 'u'.repeat(257) })],
      ['a payload that is not JSON', 'aGVhZGVy.bm90LWpzb24.sig'],
    ])(
      '#86: publishes with no serverUserId (null scope, no throw) for %s',
      async (_label, accessToken) => {
        appleMocks.runAppleSignIn.mockResolvedValueOnce({
          kind: 'tokens',
          accessToken,
          refreshToken: 'rt-bad-claim',
          sessionId: 'sid-bad-claim',
        });

        await expect(
          appleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE)
        ).resolves.toMatchObject({ kind: 'tokens', credentialOwner: 41 });

        const [stored] = tokenMocks.storeRefreshTokenIfOwner.mock.calls[0];
        expect(stored).not.toHaveProperty('serverUserId');
      }
    );

    it('dispatches an already probe-approved self-hosted origin exactly', async () => {
      await appleSignInHandler({ senderFrame: { url: TRUSTED } }, SELF_HOSTED_API_BASE);

      expect(appleMocks.runAppleSignIn.mock.calls[0][0].apiBase).toBe(SELF_HOSTED_API_BASE);
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledWith(
        expect.objectContaining({ apiBase: SELF_HOSTED_API_BASE }),
        41
      );
    });

    it('allows the exact main-configured development origin', async () => {
      await appleSignInHandler({ senderFrame: { url: TRUSTED } }, DEV_API_BASE);

      expect(appleMocks.runAppleSignIn.mock.calls[0][0].apiBase).toBe(DEV_API_BASE);
    });

    it('controlPlaneFetch resolves every input shape to a URL string and pins credentials', async () => {
      // S6551 regression: String(Request) would coerce to '[object Request]'.
      // Each fetch-input shape must reach net.fetch as its URL string, and
      // every call must carry credentials:'include' (the refresh-cookie jar
      // contract, plan deviation D2).
      await appleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
      const deps = appleMocks.runAppleSignIn.mock.calls[0][0];
      const netFetch = vi.mocked(net.fetch);

      await deps.controlPlaneFetch('https://api.test/a');
      await deps.controlPlaneFetch(new URL('https://api.test/b'));
      await deps.controlPlaneFetch({ url: 'https://api.test/c' }); // Request-shaped

      expect(netFetch.mock.calls.map((c) => c[0])).toEqual([
        'https://api.test/a',
        'https://api.test/b',
        'https://api.test/c',
      ]);
      for (const call of netFetch.mock.calls) {
        expect((call[1] as RequestInit).credentials).toBe('include');
      }
    });

    it('revokes a malformed successful /session response by captured cookie-bound session ID', async () => {
      vi.mocked(net.fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ unexpected: true }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-Concord-Session-ID': SESSION_ID,
            },
          })
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      appleMocks.runAppleSignIn.mockImplementationOnce(async (deps) => {
        await deps.controlPlaneFetch(`${SAAS_API_BASE}/api/v1/auth/sso/apple/session`, {
          method: 'POST',
        });
        return { kind: 'error', code: 'sso_session_rejected' } as never;
      });

      await expect(
        appleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE)
      ).resolves.toEqual({ kind: 'error', code: 'sso_session_rejected' });

      expect(net.fetch).toHaveBeenLastCalledWith(`${SAAS_API_BASE}/api/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Session-ID': SESSION_ID },
        signal: expect.any(AbortSignal),
      });
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
      expect(tokenMocks.clearTokensIfOwner).toHaveBeenCalledWith(41);
    });

    it('does not let a delayed SSO token overwrite a password credential and keys', async () => {
      let finishApple!: (result: {
        kind: 'tokens';
        accessToken: string;
        refreshToken: string;
        sessionId: string;
      }) => void;
      appleMocks.runAppleSignIn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishApple = resolve;
          })
      );

      const delayedSSO = appleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
      await vi.waitFor(() => expect(appleMocks.runAppleSignIn).toHaveBeenCalledTimes(1));
      tokenMocks.supersedeCredential();
      finishApple({
        kind: 'tokens',
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        sessionId: 'stale-session',
      });

      await expect(delayedSSO).resolves.toEqual({ kind: 'error', code: 'sso_cancelled' });
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
      // #2354 §6.4: the explicit-session revoke is credentials:'omit', so it moved onto
      // the guarded Node transport. It is the ONLY sso.ts egress that may.
      expect(guardedMocks.guardedRequest).toHaveBeenCalledWith(
        `${SAAS_API_BASE}/api/v1/auth/logout`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer stale-access',
            'X-Refresh-Token': 'stale-refresh',
          },
          isOriginApproved: expect.any(Function),
        }
      );
    });

    it('sso:appleCancel tears down the active flow for trusted frames', () => {
      appleCancelHandler({ senderFrame: { url: TRUSTED } });
      expect(appleMocks.cancelActiveAppleFlow).toHaveBeenCalledTimes(1);
    });

    it('sso:appleCancel silently no-ops for untrusted frames', () => {
      appleCancelHandler({ senderFrame: { url: UNTRUSTED } });
      expect(appleMocks.cancelActiveAppleFlow).not.toHaveBeenCalled();
    });
  });

  describe('SSO completion channels', () => {
    async function beginAppleCompletion(branch: 'new_user' | 'account_link' = 'new_user') {
      appleMocks.runAppleSignIn.mockImplementationOnce(
        async () =>
          ({
            kind: 'sso_token',
            branch,
            ssoToken: 'sso-token-1',
            ...(branch === 'new_user'
              ? { email: 'alice@example.com', name: 'Alice' }
              : { maskedEmail: 'a***@example.com' }),
          }) as never
      );
      return appleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
    }

    it('#86: passes the completion access token user_id claim as serverUserId', async () => {
      await beginAppleCompletion();
      const accessToken = accessTokenWithClaims({ user_id: 'registered-user-7' });
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: 'completion-refresh',
            session_id: SUCCESS_SESSION_ID,
            remember_me: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await completeRegistrationHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        registrationPayload
      );

      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken, serverUserId: 'registered-user-7' }),
        41
      );
    });

    it('completes registration in main, stores the owner-bound refresh credential, and sanitizes IPC', async () => {
      await expect(beginAppleCompletion()).resolves.toMatchObject({
        kind: 'sso_token',
        branch: 'new_user',
      });
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'completion-access',
            refresh_token: 'completion-refresh',
            session_id: SUCCESS_SESSION_ID,
            remember_me: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await completeRegistrationHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        registrationPayload
      );

      expect(result).toEqual({
        kind: 'tokens',
        accessToken: 'completion-access',
        sessionId: SUCCESS_SESSION_ID,
        credentialOwner: 41,
      });
      expect(result).not.toHaveProperty('refreshToken');
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledWith(
        {
          accessToken: 'completion-access',
          refreshToken: 'completion-refresh',
          rememberMe: true,
          apiBase: SAAS_API_BASE,
        },
        41
      );
      expect(net.fetch).toHaveBeenCalledWith(
        `${SAAS_API_BASE}/api/v1/auth/sso/apple/complete-registration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            sso_token: registrationPayload.ssoToken,
            username: registrationPayload.username,
            password: registrationPayload.passphrase,
            wrapped_private_key: registrationPayload.wrappedPrivateKey,
            key_derivation_salt: registrationPayload.keyDerivationSalt,
            public_key: registrationPayload.publicKey,
          }),
        }
      );
    });

    it('completes account linking only for the matching pending branch', async () => {
      await beginAppleCompletion('account_link');
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'link-access',
            refresh_token: 'link-refresh',
            session_id: SUCCESS_SESSION_ID,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(
        completeRegistrationHandler(
          { senderFrame: { url: TRUSTED } },
          SAAS_API_BASE,
          registrationPayload
        )
      ).resolves.toEqual({ kind: 'error', status: 409, code: 'sso_cancelled' });
      await expect(
        completeLinkHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, linkPayload)
      ).resolves.toEqual({
        kind: 'tokens',
        accessToken: 'link-access',
        sessionId: SUCCESS_SESSION_ID,
        credentialOwner: 41,
      });
    });

    it('returns only allowlisted server error fields and never leaks refresh material', async () => {
      await beginAppleCompletion();
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error_code: 'password_invalid',
            detail: 'Try again',
            attempts_remaining: 2,
            refresh_token: 'must-not-cross-ipc',
            access_token: 'must-not-cross-ipc',
            arbitrary: { secret: true },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await completeRegistrationHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        registrationPayload
      );
      expect(result).toEqual({
        kind: 'error',
        status: 401,
        code: 'password_invalid',
        body: {
          error_code: 'password_invalid',
          detail: 'Try again',
          attempts_remaining: 2,
        },
      });
      expect(JSON.stringify(result)).not.toContain('must-not-cross-ipc');
    });

    it('revokes a cookie-bound session when completion returns malformed 2xx JSON', async () => {
      await beginAppleCompletion();
      vi.mocked(net.fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'partial' }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-Concord-Session-ID': SESSION_ID,
            },
          })
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(
        completeRegistrationHandler(
          { senderFrame: { url: TRUSTED } },
          SAAS_API_BASE,
          registrationPayload
        )
      ).resolves.toEqual({ kind: 'error', status: 502, code: 'sso_session_rejected' });
      expect(net.fetch).toHaveBeenLastCalledWith(`${SAAS_API_BASE}/api/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Session-ID': SESSION_ID },
        signal: expect.any(AbortSignal),
      });
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
      expect(tokenMocks.clearTokensIfOwner).toHaveBeenCalledWith(41);
    });

    it('revokes a delayed completion that loses the credential-owner race', async () => {
      await beginAppleCompletion();
      let resolveCompletion!: (response: Response) => void;
      // Only ONE queued net.fetch response now: the completion POST. The revoke that
      // follows it goes through guardedRequest (#2354 §6.4), so a second queued `Once`
      // would go unconsumed and leak into the next test's net.fetch queue.
      vi.mocked(net.fetch).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCompletion = resolve;
          })
      );

      const delayedCompletion = completeRegistrationHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        registrationPayload
      );
      await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
      tokenMocks.supersedeCredential();
      resolveCompletion(
        new Response(
          JSON.stringify({
            access_token: 'stale-access',
            refresh_token: 'stale-refresh',
            session_id: SUCCESS_SESSION_ID,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(delayedCompletion).resolves.toEqual({
        kind: 'error',
        status: 409,
        code: 'sso_cancelled',
      });
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveReturnedWith(null);
      expect(guardedMocks.guardedRequest).toHaveBeenCalledWith(
        `${SAAS_API_BASE}/api/v1/auth/logout`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer stale-access',
            'X-Refresh-Token': 'stale-refresh',
          },
          isOriginApproved: expect.any(Function),
        }
      );
    });

    it('rejects untrusted completion senders before network or credential access', async () => {
      await expect(
        completeRegistrationHandler(
          { senderFrame: { url: UNTRUSTED } },
          SAAS_API_BASE,
          registrationPayload
        )
      ).rejects.toThrow(/untrusted/i);
      expect(net.fetch).not.toHaveBeenCalled();
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
    });
  });

  describe('SSO MFA completion (#2424)', () => {
    // Drive a google sign-in that returns mfa_challenge, establishing pendingMFA
    // + the reserved owner (41). finishSignIn attaches the owner to the result.
    async function beginGoogleMFA(token = 'mfa-tok-1') {
      googleMocks.runGoogleSignIn.mockImplementationOnce(
        async () =>
          ({
            kind: 'mfa_challenge',
            mfaChallengeToken: token,
            methods: ['totp'],
          }) as never
      );
      return googleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
    }

    const totpPayload = {
      provider: 'google' as const,
      mfaChallengeToken: 'mfa-tok-1',
      credentialOwner: 41,
      method: 'totp',
      code: '123456',
    };

    it('preserves the reserved owner across mfa_challenge and returns it as challenge context', async () => {
      await expect(beginGoogleMFA()).resolves.toEqual({
        kind: 'mfa_challenge',
        mfaChallengeToken: 'mfa-tok-1',
        methods: ['totp'],
        credentialOwner: 41,
      });
      // The owner was NOT released (no clearTokensIfOwner on the MFA branch).
      expect(tokenMocks.clearTokensIfOwner).not.toHaveBeenCalled();
    });

    it('#86: passes the MFA access token user_id claim as serverUserId', async () => {
      await beginGoogleMFA();
      const accessToken = accessTokenWithClaims({ user_id: 'mfa-user-9' });
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: 'mfa-refresh',
            session_id: SUCCESS_SESSION_ID,
            remember_me: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, totpPayload);

      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken, serverUserId: 'mfa-user-9' }),
        41
      );
    });

    it('verifies MFA in main, stores the owner-bound credential, and sanitizes IPC', async () => {
      await beginGoogleMFA();
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'mfa-access',
            refresh_token: 'mfa-refresh',
            session_id: SUCCESS_SESSION_ID,
            remember_me: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await completeMFAHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        totpPayload
      );

      expect(result).toEqual({
        kind: 'tokens',
        accessToken: 'mfa-access',
        sessionId: SUCCESS_SESSION_ID,
        credentialOwner: 41,
      });
      expect(result).not.toHaveProperty('refreshToken');
      expect(JSON.stringify(result)).not.toContain('mfa-refresh');
      // Refresh credential stored owner-scoped in main (never returned).
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledWith(
        {
          accessToken: 'mfa-access',
          refreshToken: 'mfa-refresh',
          rememberMe: true,
          apiBase: SAAS_API_BASE,
        },
        41
      );
      // Verify happened in main, with the machine-id header and the exact body.
      expect(net.fetch).toHaveBeenCalledWith(`${SAAS_API_BASE}/api/v1/auth/mfa/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Machine-Id': TEST_MACHINE_ID,
        },
        credentials: 'include',
        body: JSON.stringify({
          mfa_challenge_token: 'mfa-tok-1',
          method: 'totp',
          code: '123456',
        }),
        signal: expect.any(AbortSignal),
      });
    });

    it('carries a WebAuthn assertion through to the verify body', async () => {
      await beginGoogleMFA();
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'mfa-access-wa',
            refresh_token: 'mfa-refresh-wa',
            session_id: SUCCESS_SESSION_ID,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, {
        provider: 'google',
        mfaChallengeToken: 'mfa-tok-1',
        credentialOwner: 41,
        method: 'webauthn',
        assertion: { id: 'cred-1', rawId: 'AAAA' },
      });

      expect(result).toMatchObject({ kind: 'tokens', credentialOwner: 41 });
      expect(net.fetch).toHaveBeenCalledWith(`${SAAS_API_BASE}/api/v1/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Machine-Id': TEST_MACHINE_ID },
        credentials: 'include',
        body: JSON.stringify({
          mfa_challenge_token: 'mfa-tok-1',
          method: 'webauthn',
          assertion: { id: 'cred-1', rawId: 'AAAA' },
        }),
        signal: expect.any(AbortSignal),
      });
    });

    // A proof in flight disables the challenge's Cancel, so the verify must
    // settle. The bound lives here, where the credential is stored: a
    // renderer-side timeout could not stop main storing a late one (#3423).
    it('bounds the verify request at 30 s and stores nothing when it times out', async () => {
      await beginGoogleMFA();
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      vi.mocked(net.fetch).mockRejectedValueOnce(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      );

      const result = await completeMFAHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        totpPayload
      );

      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(vi.mocked(net.fetch).mock.calls[0][1]?.signal).toBe(timeout.mock.results[0].value);
      expect(result).toEqual({ kind: 'error', status: 0, code: 'sso_mfa_verify_failed' });
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
      expect(tokenMocks.clearTokensIfOwner).not.toHaveBeenCalled();
      timeout.mockRestore();

      // The server may never have seen the proof, so a retry must still reach it.
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'mfa-access-retry',
            refresh_token: 'mfa-refresh-retry',
            session_id: SUCCESS_SESSION_ID,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, totpPayload)
      ).resolves.toMatchObject({ kind: 'tokens', credentialOwner: 41 });
    });

    it('stores nothing and revokes the session when the body stops mid-read', async () => {
      await beginGoogleMFA();
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      // What an abort after the headers looks like: the stream errors mid-body.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"access_token":'));
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        },
      });
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Concord-Session-ID': SESSION_ID },
        })
      );

      const result = await completeMFAHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        totpPayload
      );

      expect(result).toMatchObject({ kind: 'error', code: 'sso_session_rejected' });
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
      expect(net.fetch).toHaveBeenLastCalledWith(`${SAAS_API_BASE}/api/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Session-ID': SESSION_ID },
        signal: expect.any(AbortSignal),
      });
      expect(tokenMocks.clearTokensIfOwner).toHaveBeenCalledWith(41);
      // The logout is bounded at 10 s, so it cannot re-open the hang the verify
      // timeout closes. The verify's own 30 s call comes first; find by value.
      const revokeCall = timeout.mock.calls.findIndex(([ms]) => ms === 10_000);
      expect(revokeCall, 'the logout must get its own 10 s bound').toBeGreaterThanOrEqual(0);
      expect(vi.mocked(net.fetch).mock.lastCall?.[1]?.signal).toBe(
        timeout.mock.results[revokeCall].value
      );
      timeout.mockRestore();
      // pendingMFA is gone: a replay is refused at the pendingMFA gate, before
      // the owner check (which would also refuse it) and before any fetch.
      const fetches = vi.mocked(net.fetch).mock.calls.length;
      tokenMocks.credentialOwnerIsCurrent.mockClear();
      await expect(
        completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, totpPayload)
      ).resolves.toMatchObject({ kind: 'error', status: 409 });
      expect(tokenMocks.credentialOwnerIsCurrent).not.toHaveBeenCalled();
      expect(vi.mocked(net.fetch).mock.calls.length).toBe(fetches);
    });

    it('rejects an untrusted sender frame before any network or credential access', async () => {
      await beginGoogleMFA();
      await expect(
        completeMFAHandler({ senderFrame: { url: UNTRUSTED } }, SAAS_API_BASE, totpPayload)
      ).rejects.toThrow(/untrusted/i);
      expect(net.fetch).not.toHaveBeenCalled();
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
    });

    it('rejects a malformed payload with 400 and no side effects', async () => {
      await beginGoogleMFA();
      const result = await completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, {
        provider: 'google',
        mfaChallengeToken: 'mfa-tok-1',
        credentialOwner: 41,
        // method missing → isCompleteMFAPayload fails
      });
      expect(result).toEqual({ kind: 'error', status: 400, code: 'sso_invalid_request' });
      expect(net.fetch).not.toHaveBeenCalled();
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
    });

    it('rejects a payload whose owner/token does not match pendingMFA (409, no fetch/store)', async () => {
      await beginGoogleMFA();
      const result = await completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, {
        ...totpPayload,
        credentialOwner: 999, // not the reserved owner
      });
      expect(result).toEqual({ kind: 'error', status: 409, code: 'sso_cancelled' });
      expect(net.fetch).not.toHaveBeenCalled();
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
    });

    it('surfaces only allowlisted verify-error fields, never leaks refresh material, and preserves the reservation', async () => {
      await beginGoogleMFA();
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error_code: 'mfa_code_invalid',
            detail: 'Try again',
            attempts_remaining: 2,
            refresh_token: 'must-not-cross-ipc',
            access_token: 'must-not-cross-ipc',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await completeMFAHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        totpPayload
      );
      expect(result).toEqual({
        kind: 'error',
        status: 401,
        code: 'mfa_code_invalid',
        body: { error_code: 'mfa_code_invalid', detail: 'Try again', attempts_remaining: 2 },
      });
      expect(JSON.stringify(result)).not.toContain('must-not-cross-ipc');
      expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
      // Reservation preserved: a retry still reaches the network (pendingMFA intact).
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'mfa-access-retry',
            refresh_token: 'mfa-refresh-retry',
            session_id: SUCCESS_SESSION_ID,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      const retry = await completeMFAHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        totpPayload
      );
      expect(retry).toMatchObject({ kind: 'tokens', credentialOwner: 41 });
    });

    it('revokes a delayed completion that loses the credential-owner race (TOCTOU)', async () => {
      await beginGoogleMFA();
      let resolveVerify!: (response: Response) => void;
      // Only ONE queued net.fetch response: the MFA verify POST. The revoke that follows
      // goes through guardedRequest (#2354 §6.4), so a second queued `Once` would go
      // unconsumed and leak into the next test's net.fetch queue.
      vi.mocked(net.fetch).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve;
          })
      );

      const delayed = completeMFAHandler(
        { senderFrame: { url: TRUSTED } },
        SAAS_API_BASE,
        totpPayload
      );
      await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
      tokenMocks.supersedeCredential(); // a successor establishes credentials mid-verify
      resolveVerify(
        new Response(
          JSON.stringify({
            access_token: 'stale-access',
            refresh_token: 'stale-refresh',
            session_id: SUCCESS_SESSION_ID,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(delayed).resolves.toEqual({ kind: 'error', status: 409, code: 'sso_cancelled' });
      // The CAS store rejected (owner no longer current) — no successor overwrite.
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveReturnedWith(null);
      expect(guardedMocks.guardedRequest).toHaveBeenCalledWith(
        `${SAAS_API_BASE}/api/v1/auth/logout`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer stale-access', 'X-Refresh-Token': 'stale-refresh' },
          isOriginApproved: expect.any(Function),
        }
      );
    });
  });

  describe('sso:abandonReservation (#2394)', () => {
    // Drive a google sign-in that parks an sso_token completion, establishing
    // pendingCompletion + the reserved owner (41).
    async function beginGoogleRegistration(ssoToken = 'st-1') {
      googleMocks.runGoogleSignIn.mockImplementationOnce(
        async () =>
          ({
            kind: 'sso_token',
            branch: 'new_user',
            ssoToken,
            email: 'alice@example.com',
            name: 'Alice',
          }) as never
      );
      return googleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
    }

    // Drive a google sign-in that parks an MFA challenge, establishing
    // pendingMFA + the reserved owner (41).
    async function beginGoogleMFAChallenge(token = 'mfa-tok-1') {
      googleMocks.runGoogleSignIn.mockImplementationOnce(
        async () =>
          ({
            kind: 'mfa_challenge',
            mfaChallengeToken: token,
            methods: ['totp'],
          }) as never
      );
      return googleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
    }

    const googleRegistrationPayload = {
      ...registrationPayload,
      provider: 'google' as const,
      ssoToken: 'st-1',
    };

    const googleTotpPayload = {
      provider: 'google' as const,
      mfaChallengeToken: 'mfa-tok-1',
      credentialOwner: 41,
      method: 'totp',
      code: '123456',
    };

    it('releases the reservation and discards pendingCompletion', async () => {
      await expect(beginGoogleRegistration()).resolves.toMatchObject({ kind: 'sso_token' });

      expect(abandonReservationHandler({ senderFrame: { url: TRUSTED } })).toBe(true);
      expect(tokenMocks.releaseCredentialReservation).toHaveBeenCalledTimes(1);

      vi.mocked(net.fetch).mockClear();
      tokenMocks.credentialOwnerIsCurrent.mockClear();

      await expect(
        completeRegistrationHandler(
          { senderFrame: { url: TRUSTED } },
          SAAS_API_BASE,
          googleRegistrationPayload
        )
      ).resolves.toEqual({ kind: 'error', status: 409, code: 'sso_cancelled' });
      expect(net.fetch).not.toHaveBeenCalled();
      // The 409 came from the DISCARDED pending, not from completeSSO's owner
      // CAS — that path would have called credentialOwnerIsCurrent. Without
      // this assertion the generation bump alone would satisfy the 409.
      expect(tokenMocks.credentialOwnerIsCurrent).not.toHaveBeenCalled();
    });

    it('releases the reservation and discards pendingMFA', async () => {
      await expect(beginGoogleMFAChallenge()).resolves.toMatchObject({ kind: 'mfa_challenge' });

      expect(abandonReservationHandler({ senderFrame: { url: TRUSTED } })).toBe(true);
      expect(tokenMocks.releaseCredentialReservation).toHaveBeenCalledTimes(1);

      vi.mocked(net.fetch).mockClear();
      tokenMocks.credentialOwnerIsCurrent.mockClear();

      await expect(
        completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, googleTotpPayload)
      ).resolves.toEqual({ kind: 'error', status: 409, code: 'sso_cancelled' });
      expect(net.fetch).not.toHaveBeenCalled();
      expect(tokenMocks.credentialOwnerIsCurrent).not.toHaveBeenCalled();
    });

    it('rejects an untrusted sender frame without mutating any state', async () => {
      await beginGoogleMFAChallenge();

      expect(abandonReservationHandler({ senderFrame: { url: UNTRUSTED } })).toBe(false);
      expect(tokenMocks.releaseCredentialReservation).not.toHaveBeenCalled();

      // The pendings survive an untrusted call — the frame check runs AHEAD of
      // the discard, so a completion still reaches the network and succeeds.
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'mfa-access',
            refresh_token: 'mfa-refresh',
            session_id: SUCCESS_SESSION_ID,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, googleTotpPayload)
      ).resolves.toMatchObject({ kind: 'tokens', credentialOwner: 41 });
    });

    it('rejects a null sender frame', () => {
      expect(abandonReservationHandler({ senderFrame: null } as never)).toBe(false);
      expect(tokenMocks.releaseCredentialReservation).not.toHaveBeenCalled();
    });

    // Gitar (PR #2655): a release that returned false changed NOTHING, so it
    // must destroy nothing. This handler is invoked from stale UI that can sit
    // in the IPC queue, and an unconditional discard could wipe a NEWER
    // sign-in's live pendingMFA while doing no useful work.
    it('returns false when there is no reservation, and PRESERVES the pendings', async () => {
      await beginGoogleMFAChallenge();
      // A successor credential took the slot, so the release is a structural
      // no-op. The pending must survive it untouched.
      tokenMocks.supersedeCredential();

      expect(abandonReservationHandler({ senderFrame: { url: TRUSTED } })).toBe(false);
      expect(tokenMocks.releaseCredentialReservation).toHaveReturnedWith(false);

      vi.mocked(net.fetch).mockClear();
      tokenMocks.credentialOwnerIsCurrent.mockClear();

      // Still 409s — but via the stale owner CAS, not via a missing pending.
      await expect(
        completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, googleTotpPayload)
      ).resolves.toEqual({ kind: 'error', status: 409, code: 'sso_cancelled' });
      expect(net.fetch).not.toHaveBeenCalled();
      // Load-bearing: a DISCARDED pendingMFA would bail before the owner check
      // and 409 with the CAS never called. The CAS having been called is what
      // proves the pending survived and was evaluated on its merits.
      expect(tokenMocks.credentialOwnerIsCurrent).toHaveBeenCalled();
    });

    // AC5 — a completion already past its pre-fetch owner check, racing the
    // abandon, must not leave an orphaned server session behind.
    it('revokes the issued server session when a completion races the abandon', async () => {
      await beginGoogleMFAChallenge();

      // The verify POST resolves 200 with a well-formed body, but the abandon
      // lands while it is in flight, so storeRefreshTokenIfOwner refuses the
      // now-stale owner and BOTH issued sessions must be revoked.
      vi.mocked(net.fetch)
        .mockImplementationOnce(async () => {
          abandonReservationHandler({ senderFrame: { url: TRUSTED } });
          return new Response(
            JSON.stringify({
              access_token: 'raced-access',
              refresh_token: 'raced-refresh',
              session_id: SUCCESS_SESSION_ID,
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'X-Concord-Session-ID': SESSION_ID,
              },
            }
          );
        })
        // Exactly ONE more net.fetch follows: revokeCookieBoundSession. The explicit-session
        // revoke moved onto guardedRequest (#2354 §6.4), so a second queued `Once` here goes
        // unconsumed — and vi.clearAllMocks() does NOT drain the once-queue, so it would leak
        // into whichever later test consumes net.fetch next.
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(
        completeMFAHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE, googleTotpPayload)
      ).resolves.toEqual({ kind: 'error', status: 409, code: 'sso_cancelled' });

      // The CAS store rejected — the raced credential was never adopted.
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveReturnedWith(null);
      // revokeCookieBoundSession then revokeExplicitSession, both against
      // /api/v1/auth/logout (the real endpoints in ipc/sso.ts). They now travel on
      // DIFFERENT transports: #2354 §6.4 moved revokeExplicitSession onto the guarded
      // Node transport because it is the one credentials:'omit' egress here, while
      // revokeCookieBoundSession must stay on Electron net.fetch — Node has no cookie
      // jar, and dropping that cookie would strand the session at access-token expiry.
      expect(net.fetch).toHaveBeenNthCalledWith(2, `${SAAS_API_BASE}/api/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Session-ID': SESSION_ID },
        signal: expect.any(AbortSignal),
      });
      expect(guardedMocks.guardedRequest).toHaveBeenCalledWith(
        `${SAAS_API_BASE}/api/v1/auth/logout`,
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer raced-access',
            'X-Refresh-Token': 'raced-refresh',
          },
        })
      );
    });
  });

  describe('google sign-in channels (#975)', () => {
    it('sso:googleSignIn rejects untrusted sender frames without starting a flow', async () => {
      await expect(
        googleSignInHandler({ senderFrame: { url: UNTRUSTED } }, SAAS_API_BASE)
      ).rejects.toThrow(/untrusted/i);
      expect(googleMocks.runGoogleSignIn).not.toHaveBeenCalled();
    });

    it('sso:googleSignIn dispatches runGoogleSignIn with clientSecret for trusted frames', async () => {
      const result = await googleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
      expect(result).toEqual({
        kind: 'tokens',
        accessToken: 'g-at-1',
        sessionId: 'g-sid-1',
        credentialOwner: 41,
      });
      expect(googleMocks.runGoogleSignIn).toHaveBeenCalledTimes(1);
      const deps = googleMocks.runGoogleSignIn.mock.calls[0][0];
      // clientSecret is the non-confidential embedded secret — must be present.
      expect(deps.clientSecret).toBe('test-google-client-secret');
      // client_id is NOT passed — googleFlow parses it from the server-built
      // authorize URL (sourced from the control-plane's GOOGLE_CLIENT_ID config).
      expect(deps).not.toHaveProperty('clientId');
      expect(typeof deps.controlPlaneFetch).toBe('function');
    });

    it('does not let an older provider completion overwrite a newer credential', async () => {
      let finishApple!: (result: {
        kind: 'tokens';
        accessToken: string;
        refreshToken: string;
        sessionId: string;
      }) => void;
      appleMocks.runAppleSignIn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishApple = resolve;
          })
      );

      const older = appleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
      await vi.waitFor(() => expect(appleMocks.runAppleSignIn).toHaveBeenCalled());
      await googleSignInHandler({ senderFrame: { url: TRUSTED } }, SAAS_API_BASE);
      finishApple({
        kind: 'tokens',
        accessToken: 'old-at',
        refreshToken: 'old-rt',
        sessionId: 'old-sid',
      });

      await expect(older).resolves.toEqual({ kind: 'error', code: 'sso_cancelled' });
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledTimes(1);
      expect(tokenMocks.storeRefreshTokenIfOwner).toHaveBeenCalledWith(
        expect.objectContaining({ refreshToken: 'g-rt-1' }),
        42
      );
      expect(guardedMocks.guardedRequest).toHaveBeenCalledWith(
        `${SAAS_API_BASE}/api/v1/auth/logout`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer old-at',
            'X-Refresh-Token': 'old-rt',
          },
          isOriginApproved: expect.any(Function),
        }
      );
    });

    it('sso:googleCancel tears down the active flow for trusted frames', () => {
      googleCancelHandler({ senderFrame: { url: TRUSTED } });
      expect(googleMocks.cancelActiveGoogleFlow).toHaveBeenCalledTimes(1);
    });

    it('sso:googleCancel silently no-ops for untrusted frames', () => {
      googleCancelHandler({ senderFrame: { url: UNTRUSTED } });
      expect(googleMocks.cancelActiveGoogleFlow).not.toHaveBeenCalled();
    });
  });
});

describe('approvedApiBase tier-1 pre-flight (#2354 §6.5)', () => {
  const defaultApproval = (apiBase: string) => apiBase === SELF_HOSTED_API_BASE;

  afterEach(() => {
    profileMocks.isValidatedSelfHostedApiBase.mockImplementation(defaultApproval);
  });

  it('refuses a tier-1 IP-literal apiBase even when the approvals store claims it', () => {
    // A tier-1 literal can never enter the set through the ceremony; this defends a
    // hand-edited/tampered self-hosted-approvals.json, or a future path that adds to
    // the set outside the ceremony. It is synchronous and IP-literal-only, so it does
    // NOT close a TOCTOU window.
    profileMocks.isValidatedSelfHostedApiBase.mockReturnValue(true);
    expect(approvedApiBase('https://169.254.169.254')).toBeNull();
  });

  it('refuses a bracketed tier-1 IPv6 literal', () => {
    profileMocks.isValidatedSelfHostedApiBase.mockReturnValue(true);
    expect(approvedApiBase('https://[fe80::1]')).toBeNull();
  });

  it('passes the production SaaS origin through unchanged', () => {
    expect(approvedApiBase(SAAS_API_BASE)).toBe(SAAS_API_BASE);
  });

  it('passes an approved self-hosted hostname through (pre-flight is IP-literal-only)', () => {
    expect(approvedApiBase(SELF_HOSTED_API_BASE)).toBe(SELF_HOSTED_API_BASE);
  });

  // The pre-flight is TIER-1-ONLY by design. Every other case here is a hostname or a
  // tier-1 literal, so all of them stay green if the condition is tightened from
  // `.tier === 'tier1'` to `.tier !== 'public'` — and that tightening silently strips
  // credential custody from every localhost/LAN self-hoster, the most common deployment
  // this feature exists to serve. These two are the only tests that can catch it.
  it.each([
    ['an approved IPv4 loopback literal', 'https://127.0.0.1:8443'],
    ['an approved RFC1918 literal', 'https://192.168.1.20:8443'],
  ])('passes %s through (tier 2 is approvable, only tier 1 is refused)', (_label, apiBase) => {
    profileMocks.isValidatedSelfHostedApiBase.mockImplementation((v: string) => v === apiBase);
    expect(approvedApiBase(apiBase)).toBe(apiBase);
  });

  it('still refuses an origin that is not approved', () => {
    expect(approvedApiBase('https://not-approved.example')).toBeNull();
  });

  it('refuses a non-string value', () => {
    expect(approvedApiBase(42)).toBeNull();
  });
});

describe('revokeExplicitSession egress (#2354 §6.4)', () => {
  const tokens = {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    sessionId: SESSION_ID,
    rememberMe: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the explicit-session revoke through the guarded transport, not net.fetch', async () => {
    await __revokeExplicitSessionForTest(SAAS_API_BASE, tokens);

    expect(guardedMocks.guardedRequest).toHaveBeenCalledWith(
      `${SAAS_API_BASE}/api/v1/auth/logout`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('swallows a guarded-transport failure — server-side expiry is the backstop', async () => {
    guardedMocks.guardedRequest.mockRejectedValueOnce(new Error('egress denied'));

    await expect(__revokeExplicitSessionForTest(SAAS_API_BASE, tokens)).resolves.toBeUndefined();
    expect(net.fetch).not.toHaveBeenCalled();
  });

  // The whole point of routing this egress through guardedRequest is the TIER bound on
  // the dial. `expect.any(Function)` proves a callback was passed and nothing about what
  // it decides — a regression to `() => true`, or back to the ORIGIN-trust predicate
  // `isValidatedSelfHostedApiBase` (which re-opens public-consent → loopback dial, the
  // exact hole #2354 closes), satisfies it identically. So capture the callback and run
  // it. Mirrors selfHostedDialConsent.test.ts, which does the same for the probe egress.
  describe('the isOriginApproved callback is the tier-2 dial predicate, not a constant', () => {
    const LOOPBACK_ORIGIN = 'http://127.0.0.1:8443';

    // vi.clearAllMocks() clears CALLS, not implementations, so a mockReturnValue set here
    // would otherwise outlive the test that set it.
    afterEach(() => {
      profileMocks.isTier2DialApproved.mockImplementation(
        (apiBase: string) => apiBase === SELF_HOSTED_API_BASE
      );
      profileMocks.isValidatedSelfHostedApiBase.mockImplementation(
        (apiBase: string) => apiBase === SELF_HOSTED_API_BASE
      );
    });

    async function captureIsOriginApproved(): Promise<(origin: string) => boolean> {
      await __revokeExplicitSessionForTest(SELF_HOSTED_API_BASE, tokens);
      expect(guardedMocks.guardedRequest).toHaveBeenCalledTimes(1);
      const opts = guardedMocks.guardedRequest.mock.calls[0][1] as {
        isOriginApproved: (origin: string) => boolean;
      };
      expect(typeof opts.isOriginApproved).toBe('function');
      return opts.isOriginApproved;
    }

    it('delegates to isTier2DialApproved and returns its verdict verbatim', async () => {
      const isOriginApproved = await captureIsOriginApproved();

      profileMocks.isTier2DialApproved.mockReturnValue(false);
      expect(isOriginApproved(LOOPBACK_ORIGIN)).toBe(false);

      profileMocks.isTier2DialApproved.mockReturnValue(true);
      expect(isOriginApproved(LOOPBACK_ORIGIN)).toBe(true);

      // Both directions came from the tier predicate, so a constant cannot pass.
      expect(profileMocks.isTier2DialApproved).toHaveBeenCalledWith(LOOPBACK_ORIGIN);
    });

    it('consults the DIAL predicate, never the origin-trust one', async () => {
      const isOriginApproved = await captureIsOriginApproved();
      profileMocks.isTier2DialApproved.mockClear();
      profileMocks.isValidatedSelfHostedApiBase.mockClear();

      isOriginApproved(LOOPBACK_ORIGIN);

      expect(profileMocks.isTier2DialApproved).toHaveBeenCalledTimes(1);
      // Origin trust admits credential custody; it must NOT admit a tier-2 dial. If this
      // fires, the predicate was swapped back to the pre-#2354 one.
      expect(profileMocks.isValidatedSelfHostedApiBase).not.toHaveBeenCalled();
    });

    it('an origin trusted for custody is still refused the dial without tier-2 consent', async () => {
      const isOriginApproved = await captureIsOriginApproved();
      // The realistic post-#2354 split: the ceremony displayed a PUBLIC address, so the
      // origin holds credentials but has no tier-2 consent behind it.
      profileMocks.isValidatedSelfHostedApiBase.mockReturnValue(true);
      profileMocks.isTier2DialApproved.mockReturnValue(false);

      expect(isOriginApproved(LOOPBACK_ORIGIN)).toBe(false);
    });
  });
});

// #86 Task 7B: binding-derived semantics. Handlers are registered through registerIpc, so
// the spy's handlers are the admission wrappers; events carry a sender bound in the main-held
// connection registry. The session fetch comes from each service's own session.
import {
  _resetConnectionRegistryForTesting,
  bindSender,
  openConnection,
  registerService,
  setForeground,
} from '../../../../src/main/connectionRegistry';
import {
  _resetIpcRegistryForTesting,
  setRemoteSpaOriginSource,
} from '../../../../src/main/ipc/registry';

describe('sso owner-scoping and session fetch (#86 7B)', () => {
  const sessionFetch = vi.fn(async () => new Response('{}', { status: 200 }));
  const ORIGIN_A = 'https://a.example';
  const ORIGIN_B = 'https://b.example';
  const bound = (origin: string, id: number) => {
    const r = registerService(origin, {
      makeSession: () => ({ fetch: sessionFetch }) as never,
      makeCustody: () => tokenMocks as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!r.ok) throw new Error(r.reason);
    const wc = { id, mainFrame: { frameTreeNodeId: id } } as never;
    const o = openConnection(r.service.serviceId, wc, null);
    if (!o.ok) throw new Error(o.reason);
    bindSender(wc, o.record.connectionId, 'primary');
    return { wc, record: o.record };
  };
  const ev = (wc: unknown) => {
    const id = (wc as { mainFrame: { frameTreeNodeId: number } }).mainFrame.frameTreeNodeId;
    return {
      sender: wc,
      senderFrame: {
        url: 'app://concord/index.html',
        parent: null,
        frameTreeNodeId: id,
        detached: false,
      },
    };
  };
  const handler = (channel: string) => {
    const c = [...mocked.handleSpy.mock.calls, ...mocked.onSpy.mock.calls].find(
      (x) => x[0] === channel
    );
    if (!c) throw new Error(`${channel} not registered`);
    return c[1] as (...a: unknown[]) => Promise<unknown>;
  };
  let A: ReturnType<typeof bound>;
  let B: ReturnType<typeof bound>;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenMocks.reset();
    mocked.fakeHandles.length = 0;
    profileMocks.isValidatedSelfHostedApiBase.mockImplementation(() => true);
    profileMocks.isTier2DialApproved.mockImplementation(() => true);
    _resetConnectionRegistryForTesting();
    _resetIpcRegistryForTesting();
    setRemoteSpaOriginSource(() => null);
    A = bound(ORIGIN_A, 1);
    B = bound(ORIGIN_B, 2);
    setForeground(A.record.connectionId);
    registerSSOIPC(getSpaBaseUrl);
  });

  afterEach(() => {
    const only = (b: string) => b === 'https://voice.example';
    profileMocks.isValidatedSelfHostedApiBase.mockImplementation(only);
    profileMocks.isTier2DialApproved.mockImplementation(only);
  });

  it('awaitCallback and cancelLoopback from a non-owner connection are refused', async () => {
    const started = (await handler('sso:startLoopback')(ev(A.wc))) as { port: number };
    const handle = mocked.fakeHandles[0];
    const outcome = await Promise.race([
      handler('sso:awaitCallback')(ev(B.wc), started.port).then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise((r) => setTimeout(() => r('hung'), 100)),
    ]);
    expect(outcome).toBe('rejected');
    await handler('sso:cancelLoopback')(ev(B.wc), started.port);
    expect(handle.__closeCalls).toBe(0);
    await handler('sso:cancelLoopback')(ev(A.wc), started.port);
    expect(handle.__closeCalls).toBe(1);
  });

  it('the SSO fetch goes through the sender service session, not net.fetch, with credentials include', async () => {
    await handler('sso:appleSignIn')(ev(A.wc), ORIGIN_A);
    const deps = appleMocks.runAppleSignIn.mock.calls[0][0] as {
      controlPlaneFetch: (u: string, i?: RequestInit) => Promise<Response>;
    };
    await deps.controlPlaneFetch(`${ORIGIN_A}/x`, { method: 'POST', headers: { h: '1' } });
    expect(sessionFetch).toHaveBeenCalledWith(`${ORIGIN_A}/x`, {
      method: 'POST',
      headers: { h: '1' },
      credentials: 'include',
    });
    expect(vi.mocked(net.fetch)).not.toHaveBeenCalled();
  });

  it("a pending MFA set by A is invisible to B's sso:completeMFA", async () => {
    appleMocks.runAppleSignIn.mockResolvedValueOnce({
      kind: 'mfa_challenge',
      mfaChallengeToken: 'tok-A',
      methods: ['totp'],
    } as never);
    const started = (await handler('sso:appleSignIn')(ev(A.wc), ORIGIN_A)) as {
      credentialOwner: number;
    };
    const out = await handler('sso:completeMFA')(ev(B.wc), ORIGIN_B, {
      provider: 'apple',
      mfaChallengeToken: 'tok-A',
      method: 'totp',
      code: '123456',
      credentialOwner: started.credentialOwner,
    });
    expect(out).toMatchObject({ kind: 'error', code: 'sso_cancelled' });
    expect(sessionFetch).not.toHaveBeenCalled();
    expect(vi.mocked(net.fetch)).not.toHaveBeenCalled();
  });
});

// #86 Task 7B (implementer negatives): the owner-generation fence after every await and
// the owner-scoped provider cancel. Each test fails if its guard in sso.ts is removed.
import { advanceGeneration } from '../../../../src/main/connectionRegistry';

describe('sso connection fences (#86 7B)', () => {
  const sessionFetch = vi.fn(async () => new Response('{}', { status: 200 }));
  const ORIGIN_A = 'https://a.example';
  const ORIGIN_B = 'https://b.example';
  const bound = (origin: string, id: number) => {
    const r = registerService(origin, {
      makeSession: () => ({ fetch: sessionFetch }) as never,
      makeCustody: () => tokenMocks as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!r.ok) throw new Error(r.reason);
    const wc = { id, mainFrame: { frameTreeNodeId: id } } as never;
    const o = openConnection(r.service.serviceId, wc, null);
    if (!o.ok) throw new Error(o.reason);
    bindSender(wc, o.record.connectionId, 'primary');
    return { wc, record: o.record };
  };
  const ev = (wc: unknown) => {
    const id = (wc as { mainFrame: { frameTreeNodeId: number } }).mainFrame.frameTreeNodeId;
    return {
      sender: wc,
      senderFrame: {
        url: 'app://concord/index.html',
        parent: null,
        frameTreeNodeId: id,
        detached: false,
      },
    };
  };
  const handler = (channel: string) => {
    const c = [...mocked.handleSpy.mock.calls, ...mocked.onSpy.mock.calls].find(
      (x) => x[0] === channel
    );
    if (!c) throw new Error(`${channel} not registered`);
    return c[1] as (...a: unknown[]) => Promise<unknown>;
  };
  let A: ReturnType<typeof bound>;
  let B: ReturnType<typeof bound>;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenMocks.reset();
    profileMocks.isValidatedSelfHostedApiBase.mockImplementation(() => true);
    profileMocks.isTier2DialApproved.mockImplementation(() => true);
    _resetConnectionRegistryForTesting();
    _resetIpcRegistryForTesting();
    setRemoteSpaOriginSource(() => null);
    A = bound(ORIGIN_A, 1);
    B = bound(ORIGIN_B, 2);
    registerSSOIPC();
  });

  afterEach(() => {
    const only = (b: string) => b === 'https://voice.example';
    profileMocks.isValidatedSelfHostedApiBase.mockImplementation(only);
    profileMocks.isTier2DialApproved.mockImplementation(only);
  });

  it('a sign-in whose connection document moves on mid-flight stores nothing and revokes', async () => {
    appleMocks.runAppleSignIn.mockImplementationOnce(async () => {
      advanceGeneration(A.record.connectionId, 'document');
      return { kind: 'tokens', accessToken: 'at', refreshToken: 'rt', sessionId: 'sid' } as never;
    });
    const out = await handler('sso:appleSignIn')(ev(A.wc), ORIGIN_A);
    expect(out).toEqual({ kind: 'error', code: 'sso_cancelled' });
    expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
    expect(guardedMocks.guardedRequest).toHaveBeenCalledTimes(1);
  });

  it('an MFA proof whose connection moves on during verify stores nothing', async () => {
    appleMocks.runAppleSignIn.mockResolvedValueOnce({
      kind: 'mfa_challenge',
      mfaChallengeToken: 'tok-A',
      methods: ['totp'],
    } as never);
    const started = (await handler('sso:appleSignIn')(ev(A.wc), ORIGIN_A)) as {
      credentialOwner: number;
    };
    sessionFetch.mockImplementationOnce(async () => {
      advanceGeneration(A.record.connectionId, 'document');
      return new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          session_id: SUCCESS_SESSION_ID,
        }),
        { status: 200 }
      );
    });
    const out = await handler('sso:completeMFA')(ev(A.wc), ORIGIN_A, {
      provider: 'apple',
      mfaChallengeToken: 'tok-A',
      method: 'totp',
      code: '123456',
      credentialOwner: started.credentialOwner,
    });
    expect(out).toEqual({ kind: 'error', status: 409, code: 'sso_cancelled' });
    expect(tokenMocks.storeRefreshTokenIfOwner).not.toHaveBeenCalled();
    expect(guardedMocks.guardedRequest).toHaveBeenCalledTimes(1);
  });

  it("B's sso:appleCancel cannot cancel A's in-flight Apple flow; A's can", async () => {
    appleMocks.runAppleSignIn.mockImplementationOnce(() => new Promise(() => undefined) as never);
    void handler('sso:appleSignIn')(ev(A.wc), ORIGIN_A);
    handler('sso:appleCancel')(ev(B.wc));
    expect(appleMocks.cancelActiveAppleFlow).not.toHaveBeenCalled();
    handler('sso:appleCancel')(ev(A.wc));
    expect(appleMocks.cancelActiveAppleFlow).toHaveBeenCalledTimes(1);
  });
});
