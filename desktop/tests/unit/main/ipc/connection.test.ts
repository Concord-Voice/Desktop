import type * as ConnectionRegistryModule from '../../../../src/main/connectionRegistry';
import type * as SelfHostedProfileModule from '../../../../src/main/selfHostedProfile';
// @vitest-environment node
// connection:* channels (spec 2026-11-09-86-connection-context-isolation §3.7;
// plan Task 7A step 4): whoAmI, create, activate and the generation push.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const { handlers, mockIpcMain, regDeps } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const reg = () =>
    vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    });
  return {
    handlers,
    mockIpcMain: { handle: reg(), on: reg(), once: reg(), handleOnce: reg() },
    regDeps: {
      makeSession: () => ({}),
      makeCustody: () => ({}),
      isValidatedSelfHostedApiBase: () => true,
    },
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: mockIpcMain,
}));

// Wrapped, not replaced: the real registry runs, the spy only records and supplies deps.
vi.mock('../../../../src/main/connectionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionRegistryModule>();
  return {
    ...actual,
    registerService: vi.fn((origin: string) => actual.registerService(origin, regDeps as never)),
  };
});
vi.mock('../../../../src/main/selfHostedCeremonyBudget', () => ({
  consumeCeremonyToken: vi.fn(() => true),
}));
vi.mock('../../../../src/main/selfHostedProfile', async (importOriginal) => ({
  ...(await importOriginal<typeof SelfHostedProfileModule>()),
  commitSelfHostedApproval: vi.fn(() => true),
}));

import {
  _resetConnectionRegistryForTesting,
  advanceGeneration,
  bindSender,
  openConnection,
  registerService,
  setForeground,
  getService,
} from '../../../../src/main/connectionRegistry';
import { consumeCeremonyToken } from '../../../../src/main/selfHostedCeremonyBudget';
import {
  commitSelfHostedApproval,
  serviceIdForApiBase,
} from '../../../../src/main/selfHostedProfile';
import { _resetIpcRegistryForTesting } from '../../../../src/main/ipc/registry';
import {
  _resetModalMutexForTesting,
  modalInFlight,
  tryAcquireModal,
} from '../../../../src/main/modalMutex';
import { registerConnectionIpc } from '../../../../src/main/ipc/connection';
import {
  requireConnectionSender,
  trackMainFrameNavigation,
} from '../../../../src/main/ipc/connectionSender';

const SAAS_ORIGIN = 'https://api.concordvoice.chat';
const A = new URL('https://a.example').origin;
const B = new URL('https://b.example:8443').origin;
const NEW = new URL('https://new.example').origin;

const sends = new Map<number, ReturnType<typeof vi.fn>>();
const fakeWc = (id: number) => {
  const send = vi.fn();
  sends.set(id, send);
  return { id, mainFrame: { frameTreeNodeId: id }, send, isDestroyed: () => false } as never;
};

function conn(origin: string, id: number) {
  const r = registerService(origin);
  if (!r.ok) throw new Error(r.reason);
  const wc = fakeWc(id);
  const o = openConnection(r.service.serviceId, wc, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc, o.record.connectionId, 'primary');
  return { wc, record: o.record, service: r.service };
}
const ev = (
  wc: unknown,
  frame?: Record<string, unknown> | null,
  url = 'app://concord/index.html'
) => {
  const mainId = (wc as { mainFrame: { frameTreeNodeId: number } }).mainFrame.frameTreeNodeId;
  const senderFrame =
    frame === null
      ? null
      : { url, parent: null, frameTreeNodeId: mainId, detached: false, ...(frame ?? {}) };
  return { sender: wc, senderFrame, returnValue: undefined } as unknown as IpcMainInvokeEvent & {
    returnValue: unknown;
  };
};
const call = (channel: string, event: unknown, ...args: unknown[]) =>
  handlers.get(channel)!(event, ...args);
const whoAmI = (event: ReturnType<typeof ev>) => {
  handlers.get('connection:whoAmI')!(event);
  return event.returnValue;
};

let nextWc = 100;
const deps = {
  openConnectionView: vi.fn(),
  activateConnection: vi.fn(),
  probe: vi.fn(),
  ceremony: vi.fn(),
  writeConnections: vi.fn(),
  // registerConnectionIpc's RegisterServiceDeps (the registerService mock ignores them).
  serviceDeps: regDeps,
};

beforeEach(() => {
  _resetConnectionRegistryForTesting();
  _resetIpcRegistryForTesting();
  handlers.clear();
  sends.clear();
  vi.clearAllMocks();
  vi.mocked(consumeCeremonyToken).mockReturnValue(true);
  vi.mocked(commitSelfHostedApproval).mockReturnValue(true);
  // Behaves like the real openConnectionView: opens and binds the connection.
  deps.openConnectionView.mockImplementation(async (serviceId: never) => {
    const wc = fakeWc(nextWc++);
    const o = openConnection(serviceId, wc, null);
    if (!o.ok) return { ok: false, reason: o.reason };
    bindSender(wc, o.record.connectionId, 'primary');
    return { ok: true, record: o.record };
  });
  deps.activateConnection.mockReturnValue(true);
  deps.probe.mockResolvedValue({ status: 'ok' });
  deps.ceremony.mockResolvedValue({ approved: true, address: '203.0.113.10' });
  deps.writeConnections.mockResolvedValue(undefined);
  registerConnectionIpc(deps as never);
});

describe('connection:whoAmI', () => {
  it('returns the identity for a bound primary main frame', () => {
    const saas = conn(SAAS_ORIGIN, 1);
    expect(whoAmI(ev(saas.wc))).toEqual({
      connectionId: saas.record.connectionId,
      generation: 1,
      serviceId: 'saas',
      kind: 'saas',
      apiOrigin: SAAS_ORIGIN,
    });
  });

  it('registers through ipcMain.on (a synchronous returnValue), not handle', () => {
    expect(mockIpcMain.on).toHaveBeenCalledWith('connection:whoAmI', expect.any(Function));
  });

  it('returns null for a subframe', () => {
    const saas = conn(SAAS_ORIGIN, 1);
    expect(whoAmI(ev(saas.wc, { parent: {} }))).toBeNull();
  });

  it('returns null for an unbound webContents', () => {
    conn(SAAS_ORIGIN, 1);
    expect(whoAmI(ev(fakeWc(77)))).toBeNull();
  });

  it('returns null for a null senderFrame', () => {
    const saas = conn(SAAS_ORIGIN, 1);
    expect(whoAmI(ev(saas.wc, null))).toBeNull();
  });

  it('returns null for spa.concordvoice.chat inside a self-hosted view', () => {
    const a = conn(A, 2);
    expect(whoAmI(ev(a.wc, undefined, 'https://spa.concordvoice.chat/'))).toBeNull();
  });

  it('returns the self-hosted identity for app://concord inside a self-hosted view', () => {
    const a = conn(A, 2);
    expect(whoAmI(ev(a.wc))).toMatchObject({ kind: 'selfhost', apiOrigin: A });
  });
});

// D1 (measured in the Electron e2e run): a view whose first loadURL is issued in the
// same tick it is created evaluates its preload, and sends whoAmI, BEFORE the renderer
// reports that document's commit; the browser records the commit only after the reply,
// so the sender main frame still reports url '' and waiting for it deadlocks. Such a
// sender is admitted on the URL of the main-frame navigation main saw start in that
// same frame, under the same kind allowlist; nothing else is admitted on an empty URL.
describe('connection:whoAmI before the browser records the commit', () => {
  /** A webContents whose listeners the test can fire, as Electron would. */
  const emitterWc = (id: number) => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const wc = {
      id,
      mainFrame: { frameTreeNodeId: id },
      send: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(fn);
        return wc;
      }),
    };
    const emit = (name: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
    };
    return { wc, emit };
  };
  const PID = 6;
  const RID = 1;
  const boundSelfHost = (id: number) => {
    const r = registerService(A);
    if (!r.ok) throw new Error(r.reason);
    const e = emitterWc(id);
    const o = openConnection(r.service.serviceId, e.wc as never, null);
    if (!o.ok) throw new Error(o.reason);
    bindSender(e.wc as never, o.record.connectionId, 'primary');
    trackMainFrameNavigation(e.wc as never);
    return { ...e, record: o.record };
  };
  const started = (url: string, frame: unknown = { processId: PID, routingId: RID }) => ({
    url,
    isMainFrame: true,
    isSameDocument: false,
    frame,
  });
  /** The sender: the view's main frame, with no committed URL yet. */
  const uncommitted = (wc: unknown, extra: Record<string, unknown> = {}) =>
    ev(wc, { processId: PID, routingId: RID, ...extra }, '');

  it('admits the first document on the main-frame navigation in flight in its frame', () => {
    const v = boundSelfHost(40);
    v.emit('did-start-navigation', started('http://localhost:3001/'));
    expect(whoAmI(uncommitted(v.wc))).toMatchObject({
      connectionId: v.record.connectionId,
      kind: 'selfhost',
      apiOrigin: A,
    });
  });

  it('refuses when the navigation in flight is not permitted for the kind', () => {
    const v = boundSelfHost(41);
    v.emit('did-start-navigation', started('https://evil.example/'));
    expect(whoAmI(uncommitted(v.wc))).toBeNull();
  });

  it('refuses when a redirect moved the navigation off the allowlist', () => {
    const v = boundSelfHost(42);
    v.emit('did-start-navigation', started('http://localhost:3001/'));
    v.emit('did-redirect-navigation', started('https://evil.example/'));
    expect(whoAmI(uncommitted(v.wc))).toBeNull();
  });

  it('refuses with no navigation in flight', () => {
    const v = boundSelfHost(43);
    expect(whoAmI(uncommitted(v.wc))).toBeNull();
  });

  it('refuses when the navigation runs in another frame (a cross-process swap)', () => {
    const v = boundSelfHost(44);
    v.emit(
      'did-start-navigation',
      started('http://localhost:3001/', { processId: 9, routingId: 3 })
    );
    expect(whoAmI(uncommitted(v.wc))).toBeNull();
  });

  it('ignores subframe and same-document navigations', () => {
    const v = boundSelfHost(45);
    v.emit('did-start-navigation', { ...started('http://localhost:3001/'), isMainFrame: false });
    v.emit('did-start-navigation', { ...started('http://localhost:3001/'), isSameDocument: true });
    expect(whoAmI(uncommitted(v.wc))).toBeNull();
  });

  it('refuses an unbound webContents and a subframe sender even with a navigation in flight', () => {
    const unbound = emitterWc(46);
    trackMainFrameNavigation(unbound.wc as never);
    unbound.emit('did-start-navigation', started('http://localhost:3001/'));
    expect(whoAmI(uncommitted(unbound.wc))).toBeNull();
    const v = boundSelfHost(47);
    v.emit('did-start-navigation', started('http://localhost:3001/'));
    expect(whoAmI(uncommitted(v.wc, { parent: {} }))).toBeNull();
  });

  it('a committed URL is still checked as committed, never replaced by the navigation', () => {
    const v = boundSelfHost(48);
    v.emit('did-start-navigation', started('http://localhost:3001/'));
    const committed = ev(v.wc, { processId: PID, routingId: RID }, 'https://evil.example/');
    expect(whoAmI(committed)).toBeNull();
  });

  it('only whoAmI opts in: other admission refuses an uncommitted frame', () => {
    const v = boundSelfHost(49);
    v.emit('did-start-navigation', started('http://localhost:3001/'));
    expect(requireConnectionSender(uncommitted(v.wc) as never)).toBeNull();
  });
});

describe('connection:create', () => {
  function saasForeground() {
    const saas = conn(SAAS_ORIGIN, 1);
    setForeground(saas.record.connectionId);
    return saas;
  }

  it('opens a new connection: probe, ceremony, token, commit, register, open, activate', async () => {
    const saas = saasForeground();
    const result = await call('connection:create', ev(saas.wc), NEW);
    const serviceId = serviceIdForApiBase(NEW);
    expect(result).toEqual({ status: 'opened', serviceId });
    expect(deps.probe).toHaveBeenCalledTimes(1);
    expect(deps.ceremony).toHaveBeenCalledTimes(1);
    expect(consumeCeremonyToken).toHaveBeenCalledTimes(1);
    expect(commitSelfHostedApproval).toHaveBeenCalledWith(NEW, '203.0.113.10');
    expect(vi.mocked(registerService).mock.calls.filter((c) => c[0] === NEW)).toHaveLength(1);
    expect(deps.openConnectionView).toHaveBeenCalledWith(
      serviceId,
      expect.any(String),
      expect.anything()
    );
    expect(deps.activateConnection).toHaveBeenCalledWith(serviceId);
    expect(getService(serviceId)).toBeDefined();
  });

  it('appends the new entry to connections.json', async () => {
    const saas = saasForeground();
    await call('connection:create', ev(saas.wc), NEW);
    expect(deps.writeConnections).toHaveBeenCalledTimes(1);
    const entries = deps.writeConnections.mock.calls[0]![0] as Array<{
      serviceId: string;
      origin: string;
    }>;
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serviceId: serviceIdForApiBase(NEW), origin: NEW }),
      ])
    );
  });

  it('refuses an unbound sender with untrusted-sender', async () => {
    saasForeground();
    expect(await call('connection:create', ev(fakeWc(77)), NEW)).toEqual({
      status: 'rejected',
      reason: 'untrusted-sender',
    });
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it('refuses a background primary with not-foreground', async () => {
    saasForeground();
    const bg = conn(A, 2);
    expect(await call('connection:create', ev(bg.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'not-foreground',
    });
    expect(deps.probe).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalledWith(NEW, expect.anything());
  });

  it.each([
    ['not a url'],
    [''],
    [42],
    [undefined],
    ['ftp://x.example'],
    ['https://a.example/path?x=1'],
  ])('rejects an invalid origin %j without probing', async (bad) => {
    const saas = saasForeground();
    const r = (await call('connection:create', ev(saas.wc), bad)) as {
      status: string;
      reason: string;
    };
    // A URL with a path is not a canonical origin: origins are compared via new URL(x).origin.
    expect(r).toEqual({ status: 'rejected', reason: 'invalid-origin' });
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent create for the same origin with busy', async () => {
    const saas = saasForeground();
    let release!: (v: unknown) => void;
    deps.probe.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = call('connection:create', ev(saas.wc), NEW) as Promise<unknown>;
    const second = await call('connection:create', ev(saas.wc), NEW);
    expect(second).toEqual({ status: 'rejected', reason: 'busy' });
    release({ status: 'ok' });
    expect(await first).toMatchObject({ status: 'opened' });
    // single-flight is released afterwards
    expect(await call('connection:create', ev(saas.wc), NEW)).toMatchObject({ status: 'opened' });
  });

  it('releases single-flight after a failure', async () => {
    const saas = saasForeground();
    deps.probe.mockRejectedValueOnce(new Error('boom'));
    await call('connection:create', ev(saas.wc), NEW).catch(() => undefined);
    expect(await call('connection:create', ev(saas.wc), NEW)).toMatchObject({ status: 'opened' });
  });

  it('returns declined and never registers the service when the ceremony is declined', async () => {
    const saas = saasForeground();
    deps.ceremony.mockResolvedValue({ approved: false });
    expect(await call('connection:create', ev(saas.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'declined',
    });
    expect(registerService).not.toHaveBeenCalledWith(NEW, expect.anything());
    expect(commitSelfHostedApproval).not.toHaveBeenCalled();
    expect(deps.openConnectionView).not.toHaveBeenCalled();
  });

  it('returns service-id-collision when the registry reports one', async () => {
    const saas = saasForeground();
    vi.mocked(registerService).mockReturnValueOnce({ ok: false, reason: 'service-id-collision' });
    expect(await call('connection:create', ev(saas.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'service-id-collision',
    });
    expect(deps.openConnectionView).not.toHaveBeenCalled();
  });

  it('returns limit when the view cannot be opened for the live-connection cap', async () => {
    const saas = saasForeground();
    deps.openConnectionView.mockResolvedValueOnce({ ok: false, reason: 'limit' });
    expect(await call('connection:create', ev(saas.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'limit',
    });
    expect(deps.activateConnection).not.toHaveBeenCalled();
  });

  it('re-checks after the ceremony: an origin registered meanwhile opens without a second register/open', async () => {
    const saas = saasForeground();
    let other: ReturnType<typeof conn> | undefined;
    deps.ceremony.mockImplementationOnce(async () => {
      other = conn(NEW, 9); // another path registered AND opened this origin during the dialog
      return { approved: true, address: '203.0.113.10' };
    });
    const result = await call('connection:create', ev(saas.wc), NEW);
    expect(result).toEqual({ status: 'opened', serviceId: other!.service.serviceId });
    // only the other path's own registerService call; connection.ts made none after the ceremony
    expect(vi.mocked(registerService).mock.calls.filter((c) => c[0] === NEW)).toHaveLength(1);
    expect(deps.openConnectionView).not.toHaveBeenCalled();
  });

  it('does not open anything when the sender stops being the foreground during the ceremony', async () => {
    const saas = saasForeground();
    const bg = conn(A, 2);
    deps.ceremony.mockImplementationOnce(async () => {
      setForeground(bg.record.connectionId);
      return { approved: true, address: '203.0.113.10' };
    });
    const result = (await call('connection:create', ev(saas.wc), NEW)) as { status: string };
    expect(result.status).toBe('rejected');
    expect(deps.openConnectionView).not.toHaveBeenCalled();
  });
});

// #87 R13: the approval dialog and the capture-move dialog share one modal slot. The
// probe has already run by the time approve() asks for the slot, so "probe not called"
// would be the wrong assertion; nothing after it runs, and no ceremony token is spent.
describe('connection:create under the cross-kind modal mutex (#87)', () => {
  function saasForeground() {
    const saas = conn(SAAS_ORIGIN, 1);
    setForeground(saas.record.connectionId);
    return saas;
  }

  beforeEach(() => {
    _resetModalMutexForTesting();
  });
  afterEach(() => {
    _resetModalMutexForTesting();
  });

  it('refuses busy while the capture ceremony holds the modal, spending no ceremony token', async () => {
    const saas = saasForeground();
    const releaseCapture = tryAcquireModal('capture');
    expect(releaseCapture).not.toBeNull();

    expect(await call('connection:create', ev(saas.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'busy',
    });
    expect(deps.probe).toHaveBeenCalledTimes(1);
    expect(consumeCeremonyToken).not.toHaveBeenCalled();
    expect(deps.ceremony).not.toHaveBeenCalled();
    expect(commitSelfHostedApproval).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalledWith(NEW, expect.anything());
    expect(modalInFlight()).toBe('capture');

    releaseCapture?.();
    expect(await call('connection:create', ev(saas.wc), NEW)).toMatchObject({ status: 'opened' });
  });

  it('holds the self-hosted-approval slot for the ceremony and releases it afterwards', async () => {
    const saas = saasForeground();
    let during: string | null = null;
    deps.ceremony.mockImplementationOnce(async () => {
      during = modalInFlight();
      return { approved: true, address: '203.0.113.10' };
    });
    expect(await call('connection:create', ev(saas.wc), NEW)).toMatchObject({ status: 'opened' });
    expect(during).toBe('self-hosted-approval');
    expect(modalInFlight()).toBeNull();
  });

  it('a capture acquire while the approval dialog is open is refused', async () => {
    const saas = saasForeground();
    let captureDuring: (() => void) | null | undefined;
    deps.ceremony.mockImplementationOnce(async () => {
      captureDuring = tryAcquireModal('capture');
      return { approved: false };
    });
    await call('connection:create', ev(saas.wc), NEW);
    expect(captureDuring).toBeNull();
    expect(tryAcquireModal('capture')).not.toBeNull();
  });

  it('releases the slot when the ceremony throws', async () => {
    const saas = saasForeground();
    let during: string | null = null;
    deps.ceremony.mockImplementationOnce(async () => {
      during = modalInFlight();
      throw new Error('native dialog failed');
    });
    // createConnection maps a thrown create to 'declined'.
    expect(await call('connection:create', ev(saas.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'declined',
    });
    expect(during).toBe('self-hosted-approval');
    expect(modalInFlight()).toBeNull();
  });

  it('takes the slot before the token, and releases it when the budget refuses', async () => {
    const saas = saasForeground();
    let during: string | null = null;
    vi.mocked(consumeCeremonyToken).mockImplementationOnce(() => {
      during = modalInFlight();
      return false;
    });
    expect(await call('connection:create', ev(saas.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'busy',
    });
    expect(during).toBe('self-hosted-approval');
    expect(deps.ceremony).not.toHaveBeenCalled();
    expect(modalInFlight()).toBeNull();
  });

  it('an origin that needs no approval takes no slot and opens while the capture modal is held', async () => {
    const saas = saasForeground();
    deps.probe.mockResolvedValueOnce({ status: 'ok', needsApproval: false });
    tryAcquireModal('capture');
    expect(await call('connection:create', ev(saas.wc), NEW)).toMatchObject({ status: 'opened' });
    expect(deps.ceremony).not.toHaveBeenCalled();
    expect(modalInFlight()).toBe('capture');
  });
});

describe('connection:create opener generation', () => {
  it('opens nothing when the opener document is replaced (generation advanced) during the ceremony', async () => {
    const saas = conn(SAAS_ORIGIN, 1);
    setForeground(saas.record.connectionId);
    deps.ceremony.mockImplementationOnce(async () => {
      advanceGeneration(saas.record.connectionId, 'document');
      return { approved: true, address: '203.0.113.10' };
    });
    expect(await call('connection:create', ev(saas.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'untrusted-sender',
    });
    expect(commitSelfHostedApproval).not.toHaveBeenCalled();
    expect(deps.openConnectionView).not.toHaveBeenCalled();
  });
});

describe('connection:activate', () => {
  it('returns false for an unknown service and never calls activateConnection', async () => {
    const saas = conn(SAAS_ORIGIN, 1);
    setForeground(saas.record.connectionId);
    deps.activateConnection.mockReturnValue(false);
    expect(await call('connection:activate', ev(saas.wc), serviceIdForApiBase(B))).toBe(false);
  });

  it('returns false for a non-string argument', async () => {
    const saas = conn(SAAS_ORIGIN, 1);
    setForeground(saas.record.connectionId);
    expect(await call('connection:activate', ev(saas.wc), { serviceId: 'saas' })).toBe(false);
    expect(deps.activateConnection).not.toHaveBeenCalled();
  });

  it('activates a known service from the foreground primary', async () => {
    const saas = conn(SAAS_ORIGIN, 1);
    const a = conn(A, 2);
    setForeground(saas.record.connectionId);
    expect(await call('connection:activate', ev(saas.wc), a.service.serviceId)).toBe(true);
    expect(deps.activateConnection).toHaveBeenCalledWith(a.service.serviceId);
  });

  it('refuses a background primary (app-global-mutate) with false', async () => {
    const saas = conn(SAAS_ORIGIN, 1);
    const a = conn(A, 2);
    setForeground(saas.record.connectionId);
    expect(await call('connection:activate', ev(a.wc), saas.service.serviceId)).toBe(false);
    expect(deps.activateConnection).not.toHaveBeenCalled();
  });
});

describe('connection:generation push', () => {
  it("sends the new generation to the record's own webContents only", () => {
    const saas = conn(SAAS_ORIGIN, 1);
    const a = conn(A, 2);
    const to = advanceGeneration(a.record.connectionId, 'credential-start');
    expect(sends.get(2)).toHaveBeenCalledTimes(1);
    expect(sends.get(2)).toHaveBeenCalledWith('connection:generation', {
      connectionId: a.record.connectionId,
      generation: to,
      reason: 'credential-start',
    });
    expect(sends.get(1)).not.toHaveBeenCalled();
    expect(saas.record.generation).toBe(1);
  });
});

describe('connection:create X4 (no orphan service after a refused view)', () => {
  it('does not leave the service registered when openConnectionView refuses after registerService', async () => {
    const saas = conn(SAAS_ORIGIN, 1);
    setForeground(saas.record.connectionId);
    deps.openConnectionView.mockResolvedValueOnce({ ok: false, reason: 'limit' });
    expect(await call('connection:create', ev(saas.wc), NEW)).toEqual({
      status: 'rejected',
      reason: 'limit',
    });
    expect(getService(serviceIdForApiBase(NEW))).toBeUndefined();
  });
});

// #86 Task 9: connection:preferenceScope returns only { serviceId, accountKey } or null.
describe('connection:preferenceScope', () => {
  const KEY = '0123456789abcdef';
  const withKey = (service: { custody: unknown }, key: string | null) => {
    (service.custody as { getAccountKey: () => string | null }).getAccountKey = () => key;
  };

  it('is registered', () => {
    expect(handlers.has('connection:preferenceScope')).toBe(true);
  });

  it('is null for a connection with no authenticated account', async () => {
    const a = conn(A, 21);
    withKey(a.service, null);
    expect(await call('connection:preferenceScope', ev(a.wc))).toBeNull();
  });

  it('is exactly { serviceId, accountKey } for an authenticated connection', async () => {
    const a = conn(A, 22);
    withKey(a.service, KEY);
    expect(await call('connection:preferenceScope', ev(a.wc))).toStrictEqual({
      serviceId: a.service.serviceId,
      accountKey: KEY,
    });
  });

  it('answers from the sender binding: each connection gets its own scope', async () => {
    const a = conn(A, 23);
    const b = conn(B, 24);
    withKey(a.service, KEY);
    withKey(b.service, null);
    expect(await call('connection:preferenceScope', ev(b.wc))).toBeNull();
    expect(await call('connection:preferenceScope', ev(a.wc))).toMatchObject({ accountKey: KEY });
  });

  it('is null again once the custody account is cleared', async () => {
    const a = conn(A, 25);
    withKey(a.service, KEY);
    withKey(a.service, null);
    expect(await call('connection:preferenceScope', ev(a.wc))).toBeNull();
  });

  it('is refused (null) for an unbound sender, whatever any custody holds', async () => {
    const a = conn(A, 26);
    withKey(a.service, KEY);
    expect(await call('connection:preferenceScope', ev(fakeWc(77)))).toBeNull();
  });

  it('is refused (null) for a frame not at an allowed URL', async () => {
    const a = conn(A, 27);
    withKey(a.service, KEY);
    expect(
      await call('connection:preferenceScope', ev(a.wc, undefined, 'https://evil.example/'))
    ).toBeNull();
  });

  it('never returns a path, an origin or any key beyond the two scope fields', async () => {
    const a = conn(A, 28);
    withKey(a.service, KEY);
    const out = (await call('connection:preferenceScope', ev(a.wc))) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['accountKey', 'serviceId']);
    expect(JSON.stringify(out)).not.toContain('a.example');
  });
});
