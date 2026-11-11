// @vitest-environment node
// connection:* channels (spec 2026-11-09-86-connection-context-isolation §3.7;
// plan Task 7A step 4): whoAmI, create, activate and the generation push.
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  const actual = await importOriginal<typeof import('../../../../src/main/connectionRegistry')>();
  return {
    ...actual,
    registerService: vi.fn((origin: string) => actual.registerService(origin, regDeps as never)),
  };
});
vi.mock('../../../../src/main/selfHostedCeremonyBudget', () => ({
  consumeCeremonyToken: vi.fn(() => true),
}));
vi.mock('../../../../src/main/selfHostedProfile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/selfHostedProfile')>()),
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
import { registerConnectionIpc } from '../../../../src/main/ipc/connection';

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
