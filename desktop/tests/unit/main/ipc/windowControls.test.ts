import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { quit: vi.fn(), getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: { handle: vi.fn() },
}));

import { app, ipcMain } from 'electron';
import { registerWindowControlsIpc, getCachedClientBehavior } from '@/main/ipc/windowControls';
import { DEFAULT_CLIENT_BEHAVIOR } from '@/shared/clientBehavior';
import {
  _resetConnectionRegistryForTesting,
  bindSender,
  openConnection,
  registerService,
  setForeground,
} from '@/main/connectionRegistry';
import { _resetIpcRegistryForTesting } from '@/main/ipc/registry';

const makeMockWindow = () => ({
  setTitleBarOverlay: vi.fn(),
  isDestroyed: vi.fn(() => false),
});

// #86 Task 7B re-point: handlers now run behind registerIpc, so the legacy `{}` event
// is replaced by the FOREGROUND primary's event (the only sender these channels admit).
// The registry is reset per case because registerIpc refuses a duplicate channel.
let fgEvent: unknown = null;
const fgEv = () => fgEvent as never;

describe('registerWindowControlsIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetConnectionRegistryForTesting();
    _resetIpcRegistryForTesting();
    const r = registerService('https://api.concordvoice.chat', {
      makeSession: () => ({}) as never,
      makeCustody: () => ({}) as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!r.ok) throw new Error(r.reason);
    const wc = { id: 7, mainFrame: { frameTreeNodeId: 7 } } as never;
    const o = openConnection(r.service.serviceId, wc, null);
    if (!o.ok) throw new Error(o.reason);
    bindSender(wc, o.record.connectionId, 'primary');
    setForeground(o.record.connectionId);
    fgEvent = {
      sender: wc,
      senderFrame: {
        url: 'app://concord/index.html',
        parent: null,
        frameTreeNodeId: 7,
        detached: false,
      },
    };
  });

  it('starts with the safe default cached client behavior (close→tray, minimize→toolbar)', () => {
    const window = makeMockWindow();
    registerWindowControlsIpc(() => window as never);
    expect(getCachedClientBehavior()).toEqual(DEFAULT_CLIENT_BEHAVIOR);
  });

  it('registers all three IPC handlers', () => {
    registerWindowControlsIpc(() => makeMockWindow() as never);
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(channels).toContain('window:setClientBehavior');
    expect(channels).toContain('window:quit');
    expect(channels).toContain('window:setTitleBarOverlayColor');
  });

  it('updates the cached client behavior on setClientBehavior', () => {
    registerWindowControlsIpc(() => makeMockWindow() as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:setClientBehavior'
    )![1];
    handler(fgEv(), { toTray: 'minimize', toToolbar: 'close' });
    expect(getCachedClientBehavior()).toEqual({ toTray: 'minimize', toToolbar: 'close' });
  });

  it('window:quit handler calls app.quit()', () => {
    const window = { ...makeMockWindow(), webContents: { mainFrame: { frameTreeNodeId: 1 } } };
    registerWindowControlsIpc(() => window as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:quit'
    )![1];
    handler(fgEv());
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('window:quit refuses a same-origin PiP or subframe', () => {
    const window = { ...makeMockWindow(), webContents: { mainFrame: { frameTreeNodeId: 1 } } };
    registerWindowControlsIpc(() => window as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:quit'
    )![1];
    // #86: "the main window" is the foreground connection's bound primary. An unbound
    // webContents (a PiP, or any other window) and a subframe of the primary are refused.
    const fg = fgEvent as { sender: { mainFrame: { frameTreeNodeId: number } } };
    handler({
      sender: { id: 9, mainFrame: { frameTreeNodeId: 9 } },
      senderFrame: { url: 'app://concord/index.html', parent: null, frameTreeNodeId: 9 },
    } as never);
    handler({
      sender: fg.sender,
      senderFrame: { url: 'app://concord/index.html', parent: {}, frameTreeNodeId: 2 },
    } as never);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('setTitleBarOverlayColor calls win.setTitleBarOverlay with passed color', () => {
    const window = makeMockWindow();
    registerWindowControlsIpc(() => window as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:setTitleBarOverlayColor'
    )![1];
    handler(fgEv(), { color: '#000000', symbolColor: '#ffffff' });
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ color: '#000000', symbolColor: '#ffffff' })
    );
  });

  it('setTitleBarOverlayColor is a no-op when window is destroyed', () => {
    const window = makeMockWindow();
    window.isDestroyed.mockReturnValue(true);
    registerWindowControlsIpc(() => window as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:setTitleBarOverlayColor'
    )![1];
    handler(fgEv(), { color: '#000', symbolColor: '#fff' });
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  // Input-validation guards added during /reconcile-copilot on #806
  // (security-reviewer findings L1 + L2). The handlers must drop invalid
  // shapes at the IPC trust boundary rather than blindly trusting the
  // renderer's payload.
  it('setClientBehavior rejects invalid toTray value (keeps cache unchanged)', () => {
    registerWindowControlsIpc(() => makeMockWindow() as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:setClientBehavior'
    )![1];
    const before = getCachedClientBehavior();
    handler(fgEv(), { toTray: 'EVIL', toToolbar: 'minimize' });
    expect(getCachedClientBehavior()).toEqual(before);
  });

  it('setClientBehavior rejects non-object payload', () => {
    registerWindowControlsIpc(() => makeMockWindow() as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:setClientBehavior'
    )![1];
    const before = getCachedClientBehavior();
    handler(fgEv(), 'not-an-object');
    expect(getCachedClientBehavior()).toEqual(before);
  });

  it('setClientBehavior accepts the swap configuration', () => {
    registerWindowControlsIpc(() => makeMockWindow() as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:setClientBehavior'
    )![1];
    handler(fgEv(), { toTray: 'minimize', toToolbar: 'close' });
    expect(getCachedClientBehavior()).toEqual({ toTray: 'minimize', toToolbar: 'close' });
  });

  it('setTitleBarOverlayColor rejects non-CSS-color color value', () => {
    const window = makeMockWindow();
    registerWindowControlsIpc(() => window as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:setTitleBarOverlayColor'
    )![1];
    handler(fgEv(), { color: '<script>alert(1)</script>', symbolColor: '#fff' });
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it('setTitleBarOverlayColor accepts rgba() format', () => {
    const window = makeMockWindow();
    registerWindowControlsIpc(() => window as never);
    const handler = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'window:setTitleBarOverlayColor'
    )![1];
    handler(fgEv(), { color: 'rgba(26, 22, 48, 1)', symbolColor: '#ffffff' });
    expect(window.setTitleBarOverlay).toHaveBeenCalled();
  });
});

// #86 Task 7B: low-stakes channels are admitted for the FOREGROUND primary only; any other
// sender (a background primary) gets a silent no-op (undefined, no warn, no effect).
describe('window controls: binding-derived admission (#86 Task 7B)', () => {
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
    return { wc, record: o.record, id };
  }
  const ev = (c: { wc: unknown; id: number }) =>
    ({
      sender: c.wc,
      senderFrame: {
        url: 'app://concord/index.html',
        parent: null,
        frameTreeNodeId: c.id,
        detached: false,
      },
    }) as never;
  const handlerFor = (channel: string) => {
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === channel
    );
    return calls[calls.length - 1][1] as (...a: unknown[]) => unknown;
  };

  function boot() {
    _resetConnectionRegistryForTesting();
    _resetIpcRegistryForTesting();
    const window = makeMockWindow();
    registerWindowControlsIpc(() => window as never);
    const fg = conn('https://api.concordvoice.chat', 21);
    const bg = conn(new URL('https://a.example').origin, 22);
    setForeground(fg.record.connectionId);
    return { window, fg, bg };
  }

  it('setTitleBarOverlayColor from a background primary is a silent no-op', () => {
    const { window, bg } = boot();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = handlerFor('window:setTitleBarOverlayColor')(ev(bg), {
      color: '#000000',
      symbolColor: '#ffffff',
    });
    expect(r).toBeUndefined();
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('setClientBehavior from a background primary is a silent no-op and keeps the cache', () => {
    const { bg } = boot();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = getCachedClientBehavior();
    const r = handlerFor('window:setClientBehavior')(ev(bg), {
      toTray: 'none',
      toToolbar: 'close',
    });
    expect(r).toBeUndefined();
    expect(getCachedClientBehavior()).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('both channels still work from the foreground primary', () => {
    const { window, fg } = boot();
    handlerFor('window:setTitleBarOverlayColor')(ev(fg), {
      color: '#000000',
      symbolColor: '#ffffff',
    });
    expect(window.setTitleBarOverlay).toHaveBeenCalledTimes(1);
    handlerFor('window:setClientBehavior')(ev(fg), { toTray: 'none', toToolbar: 'close' });
    expect(getCachedClientBehavior()).toEqual({ toTray: 'none', toToolbar: 'close' });
  });
});
