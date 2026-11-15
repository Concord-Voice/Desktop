// @vitest-environment node
// registerIpc admission registry (spec 2026-11-09-86-connection-context-isolation §3.7, §3.9;
// plan Task 7A step 1). One admitted / refused case per admission class.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const { handlers, mockIpcMain } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const reg = (_method: string) =>
    vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    });
  return {
    handlers,
    mockIpcMain: {
      handle: reg('handle'),
      on: reg('on'),
      once: reg('once'),
      handleOnce: reg('handleOnce'),
    },
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: mockIpcMain,
}));

// The real table lists the 77 production channels; this suite pins the registry's own
// behaviour against a small table so it does not depend on which handlers are migrated.
vi.mock('../../../../src/main/ipc/channelClassification', () => ({
  CHANNEL_CLASSES: {
    'test:bound': 'connection-bound',
    'test:read': 'app-global-read',
    'test:mutate': 'app-global-mutate',
    'test:saas': 'saas-only',
    'test:pip': 'pip-scoped',
    'test:low': 'exempt-low-stakes',
    'test:event': 'connection-bound',
  },
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
  registerIpc,
  registeredChannels,
} from '../../../../src/main/ipc/registry';

const SAAS_ORIGIN = 'https://api.concordvoice.chat';
const A = new URL('https://a.example').origin;

const fakeWc = (id: number) => ({ id, mainFrame: { frameTreeNodeId: id } }) as never;

function conn(origin: string, id: number) {
  const r = registerService(origin, {
    makeSession: () => ({}) as never,
    makeCustody: () => ({ tag: origin }) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  const wc = fakeWc(id);
  const o = openConnection(r.service.serviceId, wc, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc, o.record.connectionId, 'primary');
  return { wc, record: o.record };
}
function pipOf(c: ReturnType<typeof conn>, id: number) {
  const wc = fakeWc(id);
  bindSender(wc, c.record.connectionId, 'pip');
  return wc;
}
const ev = (wc: unknown, url = 'app://concord/index.html') => {
  const mainId = (wc as { mainFrame: { frameTreeNodeId: number } }).mainFrame.frameTreeNodeId;
  return {
    sender: wc,
    senderFrame: { url, parent: null, frameTreeNodeId: mainId, detached: false },
  } as unknown as IpcMainInvokeEvent;
};
const invoke = (channel: string, event: unknown, ...args: unknown[]) =>
  handlers.get(channel)!(event, ...args);

beforeEach(() => {
  _resetConnectionRegistryForTesting();
  _resetIpcRegistryForTesting();
  handlers.clear();
  vi.clearAllMocks();
});

describe('registerIpc admission classes', () => {
  it('connection-bound admits a bound primary (even a background one)', () => {
    const fg = conn(SAAS_ORIGIN, 1);
    const bg = conn(A, 2);
    setForeground(fg.record.connectionId);
    const handler = vi.fn(() => 'ok');
    registerIpc('test:bound', 'connection-bound', handler);
    expect(invoke('test:bound', ev(bg.wc), 7)).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
    const [sender, , arg] = handler.mock.calls[0] as unknown as [
      { record: unknown; role: string },
      unknown,
      number,
    ];
    expect(sender.record).toBe(bg.record);
    expect(sender.role).toBe('primary');
    expect(arg).toBe(7);
  });

  it('connection-bound refuses an unbound sender and a PiP without running the handler', () => {
    const c = conn(SAAS_ORIGIN, 1);
    const handler = vi.fn();
    registerIpc('test:bound', 'connection-bound', handler);
    expect(invoke('test:bound', ev(fakeWc(99)))).toEqual({
      status: 'rejected',
      reason: 'untrusted-sender',
    });
    expect(invoke('test:bound', ev(pipOf(c, 5)))).toEqual({
      status: 'rejected',
      reason: 'untrusted-sender',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('app-global-read admits any registered primary, background included', () => {
    conn(SAAS_ORIGIN, 1);
    const bg = conn(A, 2);
    const handler = vi.fn(() => 'read');
    registerIpc('test:read', 'app-global-read', handler);
    expect(invoke('test:read', ev(bg.wc))).toBe('read');
  });

  it('app-global-read refuses an unbound sender and a PiP', () => {
    const c = conn(SAAS_ORIGIN, 1);
    const handler = vi.fn();
    registerIpc('test:read', 'app-global-read', handler);
    expect(invoke('test:read', ev(fakeWc(99)))).toEqual({
      status: 'rejected',
      reason: 'untrusted-sender',
    });
    expect(invoke('test:read', ev(pipOf(c, 5)))).toMatchObject({ status: 'rejected' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('app-global-mutate admits the foreground primary', () => {
    const fg = conn(SAAS_ORIGIN, 1);
    conn(A, 2);
    setForeground(fg.record.connectionId);
    const handler = vi.fn(() => 'mutated');
    registerIpc('test:mutate', 'app-global-mutate', handler);
    expect(invoke('test:mutate', ev(fg.wc))).toBe('mutated');
  });

  it('app-global-mutate refuses a background primary with not-foreground', () => {
    const fg = conn(SAAS_ORIGIN, 1);
    const bg = conn(A, 2);
    setForeground(fg.record.connectionId);
    const handler = vi.fn();
    registerIpc('test:mutate', 'app-global-mutate', handler);
    expect(invoke('test:mutate', ev(bg.wc))).toEqual({
      status: 'rejected',
      reason: 'not-foreground',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('saas-only admits the saas primary', () => {
    const saas = conn(SAAS_ORIGIN, 1);
    const handler = vi.fn(() => 'saas');
    registerIpc('test:saas', 'saas-only', handler);
    expect(invoke('test:saas', ev(saas.wc))).toBe('saas');
  });

  it('saas-only refuses a self-hosted primary with not-saas', () => {
    conn(SAAS_ORIGIN, 1);
    const sh = conn(A, 2);
    const handler = vi.fn();
    registerIpc('test:saas', 'saas-only', handler);
    expect(invoke('test:saas', ev(sh.wc))).toEqual({ status: 'rejected', reason: 'not-saas' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('pip-scoped admits a PiP and its primary', () => {
    const c = conn(SAAS_ORIGIN, 1);
    const pip = pipOf(c, 5);
    const handler = vi.fn(() => 'pip');
    registerIpc('test:pip', 'pip-scoped', handler);
    expect(invoke('test:pip', ev(pip))).toBe('pip');
    expect(invoke('test:pip', ev(c.wc))).toBe('pip');
    const roles = handler.mock.calls.map((c0) => (c0 as unknown as [{ role: string }])[0].role);
    expect(roles).toEqual(['pip', 'primary']);
  });

  it('pip-scoped refuses an unbound sender', () => {
    conn(SAAS_ORIGIN, 1);
    const handler = vi.fn();
    registerIpc('test:pip', 'pip-scoped', handler);
    expect(invoke('test:pip', ev(fakeWc(99)))).toMatchObject({ status: 'rejected' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('exempt-low-stakes admits the foreground primary', () => {
    const fg = conn(SAAS_ORIGIN, 1);
    setForeground(fg.record.connectionId);
    const handler = vi.fn(() => 'low');
    registerIpc('test:low', 'exempt-low-stakes', handler);
    expect(invoke('test:low', ev(fg.wc))).toBe('low');
  });

  it('exempt-low-stakes returns undefined silently for a background primary', () => {
    const fg = conn(SAAS_ORIGIN, 1);
    const bg = conn(A, 2);
    setForeground(fg.record.connectionId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = vi.fn();
    registerIpc('test:low', 'exempt-low-stakes', handler);
    expect(invoke('test:low', ev(bg.wc))).toBeUndefined();
    expect(invoke('test:low', ev(fakeWc(99)))).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refused handle returns opts.refusal(reason) when supplied', () => {
    conn(SAAS_ORIGIN, 1);
    const refusal = vi.fn((reason: string) => ({ ok: false, why: reason }));
    registerIpc('test:bound', 'connection-bound', () => ({ ok: true, why: '' }), { refusal });
    expect(invoke('test:bound', ev(fakeWc(99)))).toEqual({ ok: false, why: 'untrusted-sender' });
    expect(refusal).toHaveBeenCalledWith('untrusted-sender');
  });
});

describe('registerIpc registration rules', () => {
  it('registeredChannels lists every registration with its class', () => {
    registerIpc('test:bound', 'connection-bound', () => undefined);
    registerIpc('test:read', 'app-global-read', () => undefined);
    expect([...registeredChannels()]).toEqual([
      ['test:bound', 'connection-bound'],
      ['test:read', 'app-global-read'],
    ]);
  });

  it('registers through the requested ipcMain method', () => {
    registerIpc('test:event', 'connection-bound', () => undefined, { method: 'on' });
    expect(mockIpcMain.on).toHaveBeenCalledWith('test:event', expect.any(Function));
    expect(mockIpcMain.handle).not.toHaveBeenCalled();
  });

  it('throws for a channel absent from CHANNEL_CLASSES', () => {
    expect(() => registerIpc('test:nope', 'connection-bound', () => undefined)).toThrow(
      'Unclassified IPC channel: test:nope'
    );
    expect(mockIpcMain.handle).not.toHaveBeenCalled();
  });

  it('throws when the class differs from the table', () => {
    expect(() => registerIpc('test:bound', 'saas-only', () => undefined)).toThrow();
    expect(mockIpcMain.handle).not.toHaveBeenCalled();
  });
});

describe('registerIpc synchronous admission (§3.9)', () => {
  it('hands the handler a sender that does not change when senderFrame is nulled later', async () => {
    const c = conn(SAAS_ORIGIN, 1);
    let seen: { frame: unknown } | undefined;
    registerIpc('test:bound', 'connection-bound', (sender) => {
      seen = sender as never;
    });
    const event = ev(c.wc) as unknown as { senderFrame: unknown };
    const frameAtCall = event.senderFrame;
    invoke('test:bound', event);
    await Promise.resolve();
    event.senderFrame = null;
    await Promise.resolve();
    expect(seen).toBeDefined();
    expect(seen!.frame).toBe(frameAtCall);
  });

  it('calls the handler before invoke returns (no await ahead of it)', () => {
    const c = conn(SAAS_ORIGIN, 1);
    const handler = vi.fn(async () => 'later');
    registerIpc('test:bound', 'connection-bound', handler);
    const out = invoke('test:bound', ev(c.wc));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(out).toBeInstanceOf(Promise);
  });

  it('registry.ts contains no await', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../../../src/main/ipc/registry.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/\bawait\b/);
  });
});
