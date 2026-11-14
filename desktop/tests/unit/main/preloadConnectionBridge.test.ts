// @vitest-environment jsdom
//
// Preload `connection` bridge (spec 2026-11-09-86-connection-context-isolation §3.7;
// plan Task 7A step 5): whoAmI is read ONCE with sendSync at preload evaluation and
// cached; generation pushes older than the cache are dropped.
import { describe, expect, it, vi } from 'vitest';

type IpcListener = (event: unknown, data: unknown) => void;

const { mockExposeInMainWorld, mockIpcRenderer } = vi.hoisted(() => ({
  mockExposeInMainWorld: vi.fn(),
  mockIpcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: mockIpcRenderer,
  webFrame: { setZoomFactor: vi.fn() },
}));

const CONNECTION_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const identity = {
  connectionId: CONNECTION_ID,
  generation: 3,
  serviceId: 'saas',
  kind: 'saas',
  apiOrigin: 'https://api.concordvoice.chat',
};

interface ConnectionBridge {
  whoAmI(): { generation: number } | null;
  create(origin: string): Promise<unknown>;
  activate(serviceId: string): Promise<boolean>;
  onGenerationChanged(cb: (p: unknown) => void): () => void;
}

async function loadBridge(whoAmIValue: unknown = identity): Promise<ConnectionBridge> {
  vi.resetModules();
  mockExposeInMainWorld.mockClear();
  mockIpcRenderer.invoke.mockReset();
  mockIpcRenderer.on.mockClear();
  mockIpcRenderer.removeListener.mockClear();
  mockIpcRenderer.sendSync.mockReset();
  mockIpcRenderer.sendSync.mockImplementation((channel: string) =>
    channel === 'connection:whoAmI' ? whoAmIValue : undefined
  );
  await import('../../../src/preload/preload');
  const call = mockExposeInMainWorld.mock.calls.find((c) => c[0] === 'electron');
  expect(call, 'contextBridge.exposeInMainWorld("electron", ...) was never called').toBeDefined();
  const api = call![1] as { connection?: ConnectionBridge };
  expect(api.connection, 'electron.connection namespace missing').toBeDefined();
  return api.connection!;
}

function generationHandler(): IpcListener {
  const calls = mockIpcRenderer.on.mock.calls.filter((c) => c[0] === 'connection:generation');
  expect(calls.length, 'no ipcRenderer.on("connection:generation")').toBeGreaterThan(0);
  return calls[calls.length - 1]![1] as IpcListener;
}
const push = (generation: number) => ({
  connectionId: CONNECTION_ID,
  generation,
  reason: 'credential-start',
});

describe('preload connection bridge', () => {
  it('calls sendSync("connection:whoAmI") exactly once at load, however often whoAmI() is read', async () => {
    const api = await loadBridge();
    api.whoAmI();
    api.whoAmI();
    const calls = mockIpcRenderer.sendSync.mock.calls.filter((c) => c[0] === 'connection:whoAmI');
    expect(calls).toHaveLength(1);
  });

  it('whoAmI() returns the cached value', async () => {
    const api = await loadBridge();
    expect(api.whoAmI()).toEqual(identity);
  });

  it('whoAmI() is null when main answered null', async () => {
    const api = await loadBridge(null);
    expect(api.whoAmI()).toBeNull();
  });

  it('onGenerationChanged drops generation <= cached and delivers generation > cached', async () => {
    const api = await loadBridge();
    const cb = vi.fn();
    api.onGenerationChanged(cb);
    const handler = generationHandler();
    handler({}, push(2));
    handler({}, push(3));
    expect(cb).not.toHaveBeenCalled();
    handler({}, push(4));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(push(4));
  });

  it('updates the cache on delivery so a replayed push is dropped', async () => {
    const api = await loadBridge();
    const cb = vi.fn();
    api.onGenerationChanged(cb);
    const handler = generationHandler();
    handler({}, push(5));
    expect(api.whoAmI()?.generation).toBe(5);
    handler({}, push(5));
    handler({}, push(4));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('drops a push for another connection, and a malformed push, without moving the cache', async () => {
    const api = await loadBridge();
    const cb = vi.fn();
    api.onGenerationChanged(cb);
    const handler = generationHandler();
    handler(
      {},
      { connectionId: 'BBBBBBBBBBBBBBBBBBBBBB', generation: 9, reason: 'credential-start' }
    );
    handler({}, { connectionId: CONNECTION_ID, generation: 9, reason: 'not-a-reason' });
    handler({}, null);
    expect(cb).not.toHaveBeenCalled();
    expect(api.whoAmI()?.generation).toBe(3);
  });

  it('the returned function removes the ipcRenderer listener', async () => {
    const api = await loadBridge();
    const off = api.onGenerationChanged(vi.fn());
    const handler = generationHandler();
    off();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('connection:generation', handler);
  });

  it('create and activate invoke their channels', async () => {
    const api = await loadBridge();
    mockIpcRenderer.invoke.mockResolvedValue(true);
    await api.create('https://a.example');
    await api.activate('selfhost-0123456789abcdef');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('connection:create', 'https://a.example');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'connection:activate',
      'selfhost-0123456789abcdef'
    );
  });
});
