import { WebSocketService, ConnectionState } from '@/renderer/services/websocketService';

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
      ws.simulateMessage({ type: 'connected', data: { client_id: 'client-123', user_id: 'user-456' } });

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

      service.sendMessage('ch-1', 'Hello', 'nonce-1', false);

      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(sent.type).toBe('message');
      expect(sent.data.channel_id).toBe('ch-1');
      expect(sent.data.content).toBe('Hello');
      expect(sent.data.nonce).toBe('nonce-1');
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
