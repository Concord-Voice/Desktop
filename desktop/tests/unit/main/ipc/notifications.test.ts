// @vitest-environment node
// #86 C11: a click on a background connection's notification reveals THAT connection.
// The click is the OS's, observed by main on a notification main owns; the renderer can
// ask main to show one but has no path to activate a connection or focus the window.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: {
    handle: vi.fn((channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    }),
    on: vi.fn(),
  },
}));

import { bindTestSender, SAAS_ORIGIN, type BoundSenderFixture } from './boundSenderFixture';
import { advanceGeneration, disposeConnection, recordFor, refOf } from '@/main/connectionRegistry';
import {
  MAX_NOTIFICATIONS_PER_CONNECTION,
  registerNotificationIpc,
  type MainNotification,
  type NotificationIpcDeps,
} from '@/main/ipc/notifications';
import { NOTIFICATION_CLICKED, NOTIFICATION_SHOW } from '@/shared/desktopNotification';
import type { ConnectionId } from '@/shared/connectionIdentity';

class FakeNotification implements MainNotification {
  readonly listeners = new Map<string, () => void>();
  shown = 0;
  closed = 0;
  on(event: 'click', listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  show(): void {
    this.shown += 1;
  }
  close(): void {
    this.closed += 1;
  }
  /** The OS click, which only main observes. */
  click(): void {
    this.listeners.get('click')?.();
  }
}

function handler(channel: string): Handler {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} not registered`);
  return h;
}

function setup() {
  const created: FakeNotification[] = [];
  const deps = {
    create: vi.fn((_options: { title: string; body: string; silent: boolean }) => {
      const n = new FakeNotification();
      created.push(n);
      return n;
    }),
    activate: vi.fn(() => true),
    reveal: vi.fn(),
    send: vi.fn(() => true),
  } satisfies NotificationIpcDeps;
  // A: a background self-hosted connection. B: the foreground saas connection.
  const a = bindTestSender({ origin: 'https://a.example', foreground: false, id: 7 });
  const b = bindTestSender({ origin: SAAS_ORIGIN, foreground: true, id: 8, reset: false });
  registerNotificationIpc(deps);
  const show = (fx: BoundSenderFixture, payload: unknown, url?: string | null): unknown =>
    handler(NOTIFICATION_SHOW)(fx.event(url), payload);
  const serviceOf = (fx: BoundSenderFixture) =>
    recordFor(fx.connectionId as ConnectionId)?.serviceId;
  const refFor = (fx: BoundSenderFixture) => {
    const record = recordFor(fx.connectionId as ConnectionId);
    if (!record) throw new Error('no record');
    return refOf(record);
  };
  return { deps, created, a, b, show, serviceOf, refFor };
}

const PAYLOAD = { id: 'n-1', title: 'Ada', body: 'hello' };

describe('notification:show (#86 C11)', () => {
  beforeEach(() => handlers.clear());

  it("a click on a background connection's notification activates that connection only, then reveals and routes it", () => {
    const { deps, created, a, show, serviceOf, refFor } = setup();
    expect(show(a, PAYLOAD)).toBe(true);
    expect(deps.create).toHaveBeenCalledWith({ title: 'Ada', body: 'hello', silent: true });
    expect(created[0].shown).toBe(1);

    created[0].click();

    expect(deps.activate).toHaveBeenCalledTimes(1);
    expect(deps.activate).toHaveBeenCalledWith(serviceOf(a));
    expect(deps.reveal).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(refFor(a), NOTIFICATION_CLICKED, { id: 'n-1' });
    const order = [deps.activate, deps.reveal, deps.send].map(
      (fn) => fn.mock.invocationCallOrder[0]
    );
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  // Adversarial: the renderer-callable half must not be an activation primitive.
  it('showing a notification activates nothing and focuses nothing', () => {
    const { deps, a, b, show } = setup();
    show(a, PAYLOAD);
    show(b, { ...PAYLOAD, id: 'n-2' });
    expect(deps.activate).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('a second click on the same notification does nothing more', () => {
    const { deps, created, a, show } = setup();
    show(a, PAYLOAD);
    created[0].click();
    created[0].click();
    expect(deps.activate).toHaveBeenCalledTimes(1);
  });

  it('a click after the owner document changed is dropped', () => {
    const { deps, created, a, show } = setup();
    show(a, PAYLOAD);
    advanceGeneration(a.connectionId as ConnectionId, 'document');
    created[0].click();
    expect(deps.activate).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("a disposed connection's notifications are closed and their clicks dropped", () => {
    const { deps, created, a, b, show } = setup();
    show(a, PAYLOAD);
    show(b, { ...PAYLOAD, id: 'n-2' });
    disposeConnection(a.connectionId as ConnectionId);
    expect(created[0].closed).toBe(1);
    expect(created[1].closed).toBe(0);
    created[0].click();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-object', 'hello'],
    ['an extra key', { ...PAYLOAD, icon: 'file:///etc/passwd' }],
    ['a missing key', { id: 'n-1', title: 'Ada' }],
    ['a malformed id', { ...PAYLOAD, id: 'has space' }],
    ['an oversized title', { ...PAYLOAD, title: 'x'.repeat(257) }],
    ['an oversized body', { ...PAYLOAD, body: 'x'.repeat(1025) }],
  ])('refuses %s and shows nothing', (_name, payload) => {
    const { deps, a, show } = setup();
    expect(show(a, payload)).toBe(false);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('refuses a sender with no frame and shows nothing', () => {
    const { deps, a, show } = setup();
    expect(show(a, PAYLOAD, null)).toBe(false);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('resolves false when the platform cannot show one', () => {
    const { deps, a, show } = setup();
    deps.create.mockReturnValueOnce(null as never);
    expect(show(a, PAYLOAD)).toBe(false);
  });

  it('keeps a bounded number per connection, closing the oldest', () => {
    const { deps, created, a, show } = setup();
    for (let i = 0; i <= MAX_NOTIFICATIONS_PER_CONNECTION; i += 1) {
      show(a, { ...PAYLOAD, id: `n-${i}` });
    }
    expect(created[0].closed).toBe(1);
    expect(created[1].closed).toBe(0);
    created[0].click();
    expect(deps.activate).not.toHaveBeenCalled();
    created[MAX_NOTIFICATIONS_PER_CONNECTION].click();
    expect(deps.activate).toHaveBeenCalledTimes(1);
  });
});
