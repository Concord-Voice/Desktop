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
  registerTrayStatusIpc,
  setTrayOwner,
  trayActionTarget,
  trayOwner,
} from '../../../../src/main/ipc/trayStatus';
import {
  _resetConnectionRegistryForTesting,
  bindSender,
  disposeConnection,
  openConnection,
  refOf,
  registerService,
  setForeground,
} from '../../../../src/main/connectionRegistry';
import { _resetIpcRegistryForTesting } from '../../../../src/main/ipc/registry';
import type { ConnectionId } from '../../../../src/shared/connectionIdentity';

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
  // registerTrayStatusIpc forgets the previous test's tray state, so clearing the
  // owner after it re-renders nothing here.
  registerTrayStatusIpc();
  setTrayOwner(null);
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
    connectionId,
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

  it('refuses when no connection is foreground and no owner is set (#86 Task 7B re-point)', async () => {
    const { handler, trusted, setWindow } = setup();
    setWindow(null);
    expect(await handler(trusted, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
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

/** `attachTrayResetHooks` on a fake `webContents`, for the connection `connectionId`. */
function hooks(connectionId: ConnectionId) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const contents = {
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, fn);
    }),
  };
  attachTrayResetHooks(contents, connectionId);
  const fire = (event: string, ...args: unknown[]) => {
    const fn = listeners.get(event);
    if (!fn) throw new Error(`no ${event} listener`);
    fn(...args);
  };
  return { fire };
}

// Every reset hook, with arguments that make it reset (#86 B2 runs each one per view).
const RESETS: ReadonlyArray<readonly [string, readonly unknown[]]> = [
  ['did-navigate', []],
  ['did-fail-load', [{}, -105, 'name not resolved', 'https://x', true]],
  ['render-process-gone', [{}, {}]],
  ['unresponsive', []],
  ['destroyed', []],
];

describe('attachTrayResetHooks (AC13)', () => {
  // The foreground connection's view, with an accepted snapshot on the tray.
  async function shown() {
    const s = setup();
    await s.handler(s.trusted, SNAPSHOT);
    mockApplyTraySnapshot.mockClear();
    return { ...s, ...hooks(s.connectionId) };
  }

  it('resets to neutral once a main-frame navigation commits', async () => {
    const { fire } = await shown();
    fire('did-navigate');
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
  });

  it('does not reset on a navigation attempt that may still be cancelled', async () => {
    const { fire } = await shown();
    expect(() => fire('did-start-navigation', { isMainFrame: true })).toThrow(/no did-start/);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('resets on a failed main-frame load, but not an aborted one or a subframe', async () => {
    const { fire } = await shown();
    fire('did-fail-load', {}, -3, 'aborted', 'https://x', true);
    fire('did-fail-load', {}, -105, 'name not resolved', 'https://x', false);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    fire('did-fail-load', {}, -105, 'name not resolved', 'https://x', true);
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
  });

  it.each(['render-process-gone', 'unresponsive', 'destroyed'])('resets on %s', async (event) => {
    const { fire } = await shown();
    fire(event, {}, {});
    expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
  });

  it('re-applies the last accepted snapshot when a hung renderer recovers', async () => {
    const { fire } = await shown();
    fire('unresponsive');
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
    fire('responsive');
    expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(SNAPSHOT);
  });

  it.each(['render-process-gone', 'destroyed'])(
    'forgets the snapshot on %s, so a later responsive restores nothing',
    async (event) => {
      const { fire } = await shown();
      fire(event, {}, {});
      mockApplyTraySnapshot.mockClear();
      fire('responsive');
      expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    }
  );

  it('forgets the snapshot on a main-frame navigation', async () => {
    const { fire } = await shown();
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
    const wc = { id, mainFrame: { frameTreeNodeId: id }, isDestroyed: () => false } as never;
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
    return { handler, A, B };
  }

  it('trayOwner() is null by default and round-trips setTrayOwner', () => {
    const { B } = boot();
    expect(trayOwner()).toBeNull();
    setTrayOwner(B.ref);
    expect(trayOwner()).toEqual(B.ref);
    setTrayOwner(null);
    expect(trayOwner()).toBeNull();
  });

  it('with no tray owner it admits the foreground primary only', async () => {
    const { handler, A, B } = boot();
    expect(await handler(ev(B), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(await handler(ev(A), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
  });

  it('after setTrayOwner(refB) it admits B only, even while A is foreground', async () => {
    // CONTRACT: assumes tray:setStatus is admitted as connection-bound plus an owner
    // check (7A classified it app-global-mutate; 7B may revise that row).
    const { handler, A, B } = boot();
    setTrayOwner(B.ref);
    expect(await handler(ev(A), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
    expect(await handler(ev(B), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale tray owner ref (owner generation advanced)', async () => {
    const { handler, B } = boot();
    const reg = await import('../../../../src/main/connectionRegistry');
    setTrayOwner(B.ref);
    reg.advanceGeneration(B.record.connectionId, 'document');
    expect(await handler(ev(B), SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
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
  // #86 B1: the tray shows, and its actions reach, one connection. A snapshot a
  // background connection sent is kept for it, so a switch shows that connection's
  // state at once: its renderer sends only on change and will not resend.
  describe('foreground switch (#86 B1)', () => {
    const IN_VOICE: TrayStatusSnapshot = { ...SNAPSHOT, voice: 'channel', muted: false };
    const IDLE: TrayStatusSnapshot = { ...SNAPSHOT, voice: 'none' };

    it("shows the new foreground's snapshot, sent while it was background, with no resend", async () => {
      const { handler, A, B } = boot();
      expect(await handler(ev(A), IN_VOICE)).toBe(true);
      expect(await handler(ev(B), IDLE)).toBe(true);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IN_VOICE);
      setForeground(B.record.connectionId);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IDLE);
      setForeground(A.record.connectionId);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IN_VOICE);
    });

    it("drops the previous connection's voice rows when the new foreground has sent nothing", async () => {
      const { handler, A, B } = boot();
      await handler(ev(A), IN_VOICE);
      setForeground(B.record.connectionId);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
    });

    it('routes tray actions to the connection whose snapshot is on screen', async () => {
      const { handler, A, B } = boot();
      await handler(ev(A), IN_VOICE);
      expect(trayActionTarget()).toBe(A.wc);
      await handler(ev(B), IDLE);
      expect(trayActionTarget()).toBe(A.wc);
      setForeground(B.record.connectionId);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IDLE);
      expect(trayActionTarget()).toBe(B.wc);
    });

    it('sends tray actions nowhere while the tray is neutral or shows a non-foreground owner', async () => {
      const { handler, A, B } = boot();
      expect(trayActionTarget()).toBeNull();
      await handler(ev(A), IN_VOICE);
      setForeground(B.record.connectionId);
      expect(trayActionTarget()).toBeNull();
      // #87 seam (B3 is deferred): an owner other than the foreground fails closed.
      setForeground(A.record.connectionId);
      setTrayOwner(B.ref);
      await handler(ev(B), IDLE);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IDLE);
      expect(trayActionTarget()).toBeNull();
    });

    it("naming or clearing a tray owner shows that connection's kept snapshot at once", async () => {
      const { handler, A, B } = boot();
      await handler(ev(A), IN_VOICE);
      await handler(ev(B), IDLE);
      setTrayOwner(B.ref);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IDLE);
      setTrayOwner(null);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IN_VOICE);
    });

    it("re-renders neutral at once when the owner's generation advances, with no resend (M11)", async () => {
      const { handler, A, B } = boot();
      const reg = await import('../../../../src/main/connectionRegistry');
      await handler(ev(A), IN_VOICE);
      await handler(ev(B), IDLE);
      setTrayOwner(B.ref);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IDLE);
      mockApplyTraySnapshot.mockClear();
      reg.advanceGeneration(B.record.connectionId, 'document');
      expect(mockApplyTraySnapshot).toHaveBeenCalledTimes(1);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
      expect(trayActionTarget()).toBeNull();
    });

    it("never shows a snapshot kept at an older generation than the owner's named one (M6)", async () => {
      const { handler, A, B } = boot();
      const reg = await import('../../../../src/main/connectionRegistry');
      // B sends at generation N while A is foreground: kept, not shown.
      await handler(ev(B), IDLE);
      reg.advanceGeneration(B.record.connectionId, 'document');
      const live = reg.recordFor(B.record.connectionId)!;
      expect(live.generation).not.toBe(B.ref.generation);
      // Main names B at its CURRENT generation N+1: the owner is current, but the
      // kept snapshot predates it and B has not resent.
      setTrayOwner(reg.refOf(live));
      expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
      expect(trayActionTarget()).toBeNull();
      // Once B resends at N+1, the owner shows it.
      await handler(ev(B), IDLE);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IDLE);
      void A;
    });

    it('blanks the tray when the foreground connection is disposed', async () => {
      const { handler, A } = boot();
      await handler(ev(A), IN_VOICE);
      disposeConnection(A.record.connectionId);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
      expect(trayActionTarget()).toBeNull();
    });

    it("a background connection does not spend the foreground connection's rate budget", async () => {
      const { handler, A, B } = boot();
      for (let i = 0; i < 25; i += 1) await handler(ev(B), IDLE);
      expect(await handler(ev(B), IDLE)).toBe(false);
      expect(await handler(ev(A), IN_VOICE)).toBe(true);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(IN_VOICE);
    });
  });

  // #86 B2: every view gets reset hooks, but the tray is shared, so only the view
  // whose snapshot the tray shows may reset it.
  describe('reset hooks per view (#86 B2)', () => {
    it.each(RESETS)(
      '%s from a background view leaves the foreground tray alone',
      async (event, args) => {
        const { handler, A, B } = boot();
        await handler(ev(A), SNAPSHOT);
        await handler(ev(B), SNAPSHOT);
        mockApplyTraySnapshot.mockClear();
        hooks(B.record.connectionId).fire(event, ...args);
        hooks(B.record.connectionId).fire('responsive');
        expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
      }
    );

    it.each(RESETS)('%s from the foreground view still resets the tray', async (event, args) => {
      const { handler, A } = boot();
      await handler(ev(A), SNAPSHOT);
      mockApplyTraySnapshot.mockClear();
      hooks(A.record.connectionId).fire(event, ...args);
      expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
    });

    it.each(RESETS)(
      '%s from the tray owner resets it while another view is foreground',
      async (event, args) => {
        const { handler, B } = boot();
        setTrayOwner(B.ref);
        await handler(ev(B), SNAPSHOT);
        mockApplyTraySnapshot.mockClear();
        hooks(B.record.connectionId).fire(event, ...args);
        expect(mockApplyTraySnapshot).toHaveBeenCalledWith(null);
      }
    );

    it('a background reload forgets that connection only: switching to it shows neutral', async () => {
      const { handler, A, B } = boot();
      await handler(ev(A), SNAPSHOT);
      await handler(ev(B), { ...SNAPSHOT, voice: 'none' });
      hooks(B.record.connectionId).fire('did-navigate');
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(SNAPSHOT);
      setForeground(B.record.connectionId);
      expect(mockApplyTraySnapshot).toHaveBeenLastCalledWith(null);
    });
  });
});
