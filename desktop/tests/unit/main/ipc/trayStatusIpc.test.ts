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
  trayOwner,
} from '../../../../src/main/ipc/trayStatus';
import {
  _resetConnectionRegistryForTesting,
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
  const contents = { mainFrame: { frameTreeNodeId: 1 } };
  const win = { isDestroyed: vi.fn(() => false), webContents: contents };
  return { contents, win };
}

function setup(now?: () => number) {
  handlers.clear();
  const { contents, win } = makeWindow();
  let current: typeof win | null = win;
  vi.spyOn(Date, 'now').mockImplementation(now ?? (() => 1_000));
  registerTrayStatusIpc(
    () => null,
    () => current as never
  );
  const handler = handlers.get(TRAY_SET_STATUS);
  if (!handler) throw new Error('tray:setStatus not registered');
  const trusted = {
    sender: contents,
    senderFrame: { url: 'app://concord/index.html', frameTreeNodeId: 1 },
  };
  return {
    handler,
    contents,
    win,
    trusted,
    setWindow: (w: typeof win | null) => {
      current = w;
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
      senderFrame: { url: 'https://evil.example/', frameTreeNodeId: 1 },
    };
    expect(await handler(evil, SNAPSHOT)).toBe(true);
    expect(await handler({ sender: contents, senderFrame: null }, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('refuses a PiP sender that shares the origin', async () => {
    const { handler } = setup();
    const pip = {
      sender: { mainFrame: { frameTreeNodeId: 9 } },
      senderFrame: { url: 'app://concord/pip.html', frameTreeNodeId: 9 },
    };
    expect(await handler(pip, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('refuses a subframe of the main window', async () => {
    const { handler, contents } = setup();
    const sub = {
      sender: contents,
      senderFrame: { url: 'app://concord/index.html', frameTreeNodeId: 5 },
    };
    expect(await handler(sub, SNAPSHOT)).toBe(true);
    expect(mockApplyTraySnapshot).not.toHaveBeenCalled();
  });

  it('refuses when there is no main window, or it is destroyed, or reading it throws', async () => {
    const { handler, trusted, win, setWindow } = setup();
    setWindow(null);
    expect(await handler(trusted, SNAPSHOT)).toBe(true);
    setWindow(win);
    win.isDestroyed.mockReturnValue(true);
    expect(await handler(trusted, SNAPSHOT)).toBe(true);
    win.isDestroyed.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
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
});
