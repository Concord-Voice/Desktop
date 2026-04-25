import {
  WebSocketService,
  ConnectionState,
  fullJitter,
} from '@/renderer/services/websocketService';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) this.onopen(new Event('open'));
    }, 0);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close', { code: 1000, reason: 'test' }));
    }
  }

  // Test helper: simulate incoming message
  simulateMessage(data: object) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }

  // Test helper: simulate error
  simulateError() {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }
}

// Install mocks
const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  (globalThis as any).WebSocket = MockWebSocket;
});
afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});

// Helper: connect and wait for the async createConnection chain to resolve
// (fetch ticket → json parse → new WebSocket → setTimeout onopen)
async function connectAndWaitForOpen(
  service: WebSocketService,
  token = 'test-token'
): Promise<MockWebSocket> {
  service.connect(token);
  // Flush microtasks: resolve fetch() promise
  await vi.advanceTimersByTimeAsync(0);
  // Flush microtasks: resolve json() promise + new WebSocket setTimeout(0)
  await vi.advanceTimersByTimeAsync(0);
  const ws = (service as any).ws as MockWebSocket;
  return ws;
}

describe('WebSocketService', () => {
  let service: WebSocketService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Mock fetch for ws-ticket endpoint
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: 'mock-ticket' }),
    });
    globalThis.fetch = mockFetch;
    service = new WebSocketService('ws://localhost:8080');
  });

  afterEach(() => {
    service.disconnect();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  describe('initial state', () => {
    it('starts disconnected', () => {
      expect(service.getState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('has no connection info', () => {
      expect(service.getConnectionInfo()).toBeNull();
    });
  });

  describe('connect', () => {
    it('sets state to CONNECTING', () => {
      service.connect('test-token');
      expect(service.getState()).toBe(ConnectionState.CONNECTING);
    });

    it('does not reconnect if already connected', async () => {
      const ws = await connectAndWaitForOpen(service);

      // Simulate 'connected' message to set CONNECTED state
      ws.simulateMessage({ type: 'connected', data: { client_id: 'c1', user_id: 'u1' } });

      expect(service.getState()).toBe(ConnectionState.CONNECTED);

      // Try connecting again — should be a no-op
      service.connect('test-token');
      expect(service.getState()).toBe(ConnectionState.CONNECTED);
    });
  });

  describe('disconnect', () => {
    it('sets state to DISCONNECTED', () => {
      service.connect('test-token');
      service.disconnect();
      expect(service.getState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('clears connection info', async () => {
      const ws = await connectAndWaitForOpen(service);
      ws.simulateMessage({ type: 'connected', data: { client_id: 'c1', user_id: 'u1' } });
      expect(service.getConnectionInfo()).not.toBeNull();

      service.disconnect();
      expect(service.getConnectionInfo()).toBeNull();
    });
  });

  describe('message handling', () => {
    it('stores connection info from connected message', async () => {
      const ws = await connectAndWaitForOpen(service);
      ws.simulateMessage({
        type: 'connected',
        data: { client_id: 'client-123', user_id: 'user-456' },
      });

      const info = service.getConnectionInfo();
      expect(info?.clientId).toBe('client-123');
      expect(info?.userId).toBe('user-456');
    });

    it('calls registered message handlers', async () => {
      const ws = await connectAndWaitForOpen(service);

      const handler = vi.fn();
      service.on('test_event', handler);

      ws.simulateMessage({ type: 'test_event', data: { foo: 'bar' } });

      expect(handler).toHaveBeenCalledWith({ type: 'test_event', data: { foo: 'bar' } });
    });

    it('can remove message handlers', async () => {
      const ws = await connectAndWaitForOpen(service);

      const handler = vi.fn();
      const off = service.on('test_event', handler);
      off();

      ws.simulateMessage({ type: 'test_event', data: {} });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('connection state callbacks', () => {
    it('notifies immediately with current state', () => {
      const callback = vi.fn();
      service.onConnectionChange(callback);
      // Immediately called with current state (DISCONNECTED)
      expect(callback).toHaveBeenCalledWith(ConnectionState.DISCONNECTED);
    });

    it('notifies on state changes after connect', () => {
      const callback = vi.fn();
      service.onConnectionChange(callback);
      callback.mockClear();

      service.connect('test-token');
      expect(callback).toHaveBeenCalledWith(ConnectionState.CONNECTING);
    });

    it('can unsubscribe from state changes', () => {
      const callback = vi.fn();
      const unsub = service.onConnectionChange(callback);
      unsub();
      callback.mockClear();

      service.connect('test-token');
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('channel subscriptions', () => {
    it('tracks subscribed channels', () => {
      expect(service.isSubscribed('ch1')).toBe(false);

      // Manually add (subscribe sends via WS which needs OPEN state)
      (service as any).subscribedChannels.add('ch1');
      expect(service.isSubscribed('ch1')).toBe(true);
    });
  });

  describe('send methods', () => {
    it('sendMessage builds correct payload', async () => {
      const ws = await connectAndWaitForOpen(service);
      ws.simulateMessage({ type: 'connected', data: { client_id: 'c1', user_id: 'u1' } });

      service.sendMessage('ch-1', 'Hello', { nonce: 'nonce-1', isEncrypted: false });

      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(sent.type).toBe('message');
      expect(sent.data.channel_id).toBe('ch-1');
      expect(sent.data.content).toBe('Hello');
      expect(sent.data.nonce).toBe('nonce-1');
    });

    it('sendMessage includes attachment_ids when provided', async () => {
      const ws = await connectAndWaitForOpen(service);
      ws.simulateMessage({ type: 'connected', data: { client_id: 'c1', user_id: 'u1' } });

      service.sendMessage('ch-1', 'Files attached', {
        nonce: 'nonce-2',
        attachmentIds: ['file-1', 'file-2'],
      });

      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(sent.data.attachment_ids).toEqual(['file-1', 'file-2']);
    });

    it('sendMessage omits attachment_ids when empty', async () => {
      const ws = await connectAndWaitForOpen(service);
      ws.simulateMessage({ type: 'connected', data: { client_id: 'c1', user_id: 'u1' } });

      service.sendMessage('ch-1', 'No files');

      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(sent.data.attachment_ids).toBeUndefined();
    });

    it('sendTypingIndicator builds correct payload', async () => {
      const ws = await connectAndWaitForOpen(service);
      ws.simulateMessage({ type: 'connected', data: { client_id: 'c1', user_id: 'u1' } });

      service.sendTypingIndicator('ch-1', true);

      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(sent.type).toBe('typing');
      expect(sent.data.channel_id).toBe('ch-1');
      expect(sent.data.is_typing).toBe(true);
    });

    it('sendSetStatus builds correct payload', async () => {
      const ws = await connectAndWaitForOpen(service);
      ws.simulateMessage({ type: 'connected', data: { client_id: 'c1', user_id: 'u1' } });

      service.sendSetStatus('dnd');

      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(sent.type).toBe('set_status');
      expect(sent.data.status).toBe('dnd');
    });

    it('send does nothing when not connected', () => {
      // Should not throw
      service.send({ type: 'test', data: {} });
    });
  });
});

describe('fullJitter', () => {
  it('returns integer in [0, base) for 1000 iterations', () => {
    for (let i = 0; i < 1000; i++) {
      const d = fullJitter(1000);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1000);
    }
  });

  it('returns 0 when base is 0', () => {
    expect(fullJitter(0)).toBe(0);
  });

  it('handles base of 1 (returns 0)', () => {
    for (let i = 0; i < 100; i++) {
      expect(fullJitter(1)).toBe(0);
    }
  });
});

describe('scheduleReconnect attempt cap', () => {
  let service: WebSocketService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: 'mock-ticket' }),
    });
    globalThis.fetch = mockFetch;
    service = new WebSocketService('ws://localhost:8080');
  });

  afterEach(() => {
    service.disconnect();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('drops aggressive mode after MAX_AGGRESSIVE_ATTEMPTS (3) failures', () => {
    const s = service as unknown as {
      aggressiveReconnect: boolean;
      reconnectAttempts: number;
      scheduleReconnect: () => void;
      reconnectTimer: NodeJS.Timeout | null;
      setAggressiveReconnect: (v: boolean) => void;
    };
    s.setAggressiveReconnect(true);
    // Simulate three failed attempts incrementing the counter
    s.reconnectAttempts = 3;
    s.scheduleReconnect();
    // After hitting cap, aggressive flips off and attempts resets to 0
    expect(s.aggressiveReconnect).toBe(false);
    expect(s.reconnectAttempts).toBe(0);
  });

  it('stays aggressive below cap', () => {
    const s = service as unknown as {
      aggressiveReconnect: boolean;
      reconnectAttempts: number;
      scheduleReconnect: () => void;
      setAggressiveReconnect: (v: boolean) => void;
    };
    s.setAggressiveReconnect(true);
    s.reconnectAttempts = 2;
    s.scheduleReconnect();
    expect(s.aggressiveReconnect).toBe(true);
  });
});

describe('ticket cache', () => {
  it('consumes cached ticket within TTL', () => {
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      ticketCache: { ticket: string; issuedAt: number } | null;
      consumeCachedTicket: () => string | null;
    };
    s.ticketCache = { ticket: 'cached-ticket-abc', issuedAt: Date.now() };
    const consumed = s.consumeCachedTicket();
    expect(consumed).toBe('cached-ticket-abc');
    // Cache is cleared after consumption (single-use invariant)
    expect(s.ticketCache).toBeNull();
  });

  it('rejects cached ticket older than TTL', () => {
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      ticketCache: { ticket: string; issuedAt: number } | null;
      consumeCachedTicket: () => string | null;
    };
    s.ticketCache = { ticket: 'stale-ticket', issuedAt: Date.now() - 10_000 };
    const consumed = s.consumeCachedTicket();
    expect(consumed).toBeNull();
    expect(s.ticketCache).toBeNull(); // stale entries cleared too
  });

  it('returns null when cache is empty', () => {
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as { consumeCachedTicket: () => string | null };
    const consumed = s.consumeCachedTicket();
    expect(consumed).toBeNull();
  });
});

describe('connection-ready promise', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('whenConnectionReady resolves when connection_ready frame arrives', async () => {
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      createConnectionReadyPromise: () => void;
      resolveConnectionReady: () => void;
      whenConnectionReady: () => Promise<void>;
    };
    s.createConnectionReadyPromise();
    const p = s.whenConnectionReady();
    s.resolveConnectionReady();
    await expect(p).resolves.toBeUndefined();
  });

  it('whenConnectionReady rejects after CONNECTION_READY_TIMEOUT_MS', async () => {
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      createConnectionReadyPromise: () => void;
      whenConnectionReady: () => Promise<void>;
    };
    s.createConnectionReadyPromise();
    const p = s.whenConnectionReady();
    vi.advanceTimersByTime(5_000);
    await expect(p).rejects.toThrow(/connection_ready/);
  });

  it('rejecting on disconnect allows new promise on next open', async () => {
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      createConnectionReadyPromise: () => void;
      rejectConnectionReady: (err: Error) => void;
      whenConnectionReady: () => Promise<void>;
    };
    s.createConnectionReadyPromise();
    const p1 = s.whenConnectionReady();
    s.rejectConnectionReady(new Error('disconnected'));
    await expect(p1).rejects.toThrow(/disconnected/);

    s.createConnectionReadyPromise();
    const p2 = s.whenConnectionReady();
    expect(p2).not.toBe(p1);
  });

  it('does not produce unhandled rejection when no consumer awaits', async () => {
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      createConnectionReadyPromise: () => void;
      rejectConnectionReady: (err: Error) => void;
    };
    // Track unhandled rejections during this test
    const unhandled: unknown[] = [];
    const handler = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
    };
    globalThis.addEventListener('unhandledrejection', handler);

    s.createConnectionReadyPromise();
    s.rejectConnectionReady(new Error('test rejection'));

    // Give the microtask queue time to fire any unhandled rejection events
    await vi.advanceTimersByTimeAsync(10);
    globalThis.removeEventListener('unhandledrejection', handler);

    expect(unhandled).toHaveLength(0);
  });

  it('clears resolve/reject refs after timeout fires', async () => {
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      createConnectionReadyPromise: () => void;
      whenConnectionReady: () => Promise<void>;
      connectionReadyResolve: (() => void) | null;
      connectionReadyReject: ((err: Error) => void) | null;
      connectionReadyTimer: NodeJS.Timeout | null;
    };
    s.createConnectionReadyPromise();
    const p = s.whenConnectionReady();
    // Attach a no-op handler so the rejection is consumed (test cleanliness)
    p.catch(() => {});
    vi.advanceTimersByTime(5_000);
    await Promise.resolve(); // flush microtask queue
    // After timeout, refs should be cleared
    expect(s.connectionReadyResolve).toBeNull();
    expect(s.connectionReadyReject).toBeNull();
    expect(s.connectionReadyTimer).toBeNull();
  });
});

describe('origin 502 storm recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('recovers within 3 aggressive attempts when origin returns 502 twice then 200', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call++;
      if (call <= 2) {
        return new Response(null, { status: 502, statusText: 'Bad Gateway' });
      }
      return new Response(JSON.stringify({ ticket: 'ok-ticket-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      token: string | null;
      aggressiveReconnect: boolean;
      reconnectAttempts: number;
      createConnection: (signal?: AbortSignal) => Promise<void>;
      setAggressiveReconnect: (v: boolean) => void;
    };
    s.token = 'mock-jwt';
    s.setAggressiveReconnect(true);
    s.reconnectAttempts = 0;

    // Attempt 1 → 502 → catch → scheduleReconnect (aggressive, attempt 0 → base 500ms → jitter[0,500))
    await s.createConnection();
    // Flush any pending microtasks from the failed fetch, then fire the reconnect timer
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    await vi.runOnlyPendingTimersAsync();

    // Attempt 2 → 502 → catch → scheduleReconnect (aggressive, attempt 1 → base 1000ms → jitter[0,1000))
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    await vi.runOnlyPendingTimersAsync();

    // Attempt 3 → 200 → ticket obtained → new WebSocket (MockWebSocket; doesn't throw)
    await Promise.resolve();

    // After three attempts, fetch must have been called exactly 3 times.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('resubscribeChannels emits probe', () => {
  it('sends connection_ready_probe after all resubscribes', () => {
    vi.useFakeTimers();
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      subscribedChannels: Set<string>;
      subscribedDMs: Set<string>;
      subscribedServers: Set<string>;
      resubscribeChannels: () => void;
      send: (msg: { type: string; data: Record<string, unknown> }) => void;
    };
    // Seed state
    s.subscribedChannels.clear();
    s.subscribedDMs.clear();
    s.subscribedServers.clear();
    s.subscribedChannels.add('ch1');
    s.subscribedChannels.add('ch2');
    s.subscribedDMs.add('dm1');
    s.subscribedServers.add('sv1');

    const sent: Array<{ type: string; data: Record<string, unknown> }> = [];
    const originalSend = s.send.bind(svc);
    s.send = (msg) => {
      sent.push(msg);
      originalSend(msg);
    };

    s.resubscribeChannels();

    const types = sent.map((m) => m.type);
    expect(types).toEqual([
      'subscribe',
      'subscribe',
      'subscribe_server',
      'subscribe_dm',
      'connection_ready_probe',
    ]);
    // Probe payload marks protocol v2
    const probe = sent[sent.length - 1];
    expect(probe.data).toEqual({ protocol_version: 2 });
    vi.useRealTimers();
  });

  it('sends probe even with empty subscribed sets (cold connect)', () => {
    vi.useFakeTimers();
    const svc = new WebSocketService('ws://localhost:8080');
    const s = svc as unknown as {
      subscribedChannels: Set<string>;
      subscribedDMs: Set<string>;
      subscribedServers: Set<string>;
      resubscribeChannels: () => void;
      send: (msg: { type: string; data: Record<string, unknown> }) => void;
    };
    s.subscribedChannels.clear();
    s.subscribedDMs.clear();
    s.subscribedServers.clear();

    const sent: Array<{ type: string }> = [];
    s.send = (msg) => {
      sent.push({ type: msg.type });
    };

    s.resubscribeChannels();

    expect(sent.map((m) => m.type)).toEqual(['connection_ready_probe']);
    vi.useRealTimers();
  });
});
