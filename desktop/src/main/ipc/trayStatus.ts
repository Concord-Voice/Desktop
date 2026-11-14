/**
 * The `tray:setStatus` invoke (tray-status spec §4, IPC contract 33), and which
 * connection the shared tray shows (#86).
 *
 * Fences, in this order; nothing here throws. The result is `false` only when the
 * rate limit dropped the snapshot (the renderer resends it); every other outcome,
 * refusals included, is `true`:
 *   1. Admission (since IPC contract v34, #86): `registerIpc` as `connection-bound`
 *      admits a bound PRIMARY main frame whose URL is permitted for its connection's
 *      kind (a PiP shares the origin and is refused there).
 *   2. A 20/s token bucket per connection, so one connection cannot spend another's.
 *   3. `firstInvalidField` — the exact-key, closed-enum guard. A malformed payload is
 *      logged once per session with the field NAME only (a fixed-table token, never a
 *      value or a caller-chosen key).
 * The snapshot is then kept as its own connection's latest, and the tray renders it
 * (through `applyTraySnapshot`, which stores it while the tray is inactive) only while
 * that connection is the tray's SOURCE (R5): the bound owner, at the generation
 * `setTrayOwner` named, when one is set, else the foreground connection.
 *
 * INVARIANT (#86 B1, B2). The tray shows the source's kept snapshot, or neutral when
 * the source has none, is hung, or is a stale owner; and a `tray:action` reaches only
 * the connection the tray shows (`trayActionTarget`). `refreshTray` recomputes it after
 * every input changes: an accepted snapshot, a reset hook, `setTrayOwner`, and the
 * foreground changes and generation advances the registry announces. A background
 * connection's snapshot is kept, not refused, because its renderer sends only on
 * change: refused, it is never resent, so a switch to that connection would leave the
 * previous connection's voice controls on the tray while its actions went elsewhere.
 * What breaks the invariant: an input changing without `refreshTray`, a render keyed
 * on anything but the source, or a reset hook clearing another connection's snapshot.
 *
 * `attachTrayResetHooks` covers R17 for one connection: when its renderer reloads,
 * crashes or is destroyed, its snapshot is forgotten, so the tray drops back to the
 * neutral icon and the Open/Quit menu if it was showing that connection, rather than
 * keeping live voice controls for a session that may no longer exist. Another
 * connection's tray is left alone. A hang is the one reset that can end with the same
 * session alive, so it only hides the snapshot until `responsive`: the renderer sends
 * only on change and would otherwise leave the tray neutral until some field moved.
 */
import type { IpcMainInvokeEvent, WebContents } from 'electron';

import {
  firstInvalidField,
  TRAY_SET_STATUS,
  type TrayStatusSnapshot,
} from '../../shared/trayStatus';
import type {
  ConnectionId,
  ConnectionRef,
  Generation,
  GenerationReason,
} from '../../shared/connectionIdentity';
import { applyTraySnapshot } from '../tray';
import {
  foreground,
  onForegroundChanged,
  onGenerationAdvanced,
  recordFor,
} from '../connectionRegistry';
import { bindOwner, isOwnerCurrent, type OwnerBinding } from '../connectionCapability';

import { CHANNEL_CLASSES } from './channelClassification';
import type { ConnectionSender } from './connectionSender';
import { registerIpc } from './registry';

const TRAY_STATUS_RATE_PER_SEC = 20;

interface KeptSnapshot {
  readonly snapshot: TrayStatusSnapshot;
  /** The sender's generation when it was accepted: an owner shows only its own. */
  readonly generation: Generation;
}

/** Each live connection's last accepted snapshot; dropped on a reload, crash or dispose. */
const kept = new Map<ConnectionId, KeptSnapshot>();
/** Connections whose renderer is unresponsive: their snapshot is hidden, not forgotten. */
const hung = new Set<ConnectionId>();
const buckets = new Map<ConnectionId, () => boolean>();
/** What the tray was last given, and whose it is; null while it is neutral. */
let displayed: {
  readonly connectionId: ConnectionId;
  readonly snapshot: TrayStatusSnapshot;
} | null = null;
let unsubscribers: Array<() => void> = [];

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
 * document, renderer loss, a credential change, dispose) shows NOBODY until main
 * names a new owner or clears it: a stale owner fails closed rather than falling back.
 */
let trayOwnerBinding: OwnerBinding | null = null;

/** The connection the tray currently belongs to, or null for "the foreground primary". */
export function trayOwner(): ConnectionRef | null {
  return trayOwnerBinding?.ref ?? null;
}

/** Main-only (#87 redirects to the lease holder). Throws on a malformed ref. */
export function setTrayOwner(ref: ConnectionRef | null): void {
  trayOwnerBinding = ref === null ? null : bindOwner('tray', ref);
  refreshTray();
}

/**
 * The source's snapshot, or null for neutral. The source is the owner while one is
 * named (nobody once it is stale, and only a snapshot its primary sent at the named
 * generation), else the foreground connection.
 */
function sourceSnapshot(): { connectionId: ConnectionId; snapshot: TrayStatusSnapshot } | null {
  const owner = trayOwnerBinding;
  let connectionId: ConnectionId;
  if (owner === null) {
    const fg = foreground();
    if (fg === null) return null;
    connectionId = fg.connectionId;
  } else {
    if (!isOwnerCurrent(owner)) return null;
    connectionId = owner.ref.connectionId;
  }
  const entry = kept.get(connectionId);
  if (!entry || hung.has(connectionId)) return null;
  if (owner !== null && entry.generation !== owner.ref.generation) return null;
  return { connectionId, snapshot: entry.snapshot };
}

/** Re-render when the source's snapshot changed; a no-op otherwise (see the INVARIANT). */
function refreshTray(): void {
  const next = sourceSnapshot();
  if ((next?.snapshot ?? null) === (displayed?.snapshot ?? null)) return;
  displayed = next;
  try {
    applyTraySnapshot(next === null ? null : { ...next.snapshot });
  } catch {
    // Contract: a tray render never fails its caller (an IPC reply, a registry listener).
  }
}

function forget(connectionId: ConnectionId): void {
  kept.delete(connectionId);
  hung.delete(connectionId);
}

function onGeneration(
  connectionId: ConnectionId,
  _from: Generation,
  to: Generation,
  reason: GenerationReason
): void {
  // A lost renderer ends the session the snapshot described, so it goes now rather than
  // waiting for the matching webContents hook (#87 RC-2).
  if (reason === 'disposed' || reason === 'renderer-gone') forget(connectionId);
  // `document` advances at a navigation's START, which main may still cancel, leaving the
  // same document and call alive (#86 shellWindow). The snapshot therefore survives under
  // the new generation; the commit or real load failure forgets it through
  // `attachTrayResetHooks`, which runs before the generation hooks on the same event.
  // Forgetting here left the tray neutral after a cancelled navigation, because the
  // renderer sends only on change and never resent the unchanged snapshot (Codex P2).
  // A credential advance re-keys the SAME running document (#87 RC-14): its call and snapshot
  // go on, and the renderer sends only on change, so the snapshot moves to the new generation
  // or the tray owner (re-keyed by the capture lease) would reject it and show neutral.
  if (reason === 'document' || reason === 'credential-start' || reason === 'credential-end') {
    const entry = kept.get(connectionId);
    if (entry) kept.set(connectionId, { snapshot: entry.snapshot, generation: to });
  }
  if (reason === 'disposed') buckets.delete(connectionId);
  // An owner whose connection advanced is stale from here, so it shows nobody.
  refreshTray();
}

function bucketFor(connectionId: ConnectionId): () => boolean {
  let allow = buckets.get(connectionId);
  if (!allow) {
    allow = createTokenBucket(TRAY_STATUS_RATE_PER_SEC, () => Date.now());
    buckets.set(connectionId, allow);
  }
  return allow;
}

/**
 * Where a `tray:action` goes (#86 B1, #87 RC-2): the connection whose snapshot the tray
 * shows, so the controls act on the session they display. That is the foreground primary
 * with no owner, or the capture-lease holder while it is the owner. Null while the tray
 * is neutral (its Open/Quit menu offers no client action), including a stale owner, so an
 * action never reaches a connection the tray is not showing. What breaks it: sending to
 * the foreground without asking what is displayed.
 */
export function trayActionTarget(): WebContents | null {
  const shown = displayed;
  if (shown === null) return null;
  const record = recordFor(shown.connectionId);
  if (!record || record.state === 'disposed' || record.webContents.isDestroyed()) return null;
  return record.webContents;
}

/** The connection the tray currently renders, or null while it is neutral (#87 resource counts). */
export function displayedTrayConnection(): ConnectionId | null {
  return displayed?.connectionId ?? null;
}

/** One connection's kept snapshot (a copy), or null. */
export function traySnapshotFor(id: ConnectionId): TrayStatusSnapshot | null {
  const entry = kept.get(id);
  return entry ? { ...entry.snapshot } : null;
}

/** How many connections currently hold a kept snapshot (#87 resource counts). */
export function traySnapshotCount(): number {
  return kept.size;
}

/** Forgets one connection's snapshot; the tray goes neutral only if it was showing it. */
export function dropTraySnapshot(id: ConnectionId): void {
  forget(id);
  refreshTray();
}

/**
 * `tray:setStatus` (#86 Task 7B: `registerIpc`, `connection-bound`). Every refusal
 * still resolves `true` (the contract: a tray update never fails the renderer's
 * invoke); only a rate-limit drop resolves `false`. Also subscribes the tray to the
 * registry's foreground and generation announcements.
 */
export function registerTrayStatusIpc(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  kept.clear();
  hung.clear();
  buckets.clear();
  displayed = null;
  unsubscribers = [onForegroundChanged(refreshTray), onGenerationAdvanced(onGeneration)];
  let loggedMalformed = false;
  registerIpc(
    TRAY_SET_STATUS,
    CHANNEL_CLASSES[TRAY_SET_STATUS],
    (sender: ConnectionSender, _event: IpcMainInvokeEvent, payload: unknown): boolean => {
      try {
        const { record } = sender;
        if (!bucketFor(record.connectionId)()) return false;
        const invalid = firstInvalidField(payload);
        if (invalid !== null) {
          if (!loggedMalformed) {
            loggedMalformed = true;
            console.warn(`tray:setStatus dropped a malformed snapshot (field ${invalid})`);
          }
          return true;
        }
        // Kept for its own connection whether or not it is the source (see the INVARIANT).
        kept.set(record.connectionId, {
          snapshot: { ...(payload as TrayStatusSnapshot) },
          generation: record.generation,
        });
        // A renderer that sends is running.
        hung.delete(record.connectionId);
        refreshTray();
      } catch {
        // Contract: a tray update can never fail the renderer's invoke.
      }
      return true;
    },
    { refusal: () => true }
  );
}

/** The minimal `webContents` surface the reset hooks need. */
interface ResettableContents {
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/**
 * R17 for `connectionId`'s view (#86 B2: every view has these, the tray is shared).
 * Each hook changes only that connection's snapshot, so it moves the tray only while
 * the tray shows that connection.
 */
export function attachTrayResetHooks(
  contents: ResettableContents,
  connectionId: ConnectionId
): void {
  const reset = (): void => {
    forget(connectionId);
    refreshTray();
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
    hung.add(connectionId);
    refreshTray();
  });
  contents.on('responsive', () => {
    hung.delete(connectionId);
    refreshTray();
  });
  contents.on('destroyed', () => {
    reset();
    buckets.delete(connectionId);
  });
}
