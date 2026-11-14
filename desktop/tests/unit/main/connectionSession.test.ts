// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const mk = (name: string) => ({
    name,
    protocol: { handle: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    webRequest: { onBeforeSendHeaders: vi.fn() },
    on: vi.fn(),
    fetch: vi.fn(),
  });
  return {
    mk,
    defaultSession: mk('default'),
    fromPath: vi.fn(),
    openExternal: vi.fn(() => Promise.resolve()),
    billing: new Set<unknown>(),
  };
});
h.fromPath.mockImplementation((p: string) => ({ ...h.mk(`fromPath:${p}`) }));

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', isPackaged: true },
  net: { fetch: vi.fn() },
  shell: { openExternal: h.openExternal },
  session: { defaultSession: h.defaultSession, fromPath: h.fromPath },
}));
vi.mock('../../../src/main/billing/billingWindow', () => ({
  isBillingWebContents: (wc: unknown) => h.billing.has(wc),
}));

import {
  _resetConnectionSessionForTesting,
  assertDefaultSessionIsSaas,
  captureArbiter,
  configureConnectionSession,
  defaultCaptureArbiter,
  installNavigationGate,
  sessionFetchFor,
  sessionForService,
  setCaptureArbiter,
  type ConnectionSessionDeps,
} from '../../../src/main/connectionSession';

const SAAS_ORIGIN = 'https://api.concordvoice.chat';
const SELF_ORIGIN = new URL('https://a.example').origin;
const OTHER_ORIGIN = new URL('https://b.example:8443').origin;
const SPA_ORIGIN = 'https://spa.concordvoice.chat';

type Fake = ReturnType<typeof h.mk>;
const asSession = (s: Fake) => s as never;

function service(kind: 'saas' | 'selfhost', ses: Fake, token: string | null = 'tok') {
  return {
    serviceId: kind === 'saas' ? 'saas' : 'svc-a',
    kind,
    origin: kind === 'saas' ? SAAS_ORIGIN : SELF_ORIGIN,
    dirKey: kind === 'saas' ? '' : 'abc',
    session: asSession(ses),
    custody: { getCachedAccessToken: () => token },
  } as never;
}

const bindings = new Map<unknown, { connectionId: string; role: string; serviceId?: string }>();
function makeDeps(over: Partial<ConnectionSessionDeps> = {}): ConnectionSessionDeps {
  return {
    isPackaged: true,
    bundleRoot: '/bundle',
    getLiveDir: () => '/live',
    remoteSpaOrigin: () => SPA_ORIGIN,
    bindingFor: (wc) => bindings.get(wc) as never,
    recordFor: (id) => ({ connectionId: id, serviceId: 'saas', generation: 1 }) as never,
    getService: () => undefined,
    foreground: () => null,
    ...over,
  };
}
const wc = (extra: object = {}) => ({ id: 1, ...extra }) as never;

function permissionRequest(ses: Fake, contents: unknown, permission: string): boolean {
  const handler = ses.setPermissionRequestHandler.mock.calls[0][0];
  const cb = vi.fn();
  handler(contents, permission, cb, {});
  expect(cb).toHaveBeenCalledTimes(1);
  return cb.mock.calls[0][0];
}

beforeEach(() => {
  bindings.clear();
  h.billing.clear();
  _resetConnectionSessionForTesting();
  vi.clearAllMocks();
  for (const s of [h.defaultSession]) {
    s.protocol.handle.mockClear();
  }
});

describe('configureConnectionSession', () => {
  it('registers handlers once when called twice on the same session', () => {
    const ses = h.mk('s1');
    const svc = service('selfhost', ses);
    configureConnectionSession(asSession(ses), svc, makeDeps());
    configureConnectionSession(asSession(ses), svc, makeDeps());
    expect(ses.protocol.handle).toHaveBeenCalledTimes(1);
    expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(ses.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
  });

  it('handles app:// on every session and spa-cache:// only for saas', () => {
    const saas = h.mk('saas');
    const self = h.mk('self');
    configureConnectionSession(asSession(saas), service('saas', saas), makeDeps());
    configureConnectionSession(asSession(self), service('selfhost', self), makeDeps());
    const schemes = (s: Fake) => s.protocol.handle.mock.calls.map((c: unknown[]) => c[0]);
    expect(schemes(saas)).toContain('app');
    expect(schemes(saas)).toHaveLength(2);
    expect(schemes(self)).toEqual(['app']);
  });

  it('attaches select-hid-device once per session', () => {
    const ses = h.mk('hid');
    configureConnectionSession(asSession(ses), service('selfhost', ses), makeDeps());
    const hid = ses.on.mock.calls.filter((c: unknown[]) => c[0] === 'select-hid-device');
    expect(hid).toHaveLength(1);
    const event = { preventDefault: vi.fn() };
    const cb = vi.fn();
    hid[0][1](event, { deviceList: [{ deviceId: 'd1' }] }, cb);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith('d1');
  });
});

describe('permission request handler', () => {
  function setup() {
    const ses = h.mk('perm');
    configureConnectionSession(asSession(ses), service('selfhost', ses), makeDeps());
    return ses;
  }

  it('denies a request from an unbound webContents', () => {
    expect(permissionRequest(setup(), wc(), 'media')).toBe(false);
  });

  it('denies geolocation for a bound webContents', () => {
    const ses = setup();
    const c = wc();
    bindings.set(c, { connectionId: 'c1', role: 'primary' });
    expect(permissionRequest(ses, c, 'geolocation')).toBe(false);
  });

  it('allows media for a bound webContents', () => {
    const ses = setup();
    const c = wc();
    bindings.set(c, { connectionId: 'c1', role: 'primary' });
    expect(permissionRequest(ses, c, 'media')).toBe(true);
  });

  it('defaultCaptureArbiter: null ref and geolocation deny, others allow', () => {
    expect(defaultCaptureArbiter.decide(null, 'media', {})).toBe(false);
    expect(captureArbiter()).toBe(defaultCaptureArbiter);
    const ref = { connectionId: 'c1', generation: 1 } as never;
    expect(defaultCaptureArbiter.decide(ref, 'geolocation', {})).toBe(false);
    expect(defaultCaptureArbiter.decide(ref, 'media', {})).toBe(true);
  });

  it('check handler: a document check resolves its binding; an off-document check keeps the static policy', () => {
    const ses = setup();
    const check = ses.setPermissionCheckHandler.mock.calls[0][0];
    const c = wc();
    expect(check(c, 'media', '', { isMainFrame: true })).toBe(false);
    bindings.set(c, { connectionId: 'c1', role: 'primary' });
    expect(check(c, 'media', '', { isMainFrame: true })).toBe(true);
    expect(check(c, 'geolocation', '', { isMainFrame: true })).toBe(false);
    // Electron passes null for notification and service-worker checks.
    expect(check(null, 'notifications', '', { isMainFrame: false })).toBe(true);
    expect(check(null, 'geolocation', '', { isMainFrame: false })).toBe(false);
  });

  it('setCaptureArbiter overrides the decision and its unsubscribe restores the default', () => {
    const ses = setup();
    const c = wc();
    bindings.set(c, { connectionId: 'c1', role: 'primary' });
    const restore = setCaptureArbiter({ decide: () => false });
    expect(permissionRequest(ses, c, 'media')).toBe(false);
    restore();
    expect(captureArbiter()).toBe(defaultCaptureArbiter);
    ses.setPermissionRequestHandler.mock.calls[0][0](c, 'media', (v: boolean) => {
      expect(v).toBe(true);
    });
  });
});

describe('KLIPY header injection', () => {
  function run(svcOrigin: 'saas' | 'selfhost', token: string | null, url: string) {
    const ses = h.mk('klipy');
    const svc = service(svcOrigin, ses, token);
    configureConnectionSession(asSession(ses), svc, makeDeps());
    const [filter, listener] = ses.webRequest.onBeforeSendHeaders.mock.calls[0];
    const cb = vi.fn();
    listener({ url, requestHeaders: {} as Record<string, string> }, cb);
    return { filter, headers: cb.mock.calls[0][0].requestHeaders as Record<string, string>, svc };
  }

  it('filters on the service origin klipy media path', () => {
    const { filter, svc } = run('selfhost', 'tok', `${SELF_ORIGIN}/api/v1/klipy/media/x`);
    expect(filter).toEqual({ urls: [`${(svc as { origin: string }).origin}/api/v1/klipy/media*`] });
  });

  it('adds Authorization when token present and origin matches', () => {
    const { headers } = run('selfhost', 'tok', `${SELF_ORIGIN}/api/v1/klipy/media/x`);
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  it('adds no header when the token is null', () => {
    const { headers } = run('selfhost', null, `${SELF_ORIGIN}/api/v1/klipy/media/x`);
    expect(headers['Authorization']).toBeUndefined();
  });

  it("adds no header for another service's origin inside this session", () => {
    const { headers } = run('selfhost', 'tok', `${OTHER_ORIGIN}/api/v1/klipy/media/x`);
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('sessionForService', () => {
  it('returns defaultSession for saas', () => {
    expect(sessionForService('saas', '', '/root')).toBe(h.defaultSession);
  });

  it('uses session.fromPath(<root>/profiles/<dirKey>/session) for selfhost', () => {
    sessionForService('selfhost', 'abc', '/root');
    expect(h.fromPath).toHaveBeenCalledWith('/root/profiles/abc/session');
  });
});

describe('sessionFetchFor', () => {
  it('delegates to the service session fetch', async () => {
    const ses = h.mk('f');
    ses.fetch.mockResolvedValue('resp');
    const f = sessionFetchFor(service('selfhost', ses));
    await expect(f('https://x/y', { method: 'GET' })).resolves.toBe('resp');
    expect(ses.fetch).toHaveBeenCalledWith('https://x/y', { method: 'GET' });
  });
});

describe('installNavigationGate', () => {
  // `place` is where the bound document sits (#86 C6b): the foreground connection's
  // primary (the default), a background connection's primary, or a PiP.
  function gate(
    serviceId: string | null,
    opts: Partial<ConnectionSessionDeps> = {},
    place: 'foreground' | 'background' | 'pip' = 'foreground'
  ) {
    const handlers: Record<string, (...a: never[]) => unknown> = {};
    let openHandler: ((d: { url: string }) => { action: string }) | null = null;
    const contents = {
      on: vi.fn((ev: string, fn: never) => {
        handlers[ev] = fn;
      }),
      setWindowOpenHandler: vi.fn((fn: never) => {
        openHandler = fn;
      }),
    };
    const role = place === 'pip' ? 'pip' : 'primary';
    if (serviceId) bindings.set(contents, { connectionId: 'c1', role, serviceId });
    // A PiP is bound to its opener's connection; the record's webContents is the primary.
    const record = {
      connectionId: 'c1',
      serviceId,
      state: 'live',
      webContents: place === 'pip' ? {} : contents,
    };
    const other = { connectionId: 'c2', serviceId: 'svc-b', state: 'live', webContents: {} };
    const deps = makeDeps({
      bindingFor: (w) => {
        const b = bindings.get(w);
        return b && ({ connectionId: b.connectionId, role: b.role } as never);
      },
      recordFor: () => record as never,
      foreground: () => (place === 'background' ? other : record) as never,
      getService: (id) =>
        id === 'saas'
          ? (service('saas', h.defaultSession) as never)
          : (service('selfhost', h.mk('x')) as never),
      ...opts,
    });
    installNavigationGate(contents as never, deps);
    const nav = (url: string) => {
      const event = { preventDefault: vi.fn() };
      (handlers['will-navigate'] as (e: unknown, u: string) => void)(event, url);
      return event.preventDefault.mock.calls.length > 0;
    };
    return { nav, open: (url: string) => openHandler!({ url }), contents };
  }

  it('prevents navigation for an unbound webContents and denies window open', () => {
    const g = gate(null);
    expect(g.nav('app://concord/index.html')).toBe(true);
    expect(g.open('https://example.com/').action).toBe('deny');
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('saas-bound: permits app://concord, spa-cache and the remote SPA origin', () => {
    const g = gate('saas');
    expect(g.nav('app://concord/index.html')).toBe(false);
    expect(g.nav('spa-cache://concord/index.html')).toBe(false);
    expect(g.nav(`${SPA_ORIGIN}/channels`)).toBe(false);
  });

  it('selfhost-bound: permits only app://concord (and dev localhost)', () => {
    const g = gate('svc-a');
    expect(g.nav('app://concord/index.html')).toBe(false);
    expect(g.nav(`${SPA_ORIGIN}/channels`)).toBe(true);
    expect(g.nav('spa-cache://concord/index.html')).toBe(true);
  });

  it('selfhost-bound dev mode permits http://localhost on any port', () => {
    const g = gate('svc-a', { isPackaged: false });
    expect(g.nav('http://localhost:5173/')).toBe(false);
    expect(g.nav('https://evil.example/')).toBe(true);
  });

  it('externalizes external https navigation instead of navigating', () => {
    const g = gate('svc-a');
    expect(g.nav('https://evil.example/path')).toBe(true);
    expect(h.openExternal).toHaveBeenCalledWith('https://evil.example/path');
    h.openExternal.mockClear();
    expect(g.nav('javascript:alert(1)')).toBe(true);
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(g.open('https://example.com/').action).toBe('deny');
    expect(h.openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('prevents navigation on a malformed URL', () => {
    expect(gate('svc-a').nav('not a url')).toBe(true);
  });

  // #86 C6b: window.open and will-navigate need no click, so a hidden connection could
  // open the OS browser over the visible one. Only the foreground primary externalizes,
  // the sender `open-external` admits (app-global-mutate).
  it('a background primary neither navigates nor opens the OS browser', () => {
    for (const serviceId of ['svc-a', 'saas']) {
      const g = gate(serviceId, {}, 'background');
      expect(g.nav('https://evil.example/path')).toBe(true);
      expect(g.open('https://evil.example/popup').action).toBe('deny');
    }
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('a PiP neither navigates away nor opens the OS browser', () => {
    const g = gate('saas', {}, 'pip');
    expect(g.nav('https://evil.example/path')).toBe(true);
    expect(g.open('https://evil.example/popup').action).toBe('deny');
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('a background primary keeps its in-app navigation allowlist', () => {
    const g = gate('saas', {}, 'background');
    expect(g.nav('app://concord/index.html')).toBe(false);
    expect(g.nav(`${SPA_ORIGIN}/channels`)).toBe(false);
  });

  it('the foreground primary still opens https in the OS browser while another is hidden', () => {
    const g = gate('svc-a', {}, 'foreground');
    expect(g.open('https://example.com/').action).toBe('deny');
    expect(g.nav('https://example.com/next')).toBe(true);
    expect(h.openExternal.mock.calls).toEqual([
      ['https://example.com/'],
      ['https://example.com/next'],
    ]);
  });

  it('leaves the billing view to its own Stripe gate', () => {
    const g = gate(null);
    h.billing.add(g.contents);
    expect(g.nav('https://pay.concordvoice.com/c/pay')).toBe(false);
    expect(h.openExternal).not.toHaveBeenCalled();
  });
});

describe('assertDefaultSessionIsSaas', () => {
  const onDefault = (extra = {}) => ({ session: h.defaultSession, ...extra }) as never;
  const onOther = () => ({ session: h.mk('other') }) as never;
  // A real SenderBinding carries no serviceId; the service is the record's.
  const bf = (map: Map<unknown, string>) => (w: never) =>
    map.has(w) ? ({ connectionId: `c-${map.get(w)}`, role: 'primary' } as never) : undefined;
  const rf = (id: never) => ({ connectionId: id, serviceId: String(id).slice(2) }) as never;

  it('does not throw for the saas primary and its PiPs', () => {
    const p = onDefault();
    const pip = onDefault();
    const m = new Map<unknown, string>([
      [p, 'saas'],
      [pip, 'saas'],
    ]);
    expect(() => assertDefaultSessionIsSaas([p, pip], bf(m), rf)).not.toThrow();
  });

  it('does not throw for a selfhost contents on its own session', () => {
    const o = onOther();
    const m = new Map<unknown, string>([[o, 'svc-a']]);
    expect(() => assertDefaultSessionIsSaas([o], bf(m), rf)).not.toThrow();
  });

  it('throws when a non-saas connection sits on defaultSession', () => {
    const bad = onDefault();
    const m = new Map<unknown, string>([[bad, 'svc-a']]);
    expect(() => assertDefaultSessionIsSaas([bad], bf(m), rf)).toThrow(/R1/);
  });

  it('throws when an unbound contents sits on defaultSession', () => {
    expect(() => assertDefaultSessionIsSaas([onDefault()], bf(new Map()), rf)).toThrow(/R1/);
  });
});
