/**
 * WebSocket Service - Connection Manager for Concord Real-Time Communication
 *
 * Features:
 * - JWT authentication
 * - Auto-reconnect with exponential backoff
 * - Heartbeat/ping-pong handling
 * - Connection state management
 * - Message routing with type-based handlers
 * - Subscribe/unsubscribe to channels
 * - Typing indicators
 *
 * @see services/control-plane/internal/websocket for backend implementation
 */

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

export interface WebSocketMessage {
  type: string;
  data: Record<string, any>;
}

export interface ConnectionInfo {
  clientId: string;
  userId: string;
}

type MessageHandler = (message: WebSocketMessage) => void;
type ConnectionHandler = (state: ConnectionState) => void;

export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string | null = null;
  private state: ConnectionState = ConnectionState.DISCONNECTED;

  // Connection management
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 30000; // Max 30 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;

  // Message handlers
  private messageHandlers = new Map<string, Set<MessageHandler>>();
  private connectionHandlers = new Set<ConnectionHandler>();

  // Connection info
  private connectionInfo: ConnectionInfo | null = null;

  // Subscribed channels
  private subscribedChannels = new Set<string>();

  constructor(baseUrl: string = 'ws://localhost:8080') {
    this.url = `${baseUrl}/api/v1/ws`;
  }

  /**
   * Connect to WebSocket server with JWT token
   */
  connect(token: string): void {
    if (this.ws && this.state === ConnectionState.CONNECTED) {
      console.warn('WebSocket already connected');
      return;
    }

    this.token = token;
    this.setState(ConnectionState.CONNECTING);
    this.createConnection();
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.clearReconnectTimer();
    this.clearPingInterval();
    this.reconnectAttempts = 0;

    if (this.ws) {
      // Only close if fully connected to avoid "WebSocket is closed before connection is established" error
      // This prevents noisy errors in React Strict Mode where cleanup runs immediately after mount
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client disconnect');
      }
      // If still connecting or closing, just clear the reference without calling close()
      this.ws = null;
    }

    this.setState(ConnectionState.DISCONNECTED);
    this.connectionInfo = null;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get connection info (client ID and user ID)
   */
  getConnectionInfo(): ConnectionInfo | null {
    return this.connectionInfo;
  }

  /**
   * Send a message to the WebSocket server
   */
  send(message: WebSocketMessage): void {
    if (this.state !== ConnectionState.CONNECTED || !this.ws) {
      console.error('Cannot send message: WebSocket not connected');
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Failed to send WebSocket message:', error);
    }
  }

  /**
   * Subscribe to a channel
   */
  subscribe(channelId: string): void {
    this.subscribedChannels.add(channelId);
    this.send({
      type: 'subscribe',
      data: { channel_id: channelId },
    });
  }

  /**
   * Unsubscribe from a channel
   */
  unsubscribe(channelId: string): void {
    this.subscribedChannels.delete(channelId);
    this.send({
      type: 'unsubscribe',
      data: { channel_id: channelId },
    });
  }

  /**
   * Send a chat message to a channel
   */
  sendMessage(channelId: string, content: string): void {
    this.send({
      type: 'message',
      data: {
        channel_id: channelId,
        content,
        timestamp: Date.now(),
      },
    });
  }

  /**
   * Send typing indicator
   */
  sendTypingIndicator(channelId: string, isTyping: boolean): void {
    this.send({
      type: 'typing',
      data: {
        channel_id: channelId,
        is_typing: isTyping,
      },
    });
  }

  /**
   * Add a message handler for a specific message type
   */
  on(messageType: string, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, new Set());
    }

    this.messageHandlers.get(messageType)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.messageHandlers.get(messageType);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.messageHandlers.delete(messageType);
        }
      }
    };
  }

  /**
   * Add a connection state change handler
   */
  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);

    // Immediately call handler with current state
    handler(this.state);

    // Return unsubscribe function
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  /**
   * Remove all handlers (cleanup)
   */
  removeAllHandlers(): void {
    this.messageHandlers.clear();
    this.connectionHandlers.clear();
  }

  // Private methods

  private createConnection(): void {
    if (!this.token) {
      console.error('Cannot connect: No JWT token provided');
      this.setState(ConnectionState.ERROR);
      return;
    }

    try {
      const urlWithToken = `${this.url}?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(urlWithToken);

      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      this.setState(ConnectionState.ERROR);
      this.scheduleReconnect();
    }
  }

  private handleOpen(): void {
    console.log('WebSocket connection opened');
    this.setState(ConnectionState.CONNECTED);
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;

    // Start ping interval to detect connection health
    this.startPingInterval();
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message: WebSocketMessage = JSON.parse(event.data);

      // Handle special message types
      switch (message.type) {
        case 'connected':
          this.connectionInfo = {
            clientId: message.data.client_id,
            userId: message.data.user_id,
          };
          console.log('WebSocket connected:', this.connectionInfo);

          // Resubscribe to channels after reconnect
          this.resubscribeChannels();
          break;

        case 'error':
          console.error('WebSocket server error:', message.data);
          break;
      }

      // Notify message handlers
      const handlers = this.messageHandlers.get(message.type);
      if (handlers) {
        handlers.forEach(handler => {
          try {
            handler(message);
          } catch (error) {
            console.error('Error in message handler:', error);
          }
        });
      }
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  private handleError(event: Event): void {
    console.error('WebSocket error:', event);
    this.setState(ConnectionState.ERROR);
  }

  private handleClose(event: CloseEvent): void {
    console.log(`WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`);

    this.clearPingInterval();
    this.ws = null;

    // Only reconnect if not manually disconnected
    if (event.code !== 1000) {
      this.setState(ConnectionState.RECONNECTING);
      this.scheduleReconnect();
    } else {
      this.setState(ConnectionState.DISCONNECTED);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      this.setState(ConnectionState.ERROR);
      return;
    }

    this.clearReconnectTimer();

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.createConnection();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPingInterval(): void {
    this.clearPingInterval();

    // Send ping every 30 seconds (server expects pong within 60 seconds)
    this.pingInterval = setInterval(() => {
      if (this.state === ConnectionState.CONNECTED && this.ws) {
        // WebSocket browser API handles ping/pong automatically
        // But we can send a custom ping message if needed
        // For now, rely on the server's ping mechanism
      }
    }, 30000);
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private resubscribeChannels(): void {
    // Resubscribe to all channels after reconnect
    this.subscribedChannels.forEach(channelId => {
      this.subscribe(channelId);
    });
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.notifyConnectionHandlers();
    }
  }

  private notifyConnectionHandlers(): void {
    this.connectionHandlers.forEach(handler => {
      try {
        handler(this.state);
      } catch (error) {
        console.error('Error in connection handler:', error);
      }
    });
  }
}

// Singleton instance
let wsService: WebSocketService | null = null;

export const getWebSocketService = (baseUrl?: string): WebSocketService => {
  if (!wsService) {
    wsService = new WebSocketService(baseUrl);
  }
  return wsService;
};

export default getWebSocketService;
