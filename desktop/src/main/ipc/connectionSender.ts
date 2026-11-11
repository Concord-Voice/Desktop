// Connection-sender admission (spec 2026-11-09-86-connection-context-isolation
// §3.7, §4; Mode-2 D2/D3).
//
// The only path from an IPC event to a connection's custody. A sender is admitted
// when ALL of these hold, checked synchronously before any `await`:
//   - `event.senderFrame` (read once) is its webContents' current main frame:
//     no parent, not detached, and the `mainFrame`'s own `frameTreeNodeId`;
//   - `event.sender` is bound in the registry, and the binding agrees with the
//     record's own membership (primary = record.webContents, PiP ∈ record.pips);
//   - the binding's role is one the caller allows;
//   - the frame URL is permitted for the connection's KIND — a CVNet document
//     (remote SPA or its spa-cache copy) inside a self-hosted view admits nothing.
// The connection, its service and its custody come from that binding alone. A
// renderer-supplied `apiBase` is never an input to the choice; at most it is
// cross-checked against it (`crossCheckApiBase`).

import type { IpcMainEvent, IpcMainInvokeEvent, WebFrameMain } from 'electron';
import { SAAS_SERVICE_ID, type ConnectionRef } from '../../shared/connectionIdentity';
import {
  boundRecordFor,
  foreground,
  getService,
  refOf,
  type BindingRole,
  type ConnectionRecord,
  type ProfileCustody,
  type ServiceRecord,
} from '../connectionRegistry';
import { isPermittedFrameUrlForKind, senderMainFrame } from './frameValidation';

/** Refusal vocabulary for #86 T7 handlers that report why they declined. */
export type SenderRefusal =
  'untrusted-sender' | 'not-foreground' | 'wrong-owner' | 'not-saas' | 'not-primary';

export interface ConnectionSender {
  readonly record: ConnectionRecord;
  readonly service: ServiceRecord;
  readonly custody: ProfileCustody;
  readonly ref: ConnectionRef;
  readonly frame: WebFrameMain;
  readonly role: BindingRole;
}

const ANY_ROLE: readonly BindingRole[] = ['primary', 'pip'];
const PRIMARY_ONLY: readonly BindingRole[] = ['primary'];

/** The frame's URL, or null when reading it throws (a disposed frame). */
function frameUrl(frame: WebFrameMain): string | null {
  try {
    return frame.url;
  } catch {
    return null;
  }
}

/**
 * The admitted connection sender, or null. `roles` defaults to both; an empty
 * list admits nothing. `remoteSpaOrigin` matters only for `saas` and defaults to
 * null, so the remote SPA is admitted only when the caller supplies its origin.
 */
export function requireConnectionSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  opts?: { roles?: readonly BindingRole[] },
  remoteSpaOrigin?: string | null
): ConnectionSender | null {
  const frame = senderMainFrame(event);
  if (frame === null) return null;
  const bound = boundRecordFor(event.sender);
  if (!bound) return null;
  const roles = opts?.roles ?? ANY_ROLE;
  if (!roles.includes(bound.role)) return null;
  const service = getService(bound.record.serviceId);
  if (!service) return null;
  const url = frameUrl(frame);
  if (url === null || !isPermittedFrameUrlForKind(url, service.kind, remoteSpaOrigin ?? null)) {
    return null;
  }
  return Object.freeze({
    record: bound.record,
    service,
    custody: service.custody,
    ref: refOf(bound.record),
    frame,
    role: bound.role,
  });
}

/** A primary main frame of the FOREGROUND connection (app-global-mutate), or null. */
export function requireForegroundPrimary(
  event: IpcMainEvent | IpcMainInvokeEvent,
  remoteSpaOrigin?: string | null
): ConnectionSender | null {
  const sender = requireConnectionSender(event, { roles: PRIMARY_ONLY }, remoteSpaOrigin);
  if (!sender) return null;
  return foreground() === sender.record ? sender : null;
}

/** A primary main frame of the `saas` connection (deep links, `spaState`), or null. */
export function requireSaasPrimary(
  event: IpcMainEvent | IpcMainInvokeEvent,
  remoteSpaOrigin?: string | null
): ConnectionSender | null {
  const sender = requireConnectionSender(event, { roles: PRIMARY_ONLY }, remoteSpaOrigin);
  if (!sender) return null;
  const { service } = sender;
  return service.kind === 'saas' && service.serviceId === SAAS_SERVICE_ID ? sender : null;
}

/**
 * D3: a renderer-supplied `apiBase` is a cross-check, never a selector. `undefined`
 * (not supplied) passes; anything else must canonicalise to the sender's own
 * service origin. Non-strings, unparseable values and opaque origins fail.
 */
export function crossCheckApiBase(sender: ConnectionSender, supplied: unknown): boolean {
  if (supplied === undefined) return true;
  if (typeof supplied !== 'string') return false;
  let origin: string;
  try {
    origin = new URL(supplied).origin;
  } catch {
    return false;
  }
  return origin === sender.service.origin;
}
