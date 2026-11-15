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
//     The URL is the frame's COMMITTED URL. Only a caller that opts in
//     (`admitUncommitted`, connection:whoAmI alone) may check a frame with no
//     committed URL yet against the main-frame navigation main saw start in that
//     same frame instead (D1, `trackMainFrameNavigation`).
// The connection, its service and its custody come from that binding alone. A
// renderer-supplied `apiBase` is never an input to the choice; at most it is
// cross-checked against it (`crossCheckApiBase`).

import type { IpcMainEvent, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { SAAS_SERVICE_ID, type ConnectionRef } from '../../shared/connectionIdentity';
import {
  boundRecordFor,
  foreground,
  getService,
  pipSpaOriginFor,
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

/** A main-frame navigation main saw start (or redirect), and the frame it runs in. */
interface InFlightNavigation {
  readonly url: string;
  readonly processId: number;
  readonly routingId: number;
}

const inFlightNavigations = new WeakMap<WebContents, InFlightNavigation>();

interface NavigationDetails {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly isSameDocument: boolean;
  readonly frame: WebFrameMain | null;
}

/**
 * D1 (measured in the Electron e2e run). A view whose first `loadURL` is issued in the
 * tick that creates it evaluates its preload, and so sends `connection:whoAmI`, BEFORE
 * its renderer reports the document's commit: the browser records the commit only after
 * the sendSync is answered, so the sender main frame still reports url ''. Waiting for
 * the commit deadlocks; refusing on '' booted every restored self-hosted view with no
 * connection. So every bound view records, before its first load, the latest
 * cross-document main-frame navigation main saw start or redirect, with the frame
 * (process + routing id) it runs in. Install it before the view's first `loadURL`.
 */
export function trackMainFrameNavigation(contents: WebContents): void {
  const note = (details: NavigationDetails): void => {
    if (!details.isMainFrame || details.isSameDocument) return;
    inFlightNavigations.delete(contents);
    try {
      const frame = details.frame;
      if (frame) {
        inFlightNavigations.set(contents, {
          url: details.url,
          processId: frame.processId,
          routingId: frame.routingId,
        });
      }
    } catch {
      // A disposed frame: nothing is recorded, so an uncommitted sender is refused.
    }
  };
  contents.on('did-start-navigation', note);
  contents.on('did-redirect-navigation', note);
}

/**
 * The URL `frame` is being navigated to, when it has no committed URL yet and the
 * navigation main last saw start in that webContents' main frame runs in this same
 * frame; else null. A navigation that moved to another process or frame (a
 * cross-process swap) names a different frame and admits nothing.
 */
function uncommittedFrameUrl(contents: WebContents, frame: WebFrameMain): string | null {
  const nav = inFlightNavigations.get(contents);
  if (!nav) return null;
  try {
    return frame.processId === nav.processId && frame.routingId === nav.routingId ? nav.url : null;
  } catch {
    return null;
  }
}

/**
 * The remote-SPA origin a sender's frame URL is checked against. A caller that
 * supplies none (`undefined`) or a current origin of `null` admits no remote SPA
 * for anyone. Otherwise a primary is checked against the CURRENT origin, and a PiP
 * against it only while it EQUALS the origin main loaded that PiP from (pinned at
 * bind). Both must hold: the pin keeps a PiP opened before an SPA origin change
 * from being admitted under a new origin it was never loaded from, and the
 * current origin revokes a PiP once the remote SPA is turned off or moves. An
 * unpinned or mismatched PiP gets null (fail closed); the packaged `app://` and
 * dev documents are still admitted with null by `isPermittedFrameUrlForKind`.
 */
function spaOriginForSender(
  wc: IpcMainEvent['sender'],
  role: BindingRole,
  remoteSpaOrigin: string | null = null
): string | null {
  if (remoteSpaOrigin === null || role !== 'pip') return remoteSpaOrigin;
  return pipSpaOriginFor(wc) === remoteSpaOrigin ? remoteSpaOrigin : null;
}

/**
 * The admitted connection sender, or null. `roles` defaults to both; an empty
 * list admits nothing. `remoteSpaOrigin` matters only for `saas` and defaults to
 * null, so the remote SPA is admitted only when the caller supplies its origin;
 * a PiP only while its pinned origin is that current one (`spaOriginForSender`).
 * `admitUncommitted` (connection:whoAmI only, D1): a main frame with NO committed
 * URL is checked against its in-flight navigation's URL (`uncommittedFrameUrl`)
 * under the same kind allowlist; without it, or with nothing in flight, it is refused.
 */
export function requireConnectionSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  opts?: { roles?: readonly BindingRole[]; admitUncommitted?: boolean },
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
  const committed = frameUrl(frame);
  const url =
    committed === '' && opts?.admitUncommitted === true
      ? uncommittedFrameUrl(event.sender, frame)
      : committed;
  const spa = spaOriginForSender(event.sender, bound.role, remoteSpaOrigin);
  if (url === null || !isPermittedFrameUrlForKind(url, service.kind, spa)) {
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
