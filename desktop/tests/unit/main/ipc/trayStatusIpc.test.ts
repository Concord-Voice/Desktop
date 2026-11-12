// @vitest-environment node
//
// `tray:setStatus` (tray-status spec §4, AC8, AC13). The handler's fences run in a
// fixed order — trusted frame, main-window main frame, 20/s token bucket, exact-shape
// guard — and every refusal resolves `true`, never a throw; only a rate-limit drop
// resolves `false`, telling the renderer to resend.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TRAY_SET_STATUS, type TrayStatusSnapshot } from '../../../../src/shared/trayStatus';

type Handler = (event: unknown, payload: unknown) => unknown;

const { handlers, mockApplyTraySnapshot } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  mockApplyTraySnapshot: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: {
    handle: vi.fn((channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock('../../../../src/main/tray', () => ({
  applyTraySnapshot: mockApplyTraySnapshot,
}));

import {
  attachTrayResetHooks,
  createTokenBucket,
  displayedTrayConnection,
  dropTraySnapshot,
  registerTrayStatusIpc,
  setTrayOwner,
  trayActionTarget,
  trayOwner,
  traySnapshotCount,
  traySnapshotFor,
} from '../../../../src/main/ipc/trayStatus';
import {
  _resetConnectionRegistryForTesting,
  advanceGeneration,
  bindSender,
  openConnection,
  refOf,
  registerService,
  setForeground,
} from '../../../../src/main/connectionRegistry';
import { _resetIpcRegistryForTesting } from '../../../../src/main/ipc/registry';

const SNAPSHOT: TrayStatusSnapshot = {
  v: 1,
  auth: 'signed-in',
  presence: 'online',
  conn: 'ok',
  voice: 'channel',
  speaking: false,
  muted: false,
  deafened: false,
  sharing: false,
  micLocked: false,
  deafenLocked: false,
  unread: 0,
  mention: false,
  reducedMotion: false,
  iconStyle: 'auto',
};

function makeWindow() {
  const contents = { id: 1, mainFrame: { frameTreeNodeId: 1, parent: null, detached: false } };
  const win = { isDestroyed: vi.fn(() => false), webContents: contents };
  return { contents, win };
}

function setup(now?: () => number) {
  handlers.clear();
  const { contents, win } = makeWindow();
  vi.spyOn(Date, 'now').mockImplementation(now ?? (() => 1_000));
  // #86 Task 7B re-point: admission is the main-held binding, not a main-window identity
  // gate. `contents` is the bound FOREGROUND saas primary; `setWindow(null)` now means
  // "no connection is foreground", which is what the old null-window case guarded.
  _resetConnectionRegistryForTesting();
  _resetIpcRegistryForTesting();
  setTrayOwner(null);
  const svc = registerService('https://api.concordvoice.chat', {
    makeSession: () => ({}) as never,
    makeCustody: () => ({}) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!svc.ok) throw new Error(svc.reason);
  const opened = openConnection(svc.service.serviceId, contents as never, null);
  if (!opened.ok) throw new Error(opened.reason);
  bindSender(contents as never, opened.record.connectionId, 'primary');
  setForeground(opened.record.connectionId);
  const connectionId = opened.record.connectionId;
  registerTrayStatusIpc();
  mockApplyTraySnapshot.mockReset();
  const handler = handlers.get(TRAY_SET_STATUS);
  if (!handler) throw new Error('tray:setStatus not registered');
  const trusted = {
    sender: contents,
    senderFrame: {
      url: 'app://concord/index.html',
      frameTreeNodeId: 1,
      parent: null,
      detached: false,
    },
  };
  return {
    handler,
    contents,
    win,
    trusted,
    setWindow: (w: typeof win | null) => {
      setForeground(w ? connectionId : null);
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockApplyTraySnapshot.mockReset();
});

describe('createTokenBucket', () => {
  it('admits a full bucket, refuses the next call, then refills over time', () => {
    let t = 0;
    const allow = createTokenBucket(20, () => t);
    for (let i = 0; i < 20; i += 1) expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    t = 50; // one token per 50 ms at 20/s
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    t = 10_000;
    for (let i = 0; i < 20; i += 1) expect(allow()).toBe(true);
    expect(allow()).toBe(false);
  });

  it('does not mint tokens when the clock goes backwards', () => {
    let t = 1_000;
    const allow = createTokenBucket(1, () => t);
    expect(allow()).toBe(true);
    t = 0;
    expect(allow()).toBe(false);
  });
});

describe('tray:setStatus handler (AC8)', () => {
  it('applies a valid snapshot from the main window main frame', async () => {
    const { handler, trusted } = setup();
    expect(await handler(trusted, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(SNAPSHOT);
    // A copy, not the caller's object.
    expect(mockApplyTraySnapshot.mock.calls[0][0]).not.toBe(SNAPSHOT);
  });

  it('refuses an untrusted frame', async () => {
    const { handler, contents } = setup();
    const evil = {
      sender: contents,
      senderFrame: {
        url: 'https://evil.example/',
        frameTreeNodeId: 1,
        parent: null,
        detached: false,
      },
    };
    expect(await handler(evil, SNAPSHOT)).toBe(true);
    expect(await handler({ sender: contents, senderFrame: null }, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('refuses a PiP sender that shares the origin', async () => {
    const { handler } = setup();
    const pip = {
      sender: { mainFrame: { frameTreeNodeId: 9, parent: null, detached: false } },
      senderFrame: {
        url: 'app://concord/pip.html',
        frameTreeNodeId: 9,
        parent: null,
        detached: false,
      },
    };
    expect(await handler(pip, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('refuses a subframe of the main window', async () => {
    const { handler, contents } = setup();
    const sub = {
      sender: contents,
      senderFrame: {
        url: 'app://concord/index.html',
        frameTreeNodeId: 5,
        parent: null,
        detached: false,
      },
    };
    expect(await handler(sub, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('with no foreground and no owner it stores the snapshot but applies nothing (#87 RC-2)', async () => {
    const { handler, trusted, setWindow } = setup();
    setWindow(null);
    mockApplyTraySnapshot.mockClear();
    expect(await handler(trusted, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(traySnapshotCount()).toBe(1);
    expect(displayedTrayConnection()).toBeNull();
  });

  it('drops the 21st call inside one second', async () => {
    const { handler, trusted } = setup(() => 5_000);
    for (let i = 0; i < 20; i += 1) {
      expect(await handler(trusted, SNAPSHOT)).toBe(true);
    }
    expect(await handler(trusted, SNAPSHOT)).toBe(false);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(20);
  });

  it('drops a malformed payload and logs the field name once per session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, trusted } = setup();
    expect(await handler(trusted, { ...SNAPSHOT, unread: 1.5 })).toBe(true);
    expect(await handler(trusted, { ...SNAPSHOT, auth: 'root' })).toBe(true);
    expect(await handler(trusted, 'not-an-object')).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0].join(' '));
    expect(line).toContain('unread');
    expect(line).not.toContain('1.5');
  });

  it('never logs a caller-chosen extra key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, trusted } = setup();
    await handler(trusted, { ...SNAPSHOT, secretChannelName: true });
    const line = String(warn.mock.calls[0]?.join(' '));
    expect(line).toContain('$keys');
    expect(line).not.toContain('secretChannelName');
  });

  it('swallows a throw from applyTraySnapshot', async () => {
    mockApplyTraySnapshot.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { handler, trusted } = setup();
    await expect(Promise.resolve(handler(trusted, SNAPSHOT))).resolves.toBe(true);
  });
});

describe('attachTrayResetHooks (AC13)', () => {
  function hooks() {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const contents = {
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        listeners.set(event, fn);
      }),
    };
    attachTrayResetHooks(contents);
    const fire = (event: string, ...args: unknown[]) => {
      const fn = listeners.get(event);
      if (!fn) throw new Error(`no ${event} listener`);
      fn(...args);
    };
    return { fire };
  }

  it('resets to neutral once a main-frame navigation commits', () => {
    const { fire } = hooks();
    fire('did-navigate');
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
  });

  it('does not reset on a navigation attempt that may still be cancelled', () => {
    const { fire } = hooks();
    expect(() => fire('did-start-navigation', { isMainFrame: true })).toThrow(/no did-start/);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('resets on a failed main-frame load, but not an aborted one or a subframe', () => {
    const { fire } = hooks();
    fire('did-fail-load', {}, -3, 'aborted', 'https://x', true);
    fire('did-fail-load', {}, -105, 'name not resolved', 'https://x', false);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    fire('did-fail-load', {}, -105, 'name not resolved', 'https://x', true);
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
  });

  it.each(['render-process-gone', 'unresponsive', 'destroyed'])('resets on %s', (event) => {
    const { fire } = hooks();
    fire(event, {}, {});
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
  });

  it('re-applies the last accepted snapshot when a hung renderer recovers', async () => {
    const { handler, trusted } = setup();
    await handler(trusted, SNAPSHOT);
    const { fire } = hooks();
    mockApplyTraySnapshot.mockClear();
    fire('unresponsive');
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
    fire('responsive');
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(SNAPSHOT);
  });

  it.each(['render-process-gone', 'destroyed'])(
    'forgets the snapshot on %s, so a later responsive restores nothing',
    async (event) => {
      const { handler, trusted } = setup();
      await handler(trusted, SNAPSHOT);
      const { fire } = hooks();
      fire(event, {}, {});
      mockApplyTraySnapshot.mockClear();
      fire('responsive');
      expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    }
  );

  it('forgets the snapshot on a main-frame navigation', async () => {
    const { handler, trusted } = setup();
    await handler(trusted, SNAPSHOT);
    const { fire } = hooks();
    fire('did-navigate');
    mockApplyTraySnapshot.mockClear();
    fire('responsive');
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });
});

// #86 Task 7B: sender authority is the main-held binding. getMainWindow is null below so the
// legacy main-window identity gate can never admit these senders.
describe('tray:setStatus binding-derived admission (#86 Task 7B)', () => {
  function conn(origin: string, id: number) {
    const r = registerService(origin, {
      makeSession: () => ({}) as never,
      makeCustody: () => ({}) as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!r.ok) throw new Error(r.reason);
    const wc = { id, mainFrame: { frameTreeNodeId: id } } as never;
    const o = openConnection(r.service.serviceId, wc, null);
    if (!o.ok) throw new Error(o.reason);
    bindSender(wc, o.record.connectionId, 'primary');
    return { wc, record: o.record, id, ref: refOf(o.record) };
  }
  const ev = (c: { wc: unknown; id: number }, over: Record<string, unknown> = {}) =>
    ({
      sender: c.wc,
      senderFrame: {
        url: 'app://concord/index.html',
        parent: null,
        frameTreeNodeId: c.id,
        detached: false,
        ...over,
      },
    }) as never;

  function boot() {
    _resetConnectionRegistryForTesting();
    _resetIpcRegistryForTesting();
    handlers.clear();
    setTrayOwner(null);
    mockApplyTraySnapshot.mockReset();
    vi.spyOn(Date, 'now').mockImplementation(() => 1_000);
    registerTrayStatusIpc(
      () => null,
      () => null
    );
    const handler = handlers.get(TRAY_SET_STATUS)!;
    const A = conn('https://api.concordvoice.chat', 31);
    const B = conn(new URL('https://a.example').origin, 32);
    setForeground(A.record.connectionId);
    mockApplyTraySnapshot.mockReset();
    return { handler, A, B };
  }
  const SNAP_B: TrayStatusSnapshot = { ...SNAPSHOT, unread: 7, voice: 'none' };
  function hooksOn(wc: unknown) {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    Object.assign(wc as object, {
      on: (event: string, fn: (...args: unknown[]) => void) => {
        listeners.set(event, fn);
      },
    });
    attachTrayResetHooks(wc as never);
    return (event: string, ...args: unknown[]) => {
      const fn = listeners.get(event);
      if (!fn) throw new Error(`no ${event} listener`);
      fn(...args);
    };
  }

  it('trayOwner() is null by default and round-trips setTrayOwner', () => {
    const { B } = boot();
    expect(trayOwner()).toBeNull();
    setTrayOwner(B.ref);
    expect(trayOwner()).toEqual(B.ref);
    setTrayOwner(null);
    expect(trayOwner()).toBeNull();
  });

  // #87 RC-2 (R15 wins inside the handler): every bound primary's snapshot is STORED, and
  // only the displayed connection's is APPLIED. These rows replace #86's "admits X only".
  it("with no tray owner it stores every bound primary's snapshot and applies the foreground's only", async () => {
    const { handler, A, B } = boot();
    expect(await handler(ev(B), SNAP_B)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(traySnapshotFor(B.record.connectionId)).toEqual(SNAP_B);
    expect(await handler(ev(A), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(SNAPSHOT);
    expect(traySnapshotCount()).toBe(2);
    expect(displayedTrayConnection()).toBe(A.record.connectionId);
  });

  it("after setTrayOwner(refB) it stores A's update but applies B's only, even while A is foreground", async () => {
    const { handler, A, B } = boot();
    setTrayOwner(B.ref);
    mockApplyTraySnapshot.mockClear();
    expect(await handler(ev(A), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(traySnapshotFor(A.record.connectionId)).toEqual(SNAPSHOT);
    expect(await handler(ev(B), SNAP_B)).toBe(true);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(SNAP_B);
  });

  it("after setTrayOwner(refA) B's update is stored, not applied, even while B is foreground", async () => {
    const { handler, A, B } = boot();
    setForeground(B.record.connectionId);
    setTrayOwner(A.ref);
    mockApplyTraySnapshot.mockClear();
    expect(await handler(ev(B), SNAP_B)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(traySnapshotFor(B.record.connectionId)).toEqual(SNAP_B);
    expect(displayedTrayConnection()).toBe(A.record.connectionId);
  });

  it("setTrayOwner re-applies the newly displayed snapshot at once; null applies the foreground's", async () => {
    const { handler, A, B } = boot();
    await handler(ev(A), SNAPSHOT);
    await handler(ev(B), SNAP_B);
    mockApplyTraySnapshot.mockClear();
    setTrayOwner(B.ref);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(SNAP_B);
    setTrayOwner(null);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(2);
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(SNAPSHOT);
  });

  it('a stale tray owner stores the snapshot but keeps the tray neutral and routes no action', async () => {
    const { handler, B } = boot();
    setTrayOwner(B.ref);
    advanceGeneration(B.record.connectionId, 'document');
    mockApplyTraySnapshot.mockClear();
    expect(await handler(ev(B), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(traySnapshotFor(B.record.connectionId)).toEqual(SNAPSHOT);
    expect(displayedTrayConnection()).toBe(B.record.connectionId);
    expect(trayActionTarget()).toBeNull();
  });

  it('dropTraySnapshot removes one connection and neutralises the tray only when it is displayed', async () => {
    const { handler, A, B } = boot();
    await handler(ev(A), SNAPSHOT);
    await handler(ev(B), SNAP_B);
    mockApplyTraySnapshot.mockClear();
    dropTraySnapshot(A.record.connectionId);
    expect(traySnapshotCount()).toBe(1);
    expect(traySnapshotFor(A.record.connectionId)).toBeNull();
    expect(traySnapshotFor(B.record.connectionId)).toEqual(SNAP_B);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
    dropTraySnapshot(B.record.connectionId);
    expect(traySnapshotCount()).toBe(0);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
  });

  it("a reset hook resets only its own connection: B's did-navigate leaves displayed A untouched", async () => {
    const { handler, A, B } = boot();
    await handler(ev(A), SNAPSHOT);
    await handler(ev(B), SNAP_B);
    const fireA = hooksOn(A.wc);
    const fireB = hooksOn(B.wc);
    mockApplyTraySnapshot.mockClear();
    fireB('did-navigate');
    fireB('unresponsive');
    fireB('responsive');
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(traySnapshotFor(B.record.connectionId)).toBeNull();
    expect(traySnapshotFor(A.record.connectionId)).toEqual(SNAPSHOT);
    fireA('unresponsive');
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
    fireA('responsive');
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(SNAPSHOT);
    fireA('did-navigate');
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
    expect(traySnapshotCount()).toBe(0);
  });

  // RC-14: a credential advance re-keys the same running document, so its snapshot stays.
  it.each(['credential-start', 'credential-end'] as const)(
    'a %s advance keeps that connection’s snapshot',
    async (reason) => {
      const { handler, A } = boot();
      await handler(ev(A), SNAPSHOT);
      mockApplyTraySnapshot.mockClear();
      advanceGeneration(A.record.connectionId, reason);
      expect(traySnapshotFor(A.record.connectionId)).toEqual(SNAPSHOT);
      expect(traySnapshotCount()).toBe(1);
      expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    }
  );

  it.each(['document', 'renderer-gone', 'disposed'] as const)(
    'a %s advance drops that connection’s snapshot and neutralises it while displayed',
    async (reason) => {
      const { handler, A, B } = boot();
      await handler(ev(A), SNAPSHOT);
      await handler(ev(B), SNAP_B);
      mockApplyTraySnapshot.mockClear();
      advanceGeneration(A.record.connectionId, reason);
      expect(traySnapshotFor(A.record.connectionId)).toBeNull();
      expect(traySnapshotFor(B.record.connectionId)).toEqual(SNAP_B);
      expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
    }
  );

  it('the rate limit is per connection', async () => {
    const { handler, A, B } = boot();
    for (let i = 0; i < 20; i += 1) expect(await handler(ev(B), SNAP_B)).toBe(true);
    expect(await handler(ev(B), SNAP_B)).toBe(false);
    expect(await handler(ev(A), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(SNAPSHOT);
  });

  it("a foreground change shows the new foreground's stored snapshot while no owner is set", async () => {
    const { handler, A, B } = boot();
    await handler(ev(A), SNAPSHOT);
    await handler(ev(B), SNAP_B);
    mockApplyTraySnapshot.mockClear();
    setForeground(B.record.connectionId);
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(SNAP_B);
    setForeground(null);
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
    setTrayOwner(A.ref);
    mockApplyTraySnapshot.mockClear();
    setForeground(B.record.connectionId);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('trayActionTarget follows the displayed connection and fails closed on a stale owner', () => {
    const { A, B } = boot();
    expect(trayActionTarget()).toEqual(A.ref);
    setTrayOwner(B.ref);
    expect(trayActionTarget()).toEqual(B.ref);
    setTrayOwner(null);
    setForeground(null);
    expect(trayActionTarget()).toBeNull();
    setTrayOwner(B.ref);
    advanceGeneration(B.record.connectionId, 'document');
    expect(trayActionTarget()).toBeNull();
  });

  it('refuses a detached sender frame and a destroyed sender, resolving true', async () => {
    const { handler, A } = boot();
    expect(await handler(ev(A, { detached: true }), SNAPSHOT)).toBe(true);
    const destroyed = ev(A) as { senderFrame: unknown };
    Object.defineProperty(destroyed, 'senderFrame', {
      get: () => {
        throw new Error('Object has been destroyed');
      },
    });
    expect(await handler(destroyed, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });
});
