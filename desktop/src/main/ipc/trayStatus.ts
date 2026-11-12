/**
 * The `tray:setStatus` invoke (tray-status spec §4, IPC contract 33), per connection since
 * #87 (RC-2, R15).
 *
 * Fences, in this order; nothing here throws. The result is `false` only when the
 * rate limit dropped the snapshot (the renderer resends it); every other outcome,
 * refusals included, is `true`:
 *   1. The registry's `connection-bound` admission: a bound PRIMARY main frame whose URL
 *      is permitted for its connection's kind (a PiP shares the origin and is refused).
 *   2. A 20/s token bucket PER CONNECTION, so one view cannot starve another's updates.
 *   3. `firstInvalidField` — the exact-key, closed-enum guard. A malformed payload is
 *      logged once per session with the field NAME only (a fixed-table token, never a
 *      value or a caller-chosen key).
 * Then the snapshot is STORED for the sender's connection, and APPLIED only when that
 * connection is the displayed one.
 *
 * THE INVARIANT. The tray shows exactly `displayedSnapshot()`: the tray owner's stored
 * snapshot while its binding is current, NEUTRAL while it is stale (no fallback, as #86),
 * else the foreground connection's stored snapshot, else neutral. Every event that can
 * change the displayed connection or its stored snapshot re-applies: the displayed
 * sender's update, `setTrayOwner`, a foreground change while no owner is set, and a drop of
 * the displayed connection's snapshot (a document-replacing generation advance, a reset
 * hook, `dropTraySnapshot`). What breaks it: applying a non-displayed sender's snapshot,
 * falling back from a stale owner to the foreground, or a reset in one connection
 * blanking another connection's tray.
 *
 * `attachTrayResetHooks` covers R17: when a view's renderer reloads, crashes or hangs, its
 * connection's snapshot is forgotten and, if it is displayed, the tray drops back to the
 * neutral icon and the Open/Quit menu rather than keeping live voice controls for a
 * session that may no longer exist. A hang is the one reset that can end with the same
 * session alive, so `responsive` re-applies the stored snapshot: the renderer only sends
 * on change and would otherwise leave the tray neutral until some field moved.
 */
import type { IpcMainInvokeEvent, WebContents } from 'electron';

import {
  firstInvalidField,
  TRAY_SET_STATUS,
  type TrayStatusSnapshot,
} from '../../shared/trayStatus';
import type { ConnectionId, ConnectionRef } from '../../shared/connectionIdentity';
import { applyTraySnapshot } from '../tray';
import {
  bindingFor,
  foreground,
  onForegroundChanged,
  onGenerationAdvanced,
  refOf,
} from '../connectionRegistry';
import {
  bindOwner,
  isOwnerCurrent,
  requireOwner,
  type OwnerBinding,
} from '../connectionCapability';

import { CHANNEL_CLASSES } from './channelClassification';
import type { ConnectionSender } from './connectionSender';
import { registerIpc } from './registry';

const TRAY_STATUS_RATE_PER_SEC = 20;

/**
 * The last validated snapshot each connection's live primary sent (#87 RC-2). Dropped when
 * that connection's document is replaced, its renderer is lost or it is disposed, and by
 * its own view's reset hooks; a credential advance keeps it (RC-14: the same document
 * keeps running). Never handed out by reference.
 */
const snapshots = new Map<ConnectionId, TrayStatusSnapshot>();

/**
 * Continuous-refill token bucket: capacity `ratePerSec`, starts full, refills at
 * `ratePerSec` tokens per second. A clock that goes backwards mints nothing.
 */
export function createTokenBucket(ratePerSec: number, now: () => number): () => boolean {
  let tokens = ratePerSec;
  let last = now();
  return () => {
    const t = now();
    const elapsed = Math.max(0, t - last);
    last = Math.max(last, t);
    tokens = Math.min(ratePerSec, tokens + (elapsed * ratePerSec) / 1000);
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * The tray's owner (#86 Task 7B, spec §3.7). `null` means the foreground primary; a
 * ref names the one connection #87's capture lease redirects the tray to. Held as an
 * `OwnerBinding`, so a ref whose connection has since advanced its generation (a new
 * document, renderer loss, a credential change, dispose) shows a NEUTRAL tray and routes
 * no tray action until main names a new owner or clears it: a stale owner fails closed
 * rather than falling back.
 */
let trayOwnerBinding: OwnerBinding | null = null;

/** The connection the tray currently belongs to, or null for "the foreground primary". */
export function trayOwner(): ConnectionRef | null {
  return trayOwnerBinding?.ref ?? null;
}

/**
 * The connection whose state the tray displays: the owner's (current or stale), else the
 * foreground's, else none. A stale owner is still the displayed connection; what it shows
 * is neutral (`displayedSnapshot`).
 */
export function displayedTrayConnection(): ConnectionId | null {
  return trayOwnerBinding?.ref.connectionId ?? foreground()?.connectionId ?? null;
}

function displayedSnapshot(): TrayStatusSnapshot | null {
  const owner = trayOwnerBinding;
  if (owner !== null) {
    return isOwnerCurrent(owner) ? (snapshots.get(owner.ref.connectionId) ?? null) : null;
  }
  const fg = foreground();
  return fg === null ? null : (snapshots.get(fg.connectionId) ?? null);
}

/** Apply a copy, or neutral. A tray failure never reaches the lease or the registry. */
function show(snapshot: TrayStatusSnapshot | null): void {
  try {
    applyTraySnapshot(snapshot === null ? null : { ...snapshot });
  } catch {
    // Contract: a tray update can never fail its caller.
  }
}

/**
 * The connection a `tray:action` is routed to (#87 RC-2; main.ts calls it): the displayed
 * connection while it can be named exactly, so an action always reaches the connection
 * whose controls the tray shows. A stale owner routes nothing (fail closed).
 */
export function trayActionTarget(): ConnectionRef | null {
  const owner = trayOwnerBinding;
  if (owner !== null) return isOwnerCurrent(owner) ? owner.ref : null;
  const fg = foreground();
  return fg === null ? null : refOf(fg);
}

/**
 * Main-only (#87 redirects to the lease holder). Throws on a malformed ref, before any
 * change. Re-applies the newly displayed snapshot at once: `null` shows the foreground's
 * stored snapshot, so a freed lease never leaves the former holder's controls up.
 */
export function setTrayOwner(ref: ConnectionRef | null): void {
  const previous = trayOwnerBinding;
  trayOwnerBinding = ref === null ? null : bindOwner('tray', ref);
  if (previous === null && ref === null) return;
  show(displayedSnapshot());
}

/** A copy of `id`'s stored snapshot, or null. */
export function traySnapshotFor(id: ConnectionId): TrayStatusSnapshot | null {
  const stored = snapshots.get(id);
  return stored === undefined ? null : { ...stored };
}

/** How many connections have a stored snapshot (resource accounting, #87). */
export function traySnapshotCount(): number {
  return snapshots.size;
}

/** Forget `id`'s snapshot; the tray goes neutral only if `id` is the displayed connection. */
export function dropTraySnapshot(id: ConnectionId): void {
  if (!snapshots.delete(id)) return;
  if (displayedTrayConnection() === id) show(displayedSnapshot());
}

/**
 * FENCE (#86 Task 7B, narrowed to "apply" by #87). The registry already admitted a bound
 * PRIMARY main frame of the sender's connection. This decides whether its snapshot is the
 * displayed one: the named owner's current primary when one is set (`requireOwner` reads
 * the frame and the generation, so a stale owner admits nobody), else the foreground
 * connection's primary. What breaks it: deciding on the payload, on a renderer-held id, or
 * on window identity instead of the binding.
 */
function isDisplayedSender(sender: ConnectionSender, event: IpcMainInvokeEvent): boolean {
  const owner = trayOwnerBinding;
  if (owner !== null) return requireOwner(event, owner) === sender.record;
  return foreground() === sender.record;
}

/**
 * `tray:setStatus` (#86 Task 7B: `registerIpc`, `connection-bound`; #87 RC-2: stored per
 * connection, applied when displayed). Every refusal still resolves `true` (the contract:
 * a tray update never fails the renderer's invoke); only a rate-limit drop resolves
 * `false`. Registered once per process; a registration starts with no stored snapshot.
 */
export function registerTrayStatusIpc(): void {
  snapshots.clear();
  const buckets = new Map<ConnectionId, () => boolean>();
  const allowFor = (id: ConnectionId): boolean => {
    let allow = buckets.get(id);
    if (allow === undefined) {
      allow = createTokenBucket(TRAY_STATUS_RATE_PER_SEC, () => Date.now());
      buckets.set(id, allow);
    }
    return allow();
  };
  let loggedMalformed = false;
  registerIpc(
    TRAY_SET_STATUS,
    CHANNEL_CLASSES[TRAY_SET_STATUS],
    (sender: ConnectionSender, event: IpcMainInvokeEvent, payload: unknown): boolean => {
      try {
        if (sender.role !== 'primary') return true;
        const id = sender.ref.connectionId;
        if (!allowFor(id)) return false;
        const invalid = firstInvalidField(payload);
        if (invalid !== null) {
          if (!loggedMalformed) {
            loggedMalformed = true;
            console.warn(`tray:setStatus dropped a malformed snapshot (field ${invalid})`);
          }
          return true;
        }
        const snapshot: TrayStatusSnapshot = { ...(payload as TrayStatusSnapshot) };
        snapshots.set(id, snapshot);
        if (isDisplayedSender(sender, event)) applyTraySnapshot({ ...snapshot });
      } catch {
        // Contract: a tray update can never fail the renderer's invoke.
      }
      return true;
    },
    { refusal: () => true }
  );
  // RC-14: only a document-replacing reason ends what the snapshot describes. A credential
  // advance re-keys the same running document (the lease re-points the owner through
  // `setTrayOwner`), so its snapshot stays. No default branch: a new reason must be
  // classified here explicitly.
  onGenerationAdvanced((id, _from, _to, reason) => {
    switch (reason) {
      case 'document':
      case 'renderer-gone':
      case 'disposed':
        buckets.delete(id);
        dropTraySnapshot(id);
        return;
      case 'credential-start':
      case 'credential-end':
        return;
    }
  });
  // With no owner the foreground IS the displayed connection, so a foreground change shows
  // the new foreground's stored snapshot (or neutral) instead of leaving the old one's.
  onForegroundChanged(() => {
    if (trayOwnerBinding === null) show(displayedSnapshot());
  });
}

/** The minimal `webContents` surface the reset hooks need. */
interface ResettableContents {
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/** The connection `contents` is bound to, or null. `bindingFor` is an identity lookup only. */
function connectionOf(contents: ResettableContents): ConnectionId | null {
  return bindingFor(contents as unknown as WebContents)?.connectionId ?? null;
}

/**
 * Reset the tray when a view's renderer reloads, crashes, hangs or goes away (R17).
 *
 * #87 RC-2: the view's connection is captured HERE, when the hooks are attached (the view
 * is bound first), so each hook acts on its own connection only: it forgets that
 * connection's snapshot, and blanks or restores the tray only while that connection is
 * the displayed one. Another view's reload never touches the displayed tray. A contents
 * that is not bound keeps the pre-#87 whole-tray reset.
 */
export function attachTrayResetHooks(contents: ResettableContents): void {
  const own = connectionOf(contents);
  const mine = (): boolean => own === null || displayedTrayConnection() === own;
  const reset = (): void => {
    if (own !== null) {
      dropTraySnapshot(own);
      return;
    }
    snapshots.clear();
    show(null);
  };
  // `did-navigate`, not `did-start-navigation`: the latter fires before main.ts's
  // `will-navigate` gate, so a navigation that gate cancels would clear the tray of a
  // session that is still alive. `did-navigate` fires only when a main-frame,
  // cross-document navigation commits (same pattern as audiocapHost.ts).
  contents.on('did-navigate', reset);
  // A failed main-frame load commits an error page without `did-navigate`; ERR_ABORTED
  // (-3) is a cancelled navigation that leaves the document in place.
  contents.on(
    'did-fail-load',
    (
      _event: unknown,
      errorCode: number,
      _description: string,
      _url: string,
      isMainFrame: boolean
    ) => {
      if (isMainFrame && errorCode !== -3) reset();
    }
  );
  contents.on('render-process-gone', reset);
  contents.on('unresponsive', () => {
    if (mine()) show(null);
  });
  contents.on('responsive', () => {
    if (!mine()) return;
    const displayed = displayedSnapshot();
    if (displayed !== null) show(displayed);
  });
  contents.on('destroyed', reset);
}
