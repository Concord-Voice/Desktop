import { useEffect, useState, useCallback, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import { apiFetch, safeJson } from '../services/apiClient';
import { e2eeService } from '../services/e2eeService';
import type { MessageWithStatus } from '../types/chat';
import { indexMessages } from '../services/searchService';

const DEFAULT_LIMIT = 50;

/** Index decrypted messages for search (passive, skips failed/pending). */
function indexDecryptedMessages(channelId: string, msgs: MessageWithStatus[]) {
  const indexable = msgs
    .filter((m) => !m.decryptFailed && !m.pendingKeys && m.content)
    .map((m) => ({ id: m.id, content: m.content, scope: channelId }));
  if (indexable.length > 0) indexMessages(indexable);
}

interface UseMessageFetchOptions {
  type: 'channel' | 'dm';
  limit?: number;
  onFetchComplete?: () => void;
}

/**
 * Decrypt a batch of messages, pre-fetching the channel key once to avoid
 * N concurrent getChannelKey() calls.
 */
async function decryptMessages(
  channelId: string,
  rawMsgs: MessageWithStatus[]
): Promise<MessageWithStatus[]> {
  const hasEncrypted = rawMsgs.some((m) => m.is_encrypted);
  if (!hasEncrypted) return rawMsgs;

  // Fail-closed: if E2EE isn't initialized, blank encrypted messages rather than
  // leaking ciphertext. Mark as pendingKeys so the UI shows the correct placeholder.
  if (!e2eeService.isInitialized) {
    return rawMsgs.map((m) => (m.is_encrypted ? { ...m, content: '', pendingKeys: true } : m));
  }

  // Pre-fetch channel key ONCE for batch decryption (current version)
  let channelKey: CryptoKey | null = null;
  try {
    channelKey = await e2eeService.getChannelKey(channelId);
  } catch {
    // Key not available yet — individual messages will show pending/failed state
  }

  // Pre-fetch each unique historical key version ONCE to avoid N parallel
  // getChannelKeyByVersion() calls (which lack pending-fetch deduplication).
  const versionedKeys = new Map<number, CryptoKey>();
  const uniqueVersions = new Set(
    rawMsgs
      .filter((m): m is MessageWithStatus & { key_version: number } =>
        Boolean(m.is_encrypted && m.key_version && m.key_version > 1)
      )
      .map((m) => m.key_version)
  );
  await Promise.all(
    [...uniqueVersions].map(async (version) => {
      try {
        const key = await e2eeService.getChannelKeyByVersion(channelId, version);
        versionedKeys.set(version, key);
      } catch {
        // Will be handled per-message in the decrypt loop below
      }
    })
  );

  return Promise.all(
    rawMsgs.map(async (m) => {
      if (!m.is_encrypted || !e2eeService.isInitialized) return m;
      try {
        let plaintext: string;
        if (m.key_version && m.key_version > 1) {
          const vKey = versionedKeys.get(m.key_version);
          plaintext = vKey
            ? await e2eeService.decryptWithKey(m.content, vKey)
            : await e2eeService.decryptForChannelWithVersion(channelId, m.content, m.key_version);
        } else {
          plaintext = channelKey
            ? await e2eeService.decryptWithKey(m.content, channelKey)
            : await e2eeService.decryptForChannel(channelId, m.content);
        }
        return { ...m, content: plaintext };
      } catch (err) {
        const isPending = err instanceof Error && err.message === 'PENDING_KEY';
        return { ...m, content: '', decryptFailed: !isPending, pendingKeys: isPending };
      }
    })
  );
}

function buildEndpoint(type: 'channel' | 'dm', channelId: string, limit: number, before?: string) {
  const base =
    type === 'dm'
      ? `/api/v1/dm/conversations/${channelId}/messages`
      : `/api/v1/channels/${channelId}/messages`;
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  return `${base}?${params}`;
}

export function useMessageFetch(channelId: string | null, options: UseMessageFetchOptions) {
  const { type, limit = DEFAULT_LIMIT, onFetchComplete } = options;

  // Subscribe only to the current channel's messages to avoid re-renders
  // when other channels receive messages.
  const messages: MessageWithStatus[] =
    useChatStore((s) => (channelId ? s.messagesByChannel.get(channelId) : undefined)) || [];
  const setMessages = useChatStore((s) => s.setMessages);
  const prependMessages = useChatStore((s) => s.prependMessages);

  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  // Keep onFetchComplete in a ref to avoid stale closures without
  // including it in effect dependencies (which would cause re-fetches).
  const onFetchCompleteRef = useRef(onFetchComplete);
  onFetchCompleteRef.current = onFetchComplete;

  // Track current channelId so in-flight pagination requests can detect
  // when the channel has changed and skip stale state updates.
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;

  // Listen for key delivery events to re-fetch and decrypt messages
  useEffect(() => {
    if (!channelId) return;
    const handler = (e: Event) => {
      const { channelId: deliveredId } = (e as CustomEvent).detail;
      if (deliveredId === channelId) {
        setFetchTrigger((prev) => prev + 1);
      }
    };
    globalThis.addEventListener('e2ee-key-delivered', handler);
    return () => globalThis.removeEventListener('e2ee-key-delivered', handler);
  }, [channelId]);

  // Retry key fetch when messages are stuck in pending state.
  // Only retry when E2EE is initialized — fail-closed also sets pendingKeys
  // but retrying without E2EE just wastes cycles.
  const hasPendingKeys = messages.some((m) => m.pendingKeys);
  useEffect(() => {
    if (!hasPendingKeys || !channelId || !e2eeService.isInitialized) return;

    const interval = setInterval(async () => {
      try {
        await e2eeService.getChannelKey(channelId);
        // Key is now available — re-fetch messages to decrypt using the cached key
        setFetchTrigger((prev) => prev + 1);
      } catch {
        // Still pending — will retry
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [channelId, hasPendingKeys]);

  // Fetch message history when channel changes or keys are delivered
  useEffect(() => {
    if (!channelId) return;

    let aborted = false;

    const fetchMessages = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await apiFetch(buildEndpoint(type, channelId, limit));
        if (aborted) return;

        if (!res.ok) {
          const data = await safeJson<{ error?: string }>(res);
          throw new Error(data.error || 'Failed to load messages');
        }

        const data = await safeJson<{ messages?: MessageWithStatus[] }>(res);
        if (aborted) return;
        const rawMsgs: MessageWithStatus[] = (data.messages || []).map((m: MessageWithStatus) => ({
          ...m,
          status: 'delivered' as const,
        }));

        const msgs = await decryptMessages(channelId, rawMsgs);
        if (aborted) return;

        // Passively index decrypted messages for search
        indexDecryptedMessages(channelId, msgs);

        // Merge with any optimistic messages the user sent while the fetch
        // was in flight (e.g. during React StrictMode double-mount or reconnect).
        const existing = useChatStore.getState().messagesByChannel.get(channelId) || [];
        const optimistic = existing.filter(
          (m) => m.clientMessageId && (m.status === 'pending' || m.status === 'sent')
        );
        const fetchedIds = new Set(msgs.map((m) => m.id));
        const kept = optimistic.filter(
          (m) => !fetchedIds.has(m.id) && !fetchedIds.has(m.clientMessageId ?? '')
        );
        // Server returns DESC (newest first); reverse to ASC for chronological display
        msgs.reverse();
        setMessages(channelId, kept.length > 0 ? [...msgs, ...kept] : msgs);
        setHasMore(msgs.length === limit);
        onFetchCompleteRef.current?.();
      } catch (err) {
        if (!aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load messages');
        }
      } finally {
        if (!aborted) {
          setIsLoading(false);
        }
      }
    };

    fetchMessages();

    return () => {
      aborted = true;
    };
  }, [channelId, setMessages, fetchTrigger, type, limit]);

  // Load older messages (pagination)
  const handleLoadMore = useCallback(async () => {
    if (!channelId || isLoading || !hasMore) return;

    const requestChannelId = channelId;
    const channelMessages = useChatStore.getState().messagesByChannel.get(requestChannelId);
    if (!channelMessages || channelMessages.length === 0) return;

    const oldestMessage = channelMessages[0];

    setIsLoading(true);
    try {
      const res = await apiFetch(buildEndpoint(type, requestChannelId, limit, oldestMessage.id));

      // Channel changed while request was in flight — discard results
      if (channelIdRef.current !== requestChannelId) return;

      if (!res.ok) {
        const data = await safeJson<{ error?: string }>(res);
        throw new Error(data.error || 'Failed to load more messages');
      }

      const data = await safeJson<{ messages?: MessageWithStatus[] }>(res);
      const rawMsgs: MessageWithStatus[] = (data.messages || []).map((m: MessageWithStatus) => ({
        ...m,
        status: 'delivered' as const,
      }));

      const msgs = await decryptMessages(requestChannelId, rawMsgs);

      if (channelIdRef.current !== requestChannelId) return;

      // Server returns DESC; reverse to ASC so oldest-first prepends correctly
      msgs.reverse();
      prependMessages(requestChannelId, msgs);
      setHasMore(msgs.length === limit);
    } catch (err) {
      if (channelIdRef.current === requestChannelId) {
        setError(err instanceof Error ? err.message : 'Failed to load more messages');
      }
    } finally {
      if (channelIdRef.current === requestChannelId) {
        setIsLoading(false);
      }
    }
  }, [channelId, isLoading, hasMore, prependMessages, type, limit]);

  return { messages, isLoading, hasMore, error, handleLoadMore };
}
