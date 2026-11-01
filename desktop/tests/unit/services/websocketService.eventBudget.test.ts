/** Real ticket/constructor boundary for Hosted#2270, using Desktop's MSW seam. */
import { setImmediate } from 'node:timers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { WebSocketService, ConnectionState } from '@/renderer/services/messaging/websocketService';
import {
  resetRuntimeServerBase,
  setRuntimeServerBase,
} from '@/renderer/services/system/runtimeServerBase';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import { useConnectionStore } from '@/renderer/stores/ui/connectionStore';
import { _resetClientVersionCache } from '@/renderer/utils/runtime/clientVersion';
import { resetAllStores } from '../../helpers/store-helpers';
import { deferred } from '../../helpers/deferred';
import { server } from '../../mocks/server';

class BudgetSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: BudgetSocket[] = [];
  readyState = BudgetSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: Array<{ type: string; data: Record<string, unknown> }> = [];
  constructor(readonly url: string) {
    BudgetSocket.instances.push(this);
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
  close(code = 1000, reason = ''): void {
    this.readyState = BudgetSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
  message(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
  open(): void {
    this.readyState = BudgetSocket.OPEN;
    this.onopen?.(new Event('open'));
    this.message({
      type: 'connected',
      data: {
        client_id: '11111111-1111-4111-8111-111111111111',
        user_id: '22222222-2222-4222-8222-222222222222',
      },
    });
  }
}

interface Internals {
  reconnectAttempts: number;
  computeReconnectDelay(): number;
  createConnection(signal?: AbortSignal, forceDespiteOffline?: boolean): Promise<void>;
  armOnlineRetry(): void;
}

// Let real HTTP/MSW I/O settle without advancing the application's fake clock.
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

describe('WebSocketService overload cooldown', () => {
  let service: WebSocketService;
  let requests: string[];
  const inside = () => service as unknown as Internals;
  beforeEach(() => {
    resetAllStores();
    resetRuntimeServerBase();
    _resetClientVersionCache();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    BudgetSocket.instances = [];
    requests = [];
    server.use(
      http.post('http://localhost:8080/api/v1/auth/ws-ticket', ({ request }) => {
        requests.push(request.headers.get('Authorization') ?? '');
        return HttpResponse.json({ ticket: 'ticket-SENTINEL-2270' });
      })
    );
    vi.stubGlobal('WebSocket', BudgetSocket);
    service = new WebSocketService('ws://localhost:8080');
  });
  afterEach(() => {
    service.disconnect();
    server.resetHandlers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetRuntimeServerBase();
  });
  async function connected(): Promise<BudgetSocket> {
    service.connect('initial-token');
    await drain();
    expect(BudgetSocket.instances).toHaveLength(1);
    const socket = BudgetSocket.instances[0];
    socket.open();
    return socket;
  }
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await drain();
  }
  async function expectBoundary(delay: number): Promise<void> {
    await advance(delay - 1);
    expect(requests).toHaveLength(1);
    expect(BudgetSocket.instances).toHaveLength(1);
    await advance(1);
    expect(requests).toHaveLength(2);
    expect(BudgetSocket.instances).toHaveLength(2);
  }

  it.each([100, 1000, 5000, 30000])(
    'holds ticket and constructor until valid retry %ims',
    async (delay) => {
      const socket = await connected();
      socket.close(1013, `retry_after_ms=${delay}`);
      await expectBoundary(delay);
    }
  );

  it.each([
    '',
    'overloaded',
    'retry_after_ms=99',
    'retry_after_ms=30001',
    'retry_after_ms=01000',
    'retry_after_ms=+1000',
    'retry_after_ms=-1000',
    ' retry_after_ms=1000',
    'retry_after_ms=1000 ',
    'retry_after_ms=1e3',
    'retry_after_ms=1000.0',
    'retry_after_ms=1000\n',
    'retry_after_ms=1000\r',
    'retry_after_ms=1000\r\n',
    'retry_after_ms=1000;foo=bar',
    'retry_after_ms=１０００',
  ])('uses the 1000ms fallback for the entire malformed reason %j', async (reason) => {
    const socket = await connected();
    socket.close(1013, reason);
    await expectBoundary(1000);
  });

  it.each([
    { aggressive: false, attempt: 0, random: 0.9, retry: 100, expected: 900 },
    { aggressive: true, attempt: 0, random: 0.8, retry: 100, expected: 400 },
    { aggressive: true, attempt: 0, random: 0.8, retry: 5000, expected: 5000 },
    { aggressive: false, attempt: 9, random: 0.9999, retry: 30000, expected: 30000 },
  ])(
    'chooses one max(jitter, floor) for $aggressive/$retry',
    async ({ aggressive, attempt, random, retry, expected }) => {
      const socket = await connected();
      service.setAggressiveReconnect(aggressive);
      inside().reconnectAttempts = attempt;
      const randomSpy = vi.mocked(Math.random).mockReturnValue(random);
      randomSpy.mockClear();
      // Observe the real delay computation without replacing it. MSW's request ID
      // and ephemeral port also consume Math.random once a permitted POST starts.
      const computedDelay = vi.spyOn(inside(), 'computeReconnectDelay');
      socket.close(1013, `retry_after_ms=${retry}`);
      expect(randomSpy).toHaveBeenCalledTimes(1);
      expect(computedDelay).toHaveBeenCalledTimes(1);
      await advance(expected - 1);
      expect(requests).toHaveLength(1);
      expect(BudgetSocket.instances).toHaveLength(1);
      expect(randomSpy).toHaveBeenCalledTimes(1);
      expect(computedDelay).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(requests).toHaveLength(2);
      expect(BudgetSocket.instances).toHaveLength(2);
      expect(computedDelay).toHaveBeenCalledTimes(1);
    }
  );

  it('does not impose an overload floor on an ordinary close', async () => {
    const socket = await connected();
    socket.close(1006, 'retry_after_ms=30000');
    await advance(0);
    expect(BudgetSocket.instances).toHaveLength(2);
  });

  it('reset, aggressive changes, online and repeated token effects preserve the chosen timer and latest token', async () => {
    const socket = await connected();
    socket.close(1013, 'retry_after_ms=5000');
    await advance(2000);
    for (const token of ['rotated-1', 'rotated-latest']) {
      service.resetReconnectState();
      service.setAggressiveReconnect(true);
      service.connect(token);
      globalThis.dispatchEvent(new Event('online'));
    }
    await drain();
    expect(requests).toEqual(['Bearer initial-token']);
    await advance(2999);
    expect(BudgetSocket.instances).toHaveLength(1);
    await advance(1);
    expect(BudgetSocket.instances).toHaveLength(2);
    expect(requests).toEqual(['Bearer initial-token', 'Bearer rotated-latest']);
  });

  it.each(['online', 'fallback'])(
    'the armed offline %s retry cannot cross a 30s floor',
    async (trigger) => {
      const socket = await connected();
      inside().armOnlineRetry();
      socket.close(1013, 'retry_after_ms=30000');
      if (trigger === 'online') globalThis.dispatchEvent(new Event('online'));
      await expectBoundary(30000);
    }
  );

  it.each(['disconnect', 'account', 'server'])(
    'obsolete timer cannot dial after %s change',
    async (change) => {
      const socket = await connected();
      socket.close(1013, 'retry_after_ms=5000');
      if (change === 'disconnect') service.disconnect();
      if (change === 'account')
        useAuthStore.setState({ authGeneration: useAuthStore.getState().authGeneration + 1 });
      if (change === 'server') setRuntimeServerBase('https://successor.example');
      await advance(30000);
      expect(requests).toHaveLength(1);
      expect(BudgetSocket.instances).toHaveLength(1);
    }
  );

  it('a queued cooldown callback is inert even if invoked after explicit disconnect', async () => {
    const socket = await connected();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    socket.close(1013, 'retry_after_ms=5000');
    const call = timeout.mock.calls.find((args) => args[1] === 5000);
    expect(call).toBeDefined();
    const staleCallback = call![0] as () => void;
    service.disconnect();
    service.connect('successor-token');
    await drain();
    const current = BudgetSocket.instances[1];
    current.open();
    staleCallback();
    await drain();
    expect(service.getState()).toBe(ConnectionState.CONNECTED);
    expect(BudgetSocket.instances).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it.each(['account', 'server'])(
    'ignores a captured close after its %s ownership changes',
    async (change) => {
      const socket = await connected();
      const staleClose = socket.onclose;
      if (change === 'account')
        useAuthStore.setState({ authGeneration: useAuthStore.getState().authGeneration + 1 });
      else setRuntimeServerBase('https://successor.example');
      staleClose?.(new CloseEvent('close', { code: 1013, reason: 'retry_after_ms=5000' }));
      await advance(30000);
      expect(BudgetSocket.instances).toHaveLength(1);
      expect(requests).toHaveLength(1);
    }
  );

  it('a captured stale close cannot tear down a replacement socket or cancel renewal', async () => {
    const first = await connected();
    const staleClose = first.onclose;
    service.disconnect();
    service.connect('successor-token');
    await drain();
    const current = BudgetSocket.instances[1];
    current.open();
    service.renewToken('renewed-token');
    staleClose?.(new CloseEvent('close', { code: 1013, reason: 'retry_after_ms=30000' }));
    expect(service.getState()).toBe(ConnectionState.CONNECTED);
    await advance(16000);
    expect(current.sent.filter((frame) => frame.type === 'auth_renew')).toHaveLength(2);
    expect(BudgetSocket.instances).toHaveLength(2);
  });

  it('publishes RECONNECTING only after the gate blocks synchronous connection listeners', async () => {
    const socket = await connected();
    service.onConnectionChange((state) => {
      if (state === ConnectionState.RECONNECTING) {
        service.resetReconnectState();
        service.setAggressiveReconnect(true);
        service.connect('listener-token');
      }
    });
    socket.close(1013, 'retry_after_ms=5000');
    await expectBoundary(5000);
    expect(requests[1]).toBe('Bearer listener-token');
  });

  it('rechecks a pending ticket completion after the current socket establishes a gate', async () => {
    const socket = await connected();
    let release!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('http://localhost:8080/api/v1/auth/ws-ticket', async ({ request }) => {
        requests.push(request.headers.get('Authorization') ?? '');
        await responseGate;
        return HttpResponse.json({ ticket: 'deferred-ticket' });
      })
    );
    const pending = inside().createConnection();
    await drain();
    expect(requests).toHaveLength(2);
    socket.close(1013, 'retry_after_ms=5000');
    release();
    await pending;
    await drain();
    expect(BudgetSocket.instances).toHaveLength(1);
    await advance(4999);
    expect(BudgetSocket.instances).toHaveLength(1);
    await advance(1);
    expect(BudgetSocket.instances).toHaveLength(2);
  });

  it.each(['live', 'overload', 'disconnect', 'account', 'server'] as const)(
    'rechecks the final asynchronous version lookup before construction: %s',
    async (change) => {
      const socket = await connected();
      const finalVersionEntered = deferred();
      const finalVersion = deferred<string>();
      // The real helper normally caches the bridge result. Reset that cache
      // once the ticket response is produced so its later constructor-side
      // lookup must await a fresh bridge result. Both service awaits stay real.
      _resetClientVersionCache();
      const getVersion = vi
        .spyOn(window.electron!, 'getVersion')
        .mockReset()
        .mockResolvedValueOnce('0.3.0')
        .mockImplementationOnce(() => {
          finalVersionEntered.resolve();
          return finalVersion.promise;
        })
        .mockResolvedValue('0.3.0');
      server.use(
        http.post('http://localhost:8080/api/v1/auth/ws-ticket', ({ request }) => {
          requests.push(request.headers.get('Authorization') ?? '');
          _resetClientVersionCache();
          return HttpResponse.json({ ticket: 'version-boundary-ticket' });
        })
      );
      const pending = inside().createConnection();
      await finalVersionEntered.promise;
      // A POST has completed, the first guard has admitted its ticket, and
      // only the final version result still separates this attempt from dial.
      expect(requests).toHaveLength(2);
      expect(getVersion).toHaveBeenCalledTimes(2);
      expect(BudgetSocket.instances).toHaveLength(1);
      if (change === 'overload') socket.close(1013, 'retry_after_ms=5000');
      if (change === 'disconnect') service.disconnect();
      if (change === 'account')
        useAuthStore.setState({ authGeneration: useAuthStore.getState().authGeneration + 1 });
      if (change === 'server') setRuntimeServerBase('https://successor.example');
      finalVersion.resolve('0.3.0');
      await pending;
      if (change === 'live') {
        // Positive control: the exact same suspended attempt constructs once
        // when ownership survives; blocking all completions cannot pass.
        expect(BudgetSocket.instances).toHaveLength(2);
        expect(new URL(BudgetSocket.instances[1].url).searchParams.get('client_version')).toBe(
          '0.3.0'
        );
      } else {
        expect(BudgetSocket.instances).toHaveLength(1);
        await advance(4999);
        expect(BudgetSocket.instances).toHaveLength(1);
        expect(requests).toHaveLength(2);
        await advance(1);
        expect(BudgetSocket.instances).toHaveLength(change === 'overload' ? 2 : 1);
        expect(requests).toHaveLength(change === 'overload' ? 3 : 2);
      }
    }
  );

  it('explicit disconnect cancels the obsolete gate and permits a fresh connection immediately', async () => {
    const socket = await connected();
    socket.close(1013, 'retry_after_ms=30000');
    service.disconnect();
    service.resetReconnectState();
    service.connect('manual-token');
    await drain();
    expect(BudgetSocket.instances).toHaveLength(2);
    const next = BudgetSocket.instances[1];
    next.open();
    await advance(30000);
    expect(BudgetSocket.instances).toHaveLength(2);
  });

  it('keeps the current session-revoked event terminal', async () => {
    const socket = await connected();
    // The service dispatches this terminal envelope to the existing owning hook;
    // model that subscriber's explicit disconnect instead of adding a code map.
    service.on('session_revoked', () => service.disconnect());
    socket.message({ type: 'session_revoked', data: {} });
    expect(service.getState()).toBe(ConnectionState.DISCONNECTED);
    await advance(30000);
    expect(BudgetSocket.instances).toHaveLength(1);
  });

  it('dispatches retained advisory fields and restores only desired subscriptions after overload', async () => {
    const socket = await connected();
    const handler = vi.fn();
    service.on('error', handler);
    service.subscribe('channel');
    service.subscribeServer('server');
    service.subscribeDM('dm');
    service.sendMessage('channel', 'private-content-SENTINEL');
    service.sendProfileUpdate();
    service.sendServerUpdate('server');
    service.sendSetStatus('dnd');
    socket.message({
      type: 'error',
      data: {
        code: 'ws_rate_limited',
        event_class: 'profile',
        retry_after_ms: 5000,
        attacker: 'advisory-SENTINEL',
        channel_id: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(handler).toHaveBeenCalledWith({
      type: 'error',
      data: {
        code: 'ws_rate_limited',
        event_class: 'profile',
        retry_after_ms: 5000,
        channel_id: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(console.error).toHaveBeenCalledWith('WebSocket server error:', {
      type: 'server_error',
      code: 'ws_rate_limited',
      eventClass: 'profile',
      retryAfterMs: 5000,
    });
    const before = socket.sent.length;
    await advance(5000);
    expect(socket.sent).toHaveLength(before);
    socket.close(1013, 'malicious-close-SENTINEL ?ticket=secret');
    await advance(1000);
    const next = BudgetSocket.instances[1];
    next.open();
    expect(next.sent).toEqual([
      { type: 'subscribe', data: { channel_id: 'channel' } },
      { type: 'subscribe_server', data: { server_id: 'server' } },
      { type: 'subscribe_dm', data: { conversation_id: 'dm' } },
      { type: 'connection_ready_probe', data: { protocol_version: 2 } },
    ]);
    const logs = JSON.stringify([
      vi.mocked(console.debug).mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    for (const secret of [
      'malicious-close-SENTINEL',
      'advisory-SENTINEL',
      '33333333-3333-4333-8333-333333333333',
      'private-content-SENTINEL',
      'ticket-SENTINEL-2270',
      '?ticket=',
    ])
      expect(logs).not.toContain(secret);
  });

  it('rejects invalid advisories at the actual wire boundary without retrying the operation', async () => {
    const socket = await connected();
    const handler = vi.fn();
    service.on('error', handler);
    const count = useConnectionStore.getState().wireViolationCount;
    socket.message({
      type: 'error',
      data: { code: 'ws_rate_limited', event_class: 'unknown-SENTINEL', retry_after_ms: 5000 },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().wireViolationCount).toBe(count + 1);
    await advance(6000);
    expect(BudgetSocket.instances).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });
});
