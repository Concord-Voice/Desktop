import type { MessageWithStatus } from '../../types/chat';

/**
 * Whether a row can be edited by its author: the same test `Message.tsx` applies before it
 * offers Edit (a delivered row — status absent or `'delivered'` — whose content is readable).
 */
function isEditable(message: MessageWithStatus): boolean {
  const delivered = !message.status || message.status === 'delivered';
  return delivered && !message.decryptFailed && !message.pendingKeys;
}

/**
 * The id of the current user's NEWEST message, if that message can be edited (#1959).
 *
 * "Newest" is the last row by this user whose `type` is `'user'` or absent — system rows
 * (expiration events, call events) carry the actor's `user_id` and are never offered for
 * editing. If that newest row is not editable — it is still `pending` right after a send, it
 * failed, or its content is unreadable — the answer is `null`, NOT the next older editable row.
 * Up Arrow means "edit what I just said"; skipping to an earlier message would silently open
 * the wrong one, so the shortcut stays a no-op until the newest row settles.
 *
 * `messages` is the store's order, oldest first. Only loaded rows are considered: a newest
 * message that pagination has not loaded yields `null`.
 */
export function latestEditableOwnMessage(
  messages: readonly MessageWithStatus[],
  currentUserId: string
): string | null {
  if (!currentUserId) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.user_id !== currentUserId) continue;
    if (message.type !== undefined && message.type !== 'user') continue;
    return isEditable(message) ? message.id : null;
  }
  return null;
}
