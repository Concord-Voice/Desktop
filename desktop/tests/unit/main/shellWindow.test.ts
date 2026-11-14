// @vitest-environment node
// #86 Task 4 — BaseWindow composition and connection views (spec §3.9).
// RED step: src/main/shellWindow.ts does not exist yet.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    packaged: true,
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    windows: [] as Array<Record<string, any>>,
    views: [] as Array<Record<string, any>>,
    pips: [] as Array<Record<string, any>>,
    pipOptions: [] as Array<Record<string, any>>,
  };
  function makeWc(ses: unknown) {
    const handlers = new Map<string, Array<(...a: any[]) => void>>();
    let destroyed = false;
    const wc: Record<string, any> = {
      session: ses,
      handlers,
      mainFrame: { frameTreeNodeId: 1 },
      on: vi.fn((e: string, f: (...a: any[]) => void) => {
        handlers.set(e, [...(handlers.get(e) ?? []), f]);
        return wc;
      }),
      once: vi.fn((e: string, f: (...a: any[]) => void) => {
        handlers.set(e, [...(handlers.get(e) ?? []), f]);
        return wc;
      }),
      emit(e: string, ...a: unknown[]) {
        for (const f of handlers.get(e) ?? []) f(...a);
      },
      loadURL: vi.fn(() => {
        state.calls.push('loadURL');
        return Promise.resolve();
      }),
      send: vi.fn(),
      close: vi.fn(() => {
        state.calls.push('wc.close');
        destroyed = true;
      }),
      isDestroyed: vi.fn(() => destroyed),
      setWindowOpenHandler: vi.fn(),
      getURL: vi.fn(() => ''),
    };
    return wc;
  }
  class BaseWindow {
    opts: Record<string, any>;
    handlers = new Map<string, Array<(...a: any[]) => void>>();
    contentView = {
      children: [] as unknown[],
      addChildView: vi.fn((v: unknown) => {
        state.calls.push('addChildView');
        this.contentView.children.push(v);
      }),
      removeChildView: vi.fn((v: unknown) => {
        state.calls.push('removeChildView');
        this.contentView.children = this.contentView.children.filter((c) => c !== v);
      }),
    };
    setContentProtection = vi.fn(() => state.calls.push('protect'));
    maximize = vi.fn();
    show = vi.fn();
    getContentBounds = vi.fn(() => ({ ...state.bounds }));
    isDestroyed = vi.fn(() => false);
    constructor(opts: Record<string, any>) {
      this.opts = opts;
      state.windows.push(this as never);
    }
    on(e: string, f: (...a: any[]) => void) {
      this.handlers.set(e, [...(this.handlers.get(e) ?? []), f]);
      return this;
    }
    emit(e: string, ...a: unknown[]) {
      for (const f of this.handlers.get(e) ?? []) f(...a);
    }
  }
  class WebContentsView {
    opts: Record<string, any>;
    webContents: Record<string, any>;
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor(opts: Record<string, any>) {
      this.opts = opts;
      this.webContents = makeWc(opts?.webPreferences?.session);
      state.views.push(this as never);
    }
  }
  class BrowserWindow {
    opts: Record<string, any>;
    webContents: Record<string, any>;
    destroy = vi.fn(() => state.calls.push('pip.destroy'));
    isDestroyed = vi.fn(() => false);
    handlers = new Map<string, Array<(...a: any[]) => void>>();
    constructor(opts: Record<string, any>) {
      this.opts = opts;
      this.webContents = makeWc(opts?.webPreferences?.session);
      state.pips.push(this as never);
      state.pipOptions.push(opts);
    }
    on(e: string, f: (...a: any[]) => void) {
      this.handlers.set(e, [...(this.handlers.get(e) ?? []), f]);
      return this;
    }
    loadURL = vi.fn();
    setContentProtection = vi.fn();
    close = vi.fn();
  }
  const mk = (name: string) => ({ name, protocol: { handle: vi.fn() }, fetch: vi.fn() });
  return {
    state,
    makeWc,
    mk,
    BaseWindow,
    WebContentsView,
    BrowserWindow,
    defaultSession: mk('default'),
    Menu: {
      buildFromTemplate: vi.fn((t: unknown) => ({ template: t })),
      getApplicationMenu: vi.fn(() => null),
      setApplicationMenu: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.state.packaged;
    },
    getPath: () => '/tmp/concord-test-userdata',
    getVersion: () => '1.2.3',
  },
  BaseWindow: h.BaseWindow,
  BrowserWindow: h.BrowserWindow,
  WebContentsView: h.WebContentsView,
  Menu: h.Menu,
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  session: { defaultSession: h.defaultSession, fromPath: vi.fn() },
}));
const writeConnectionsFile = vi.hoisted(() =>
  vi.fn((_root: string, _entries: unknown[]) => Promise.resolve())
);
vi.mock('../../../src/main/connectionsFile', () => ({ writeConnectionsFile }));

vi.mock('../../../src/main/billing/billingWindow', () => ({
  isBillingWebContents: () => false,
}));

import {
  _resetConnectionRegistryForTesting,
  MAX_LIVE_CONNECTIONS,
  bindingFor,
  foreground,
  liveConnections,
  onGenerationAdvanced,
  recordFor,
  refOf,
  registerService,
} from '../../../src/main/connectionRegistry';
import { bindOwner, isOwnerCurrent } from '../../../src/main/connectionCapability';
import { assertDefaultSessionIsSaas } from '../../../src/main/connectionSession';
import { requireConnectionSender } from '../../../src/main/ipc/connectionSender';
import {
  _resetPersistedConnectionsForTesting,
  activateConnection,
  broadcastToPrimaries,
  createPipWindow,
  createShellWindow,
  disposeConnectionView,
  foregroundView,
  foregroundWebContents,
  initPersistedConnections,
  installDevConnectionMenu,
  layoutViews,
  openConnectionView,
  persistAddedConnections,
  restorePersistedConnections,
  sendToConnection,
  shellWindow,
  showSaasForDeepLink,
} from '../../../src/main/shellWindow';

const SAAS_ORIGIN = 'https://api.concordvoice.chat';
const SELF_A = new URL('https://a.example').origin;
const SELF_B = new URL('https://b.example:8443').origin;

type Any = Record<string, any>;
const calls = h.state.calls;

let custodyListeners: Map<string, (phase: string, owner: number | null) => void>;
let deps: Any;
let wireBinding: unknown;

function register(origin: string): Any {
  const r = registerService(origin, {
    makeSession: () =>
      (origin === SAAS_ORIGIN ? h.defaultSession : h.mk(`session:${origin}`)) as never,
    makeCustody: () =>
      ({
        onCredentialEvent: (l: (phase: string, owner: number | null) => void) => {
          custodyListeners.set(origin, l);
          return () => custodyListeners.delete(origin);
        },
      }) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(`register failed: ${r.reason}`);
  return r.service;
}

async function mustOpen(serviceId: string, url = 'app://concord/index.html'): Promise<Any> {
  const r = await openConnectionView(serviceId as never, url);
  if (!r.ok) throw new Error(`open failed: ${r.reason}`);
  return r.record;
}

const lastView = () => h.state.views[h.state.views.length - 1];
const viewOf = (rec: Any) => rec.view as Any;

beforeEach(() => {
  _resetConnectionRegistryForTesting();
  _resetPersistedConnectionsForTesting();
  h.state.calls.length = 0;
  h.state.windows.length = 0;
  h.state.views.length = 0;
  h.state.pips.length = 0;
  h.state.pipOptions.length = 0;
  h.state.packaged = true;
  h.state.bounds = { x: 0, y: 0, width: 1280, height: 720 };
  h.Menu.buildFromTemplate.mockClear();
  h.Menu.setApplicationMenu.mockClear();
  custodyListeners = new Map();
  wireBinding = undefined;
  deps = {
    windowOptions: { width: 1280, height: 720 },
    preloadPath: '/app/preload.js',
    contentProtectionEnabled: true,
    applyContentProtectionAtCreation: vi.fn(() => calls.push('protect')),
    wireAudiocapRendererLoss: vi.fn((wc: unknown) => {
      calls.push('wire');
      wireBinding = bindingFor(wc as never);
    }),
    attachTrayResetHooks: vi.fn(() => calls.push('tray')),
    resetDeepLinkDelivery: vi.fn(),
    prepareSession: vi.fn(),
    isQuitting: vi.fn(() => false),
    onClose: vi.fn(),
  };
  createShellWindow(deps as never);
  deps.resetDeepLinkDelivery.mockClear();
  calls.length = 0;
});

describe('createShellWindow', () => {
  it('applies content protection on the BaseWindow before any child view or load', async () => {
    _resetConnectionRegistryForTesting();
    h.state.calls.length = 0;
    createShellWindow(deps as never);
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    expect(deps.applyContentProtectionAtCreation).toHaveBeenCalledWith(
      shellWindow(),
      true,
      expect.any(String)
    );
    const protect = calls.indexOf('protect');
    expect(protect).toBeGreaterThanOrEqual(0);
    expect(protect).toBeLessThan(calls.indexOf('addChildView'));
    expect(protect).toBeLessThan(calls.indexOf('loadURL'));
  });

  it("'close' with isQuitting true returns early without preventDefault (#1383)", () => {
    deps.isQuitting.mockReturnValue(true);
    const event = { preventDefault: vi.fn() };
    (shellWindow() as unknown as Any).emit('close', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(deps.onClose).not.toHaveBeenCalled();
  });

  it("'close' routes to the client-behaviour handler when not quitting", () => {
    const event = { preventDefault: vi.fn() };
    (shellWindow() as unknown as Any).emit('close', event);
    expect(deps.onClose).toHaveBeenCalledWith(event);
  });

  it("'closed' closes every live child webContents explicitly", async () => {
    const saas = register(SAAS_ORIGIN);
    const a = register(SELF_A);
    const recS = await mustOpen(saas.serviceId);
    const recA = await mustOpen(a.serviceId);
    (shellWindow() as unknown as Any).emit('closed');
    expect(recS.webContents.close).toHaveBeenCalledTimes(1);
    expect(recA.webContents.close).toHaveBeenCalledTimes(1);
  });
});

describe('openConnectionView', () => {
  it('wires audiocap loss and tray hooks before loadURL, with the view bound as primary', async () => {
    const saas = register(SAAS_ORIGIN);
    const rec = await mustOpen(saas.serviceId);
    expect(deps.wireAudiocapRendererLoss).toHaveBeenCalledWith(rec.webContents, rec.connectionId);
    // #86 B2: the hooks act only for the connection the tray belongs to.
    expect(deps.attachTrayResetHooks).toHaveBeenCalledWith(rec.webContents, rec.connectionId);
    expect(calls.indexOf('wire')).toBeLessThan(calls.indexOf('loadURL'));
    expect(calls.indexOf('tray')).toBeLessThan(calls.indexOf('loadURL'));
    expect(wireBinding).toEqual({ connectionId: rec.connectionId, role: 'primary' });
    expect(bindingFor(rec.webContents)).toEqual({
      connectionId: rec.connectionId,
      role: 'primary',
    });
    expect(rec.webContents.loadURL).toHaveBeenCalledWith('app://concord/index.html');
  });

  it("resets deep-link delivery on the view's did-start-loading", async () => {
    const saas = register(SAAS_ORIGIN);
    const rec = await mustOpen(saas.serviceId);
    rec.webContents.emit('did-start-loading');
    expect(deps.resetDeepLinkDelivery).toHaveBeenCalledTimes(1);
  });

  it("builds the view on the service's own session with a locked-down renderer", async () => {
    const a = register(SELF_A);
    await mustOpen(a.serviceId);
    const prefs = lastView().opts.webPreferences;
    expect(prefs.session).toBe(a.session);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBeFalsy();
    expect(prefs.preload).toBe('/app/preload.js');
  });

  it('refuses an unregistered service', async () => {
    const r = await openConnectionView('selfhost-0123456789abcdef' as never, 'app://concord/');
    expect(r).toEqual({ ok: false, reason: 'unknown-service' });
    expect(liveConnections()).toEqual([]);
  });

  it('refuses a second open of the same service and leaks no view', async () => {
    const a = register(SELF_A);
    await mustOpen(a.serviceId);
    const second = await openConnectionView(a.serviceId, 'app://concord/');
    expect(second).toEqual({ ok: false, reason: 'already-open' });
    expect(liveConnections()).toHaveLength(1);
    for (const v of h.state.views.slice(1)) expect(v.webContents.close).toHaveBeenCalled();
  });

  it('refuses the MAX_LIVE_CONNECTIONS + 1th connection and closes the surplus view', async () => {
    for (let i = 0; i < MAX_LIVE_CONNECTIONS; i++) {
      await mustOpen(register(`https://h${i}.example`).serviceId);
    }
    const extra = register('https://extra.example');
    const r = await openConnectionView(extra.serviceId, 'app://concord/');
    expect(r).toEqual({ ok: false, reason: 'limit' });
    expect(liveConnections()).toHaveLength(MAX_LIVE_CONNECTIONS);
    for (const v of h.state.views.slice(MAX_LIVE_CONNECTIONS)) {
      expect(v.webContents.close).toHaveBeenCalled();
    }
  });

  it('reports session-unavailable when session setup throws, warns, and still opens saas', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saas = register(SAAS_ORIGIN);
    const a = register(SELF_A);
    deps.prepareSession.mockImplementation((service: Any) => {
      if (service.kind === 'selfhost') throw new Error('fromPath failed');
    });
    const failed = await openConnectionView(a.serviceId, 'app://concord/');
    expect(failed).toEqual({ ok: false, reason: 'session-unavailable' });
    expect(warn).toHaveBeenCalled();
    expect(liveConnections()).toEqual([]);
    const ok = await openConnectionView(saas.serviceId, 'app://concord/');
    expect(ok.ok).toBe(true);
    expect(liveConnections()).toHaveLength(1);
    expect(h.state.views.some((v) => v.opts.webPreferences.session === h.defaultSession)).toBe(
      true
    );
    warn.mockRestore();
  });

  it('refuses a self-hosted view that landed on defaultSession (R1) and closes it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = registerService(SELF_A, {
      makeSession: () => h.defaultSession as never,
      makeCustody: () => ({ onCredentialEvent: () => () => {} }) as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!r.ok) throw new Error('register');
    const result = await openConnectionView(r.service.serviceId, 'app://concord/');
    expect(result.ok).toBe(false);
    expect(liveConnections()).toEqual([]);
    expect(lastView().webContents.close).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('keeps the default session saas-only with saas and one self-hosted view open', async () => {
    const saas = register(SAAS_ORIGIN);
    const a = register(SELF_A);
    await mustOpen(saas.serviceId);
    await mustOpen(a.serviceId);
    const live = liveConnections().map((c) => c.webContents);
    expect(() => assertDefaultSessionIsSaas(live as never, bindingFor, recordFor)).not.toThrow();
  });
});

describe('generation hooks', () => {
  async function opened() {
    const saas = register(SAAS_ORIGIN);
    const rec = await mustOpen(saas.serviceId);
    const reasons: string[] = [];
    onGenerationAdvanced((_id, _from, _to, reason) => reasons.push(reason));
    return { rec, saas, reasons };
  }

  it("a main-frame did-start-navigation advances the generation with 'document'", async () => {
    const { rec, reasons } = await opened();
    rec.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(reasons).toEqual(['document']);
    expect(rec.generation).toBe(2);
  });

  // Until the new document commits, the OUTGOING one is still the committed main frame
  // and is admitted at the generation did-start-navigation advanced to. Anything it
  // binds in that window (an SSO loopback) must not stay current for its successor.
  it.each([
    ['did-navigate', [{}, 'https://a.example/', 200, 'OK']],
    ['did-fail-load', [{}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://a.example/', true]],
  ] as const)(
    "an owner bound before the main-frame commit is stale after '%s'",
    async (event, args) => {
      const { rec, reasons } = await opened();
      rec.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      const owner = bindOwner('sso-loopback', refOf(rec));
      expect(isOwnerCurrent(owner)).toBe(true);
      rec.webContents.emit(event, ...args);
      expect(isOwnerCurrent(owner)).toBe(false);
      expect(reasons).toEqual(['document', 'document']);
      expect(rec.generation).toBe(3);
    }
  );

  it.each([
    [
      'a cancelled main-frame load (ERR_ABORTED)',
      [{}, -3, 'ERR_ABORTED', 'https://a.example/', true],
    ],
    ['a subframe load failure', [{}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://a.example/', false]],
  ] as const)('%s commits no document and advances nothing', async (_name, args) => {
    const { rec, reasons } = await opened();
    rec.webContents.emit('did-fail-load', ...args);
    expect(reasons).toEqual([]);
    expect(rec.generation).toBe(1);
  });

  // D1: the first document's whoAmI can arrive before its commit is recorded, so the
  // main-frame navigation the first load starts must already be tracked.
  it('tracks the main-frame navigation the first load starts, before that load', async () => {
    const a = register(new URL('https://a.example').origin);
    const frame = { processId: 6, routingId: 1 };
    let admittedDuringLoad: unknown = 'not-loaded';
    const r = await openConnectionView(a.serviceId, 'app://concord/index.html', (wc) => {
      const contents = wc as unknown as { emit(e: string, ...x: unknown[]): void };
      contents.emit('did-start-navigation', {
        url: 'app://concord/index.html',
        isMainFrame: true,
        isSameDocument: false,
        frame,
      });
      admittedDuringLoad = requireConnectionSender(
        {
          sender: wc,
          senderFrame: { url: '', parent: null, frameTreeNodeId: 1, detached: false, ...frame },
        } as never,
        { admitUncommitted: true }
      );
      return Promise.resolve();
    });
    expect(r.ok).toBe(true);
    expect(admittedDuringLoad).not.toBeNull();
  });

  it('a subframe navigation does not advance the generation', async () => {
    const { rec, reasons } = await opened();
    rec.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(reasons).toEqual([]);
    expect(rec.generation).toBe(1);
  });

  it("render-process-gone advances with 'renderer-gone'", async () => {
    const { rec, reasons } = await opened();
    rec.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(reasons).toEqual(['renderer-gone']);
  });

  it.each(['credential-start', 'credential-end'] as const)(
    "custody '%s' advances with that reason",
    async (phase) => {
      const { reasons } = await opened();
      custodyListeners.get(SAAS_ORIGIN)?.(phase, 1);
      expect(reasons).toEqual([phase]);
    }
  );

  it('a credential event after dispose does not throw or advance anything', async () => {
    const { rec } = await opened();
    disposeConnectionView(rec.connectionId);
    const reasons: string[] = [];
    onGenerationAdvanced((_i, _f, _t, r) => reasons.push(r));
    expect(() => custodyListeners.get(SAAS_ORIGIN)?.('credential-end', 1)).not.toThrow();
    expect(reasons).toEqual([]);
  });
});

describe('sendToConnection / broadcastToPrimaries', () => {
  it('delivers to a current ref and returns true', async () => {
    const rec = await mustOpen(register(SAAS_ORIGIN).serviceId);
    expect(sendToConnection(refOf(rec), 'chan', 1, 'x')).toBe(true);
    expect(rec.webContents.send).toHaveBeenCalledWith('chan', 1, 'x');
  });

  it('drops a stale ref: false and webContents.send not called', async () => {
    const rec = await mustOpen(register(SAAS_ORIGIN).serviceId);
    const stale = refOf(rec);
    rec.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(sendToConnection(stale, 'chan')).toBe(false);
    expect(rec.webContents.send).not.toHaveBeenCalled();
    expect(sendToConnection(refOf(rec), 'chan')).toBe(true);
  });

  it('drops a ref for a disposed connection', async () => {
    const rec = await mustOpen(register(SAAS_ORIGIN).serviceId);
    const ref = refOf(rec);
    disposeConnectionView(rec.connectionId);
    expect(sendToConnection(ref, 'chan')).toBe(false);
  });

  it('returns false when the webContents is destroyed', async () => {
    const rec = await mustOpen(register(SAAS_ORIGIN).serviceId);
    rec.webContents.isDestroyed.mockReturnValue(true);
    expect(sendToConnection(refOf(rec), 'chan')).toBe(false);
    expect(rec.webContents.send).not.toHaveBeenCalled();
  });

  it('broadcastToPrimaries reaches every live primary', async () => {
    const s = await mustOpen(register(SAAS_ORIGIN).serviceId);
    const a = await mustOpen(register(SELF_A).serviceId);
    broadcastToPrimaries('update:state', { v: 1 });
    expect(s.webContents.send).toHaveBeenCalledWith('update:state', { v: 1 });
    expect(a.webContents.send).toHaveBeenCalledWith('update:state', { v: 1 });
  });
});

describe('activateConnection and layoutViews', () => {
  it('makes only the target visible and records it as foreground', async () => {
    const s = await mustOpen(register(SAAS_ORIGIN).serviceId);
    const a = await mustOpen(register(SELF_A).serviceId);
    expect(activateConnection(a.serviceId)).toBe(true);
    expect(viewOf(a).setVisible).toHaveBeenLastCalledWith(true);
    expect(viewOf(s).setVisible).toHaveBeenLastCalledWith(false);
    expect(foreground()?.connectionId).toBe(a.connectionId);
    expect(foregroundWebContents()).toBe(a.webContents);
    expect(foregroundView()).toBe(viewOf(a));
    expect(activateConnection(s.serviceId)).toBe(true);
    expect(viewOf(s).setVisible).toHaveBeenLastCalledWith(true);
    expect(viewOf(a).setVisible).toHaveBeenLastCalledWith(false);
  });

  it('returns false for an unknown or not-live service', async () => {
    const saas = register(SAAS_ORIGIN);
    expect(activateConnection('selfhost-0123456789abcdef' as never)).toBe(false);
    expect(activateConnection(saas.serviceId)).toBe(false);
  });

  it.each(['resize', 'maximize', 'enter-full-screen'])(
    "layoutViews after '%s' sets the foreground bounds to getContentBounds()",
    async (event) => {
      const s = await mustOpen(register(SAAS_ORIGIN).serviceId);
      const a = await mustOpen(register(SELF_A).serviceId);
      activateConnection(s.serviceId);
      h.state.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
      (shellWindow() as unknown as Any).emit(event);
      expect(viewOf(s).setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      });
      expect(viewOf(a).setVisible).toHaveBeenLastCalledWith(false);
    }
  );

  it('layoutViews can be called directly and is a no-op with no foreground', () => {
    expect(() => layoutViews()).not.toThrow();
  });
});

describe('disposeConnectionView', () => {
  it("orders: 'disposed' generation, then PiPs destroyed, then removeChildView, then close", async () => {
    const s = await mustOpen(register(SAAS_ORIGIN).serviceId);
    activateConnection(s.serviceId);
    const pip = createPipWindow(s.webContents as never, { width: 320, height: 240 });
    expect(pip).not.toBeNull();
    calls.length = 0;
    onGenerationAdvanced((_i, _f, _t, reason) => calls.push(`advance:${reason}`));
    disposeConnectionView(s.connectionId);
    const order = ['advance:disposed', 'pip.destroy', 'removeChildView', 'wc.close'].map((c) =>
      calls.indexOf(c)
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(foregroundWebContents()).toBeNull();
    expect(recordFor(s.connectionId)).toBeUndefined();
  });

  it('is a no-op for an unknown connection id', () => {
    expect(() => disposeConnectionView('nope' as never)).not.toThrow();
  });
});

describe('createPipWindow', () => {
  it('runs on the owner session, locked down, and binds role pip to the opener connection', async () => {
    const a = register(SELF_A);
    const rec = await mustOpen(a.serviceId);
    const pip = createPipWindow(
      rec.webContents as never,
      {
        width: 320,
        height: 240,
        webPreferences: { preload: '/app/preload.js', session: h.defaultSession },
      } as never
    );
    expect(pip).not.toBeNull();
    const prefs = h.state.pipOptions[0].webPreferences;
    expect(prefs.session).toBe(a.session);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBeFalsy();
    const pipWc = h.state.pips[0].webContents;
    expect(bindingFor(pipWc as never)).toEqual({ connectionId: rec.connectionId, role: 'pip' });
    expect(rec.pips.has(pipWc)).toBe(true);
  });

  // D1 for PiP windows (Codex C1): main.ts issues pip.loadURL in the tick that creates
  // the window, so the PiP preload's whoAmI can arrive before its commit is recorded.
  // Without the tracker the uncommitted PiP is refused and boots ConnectionUnavailable.
  it('tracks the PiP main-frame navigation, so its uncommitted first whoAmI is admitted', async () => {
    const rec = await mustOpen(register(SELF_A).serviceId);
    const pip = createPipWindow(rec.webContents as never, { width: 320, height: 240 });
    expect(pip).not.toBeNull();
    const pipWc = h.state.pips[0].webContents;
    const frame = { processId: 9, routingId: 2 };
    pipWc.emit('did-start-navigation', {
      url: 'app://concord/index.html#/pip/p1',
      isMainFrame: true,
      isSameDocument: false,
      frame,
    });
    const admitted = requireConnectionSender(
      {
        sender: pipWc,
        senderFrame: { url: '', parent: null, frameTreeNodeId: 1, detached: false, ...frame },
      } as never,
      { admitUncommitted: true }
    );
    expect(admitted).not.toBeNull();
    expect(admitted?.role).toBe('pip');
  });

  it('refuses an opener that is not a bound primary and builds no window', () => {
    const stranger = h.makeWc(h.defaultSession);
    expect(createPipWindow(stranger as never, { width: 1, height: 1 })).toBeNull();
    expect(h.state.pips).toHaveLength(0);
  });
});

describe('installDevConnectionMenu', () => {
  it('builds a Connections menu only when the app is not packaged', () => {
    h.state.packaged = false;
    installDevConnectionMenu();
    expect(h.Menu.buildFromTemplate).toHaveBeenCalled();
    expect(JSON.stringify(h.Menu.buildFromTemplate.mock.calls)).toContain('Connections');
    expect(h.Menu.setApplicationMenu).toHaveBeenCalled();
  });

  it('builds nothing when packaged', () => {
    h.state.packaged = true;
    installDevConnectionMenu();
    expect(h.Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(h.Menu.setApplicationMenu).not.toHaveBeenCalled();
  });
});

describe('restorePersistedConnections (#86 Task 6)', () => {
  const at = (day: number) => `2026-11-0${day}T00:00:00.000Z`;
  const entryFor = (service: Any, lastForegroundAt: string | null) => ({
    serviceId: service.serviceId,
    origin: service.origin,
    addedAt: at(1),
    lastForegroundAt,
  });

  it('opens one view per persisted self-hosted entry and shows the latest foreground', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    const b = register(SELF_B);
    const asked: unknown[] = [];
    writeConnectionsFile.mockClear();
    await restorePersistedConnections(
      '/user-data',
      [entryFor(saas, at(2)), entryFor(a, at(3)), entryFor(b, null)],
      (origin) => {
        asked.push(origin);
        return register(origin) as never;
      }
    );
    // The registry sees origins only: lastForegroundAt never reaches admission.
    expect(asked).toEqual([SELF_A, SELF_B]);
    expect(liveConnections().map((r) => r.serviceId)).toEqual([
      saas.serviceId,
      a.serviceId,
      b.serviceId,
    ]);
    expect(foreground()?.serviceId).toBe(a.serviceId);
    expect(writeConnectionsFile).not.toHaveBeenCalled(); // restoring layout records nothing
  });

  it('with no lastForegroundAt anywhere, shows the first entry in file order', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    await restorePersistedConnections(
      '/user-data',
      [entryFor(a, null), entryFor(saas, null)],
      (origin) => register(origin) as never
    );
    expect(foreground()?.serviceId).toBe(a.serviceId);
  });

  it('opens nothing for an entry the registry refuses', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    await restorePersistedConnections('/user-data', [entryFor(a, at(3))], () => null);
    expect(liveConnections().map((r) => r.serviceId)).toEqual([saas.serviceId]);
    expect(foreground()?.serviceId).toBe(saas.serviceId);
  });

  it('activateConnection stamps lastForegroundAt on a foreground change only', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    await restorePersistedConnections(
      '/user-data',
      [entryFor(saas, null), entryFor(a, at(3))],
      (origin) => register(origin) as never
    );
    writeConnectionsFile.mockClear();
    expect(activateConnection(saas.serviceId)).toBe(true);
    expect(writeConnectionsFile).toHaveBeenCalledTimes(1);
    const [root, written] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
    expect(root).toBe('/user-data');
    const stamped = written.find((e) => e.serviceId === saas.serviceId)?.lastForegroundAt;
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(written.find((e) => e.serviceId === a.serviceId)?.lastForegroundAt).toBe(at(3));
    activateConnection(saas.serviceId); // already the foreground
    expect(writeConnectionsFile).toHaveBeenCalledTimes(1);
  });

  // Codex C4: migration writes `[X]` alone when the root holds no Remember-Me saas
  // sign-in, so the always-open saas view had no entry and its foreground was never
  // recorded: every relaunch showed X again, even when the user last used saas.
  it('a saas foreground with no saas entry adds one, and the next launch shows saas', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    await restorePersistedConnections(
      '/user-data',
      [entryFor(a, at(3))],
      (origin) => register(origin) as never
    );
    expect(foreground()?.serviceId).toBe(a.serviceId);
    writeConnectionsFile.mockClear();
    expect(activateConnection(saas.serviceId)).toBe(true);
    expect(writeConnectionsFile).toHaveBeenCalledTimes(1);
    const [, written] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
    expect(written.map((e) => e.serviceId)).toEqual([a.serviceId, saas.serviceId]);
    const saasEntry = written.find((e) => e.serviceId === saas.serviceId);
    expect(saasEntry?.origin).toBe(SAAS_ORIGIN);
    expect(saasEntry?.lastForegroundAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(saasEntry?.addedAt).toBe(saasEntry?.lastForegroundAt);

    // The next launch, from what was written.
    (shellWindow() as unknown as Any).emit('closed');
    _resetPersistedConnectionsForTesting();
    createShellWindow(deps as never);
    await mustOpen(saas.serviceId);
    await restorePersistedConnections('/user-data', written as never, (o) => register(o) as never);
    expect(foreground()?.serviceId).toBe(saas.serviceId);
  });

  // The dev menu opens and activates a self-hosted connection that is deliberately never
  // persisted; only saas may be appended when it has no entry.
  it('an unpersisted self-hosted foreground is never added to connections.json', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    await restorePersistedConnections(
      '/user-data',
      [entryFor(a, at(3))],
      (origin) => register(origin) as never
    );
    const b = register(SELF_B);
    await mustOpen(b.serviceId);
    writeConnectionsFile.mockClear();
    expect(activateConnection(b.serviceId)).toBe(true);
    expect(foreground()?.serviceId).toBe(b.serviceId);
    expect(writeConnectionsFile).not.toHaveBeenCalled();

    // A later write keeps the restored list as it was, without b.
    activateConnection(a.serviceId);
    const [, written] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
    expect(written.map((e) => e.serviceId)).toEqual([a.serviceId]);
  });

  // #86 PR 206 review row 5: macOS keeps the app alive with no window, and the dock
  // re-creates it. The restore must not fall back to the startup snapshot.
  it('a re-created window restores a connection added after startup and keeps it in the file', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    const startup = [entryFor(saas, null), entryFor(a, at(3))];
    await restorePersistedConnections('/user-data', startup, (o) => register(o) as never);
    // Added during the session, the way connection:create does it.
    const b = register(SELF_B);
    await mustOpen(b.serviceId);
    await persistAddedConnections([entryFor(b, null)]);

    (shellWindow() as unknown as Any).emit('closed');
    expect(liveConnections()).toEqual([]);
    createShellWindow(deps as never);
    await mustOpen(saas.serviceId);
    await restorePersistedConnections('/user-data', startup, (o) => register(o) as never);

    expect(liveConnections().map((r) => r.serviceId)).toEqual([
      saas.serviceId,
      a.serviceId,
      b.serviceId,
    ]);
    writeConnectionsFile.mockClear();
    expect(activateConnection(saas.serviceId)).toBe(true);
    const [, written] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
    expect(written.map((e) => e.serviceId)).toEqual([saas.serviceId, a.serviceId, b.serviceId]);
  });

  // #86 C9: the saas renderer is shown and interactive while its loader still awaits the
  // SPA hash fetch, before restore runs. A connection:create then had no list to append
  // to: the write was refused, and restore re-seeded from the startup snapshot without it.
  it('a connection added before startup restore is written with the restored list and kept', async () => {
    const saas = register(SAAS_ORIGIN);
    const a = register(SELF_A);
    const startup = [entryFor(a, at(3))];
    initPersistedConnections('/user-data', startup);
    await mustOpen(saas.serviceId);
    const b = register(SELF_B);
    await mustOpen(b.serviceId);
    writeConnectionsFile.mockClear();
    await persistAddedConnections([entryFor(b, null)]);
    expect(writeConnectionsFile).toHaveBeenCalledTimes(1);
    const [root, added] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
    expect(root).toBe('/user-data');
    expect(added.map((e) => e.serviceId)).toEqual([a.serviceId, b.serviceId]);

    await restorePersistedConnections('/user-data', startup, (o) => register(o) as never);
    expect(liveConnections().map((r) => r.serviceId)).toEqual([
      saas.serviceId,
      b.serviceId,
      a.serviceId,
    ]);
    writeConnectionsFile.mockClear();
    expect(activateConnection(saas.serviceId)).toBe(true);
    const [, written] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
    expect(written.map((e) => e.serviceId)).toEqual([a.serviceId, b.serviceId, saas.serviceId]);
  });

  it('initPersistedConnections keeps the live list for the same root', async () => {
    const saas = register(SAAS_ORIGIN);
    const a = register(SELF_A);
    const b = register(SELF_B);
    initPersistedConnections('/user-data', [entryFor(a, at(3))]);
    await mustOpen(saas.serviceId);
    await persistAddedConnections([entryFor(b, null)]);
    // A re-created window seeds again from the same startup snapshot.
    initPersistedConnections('/user-data', [entryFor(a, at(3))]);
    writeConnectionsFile.mockClear();
    await persistAddedConnections([entryFor(b, null)]); // still listed: nothing to write
    expect(writeConnectionsFile).not.toHaveBeenCalled();
    await persistAddedConnections([entryFor(saas, null)]);
    const [, written] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
    expect(written.map((e) => e.serviceId)).toEqual([a.serviceId, b.serviceId, saas.serviceId]);
  });

  // #86 C8: deep links are delivered to the saas view only, so a valid OS link must
  // bring that view to the front, or its modal opens in a hidden view.
  describe('showSaasForDeepLink (#86 C8)', () => {
    it('brings the saas view in front of a self-hosted foreground and records it', async () => {
      const saas = register(SAAS_ORIGIN);
      const saasRecord = await mustOpen(saas.serviceId);
      const a = register(SELF_A);
      await restorePersistedConnections(
        '/user-data',
        [entryFor(a, at(3))],
        (o) => register(o) as never
      );
      const aRecord = liveConnections().find((r) => r.serviceId === a.serviceId);
      expect(foreground()?.serviceId).toBe(a.serviceId);
      writeConnectionsFile.mockClear();

      showSaasForDeepLink();

      expect(foreground()?.serviceId).toBe(saas.serviceId);
      expect(viewOf(saasRecord).setVisible).toHaveBeenLastCalledWith(true);
      expect(viewOf(aRecord).setVisible).toHaveBeenLastCalledWith(false);
      const [, written] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
      expect(written.find((e) => e.serviceId === saas.serviceId)?.lastForegroundAt).toBeTruthy();
    });

    it('a link queued before the saas view exists overrides the restored foreground', async () => {
      const saas = register(SAAS_ORIGIN);
      const a = register(SELF_A);
      showSaasForDeepLink(); // cold-start argv: no view yet
      await mustOpen(saas.serviceId);
      writeConnectionsFile.mockClear();
      await restorePersistedConnections(
        '/user-data',
        [entryFor(a, at(3))],
        (o) => register(o) as never
      );
      expect(liveConnections().map((r) => r.serviceId)).toEqual([saas.serviceId, a.serviceId]);
      expect(foreground()?.serviceId).toBe(saas.serviceId);
      // Recorded, so the next launch shows the view the user was taken to.
      const [, written] = writeConnectionsFile.mock.calls[0] as [string, Any[]];
      expect(written.find((e) => e.serviceId === saas.serviceId)?.lastForegroundAt).toBeTruthy();
    });

    it('a link arriving with no window carries to the next window, and only to it', async () => {
      const saas = register(SAAS_ORIGIN);
      const a = register(SELF_A);
      const startup = [entryFor(a, at(3))];
      await mustOpen(saas.serviceId);
      await restorePersistedConnections('/user-data', startup, (o) => register(o) as never);
      expect(foreground()?.serviceId).toBe(a.serviceId);

      (shellWindow() as unknown as Any).emit('closed');
      showSaasForDeepLink(); // macOS: the app is alive with no window
      createShellWindow(deps as never);
      await mustOpen(saas.serviceId);
      await restorePersistedConnections('/user-data', startup, (o) => register(o) as never);
      expect(foreground()?.serviceId).toBe(saas.serviceId);

      // Consumed: the window after that restores the recorded foreground.
      activateConnection(a.serviceId);
      (shellWindow() as unknown as Any).emit('closed');
      createShellWindow(deps as never);
      await mustOpen(saas.serviceId);
      await restorePersistedConnections('/user-data', startup, (o) => register(o) as never);
      expect(foreground()?.serviceId).toBe(a.serviceId);
    });

    it('a switch to another connection before restore supersedes the waiting link', async () => {
      const saas = register(SAAS_ORIGIN);
      const a = register(SELF_A);
      showSaasForDeepLink(); // cold-start argv: no view yet
      await mustOpen(saas.serviceId);
      // connection:create during the saas load opens and activates a self-hosted view.
      await mustOpen(a.serviceId);
      expect(activateConnection(a.serviceId)).toBe(true);
      await restorePersistedConnections(
        '/user-data',
        [entryFor(a, at(3))],
        (o) => register(o) as never
      );
      expect(foreground()?.serviceId).toBe(a.serviceId);
    });

    it('a link handled after restore does not reach a later restore', async () => {
      const saas = register(SAAS_ORIGIN);
      const a = register(SELF_A);
      const startup = [entryFor(a, at(3))];
      await mustOpen(saas.serviceId);
      await restorePersistedConnections('/user-data', startup, (o) => register(o) as never);
      showSaasForDeepLink();
      expect(foreground()?.serviceId).toBe(saas.serviceId);
      activateConnection(a.serviceId);
      (shellWindow() as unknown as Any).emit('closed');
      createShellWindow(deps as never);
      await mustOpen(saas.serviceId);
      await restorePersistedConnections('/user-data', startup, (o) => register(o) as never);
      expect(foreground()?.serviceId).toBe(a.serviceId);
    });
  });

  // Review row 6: a quit during the saas load closes the window before restore runs.
  it('with no shell window it registers and opens nothing, and settles', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    (shellWindow() as unknown as Any).emit('closed');
    const asked: string[] = [];
    await expect(
      restorePersistedConnections('/user-data', [entryFor(a, at(3))], (origin) => {
        asked.push(origin);
        return register(origin) as never;
      })
    ).resolves.toBeUndefined();
    expect(asked).toEqual([]);
    expect(h.state.views).toHaveLength(1); // the saas view only
  });

  it('a view that cannot be opened is logged, and the restore still settles', async () => {
    const saas = register(SAAS_ORIGIN);
    await mustOpen(saas.serviceId);
    const a = register(SELF_A);
    deps.wireView = vi.fn(() => {
      throw new Error('wire failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        restorePersistedConnections('/user-data', [entryFor(a, at(3))], (o) => register(o) as never)
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[shellWindow] connection not restored (view could not be opened)'
      );
    } finally {
      warn.mockRestore();
    }
  });
});
