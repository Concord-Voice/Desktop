// @vitest-environment jsdom
//
// Preload bridge for the capture lease (#87 spec §3.9, plan Task 6): `electron.capture`.
//
// Lives beside `preloadTrayBridge.test.ts` for the reason that file gives: the bridge
// closures are inline in the `exposeInMainWorld` literal, so the real `preload.ts` is
// imported with `electron` mocked. `ipcRenderer` is a small ordered emitter here, because
// the replay cache (Review Focus 1) is a module-scope listener registered at preload
// evaluation and the subscribers' listeners must run after it, as in Electron.
import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_ACQUIRE,
  CAPTURE_LEASE_PUSH,
  CAPTURE_LEASE_REVOKED_PUSH,
  CAPTURE_RELEASE,
} from '@/shared/captureLease';

type IpcListener = (event: unknown, data: unknown) => void;

const { listeners, mockExposeInMainWorld, mockIpcRenderer } = vi.hoisted(() => {
  const listeners = new Map<string, IpcListener[]>();
  return {
    listeners,
    mockExposeInMainWorld: vi.fn(),
    mockIpcRenderer: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, fn: IpcListener) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
      }),
      removeListener: vi.fn((channel: string, fn: IpcListener) => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((l) => l !== fn)
        );
      }),
      send: vi.fn(),
      sendSync: vi.fn(() => null),
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: mockIpcRenderer,
  webFrame: { setZoomFactor: vi.fn() },
}));

interface CaptureBridgeShape {
  acquire(input: unknown): Promise<unknown>;
  release(input: unknown): Promise<unknown>;
  onLeaseChanged(cb: (s: unknown) => void): () => void;
  onLeaseRevoked(cb: (r: unknown) => void): () => void;
}

async function loadCapture(): Promise<CaptureBridgeShape> {
  vi.resetModules();
  listeners.clear();
  mockExposeInMainWorld.mockClear();
  mockIpcRenderer.invoke.mockReset();
  mockIpcRenderer.on.mockClear();
  mockIpcRenderer.removeListener.mockClear();

  await import('../../../src/preload/preload');

  const call = mockExposeInMainWorld.mock.calls.find((c) => c[0] === 'electron');
  expect(call, 'contextBridge.exposeInMainWorld("electron", ...) was never called').toBeDefined();
  const api = (call?.[1] ?? {}) as { capture?: CaptureBridgeShape };
  expect(api.capture, 'electron.capture is not exposed').toBeDefined();
  return api.capture as CaptureBridgeShape;
}

/** Deliver one push to every listener currently registered, in registration order. */
function emit(channel: string, data: unknown): void {
  for (const l of [...(listeners.get(channel) ?? [])]) l({}, data);
}

const count = (channel: string) => (listeners.get(channel) ?? []).length;

describe('preload electron.capture invokes', () => {
  it('acquire forwards only { intent } to capture:acquire and returns main’s answer', async () => {
    const capture = await loadCapture();
    mockIpcRenderer.invoke.mockResolvedValue({ status: 'granted' });

    const input = { intent: 'voice-join', extra: 'dropped' };
    await expect(capture.acquire(input)).resolves.toEqual({ status: 'granted' });

    expect(mockIpcRenderer.invoke).toHaveBeenCalledTimes(1);
    const [channel, forwarded] = mockIpcRenderer.invoke.mock.calls[0] ?? [];
    expect(channel).toBe(CAPTURE_ACQUIRE);
    expect(forwarded).toEqual({ intent: 'voice-join' });
    expect(forwarded).not.toBe(input);
  });

  it('release forwards only { intent } to capture:release', async () => {
    const capture = await loadCapture();
    mockIpcRenderer.invoke.mockResolvedValue(true);

    await expect(capture.release({ intent: 'device-test', x: 1 })).resolves.toBe(true);

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(CAPTURE_RELEASE, {
      intent: 'device-test',
    });
  });
});

describe('preload electron.capture.onLeaseChanged', () => {
  it('delivers a valid push as a copy per subscriber', async () => {
    const capture = await loadCapture();
    const first = vi.fn((s: unknown) => {
      (s as { held: boolean }).held = false;
    });
    const second = vi.fn();
    capture.onLeaseChanged(first);
    capture.onLeaseChanged(second);

    const push = { held: true, mine: false };
    emit(CAPTURE_LEASE_PUSH, push);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[0]).toEqual({ held: true, mine: false });
    expect(second.mock.calls[0]?.[0]).not.toBe(push);
    expect(push).toEqual({ held: true, mine: false });
  });

  it('drops a wrong-typed field and a missing key (non-vacuity: a valid push lands)', async () => {
    const capture = await loadCapture();
    const cb = vi.fn();
    capture.onLeaseChanged(cb);

    emit(CAPTURE_LEASE_PUSH, { held: false, mine: false });
    expect(cb).toHaveBeenCalledTimes(1);

    emit(CAPTURE_LEASE_PUSH, { held: 'yes', mine: false });
    emit(CAPTURE_LEASE_PUSH, { held: true });
    emit(CAPTURE_LEASE_PUSH, { held: true, mine: true, extra: 1 });
    emit(CAPTURE_LEASE_PUSH, null);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('replays a push received before subscription to every subscriber until superseded', async () => {
    const capture = await loadCapture();
    emit(CAPTURE_LEASE_PUSH, { held: true, mine: false });

    const first = vi.fn();
    capture.onLeaseChanged(first);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({ held: true, mine: false });

    const later = vi.fn();
    capture.onLeaseChanged(later);
    expect(later).toHaveBeenCalledTimes(1);
    expect(later.mock.calls[0]?.[0]).toEqual({ held: true, mine: false });
    expect(later.mock.calls[0]?.[0]).not.toBe(first.mock.calls[0]?.[0]);

    // A malformed push does not supersede the cached one.
    emit(CAPTURE_LEASE_PUSH, { held: 'no', mine: false });
    // A valid push does.
    emit(CAPTURE_LEASE_PUSH, { held: false, mine: false });
    const newest = vi.fn();
    capture.onLeaseChanged(newest);
    expect(newest).toHaveBeenCalledTimes(1);
    expect(newest).toHaveBeenCalledWith({ held: false, mine: false });
  });

  it('replays nothing when no valid push has arrived', async () => {
    const capture = await loadCapture();
    emit(CAPTURE_LEASE_PUSH, { held: 'yes', mine: false });
    const cb = vi.fn();
    capture.onLeaseChanged(cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes the ipcRenderer listener and disarms the handler', async () => {
    const capture = await loadCapture();
    const before = count(CAPTURE_LEASE_PUSH);
    const cb = vi.fn();
    const unsubscribe = capture.onLeaseChanged(cb);
    expect(count(CAPTURE_LEASE_PUSH)).toBe(before + 1);
    const registered = mockIpcRenderer.on.mock.calls.filter((c) => c[0] === CAPTURE_LEASE_PUSH);
    const handler = registered[registered.length - 1]?.[1] as IpcListener;

    unsubscribe();

    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(CAPTURE_LEASE_PUSH, handler);
    expect(count(CAPTURE_LEASE_PUSH)).toBe(before);
    // An emit already holding the handler (EventEmitter snapshot) must not deliver.
    handler({}, { held: true, mine: true });
    emit(CAPTURE_LEASE_PUSH, { held: true, mine: true });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('preload electron.capture.onLeaseRevoked', () => {
  it('delivers a valid revocation as a copy and drops an extra key', async () => {
    const capture = await loadCapture();
    const cb = vi.fn();
    capture.onLeaseRevoked(cb);

    const push = { reason: 'moved' };
    emit(CAPTURE_LEASE_REVOKED_PUSH, push);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toEqual({ reason: 'moved' });
    expect(cb.mock.calls[0]?.[0]).not.toBe(push);

    emit(CAPTURE_LEASE_REVOKED_PUSH, { reason: 'moved', extra: 1 });
    emit(CAPTURE_LEASE_REVOKED_PUSH, { reason: 'evicted' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not replay a revocation received before subscription', async () => {
    const capture = await loadCapture();
    emit(CAPTURE_LEASE_REVOKED_PUSH, { reason: 'backgrounded' });
    const cb = vi.fn();
    capture.onLeaseRevoked(cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes the ipcRenderer listener and disarms the handler', async () => {
    const capture = await loadCapture();
    const cb = vi.fn();
    const unsubscribe = capture.onLeaseRevoked(cb);
    const handler = mockIpcRenderer.on.mock.calls.find(
      (c) => c[0] === CAPTURE_LEASE_REVOKED_PUSH
    )?.[1] as IpcListener;

    unsubscribe();

    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      CAPTURE_LEASE_REVOKED_PUSH,
      handler
    );
    expect(count(CAPTURE_LEASE_REVOKED_PUSH)).toBe(0);
    handler({}, { reason: 'moved' });
    expect(cb).not.toHaveBeenCalled();
  });
});
