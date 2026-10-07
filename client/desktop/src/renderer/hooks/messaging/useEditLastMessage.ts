import { useCallback } from 'react';
import type { MessageWithStatus } from '../../types/chat';
import { useChatStore } from '../../stores/chat/chatStore';
import { latestEditableOwnMessage } from '../../utils/chat/latestEditableOwnMessage';

/**
 * The composer's Up Arrow handler (#1959): open the current user's newest message for
 * editing when that message can be edited. It resolves against the loaded `messages` at call
 * time and does nothing when the selector finds no editable newest message, so Up in an empty
 * composer never errors and never opens an older message than the one the user means. One
 * hook shared by the three composer owners (channel chat, DM chat, voice text chat).
 */
export function useEditLastMessage(
  messages: readonly MessageWithStatus[],
  currentUserId: string
): () => void {
  const setEditingMessageId = useChatStore((s) => s.setEditingMessageId);
  return useCallback(() => {
    const id = latestEditableOwnMessage(messages, currentUserId);
    if (id) setEditingMessageId(id);
  }, [messages, currentUserId, setEditingMessageId]);
}
