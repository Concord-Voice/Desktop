/**
 * Message Queue Service - Handles offline message queueing and delivery tracking
 *
 * Features:
 * - Queue messages when offline
 * - Persist queue across app restarts (localStorage)
 * - Track message delivery status (pending, sent, delivered, failed)
 * - Auto-retry failed messages
 * - Delivery acknowledgments
 *
 * Integrates with WebSocketService for message delivery
 */

export enum MessageStatus {
  PENDING = 'pending',     // Waiting to be sent
  SENT = 'sent',           // Sent to server, awaiting ack
  DELIVERED = 'delivered', // Acknowledged by server
  FAILED = 'failed',       // Failed to send
}

export interface QueuedMessage {
  id: string;              // Unique message ID (client-generated)
  channelId: string;
  content: string;
  timestamp: number;
  status: MessageStatus;
  retryCount: number;
  maxRetries: number;
  type: 'message' | 'typing' | 'other';
}

interface MessageQueueCallbacks {
  onMessageSent?: (messageId: string) => void;
  onMessageDelivered?: (messageId: string, serverMessageId?: string) => void;
  onMessageFailed?: (messageId: string, error: string) => void;
}

const QUEUE_STORAGE_KEY = 'concord_message_queue';
const MAX_QUEUE_SIZE = 100;
const MAX_RETRIES = 3;

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private callbacks: MessageQueueCallbacks = {};
  private processingInterval: NodeJS.Timeout | null = null;

  constructor(callbacks?: MessageQueueCallbacks) {
    this.callbacks = callbacks || {};
    this.loadQueue();
  }

  /**
   * Add a message to the queue
   */
  enqueue(
    channelId: string,
    content: string,
    type: 'message' | 'typing' | 'other' = 'message'
  ): string {
    const messageId = this.generateMessageId();

    const queuedMessage: QueuedMessage = {
      id: messageId,
      channelId,
      content,
      timestamp: Date.now(),
      status: MessageStatus.PENDING,
      retryCount: 0,
      maxRetries: MAX_RETRIES,
      type,
    };

    this.queue.push(queuedMessage);
    this.trimQueue();
    this.saveQueue();

    console.log(`[MessageQueue] Enqueued message ${messageId} for channel ${channelId}`);

    return messageId;
  }

  /**
   * Mark a message as sent (awaiting server acknowledgment)
   */
  markAsSent(messageId: string): void {
    const message = this.queue.find(m => m.id === messageId);
    if (message) {
      message.status = MessageStatus.SENT;
      this.saveQueue();
      this.callbacks.onMessageSent?.(messageId);
      console.log(`[MessageQueue] Message ${messageId} marked as sent`);
    }
  }

  /**
   * Mark a message as delivered (server acknowledged)
   */
  markAsDelivered(messageId: string, serverMessageId?: string): void {
    const index = this.queue.findIndex(m => m.id === messageId);
    if (index >= 0) {
      const message = this.queue[index];
      message.status = MessageStatus.DELIVERED;

      // Remove from queue after delivery
      this.queue.splice(index, 1);
      this.saveQueue();

      this.callbacks.onMessageDelivered?.(messageId, serverMessageId);
      console.log(`[MessageQueue] Message ${messageId} delivered, removed from queue`);
    }
  }

  /**
   * Mark a message as failed
   */
  markAsFailed(messageId: string, error: string): void {
    const message = this.queue.find(m => m.id === messageId);
    if (message) {
      message.status = MessageStatus.FAILED;
      message.retryCount++;

      if (message.retryCount >= message.maxRetries) {
        console.error(`[MessageQueue] Message ${messageId} failed after ${message.retryCount} retries`);
        this.callbacks.onMessageFailed?.(messageId, error);
      } else {
        // Reset to pending for retry
        message.status = MessageStatus.PENDING;
        console.warn(`[MessageQueue] Message ${messageId} failed, will retry (${message.retryCount}/${message.maxRetries})`);
      }

      this.saveQueue();
    }
  }

  /**
   * Get all pending messages
   */
  getPendingMessages(): QueuedMessage[] {
    return this.queue.filter(m => m.status === MessageStatus.PENDING);
  }

  /**
   * Get all messages for a channel
   */
  getMessagesForChannel(channelId: string): QueuedMessage[] {
    return this.queue.filter(m => m.channelId === channelId);
  }

  /**
   * Get a specific message by ID
   */
  getMessage(messageId: string): QueuedMessage | undefined {
    return this.queue.find(m => m.id === messageId);
  }

  /**
   * Remove a message from the queue
   */
  remove(messageId: string): void {
    const index = this.queue.findIndex(m => m.id === messageId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.saveQueue();
      console.log(`[MessageQueue] Message ${messageId} removed from queue`);
    }
  }

  /**
   * Clear all messages from the queue
   */
  clear(): void {
    this.queue = [];
    this.saveQueue();
    console.log('[MessageQueue] Queue cleared');
  }

  /**
   * Clear all messages for a specific channel
   */
  clearChannel(channelId: string): void {
    this.queue = this.queue.filter(m => m.channelId !== channelId);
    this.saveQueue();
    console.log(`[MessageQueue] Cleared messages for channel ${channelId}`);
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Start processing the queue (call when connection is established)
   */
  startProcessing(sendFn: (message: QueuedMessage) => Promise<void>): void {
    if (this.processingInterval) {
      return; // Already processing
    }

    console.log('[MessageQueue] Started queue processing');

    // Process immediately
    this.processQueue(sendFn);

    // Then process every 5 seconds
    this.processingInterval = setInterval(() => {
      this.processQueue(sendFn);
    }, 5000);
  }

  /**
   * Stop processing the queue (call when connection is lost)
   */
  stopProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
      console.log('[MessageQueue] Stopped queue processing');
    }
  }

  // Private methods

  private async processQueue(sendFn: (message: QueuedMessage) => Promise<void>): Promise<void> {
    const pending = this.getPendingMessages();

    if (pending.length === 0) {
      return;
    }

    console.log(`[MessageQueue] Processing ${pending.length} pending messages`);

    for (const message of pending) {
      try {
        await sendFn(message);
        this.markAsSent(message.id);
      } catch (error) {
        console.error(`[MessageQueue] Failed to send message ${message.id}:`, error);
        this.markAsFailed(message.id, String(error));
      }
    }
  }

  private generateMessageId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private trimQueue(): void {
    if (this.queue.length > MAX_QUEUE_SIZE) {
      // Remove oldest delivered/failed messages first
      const toRemove = this.queue.length - MAX_QUEUE_SIZE;
      const delivered = this.queue
        .filter(m => m.status === MessageStatus.DELIVERED || m.status === MessageStatus.FAILED)
        .slice(0, toRemove);

      delivered.forEach(m => this.remove(m.id));

      // If still over limit, remove oldest pending (shouldn't happen normally)
      if (this.queue.length > MAX_QUEUE_SIZE) {
        this.queue = this.queue.slice(-MAX_QUEUE_SIZE);
        this.saveQueue();
      }
    }
  }

  private saveQueue(): void {
    try {
      localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(this.queue));
    } catch (error) {
      console.error('[MessageQueue] Failed to save queue to localStorage:', error);
    }
  }

  private loadQueue(): void {
    try {
      const stored = localStorage.getItem(QUEUE_STORAGE_KEY);
      if (stored) {
        this.queue = JSON.parse(stored);
        console.log(`[MessageQueue] Loaded ${this.queue.length} messages from storage`);

        // Reset all "sent" messages to "pending" on load (in case app crashed while sending)
        this.queue.forEach(m => {
          if (m.status === MessageStatus.SENT) {
            m.status = MessageStatus.PENDING;
          }
        });
      }
    } catch (error) {
      console.error('[MessageQueue] Failed to load queue from localStorage:', error);
      this.queue = [];
    }
  }
}

// Singleton instance
let messageQueue: MessageQueue | null = null;

export const getMessageQueue = (callbacks?: MessageQueueCallbacks): MessageQueue => {
  if (!messageQueue) {
    messageQueue = new MessageQueue(callbacks);
  }
  return messageQueue;
};

export default getMessageQueue;
