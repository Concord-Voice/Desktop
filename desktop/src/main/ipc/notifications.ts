/**
 * #86 C11: main-owned desktop notifications (IPC contract v36).
 *
 * Before this, a connection's renderer showed a web `Notification` and its click called
 * `app:focusWindow`, which RT6 made foreground-only: a click on a hidden connection's
 * notification navigated inside the hidden view and brought nothing forward.
 *
 * The invariant: only a click main observed, on a notification main showed for a
 * connection, may activate a connection, and it activates THAT connection, at the
 * document generation that asked. `notification:show` (connection-bound) creates the
 * notification and nothing else, so no renderer call activates a view or focuses the
 * window; `app:focusWindow` stays foreground-only. A click is dropped once the owner's
 * generation has advanced (its document is gone, or the connection is disposed), after
 * the notification was evicted, or on a second click.
 */
import { CHANNEL_CLASSES } from './channelClassification';
import { registerIpc } from './registry';
import type { ConnectionSender } from './connectionSender';
import { onGenerationAdvanced } from '../connectionRegistry';
import { bindOwner, isOwnerCurrent, type OwnerBinding } from '../connectionCapability';
import type { ConnectionId, ConnectionRef, ServiceId } from '../../shared/connectionIdentity';
import {
  NOTIFICATION_CLICKED,
  NOTIFICATION_SHOW,
  isNotificationShowPayload,
} from '../../shared/desktopNotification';

/** The slice of Electron's main-process `Notification` this module uses. */
export interface MainNotification {
  on(event: 'click', listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface NotificationIpcDeps {
  /** A main-process notification, or `null` where the platform cannot show one. */
  create(options: { title: string; body: string; silent: boolean }): MainNotification | null;
  /** Make the service's connection the foreground one (`shellWindow.activateConnection`). */
  activate(serviceId: ServiceId): boolean;
  /** Restore, show and focus the shell window. */
  reveal(): void;
  /** Push to the connection's view, only while `ref` is current (`sendToConnection`). */
  send(ref: ConnectionRef, channel: string, payload: unknown): boolean;
}

/**
 * Held per connection, oldest first. Electron's notification must stay referenced for its
 * click to arrive, and on Windows `close` also fires on a timeout that moves the toast to
 * Action Center, where it can still be clicked, so `close` does not release an entry. The
 * cap, a click, and a generation advance do.
 */
export const MAX_NOTIFICATIONS_PER_CONNECTION = 20;

interface Shown {
  readonly id: string;
  readonly owner: OwnerBinding;
  readonly serviceId: ServiceId;
  readonly notification: MainNotification;
}

const shown = new Map<ConnectionId, Shown[]>();

/** Remove `entry`; `false` when it was already released. */
function release(entry: Shown): boolean {
  const connectionId = entry.owner.ref.connectionId;
  const list = shown.get(connectionId);
  const index = list?.indexOf(entry) ?? -1;
  if (!list || index < 0) return false;
  list.splice(index, 1);
  if (list.length === 0) shown.delete(connectionId);
  return true;
}

function onClick(entry: Shown, deps: NotificationIpcDeps): void {
  if (!release(entry)) return;
  if (!isOwnerCurrent(entry.owner)) return;
  if (!deps.activate(entry.serviceId)) return;
  deps.reveal();
  deps.send(entry.owner.ref, NOTIFICATION_CLICKED, { id: entry.id });
}

function showFor(sender: ConnectionSender, payload: unknown, deps: NotificationIpcDeps): boolean {
  if (!isNotificationShowPayload(payload)) return false;
  // Sounds are the renderer's (notificationSoundService), as they were for web notifications.
  const notification = deps.create({ title: payload.title, body: payload.body, silent: true });
  if (!notification) return false;
  const entry: Shown = {
    id: payload.id,
    owner: bindOwner('notification', sender.ref),
    serviceId: sender.service.serviceId,
    notification,
  };
  const connectionId = sender.ref.connectionId;
  const list = shown.get(connectionId) ?? [];
  list.push(entry);
  shown.set(connectionId, list);
  while (list.length > MAX_NOTIFICATIONS_PER_CONNECTION) {
    list.shift()?.notification.close();
  }
  notification.on('click', () => onClick(entry, deps));
  notification.show();
  return true;
}

export function registerNotificationIpc(deps: NotificationIpcDeps): void {
  shown.clear();
  // Any advance makes every owner of that connection stale, so their clicks are already
  // refused; release them now. A disposed connection's notifications also leave the screen.
  onGenerationAdvanced((id, _from, _to, reason) => {
    const list = shown.get(id);
    if (!list) return;
    shown.delete(id);
    if (reason === 'disposed') for (const entry of list) entry.notification.close();
  });
  registerIpc(
    NOTIFICATION_SHOW,
    CHANNEL_CLASSES[NOTIFICATION_SHOW],
    (sender, _event, payload: unknown) => showFor(sender, payload, deps),
    { refusal: () => false }
  );
}
