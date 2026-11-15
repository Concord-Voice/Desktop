/**
 * #86 C11: main-owned desktop notifications (IPC contract v36).
 *
 * A connection's renderer asks main to show a notification (`notification:show`, an
 * invoke, `connection-bound`). Main shows it with Electron's main-process
 * `Notification`, keeps the sender's ConnectionRef, and on the OS click activates that
 * connection, restores the window and pushes `notification:clicked` to the owner's view.
 * The id is renderer-chosen and opaque to main: the renderer maps it to its own
 * navigation target, so no navigation data passes through main.
 *
 * Shared by main (validation before use) and the preload (validation before the
 * renderer sees a push).
 */
export const NOTIFICATION_SHOW = 'notification:show';
export const NOTIFICATION_CLICKED = 'notification:clicked';

export const NOTIFICATION_TITLE_MAX = 256;
export const NOTIFICATION_BODY_MAX = 1024;
const NOTIFICATION_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface NotificationShowPayload {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface NotificationClicked {
  readonly id: string;
}

/** A plain object whose own keys are exactly `keys`, each a data property. */
function hasExactDataKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

export function isNotificationId(value: unknown): value is string {
  return typeof value === 'string' && NOTIFICATION_ID.test(value);
}

export function isNotificationShowPayload(value: unknown): value is NotificationShowPayload {
  if (!hasExactDataKeys(value, ['id', 'title', 'body'])) return false;
  return (
    isNotificationId(value.id) &&
    typeof value.title === 'string' &&
    value.title.length <= NOTIFICATION_TITLE_MAX &&
    typeof value.body === 'string' &&
    value.body.length <= NOTIFICATION_BODY_MAX
  );
}

export function isNotificationClicked(value: unknown): value is NotificationClicked {
  return hasExactDataKeys(value, ['id']) && isNotificationId(value.id);
}
