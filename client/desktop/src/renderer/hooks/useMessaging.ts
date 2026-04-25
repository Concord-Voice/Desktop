/**
 * useMessaging - Enhanced hook for sending messages with delivery tracking
 *
 * Features:
 * - Message queue for offline mode
 * - Delivery status tracking (pending → sent → delivered)
 * - Auto-retry failed messages
 * - Optimistic UI updates
 * - Persistent queue across app restarts
 *
 * Integrates with useWebSocket and MessageQueue
 */

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useUserStore } from '../stores/userStore';
import { useChannelStore } from '../stores/channelStore';
import { useDMStore } from '../stores/dmStore';
import { getWebSocketService, ConnectionState } from '../services/websocketService';
import { getMessageQueue, type QueuedMessage } from '../services/messageQueue';
import { e2eeService } from '../services/e2eeService';
import { classifyError } from '../services/e2eeErrors';
import type { AttachmentSummary, MessageWithStatus } from '../types/chat';

/** Wrap content + gif_slug into a JSON envelope for E2EE encryption when a GIF is attached. */
function wrapContentWithGifSlug(content: string, gifSlug?: string): string {
  return gifSlug ? JSON.stringify({ text: content, gif_slug: gifSlug }) : content;
}

/** Encrypt a queued message's content (with optional gif_slug) for an E2EE channel.
 *  Returns the ciphertext + key version, throws on failure. */
async function encryptQueuedContent(
  channelId: string,
  content: string,
  gifSlug: string | undefined,
  msgId: string,
  isDM: boolean
): Promise<{ ciphertext: string; keyVersion: number }> {
  if (!e2eeService.isInitialized) {
    throw new Error(
      `E2EE not initialized for encrypted ${isDM ? 'DM' : 'channel'} message ${msgId}; retry later`
    );
  }
  const plaintext = wrapContentWithGifSlug(content, gifSlug);
  const ciphertext = await e2eeService.encryptForChannel(channelId, plaintext);
  if (!ciphertext || ciphertext.length < 40) {
    throw new Error(`Encryption produced invalid output for message ${msgId}`);
  }
  return { ciphertext, keyVersion: e2eeService.getCurrentKeyVersion(channelId) };
}

interface SendMessageOptions {
  avatarUrl?: string;
  displayName?: string;
  mentionMeta?: string;
  replyToId?: string;
  attachmentIds?: string[];
  attachments?: AttachmentSummary[];
  gifSlug?: string;
}

export function useMessaging() {
  const wsService = useRef(getWebSocketService()).current;
  // Tracks whether the connection_ready gate warn has fired for this connection.
  // Reset to false on each CONNECTED state transition so the next timeout cycle
  // logs exactly once rather than spamming the console for v1-hub sessions or
  // any scenario where the gate stays rejected for the rest of a connection.
  const connectionReadyWarnedRef = useRef(false);
  const messageQueue = useRef(
    getMessageQueue({
      onMessageSent: (messageId) => {
        console.debug(`[useMessaging] Message ${messageId} sent`);
      },
      onMessageDelivered: (messageId, serverMessageId) => {
        console.debug(`[useMessaging] Message ${messageId} delivered (${serverMessageId})`);
      },
      onMessageFailed: (messageId, error) => {
        console.warn(`[useMessaging] Message ${messageId} failed: ${error}`);
      },
    })
  ).current;

  const updateMessageStatus = useChatStore((s) => s.updateMessageStatus);
  const addMessage = useChatStore((s) => s.addMessage);
  const userId = useUserStore((s) => s.user?.id);

  // Process a single queued message: encrypt if needed, then send via correct transport
  const processQueuedMessage = useCallback(
    async (msg: QueuedMessage) => {
      // Gate on connection-ready: during reconnect, wait for the hub to
      // acknowledge all resubscribes. On cold connect, this resolves in ~RTT.
      // On timeout (5s with no ack), proceed best-effort — the error path
      // from an unsubscribed-channel send is already handled below.
      //
      // This promise rejects only on: (a) 5s timeout, or (b) disconnect-before-ready.
      // Both are intended proceed-best-effort paths — the isSubscribed check below
      // is the authoritative gate. If additional rejection reasons are added to
      // createConnectionReadyPromise() in the future, re-evaluate whether
      // proceed-best-effort remains correct.
      try {
        await wsService.whenConnectionReady();
      } catch (err) {
        if (!connectionReadyWarnedRef.current) {
          connectionReadyWarnedRef.current = true;
          console.warn(
            `[useMessaging] connection_ready gate: ${(err as Error).message}; proceeding best-effort (further warnings suppressed for this connection)`
          );
        }
      }

      const isDM = msg.type === 'dm_message';
      const subscribed = isDM
        ? wsService.isDMSubscribed(msg.channelId)
        : wsService.isSubscribed(msg.channelId);
      if (!subscribed) {
        throw new Error(
          `Subscription not available for ${isDM ? 'DM' : 'channel'} ${msg.channelId}; retry later`
        );
      }
      // For DMs, encryption state is captured at enqueue time.
      // For channels, look up from the channel store (authoritative).
      const isEncrypted = isDM
        ? (msg.isEncrypted ?? false)
        : (useChannelStore.getState().channels.find((c) => c.id === msg.channelId)?.is_encrypted ??
          false);
      let content = msg.content;
      let keyVersion: number | undefined;
      if (isEncrypted) {
        const result = await encryptQueuedContent(
          msg.channelId,
          msg.content,
          msg.gifSlug,
          msg.id,
          isDM
        );
        content = result.ciphertext;
        keyVersion = result.keyVersion;
      }
      const opts: Record<string, unknown> = {
        nonce: msg.id,
        isEncrypted,
        keyVersion,
        mentionMeta: msg.mentionMeta,
        replyToId: msg.replyToId,
      };
      // For unencrypted channels, send gif_slug as a separate field (server stores it in the column)
      if (msg.gifSlug && !isEncrypted) {
        opts.gifSlug = msg.gifSlug;
      }
      if (isDM) {
        wsService.sendDMMessage(msg.channelId, content, opts);
      } else {
        wsService.sendMessage(msg.channelId, content, opts);
      }
    },
    [wsService]
  );

  // Start/stop queue processing based on connection state.
  // Also resets the connection_ready warn flag on each fresh CONNECTED handshake
  // so the next timeout cycle logs exactly once rather than staying permanently silent.
  useEffect(() => {
    const unsubscribe = wsService.onConnectionChange((state) => {
      if (state === ConnectionState.CONNECTED) {
        connectionReadyWarnedRef.current = false;
        messageQueue.startProcessing(processQueuedMessage);
      } else {
        messageQueue.stopProcessing();
      }
    });

    return () => {
      unsubscribe();
      messageQueue.stopProcessing();
    };
  }, [wsService, messageQueue, processQueuedMessage]);

  /**
   * Send a message with delivery tracking.
   * If the channel is E2EE, encrypts before sending (fail-closed: won't send if encryption fails).
   */
  const sendMessage = useCallback(
    (
      channelId: string,
      content: string,
      username: string = 'You',
      opts?: SendMessageOptions
    ): string => {
      const {
        avatarUrl,
        displayName,
        mentionMeta,
        replyToId,
        attachmentIds,
        attachments,
        gifSlug,
      } = opts ?? {};
      // Check if channel is encrypted
      const channel = useChannelStore.getState().channels.find((c) => c.id === channelId);
      const isEncrypted = channel?.is_encrypted ?? false;

      // Generate client-side message ID
      const clientMessageId = messageQueue.enqueue(
        channelId,
        content,
        'message',
        mentionMeta,
        replyToId
      );

      // Build replied_to summary from store for optimistic display
      // (prevents "Original message was deleted" flash before WS ack)
      let repliedTo: MessageWithStatus['replied_to'];
      if (replyToId) {
        const storeMessages = useChatStore.getState().messagesByChannel.get(channelId);
        const target = storeMessages?.find((m) => m.id === replyToId);
        if (target) {
          repliedTo = {
            id: target.id,
            user_id: target.user_id,
            username: target.username,
            display_name: target.display_name,
            content: target.content,
            is_encrypted: target.is_encrypted,
          };
        }
      }

      // Optimistically add message to UI with "pending" status
      // Always show plaintext locally for the sender
      const optimisticMessage: MessageWithStatus = {
        id: clientMessageId, // Temporary ID
        clientMessageId,
        channel_id: channelId,
        user_id: userId || 'unknown',
        username,
        display_name: displayName,
        avatar_url: avatarUrl,
        content,
        is_encrypted: isEncrypted,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'pending',
        reply_to_id: replyToId,
        replied_to: repliedTo,
        attachments,
        gif_slug: gifSlug,
      };

      addMessage(channelId, optimisticMessage);

      // If connected, send immediately (with encryption if needed)
      if (wsService.getState() === ConnectionState.CONNECTED) {
        const doSend = async () => {
          try {
            let sendContent = content;
            let keyVersion: number | undefined;
            // For E2EE: wrap content in JSON when gif_slug is present
            const plaintext = wrapContentWithGifSlug(content, gifSlug);
            if (isEncrypted) {
              // Fail-closed: if encryption fails, do NOT send
              sendContent = await e2eeService.encryptForChannel(channelId, plaintext);
              keyVersion = e2eeService.getCurrentKeyVersion(channelId);
              // Validate encrypted output: must be non-empty base64 with minimum size
              // (12-byte IV + 16-byte auth tag = 28 bytes minimum decoded)
              if (!sendContent || sendContent.length < 40) {
                throw new Error('Encryption produced invalid output');
              }
            }
            wsService.sendMessage(channelId, sendContent, {
              nonce: clientMessageId,
              isEncrypted,
              keyVersion,
              mentionMeta,
              replyToId,
              attachmentIds,
              gifSlug: isEncrypted ? undefined : gifSlug,
            });
            messageQueue.markAsSent(clientMessageId);
            messageQueue.remove(clientMessageId);
            updateMessageStatus(channelId, clientMessageId, 'sent');
          } catch (error) {
            console.error('[useMessaging] Failed to send message:', error);
            // Classify the error to surface code-specific UX copy (spec §6.5).
            // Falls back to generic "Unable to send message" for non-typed errors.
            const classification = classifyError(error);
            const errMsg = classification.uxMessage;
            if (classification.triggerRekey) {
              // REVOKED_EPOCH: invalidate the cached key so the next retry
              // attempt rotates to the successor epoch.
              e2eeService.invalidateChannelKey(channelId);
            }
            if (classification.retryable) {
              messageQueue.markAsFailed(clientMessageId, errMsg);
            } else {
              messageQueue.markAsTerminallyFailed(clientMessageId, errMsg);
            }
            updateMessageStatus(channelId, clientMessageId, 'failed', undefined, errMsg);
          }
        };
        doSend();
      } else {
        // Message stays in queue with "pending" status
        console.debug(`[useMessaging] Message queued (offline): ${clientMessageId}`);
      }

      return clientMessageId;
    },
    [wsService, messageQueue, addMessage, updateMessageStatus, userId]
  );

  /**
   * Send a DM message with delivery tracking.
   * Mirrors sendMessage but routes through DM WebSocket transport.
   * Fixes #492: includes keyVersion for epoch enforcement (was previously omitted).
   */
  const sendDMMessage = useCallback(
    (
      conversationId: string,
      content: string,
      isEncrypted: boolean,
      username: string = 'You',
      opts?: SendMessageOptions
    ): string => {
      const {
        avatarUrl,
        displayName,
        mentionMeta,
        replyToId,
        attachmentIds,
        attachments,
        gifSlug,
      } = opts ?? {};

      // Generate client-side message ID
      const clientMessageId = messageQueue.enqueue(
        conversationId,
        content,
        'dm_message',
        mentionMeta,
        replyToId,
        isEncrypted
      );

      // Build replied_to summary from store for optimistic display
      let repliedTo: MessageWithStatus['replied_to'];
      if (replyToId) {
        const storeMessages = useChatStore.getState().messagesByChannel.get(conversationId);
        const target = storeMessages?.find((m) => m.id === replyToId);
        if (target) {
          repliedTo = {
            id: target.id,
            user_id: target.user_id,
            username: target.username,
            display_name: target.display_name,
            content: target.content,
            is_encrypted: target.is_encrypted,
          };
        }
      }

      // Optimistically add message to UI with "pending" status
      const optimisticMessage: MessageWithStatus = {
        id: clientMessageId,
        clientMessageId,
        channel_id: conversationId,
        user_id: userId || 'unknown',
        username,
        display_name: displayName,
        avatar_url: avatarUrl,
        content,
        is_encrypted: isEncrypted,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'pending',
        reply_to_id: replyToId,
        replied_to: repliedTo,
        attachments,
        gif_slug: gifSlug,
      };

      addMessage(conversationId, optimisticMessage);

      // Capture previous lastMessage for rollback if send fails
      const prevLastMessage =
        useDMStore.getState().conversations.find((c) => c.id === conversationId)?.lastMessage ??
        null;

      // Optimistically bump conversation to top of DM list (#656)
      useDMStore.getState().bumpConversation(conversationId, {
        content,
        userId: userId || 'unknown',
        username,
        createdAt: optimisticMessage.created_at,
        isEncrypted,
        ...(opts?.attachments?.length
          ? { attachmentType: opts.attachments[0].file_type as string }
          : {}),
      });

      // If connected, send immediately (with encryption if needed)
      if (wsService.getState() === ConnectionState.CONNECTED) {
        const doSend = async () => {
          try {
            let sendContent = content;
            let keyVersion: number | undefined;
            const plaintext = wrapContentWithGifSlug(content, gifSlug);
            if (isEncrypted) {
              sendContent = await e2eeService.encryptForChannel(conversationId, plaintext);
              keyVersion = e2eeService.getCurrentKeyVersion(conversationId);
              if (!sendContent || sendContent.length < 40) {
                throw new Error('Encryption produced invalid output');
              }
            }
            wsService.sendDMMessage(conversationId, sendContent, {
              nonce: clientMessageId,
              isEncrypted,
              keyVersion,
              mentionMeta,
              attachmentIds,
              replyToId,
              gifSlug: isEncrypted ? undefined : gifSlug,
            });
            messageQueue.markAsSent(clientMessageId);
            messageQueue.remove(clientMessageId);
            updateMessageStatus(conversationId, clientMessageId, 'sent');
          } catch (error) {
            console.error('[useMessaging] Failed to send DM message:', error);
            const classification = classifyError(error);
            const errMsg = classification.uxMessage;
            if (classification.triggerRekey) {
              e2eeService.invalidateChannelKey(conversationId);
            }
            if (classification.retryable) {
              messageQueue.markAsFailed(clientMessageId, errMsg);
            } else {
              messageQueue.markAsTerminallyFailed(clientMessageId, errMsg);
            }
            updateMessageStatus(conversationId, clientMessageId, 'failed', undefined, errMsg);
            useDMStore.getState().bumpConversation(conversationId, prevLastMessage);
          }
        };
        doSend();
      } else {
        console.debug(`[useMessaging] DM message queued (offline): ${clientMessageId}`);
      }

      return clientMessageId;
    },
    [wsService, messageQueue, addMessage, updateMessageStatus, userId]
  );

  /**
   * Mark a message as delivered (called when server acknowledges)
   */
  const markDelivered = useCallback(
    (clientMessageId: string, serverMessageId: string, channelId: string) => {
      messageQueue.markAsDelivered(clientMessageId, serverMessageId);
      updateMessageStatus(channelId, clientMessageId, 'delivered', serverMessageId);
    },
    [messageQueue, updateMessageStatus]
  );

  /**
   * Send typing indicator
   */
  const sendTyping = useCallback(
    (channelId: string, isTyping: boolean) => {
      if (wsService.getState() === ConnectionState.CONNECTED) {
        wsService.sendTypingIndicator(channelId, isTyping);
      }
    },
    [wsService]
  );

  /**
   * Get pending message count
   */
  const getPendingCount = useCallback((): number => {
    return messageQueue.size();
  }, [messageQueue]);

  /**
   * Get pending messages for a specific channel
   */
  const getPendingMessagesForChannel = useCallback(
    (channelId: string): QueuedMessage[] => {
      return messageQueue.getMessagesForChannel(channelId);
    },
    [messageQueue]
  );

  return {
    sendMessage,
    sendDMMessage,
    markDelivered,
    sendTyping,
    getPendingCount,
    getPendingMessagesForChannel,
  };
}
