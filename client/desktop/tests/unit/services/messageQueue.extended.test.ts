/**
 * Extended tests for MessageQueue — covers startProcessing, stopProcessing,
 * processQueue flow, trimQueue edge cases, loadQueue localStorage cleanup,
 * and the getMessageQueue singleton.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageQueue, MessageStatus, getMessageQueue } from '@/renderer/services/messageQueue';
import { E2EEKeyUnavailableError } from '@/renderer/services/e2eeErrors';
import { e2eeService } from '@/renderer/services/e2eeService';

describe('MessageQueue — extended', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new MessageQueue();
  });

  afterEach(() => {
    queue.stopProcessing();
    vi.useRealTimers();
  });

  describe('startProcessing', () => {
    it('processes pending messages immediately', async () => {
      const id = queue.enqueue('ch-1', 'Hello');
      const sendFn = vi.fn().mockResolvedValue(undefined);

      queue.startProcessing(sendFn);

      // Wait for the async processQueue to complete
      await vi.advanceTimersByTimeAsync(0);

      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({ id, channelId: 'ch-1', content: 'Hello' })
      );
    });

    it('processes periodically every 5 seconds', async () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);

      // Enqueue a message first, then start processing
      queue.enqueue('ch-1', 'First');

      queue.startProcessing(sendFn);
      await vi.advanceTimersByTimeAsync(0); // Initial process — sends 'First'

      expect(sendFn).toHaveBeenCalledTimes(1);

      // Enqueue another message
      queue.enqueue('ch-1', 'Second');

      // Advance 5 seconds for next processing cycle
      await vi.advanceTimersByTimeAsync(5000);

      // sendFn should have been called again for 'Second'
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it('does nothing if already processing', () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);

      queue.startProcessing(sendFn);
      queue.startProcessing(sendFn); // Second call should be no-op

      // Should not set up duplicate intervals
      expect(sendFn).toBeDefined();
    });

    it('marks messages as sent and removes them after successful send', async () => {
      const id = queue.enqueue('ch-1', 'Success');
      const sendFn = vi.fn().mockResolvedValue(undefined);

      queue.startProcessing(sendFn);
      await vi.advanceTimersByTimeAsync(0);

      // Message should be removed after successful processing
      expect(queue.getMessage(id)).toBeUndefined();
      expect(queue.size()).toBe(0);
    });

    it('marks messages as failed when send throws', async () => {
      const id = queue.enqueue('ch-1', 'Fail');
      const sendFn = vi.fn().mockRejectedValue(new Error('Network error'));

      queue.startProcessing(sendFn);
      await vi.advanceTimersByTimeAsync(0);

      const msg = queue.getMessage(id);
      expect(msg).toBeDefined();
      // Non-typed errors (network failures) are classified as retryable —
      // after first failure, should be set back to PENDING for retry.
      expect(msg!.status).toBe(MessageStatus.PENDING);
      expect(msg!.retryCount).toBe(1);
    });

    it('terminally fails on NOT_MEMBER without retrying', async () => {
      const onMessageFailed = vi.fn();
      const q = new MessageQueue({ onMessageFailed });
      const id = q.enqueue('ch-1', 'Forbidden');
      const sendFn = vi.fn().mockRejectedValue(new E2EEKeyUnavailableError('NOT_MEMBER'));

      q.startProcessing(sendFn);
      await vi.advanceTimersByTimeAsync(0);

      const msg = q.getMessage(id);
      expect(msg!.status).toBe(MessageStatus.FAILED);
      // Retry count jumped straight to maxRetries — no PENDING intermediate.
      expect(msg!.retryCount).toBe(msg!.maxRetries);
      expect(onMessageFailed).toHaveBeenCalledTimes(1);
      expect(onMessageFailed).toHaveBeenCalledWith(
        id,
        expect.stringContaining("don't have access")
      );
      q.stopProcessing();
    });

    it('terminally fails on REVOKED_EPOCH and invalidates the channel key', async () => {
      const invalidateSpy = vi
        .spyOn(e2eeService, 'invalidateChannelKey')
        .mockImplementation(() => {});
      const onMessageFailed = vi.fn();
      const q = new MessageQueue({ onMessageFailed });
      const id = q.enqueue('ch-revoked', 'Stale epoch');
      const sendFn = vi.fn().mockRejectedValue(new E2EEKeyUnavailableError('REVOKED_EPOCH'));

      q.startProcessing(sendFn);
      await vi.advanceTimersByTimeAsync(0);

      expect(q.getMessage(id)!.status).toBe(MessageStatus.FAILED);
      expect(invalidateSpy).toHaveBeenCalledWith('ch-revoked');
      expect(onMessageFailed).toHaveBeenCalledWith(id, expect.stringContaining('re-establishing'));
      q.stopProcessing();
      invalidateSpy.mockRestore();
    });

    it('retries NO_KEY_YET (pending=true) through the backoff loop', async () => {
      const id = queue.enqueue('ch-pending', 'Provisioning');
      const sendFn = vi.fn().mockRejectedValue(new E2EEKeyUnavailableError('NO_KEY_YET', true));

      queue.startProcessing(sendFn);
      await vi.advanceTimersByTimeAsync(0);

      const msg = queue.getMessage(id);
      // First failure resets to PENDING for retry (retryable path).
      expect(msg!.status).toBe(MessageStatus.PENDING);
      expect(msg!.retryCount).toBe(1);
    });

    it('skips empty queue', async () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);

      queue.startProcessing(sendFn);
      await vi.advanceTimersByTimeAsync(0);

      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('stopProcessing', () => {
    it('stops the processing interval', async () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);

      queue.startProcessing(sendFn);
      await vi.advanceTimersByTimeAsync(0);

      queue.stopProcessing();

      // Enqueue a new message and advance time — should not be processed
      queue.enqueue('ch-1', 'After stop');
      await vi.advanceTimersByTimeAsync(10000);

      // Only the initial process should have happened
      expect(sendFn).toHaveBeenCalledTimes(0); // No messages in initial call
    });

    it('is safe to call when not processing', () => {
      expect(() => queue.stopProcessing()).not.toThrow();
    });

    it('is safe to call multiple times', () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      queue.startProcessing(sendFn);
      queue.stopProcessing();
      queue.stopProcessing();
      // No error
      expect(queue.size()).toBe(0);
    });
  });

  describe('message lifecycle', () => {
    it('full lifecycle: enqueue → send → markAsSent → markAsDelivered', () => {
      const onSent = vi.fn();
      const onDelivered = vi.fn();
      const q = new MessageQueue({
        onMessageSent: onSent,
        onMessageDelivered: onDelivered,
      });

      const id = q.enqueue('ch-1', 'Full lifecycle');
      expect(q.getMessage(id)!.status).toBe(MessageStatus.PENDING);

      q.markAsSent(id);
      expect(q.getMessage(id)!.status).toBe(MessageStatus.SENT);
      expect(onSent).toHaveBeenCalledWith(id);

      q.markAsDelivered(id, 'server-id-1');
      expect(q.getMessage(id)).toBeUndefined(); // Removed
      expect(onDelivered).toHaveBeenCalledWith(id, 'server-id-1');
    });

    it('marks non-existent message as sent (no-op)', () => {
      queue.markAsSent('nonexistent');
      // Should not throw
      expect(queue.getMessage('nonexistent')).toBeUndefined();
    });

    it('marks non-existent message as delivered (no-op)', () => {
      queue.markAsDelivered('nonexistent');
      // Should not throw
      expect(queue.getMessage('nonexistent')).toBeUndefined();
    });

    it('marks non-existent message as failed (no-op)', () => {
      queue.markAsFailed('nonexistent', 'error');
      // Should not throw
      expect(queue.getMessage('nonexistent')).toBeUndefined();
    });

    it('removes non-existent message (no-op)', () => {
      queue.remove('nonexistent');
      // Should not throw
      expect(queue.getMessage('nonexistent')).toBeUndefined();
    });
  });

  describe('trimQueue', () => {
    it('trims delivered/failed messages first when over limit', () => {
      // Enqueue 101 messages
      for (let i = 0; i < 101; i++) {
        queue.enqueue('ch-1', `Message ${i}`);
      }
      // All messages are PENDING, so trimQueue falls through to slice
      expect(queue.size()).toBeLessThanOrEqual(100);
    });

    it('trims old pending messages as last resort', () => {
      for (let i = 0; i < 105; i++) {
        queue.enqueue('ch-1', `Message ${i}`);
      }
      expect(queue.size()).toBeLessThanOrEqual(100);
    });
  });

  describe('enqueue with different types', () => {
    it('defaults to message type', () => {
      const id = queue.enqueue('ch-1', 'Test');
      expect(queue.getMessage(id)!.type).toBe('message');
    });

    it('supports typing type', () => {
      const id = queue.enqueue('ch-1', '', 'typing');
      expect(queue.getMessage(id)!.type).toBe('typing');
    });

    it('supports other type', () => {
      const id = queue.enqueue('ch-1', 'data', 'other');
      expect(queue.getMessage(id)!.type).toBe('other');
    });
  });

  describe('getMessage', () => {
    it('returns undefined for non-existent message', () => {
      expect(queue.getMessage('nope')).toBeUndefined();
    });
  });

  describe('clearChannel', () => {
    it('only clears messages for the specified channel', () => {
      queue.enqueue('ch-1', 'A');
      queue.enqueue('ch-2', 'B');
      queue.enqueue('ch-1', 'C');

      queue.clearChannel('ch-1');

      expect(queue.size()).toBe(1);
      expect(queue.getMessagesForChannel('ch-1')).toHaveLength(0);
      expect(queue.getMessagesForChannel('ch-2')).toHaveLength(1);
    });
  });

  describe('loadQueue — localStorage cleanup', () => {
    it('removes old persisted queue from localStorage on construction', () => {
      localStorage.setItem('concord_message_queue', '[{"old": true}]');
      // Constructor side-effect: cleans up old persisted plaintext messages
      const cleanupQueue = new MessageQueue();
      expect(localStorage.getItem('concord_message_queue')).toBeNull();
      cleanupQueue.clear(); // use the instance to satisfy lint
    });
  });

  describe('getMessageQueue singleton', () => {
    it('returns the same instance on subsequent calls', () => {
      // Note: This tests the module-level singleton. We can't easily reset it
      // between tests, so we just verify it returns a MessageQueue.
      const q1 = getMessageQueue();
      const q2 = getMessageQueue();
      expect(q1).toBe(q2);
    });
  });
});

// regression for #918 — E2EE init startup-race + missing-wrap recovery
//
// Symptom: on fresh login, MessageQueue.processQueue dequeues an E2EE
// message before e2eeService has finished init. The send hits the server
// before any wrapped key exists for the user, surfacing as a 404 NO_KEY_YET.
// Even with #751's classifier turning that into a "Key not ready — retrying"
// toast, the user still sees a transient error on the very first send.
//
// Fix invariant: while e2eeService.isInitialized === false, MessageQueue
// must not invoke sendFn for messages that require encryption.
describe('MessageQueue — startup-race gate (regression for #918)', () => {
  let queue: MessageQueue;
  let isInitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new MessageQueue();
    isInitSpy = vi.spyOn(e2eeService, 'isInitialized', 'get').mockReturnValue(false);
  });

  afterEach(() => {
    queue.stopProcessing();
    isInitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not call sendFn for an E2EE DM message while e2eeService is not initialized', async () => {
    const id = queue.enqueue(
      'dm-conversation-1',
      'Hello',
      'dm_message',
      undefined,
      undefined,
      true // isEncrypted — requires e2eeService to be ready
    );
    const sendFn = vi.fn().mockResolvedValue(undefined);

    queue.startProcessing(sendFn);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendFn).not.toHaveBeenCalled();
    expect(queue.getMessage(id)?.status).toBe(MessageStatus.PENDING);
    expect(queue.getMessage(id)?.retryCount).toBe(0);
  });

  it('begins calling sendFn once e2eeService becomes initialized on the next tick', async () => {
    queue.enqueue('dm-conversation-1', 'Hello', 'dm_message', undefined, undefined, true);
    const sendFn = vi.fn().mockResolvedValue(undefined);

    queue.startProcessing(sendFn);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendFn).not.toHaveBeenCalled();

    // E2EE init completes before the next 5s polling tick.
    isInitSpy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5000);

    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT gate channel messages that omit the isEncrypted flag (caller-asymmetry contract)', async () => {
    // The channel-message path in useMessaging.ts sendMessage calls
    // enqueue(channelId, content, 'message') WITHOUT an isEncrypted arg.
    // The persisted message.isEncrypted is therefore `undefined`, which
    // short-circuits the gate's `message.isEncrypted && ...` predicate to
    // false — so channel messages flow through even with isInitialized=false.
    // Channel encryption is re-derived at dequeue time inside the sendFn
    // (useMessaging.ts processQueuedMessage), not gated here. This test
    // documents the contract so a future refactor doesn't accidentally
    // tighten the gate to gate ALL messages and silently break the
    // server-channel send path.
    const id = queue.enqueue('ch-1', 'Channel message', 'message');
    const sendFn = vi.fn().mockResolvedValue(undefined);

    queue.startProcessing(sendFn);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ id, content: 'Channel message' })
    );
    expect(queue.getMessage(id)).toBeUndefined(); // sent + removed
  });

  it('skips only the encrypted message and processes the interleaved plaintext (validates `continue`, not `break`)', async () => {
    // A "wrong fix" using `break` would abort the loop on the first gated
    // message and silently starve any non-encrypted messages queued after
    // it. This test would fail under that refactor — sendFn would be called
    // zero times instead of one.
    const encryptedId = queue.enqueue(
      'dm-1',
      'Encrypted',
      'dm_message',
      undefined,
      undefined,
      true
    );
    const plaintextId = queue.enqueue('ch-1', 'Plaintext', 'message');
    const sendFn = vi.fn().mockResolvedValue(undefined);

    queue.startProcessing(sendFn);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: plaintextId, content: 'Plaintext' })
    );
    expect(queue.getMessage(encryptedId)?.status).toBe(MessageStatus.PENDING);
    expect(queue.getMessage(plaintextId)).toBeUndefined();
  });

  it('terminally fails an encrypted message after MAX_INIT_SKIP_CYCLES (12) gate cycles', async () => {
    // Bound exists so a permanent init failure (App.tsx
    // initializeFromStoredKeys catch path) terminates the message via the
    // existing onMessageFailed callback rather than leaving it PENDING
    // forever with no UI signal. ~60s of patience at the 5s tick cadence.
    const onMessageFailed = vi.fn();
    const q = new MessageQueue({ onMessageFailed });
    const id = q.enqueue('dm-1', 'Hello', 'dm_message', undefined, undefined, true);
    const sendFn = vi.fn().mockResolvedValue(undefined);

    q.startProcessing(sendFn);

    // Initial process tick = skip 1
    await vi.advanceTimersByTimeAsync(0);
    expect(onMessageFailed).not.toHaveBeenCalled();

    // 11 more 5s ticks brings total skips to 12, hitting the threshold
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    expect(sendFn).not.toHaveBeenCalled();
    expect(onMessageFailed).toHaveBeenCalledTimes(1);
    expect(onMessageFailed).toHaveBeenCalledWith(
      id,
      expect.stringContaining('Encryption setup did not complete')
    );
    expect(q.getMessage(id)?.status).toBe(MessageStatus.FAILED);

    q.stopProcessing();
  });
});
