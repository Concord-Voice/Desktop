// @vitest-environment node
// #86 Task 7B: sender-binding authority for the SSO channels (and, for S1, custody
// resolution). A sender bound to connection A that supplies connection B's apiBase must be
// refused with nothing dialled, no custody touched and no ceremony state moved; custody and
// the session fetch come from the sender's binding, never from the supplied apiBase and
// never from the Task 5 pointer shims; pending SSO state is keyed by ConnectionId.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const m = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const reg = () =>
    vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    });
  const custodies = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const makeCustodyMock = () => {
    let owner = 100;
    return {
      reserveCredentialOwner: vi.fn(() => ++owner),
      credentialOwnerIsCurrent: vi.fn(() => true),
      storeRefreshTokenIfOwner: vi.fn((_d: unknown, o: number) => o),
      clearTokensIfOwner: vi.fn(() => true),
      releaseCredentialReservation: vi.fn(() => true),
    };
  };
  return {
    handlers,
    ipc: { handle: reg(), on: reg(), once: reg(), handleOnce: reg() },
    custodies,
    makeCustodyMock,
    stray: makeCustodyMock(),
    netFetch: vi.fn(async () => new Response('{}', { status: 200 })),
    sessionFetch: vi.fn(async () => new Response('{}', { status: 200 })),
    sessionFetchFor: vi.fn(),
    runApple: vi.fn(),
    runGoogle: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: m.ipc,
  net: { fetch: m.netFetch },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/ssoLoopback', () => ({ startLoopback: vi.fn() }));
vi.mock('../../../../src/main/oauth/apple/appleFlow', () => ({
  runAppleSignIn: m.runApple,
  cancelActiveAppleFlow: vi.fn(),
}));
vi.mock('../../../../src/main/oauth/google/googleFlow', () => ({
  runGoogleSignIn: m.runGoogle,
  cancelActiveGoogleFlow: vi.fn(),
}));
vi.mock('../../../../src/main/oauth/apple/idTokenVerifier', () => ({
  verifyAppleIDToken: vi.fn(),
}));
vi.mock('../../../../src/main/oauth/google/idTokenVerifier', () => ({
  verifyGoogleIDToken: vi.fn(),
}));
vi.mock('../../../../src/main/oauth/google/clientSecret', () => ({
  loadGoogleClientSecret: vi.fn(() => 'secret'),
}));
vi.mock('../../../../src/main/apiBaseUrl', () => ({
  PRODUCTION_API_BASE: 'https://api.concordvoice.chat',
  getApiBaseUrl: vi.fn(() => 'https://api.concordvoice.chat'),
}));
vi.mock('../../../../src/main/selfHostedProfile', async (orig) => ({
  ...(await orig<object>()),
  isValidatedSelfHostedApiBase: vi.fn(() => true),
  isTier2DialApproved: vi.fn(() => true),
}));
vi.mock('../../../../src/main/guardedRequest', () => ({
  guardedRequest: vi.fn(async () => ({ ok: true, status: 200, url: '', json: async () => ({}) })),
  EgressDeniedError: class extends Error {},
}));
vi.mock('../../../../src/main/machineId', () => ({ getMachineId: vi.fn(() => 'mid') }));
// Every custody the transitional shims hand out is the STRAY one: a handler that reaches it
// resolved custody from something other than the sender's binding (S1).
vi.mock('../../../../src/main/tokenManager', () => ({
  custodyForApiBase: vi.fn(() => m.stray),
  liveCustody: vi.fn(() => m.stray),
  restoreTargetCustody: vi.fn(() => m.stray),
  custodyFor: vi.fn(() => m.stray),
}));
vi.mock('../../../../src/main/connectionSession', async (orig) => ({
  ...(await orig<object>()),
  sessionFetchFor: m.sessionFetchFor,
}));

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
import { registerSSOIPC } from '../../../../src/main/ipc/sso';

const SAAS = 'https://api.concordvoice.chat';
const ORIGIN_A = 'https://a.example';
const ORIGIN_B = 'https://b.example';
const MFA = {
  provider: 'google' as const,
  mfaChallengeToken: 'challenge-token-A',
  method: 'totp',
  code: '123456',
};

function conn(origin: string, id: number) {
  const custody = m.makeCustodyMock();
  m.custodies.set(origin, custody);
  const r = registerService(origin, {
    makeSession: () => ({ fetch: m.sessionFetch }) as never,
    makeCustody: () => custody as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  const wc = { id, mainFrame: { frameTreeNodeId: id } } as never;
  const o = openConnection(r.service.serviceId, wc, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc, o.record.connectionId, 'primary');
  return { wc, record: o.record, service: r.service, custody };
}
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
  } as unknown as IpcMainInvokeEvent;
};
const call = async (channel: string, wc: unknown, ...args: unknown[]) => {
  try {
    return { threw: false as const, value: await m.handlers.get(channel)!(ev(wc), ...args) };
  } catch (error) {
    return { threw: true as const, value: error };
  }
};

let A: ReturnType<typeof conn>;
let B: ReturnType<typeof conn>;

beforeEach(() => {
  vi.clearAllMocks();
  m.handlers.clear();
  m.custodies.clear();
  _resetConnectionRegistryForTesting();
  _resetIpcRegistryForTesting();
  setRemoteSpaOriginSource(() => null);
  m.sessionFetchFor.mockImplementation(() => m.sessionFetch);
  m.runApple.mockResolvedValue({
    kind: 'tokens',
    accessToken: 'at',
    refreshToken: 'rt',
    sessionId: null,
  });
  m.runGoogle.mockResolvedValue({
    kind: 'tokens',
    accessToken: 'at',
    refreshToken: 'rt',
    sessionId: null,
  });
  A = conn(ORIGIN_A, 1);
  B = conn(ORIGIN_B, 2);
  setForeground(A.record.connectionId);
  registerSSOIPC(() => null);
});

const untouched = (c: ReturnType<typeof m.makeCustodyMock>) =>
  Object.values(c).forEach((fn) => expect(fn).not.toHaveBeenCalled());

describe('wrong-owner: a sender bound to A supplying B apiBase', () => {
  it.each([
    ['sso:appleSignIn', [ORIGIN_B]],
    ['sso:googleSignIn', [ORIGIN_B]],
    [
      'sso:completeRegistration',
      [
        ORIGIN_B,
        {
          provider: 'apple',
          ssoToken: 'x',
          username: 'u',
          passphrase: 'p',
          wrappedPrivateKey: 'w',
          keyDerivationSalt: 's',
          publicKey: 'k',
        },
      ],
    ],
    ['sso:completeLink', [ORIGIN_B, { provider: 'apple', ssoToken: 'x', password: 'p' }]],
    ['sso:completeMFA', [ORIGIN_B, { ...MFA, credentialOwner: 101 }]],
  ])('%s is refused and dials nothing, writes nothing', async (channel, args) => {
    const out = await call(channel, A.wc, ...args);
    // Either the channel's refusal shape or a throw: never a success.
    if (!out.threw) expect(out.value).not.toMatchObject({ kind: 'tokens' });
    expect(m.runApple).not.toHaveBeenCalled();
    expect(m.runGoogle).not.toHaveBeenCalled();
    expect(m.netFetch).not.toHaveBeenCalled();
    expect(m.sessionFetch).not.toHaveBeenCalled();
    untouched(A.custody);
    untouched(B.custody);
    untouched(m.stray);
  });

  it('sso:appleSignIn names the refusal wrong-owner (registry/handler refusal shape)', async () => {
    const out = await call('sso:appleSignIn', A.wc, ORIGIN_B);
    const text = out.threw ? String((out.value as Error).message) : JSON.stringify(out.value);
    expect(text).toContain('wrong-owner');
  });
});

describe('S1: custody and fetch come from the sender binding alone', () => {
  it('sign-in from A reserves in A custody only and never reaches a shim custody', async () => {
    await call('sso:appleSignIn', A.wc, ORIGIN_A);
    expect(A.custody.reserveCredentialOwner).toHaveBeenCalledTimes(1);
    untouched(B.custody);
    untouched(m.stray);
  });

  it('the control-plane fetch goes through sessionFetchFor(sender.service), not net.fetch', async () => {
    m.runApple.mockImplementation(
      async (p: { controlPlaneFetch: (u: string, i?: RequestInit) => Promise<Response> }) => {
        await p.controlPlaneFetch(`${ORIGIN_A}/api/v1/auth/sso/apple/session`, { method: 'POST' });
        return { kind: 'tokens', accessToken: 'at', refreshToken: 'rt', sessionId: null };
      }
    );
    await call('sso:appleSignIn', A.wc, ORIGIN_A);
    expect(m.sessionFetchFor).toHaveBeenCalledWith(expect.objectContaining({ origin: ORIGIN_A }));
    expect(m.netFetch).not.toHaveBeenCalled();
    expect(m.sessionFetch).toHaveBeenCalledTimes(1);
  });

  it('for the saas service the init is byte-identical to { ...init, credentials: "include" }', async () => {
    const saas = conn(SAAS, 3);
    setForeground(saas.record.connectionId); // sso:*SignIn admits the foreground only (RT2)
    m.runApple.mockImplementation(
      async (p: { controlPlaneFetch: (u: string, i?: RequestInit) => Promise<Response> }) => {
        await p.controlPlaneFetch(`${SAAS}/api/v1/auth/sso/apple/session`, {
          method: 'POST',
          headers: { 'X-Test': '1' },
        });
        return { kind: 'tokens', accessToken: 'at', refreshToken: 'rt', sessionId: null };
      }
    );
    await call('sso:appleSignIn', saas.wc, SAAS);
    expect(m.sessionFetch).toHaveBeenCalledWith(`${SAAS}/api/v1/auth/sso/apple/session`, {
      method: 'POST',
      headers: { 'X-Test': '1' },
      credentials: 'include',
    });
  });
});

describe('SSO pending state is keyed by ConnectionId', () => {
  const challenge = {
    kind: 'mfa_challenge',
    mfaChallengeToken: 'challenge-token-A',
    methods: ['totp'],
  };

  it("B's sign-in does not clear A's pending MFA (A can still complete it)", async () => {
    m.runGoogle.mockResolvedValueOnce(challenge);
    const started = await call('sso:googleSignIn', A.wc, ORIGIN_A);
    expect(started.value).toMatchObject({ kind: 'mfa_challenge' });
    const ownerA = (started.value as { credentialOwner: number }).credentialOwner;

    // B must be the foreground to start a sign-in at all (RT2); A's challenge stays pending.
    setForeground(B.record.connectionId);
    await call('sso:appleSignIn', B.wc, ORIGIN_B); // today this nulls the module-level pendingMFA

    const done = await call('sso:completeMFA', A.wc, ORIGIN_A, { ...MFA, credentialOwner: ownerA });
    expect(done.threw).toBe(false);
    expect(done.value).not.toMatchObject({ code: 'sso_cancelled' });
    expect(m.sessionFetch).toHaveBeenCalledTimes(1);
  });

  it("A's pending MFA is invisible to B's sso:completeMFA", async () => {
    m.runGoogle.mockResolvedValueOnce(challenge);
    const started = await call('sso:googleSignIn', A.wc, ORIGIN_A);
    const ownerA = (started.value as { credentialOwner: number }).credentialOwner;
    const out = await call('sso:completeMFA', B.wc, ORIGIN_B, { ...MFA, credentialOwner: ownerA });
    expect(out.value).toMatchObject({ kind: 'error', code: 'sso_cancelled' });
    expect(m.sessionFetch).not.toHaveBeenCalled();
    expect(m.netFetch).not.toHaveBeenCalled();
    untouched(B.custody);
  });
});

describe('sso:awaitCallback / sso:cancelLoopback are owner-scoped', () => {
  it('a loopback started by A cannot be awaited or cancelled by B', async () => {
    const { startLoopback } = await import('../../../../src/main/ssoLoopback');
    const close = vi.fn();
    (startLoopback as ReturnType<typeof vi.fn>).mockResolvedValue({
      port: 52000,
      redirectURI: 'http://127.0.0.1:52000/oauth/callback',
      promise: new Promise(() => undefined),
      close,
    });
    const started = await call('sso:startLoopback', A.wc);
    expect(started.value).toMatchObject({ port: 52000 });

    // A refused (or unknown-port) await settles at once; a hang means B reached A's handle.
    const awaited = await Promise.race([
      call('sso:awaitCallback', B.wc, 52000),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    expect(awaited).not.toBe('hung');
    expect((awaited as { threw: boolean }).threw).toBe(true);
    m.handlers.get('sso:cancelLoopback')!(ev(B.wc), 52000);
    expect(close).not.toHaveBeenCalled();

    m.handlers.get('sso:cancelLoopback')!(ev(A.wc), 52000);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// Channels in main.ts that take (or carry) an apiBase. They cannot be driven behaviourally
// from here (main.ts is not importable without the whole app), so the table is enforced on
// source: each must be a registerIpc registration, never raw ipcMain, and none may resolve
// custody through a Task 5 pointer shim (S1/S2/S3). The behavioural wrong-owner rows for
// them belong in main.test.ts, which already loads main.ts.
const MAIN_APIBASE_CHANNELS = [
  'auth:getMachineId',
  'auth:storeRefreshToken',
  'auth:storeE2EEKeys',
  'selfHosted:probeServer',
] as const;
const SRC_MAIN = path.resolve(__dirname, '../../../../src/main');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });

describe('apiBase-taking channels outside sso.ts are binding-derived (source enforcement)', () => {
  const mainSrc = readFileSync(path.join(SRC_MAIN, 'main.ts'), 'utf8');
  it.each(MAIN_APIBASE_CHANNELS)('%s is registered via registerIpc, not raw ipcMain', (channel) => {
    expect(mainSrc).not.toMatch(new RegExp(`ipcMain\\.(handle|on|once)\\(\\s*'${channel}'`));
    expect(mainSrc).toMatch(new RegExp(`registerIpc\\(\\s*'${channel}'`));
  });

  it('S1: no src/main file other than tokenManager.ts uses a custody pointer shim', () => {
    const offenders = walk(SRC_MAIN)
      .filter((f) => !f.endsWith(`${path.sep}tokenManager.ts`))
      .filter((f) =>
        /\b(custodyForApiBase|liveCustody|restoreTargetCustody)\b/.test(readFileSync(f, 'utf8'))
      );
    expect(offenders).toEqual([]);
  });

  it('S1: tokenManager.ts no longer exports custodyForApiBase', () => {
    const tm = readFileSync(path.join(SRC_MAIN, 'tokenManager.ts'), 'utf8');
    expect(tm).not.toMatch(
      /export (async )?function custodyForApiBase|export const custodyForApiBase/
    );
  });
});
