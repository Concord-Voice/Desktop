// Exclusive capture lease (spec 2026-11-09-87-capture-lease-and-resource-budgets
// §3.2, §3.4, §3.10).
//
// The main process's only authority over the microphone, camera and screen: one
// connection (the holder) captures at a time, and capture moves to another only
// through the main-drawn ceremony and the ack-or-crash handoff. In memory only.
//
// INVARIANTS, and what breaks each one:
//
// 1. AT MOST ONE DOCUMENT MAY HOLD LIVE CAPTURE. While a handoff is pending the
//    holder is null and nobody is granted until the previous holder's document has
//    acked, been replaced (`document`, `renderer-gone`, `disposed`) or been crashed;
//    `handoff !== null` implies `holder === null`. Breaks if a grant is issued with a
//    handoff pending, if a handoff ends without its `from` document going quiet, or if
//    a credential advance is read as ending the holder: that document and its tracks
//    keep running, so the lease would be free beside a live microphone (RC-14).
// 2. ONLY THE HOLDER'S CURRENT DOCUMENT SPEAKS FOR IT. Holder checks compare the ref
//    and the `capture-lease` OwnerBinding's currentness. A credential advance re-keys
//    both on the same holder entry, so the ceremony's post-await check compares entry
//    identity, not the generation.
// 3. NO FRESH GRANT TO A BACKGROUND DOCUMENT (R5). `not-foreground` is decided before
//    any held check, so a background document also learns nothing about the lease (R6).
// 4. EVERY MUTATION IS SYNCHRONOUS. The only awaits are the ceremony and the handoff
//    wait, each followed by a re-check of the requester's currentness and the holder's
//    identity before any effect (§3.10). State is written before side effects run.

import type { IpcMainInvokeEvent } from 'electron';
import {
  CAPTURE_LEASE_PUSH,
  CAPTURE_LEASE_REVOKED_PUSH,
  isCaptureAcquireInput,
  type CaptureAcquireResult,
  type CaptureIntent,
  type CaptureLeaseRevoked,
  type CaptureLeaseState,
  type CaptureRejectReason,
} from '../shared/captureLease';
import type {
  ConnectionId,
  ConnectionRef,
  Generation,
  GenerationReason,
} from '../shared/connectionIdentity';
import { bindOwner, isOwnerCurrent, requireOwner, type OwnerBinding } from './connectionCapability';
import {
  onForegroundChanged,
  onGenerationAdvanced,
  refOf,
  type ConnectionRecord,
} from './connectionRegistry';
import type { ConnectionSender } from './ipc/connectionSender';

/** Q4: how long a moved holder has to ack before its renderer is crashed. */
export const HANDOFF_ACK_TIMEOUT_MS = 5000;
/** A navigation hold waits out a slow load this many extra deadlines, then crashes. */
export const NAV_HOLD_MAX_REARMS = 6;

export interface CaptureLeaseDeps {
  foreground(): ConnectionRecord | null;
  recordFor(id: ConnectionId): ConnectionRecord | undefined;
  sendToConnection(ref: ConnectionRef, channel: string, ...args: unknown[]): boolean;
  setTrayOwner(ref: ConnectionRef | null): void;
  /** Handoff only. A generation advance is #86's audiocap listener's to handle (RC-4). */
  revokeAudiocapShare(): void;
  serviceMediaCapability(id: ConnectionId): boolean | undefined;
  isQuitting(): boolean;
  runCeremony(
    from: ConnectionRef,
    to: ConnectionRef,
    signal: AbortSignal
  ): Promise<'join' | 'stay'>;
  /** The cross-kind modal mutex (R13): a release function, or null while another modal is open. */
  tryAcquireModal(): (() => void) | null;
  consumeCeremonyToken(): boolean;
  /** Defaults to `crashAndReloadRenderer`. */
  crashAndReload?: (record: ConnectionRecord) => void;
}

type RevokeReason = CaptureLeaseRevoked['reason'];

interface HolderEntry {
  ref: ConnectionRef;
  binding: OwnerBinding;
  readonly claims: Set<CaptureIntent>;
  readonly legacy: boolean;
}

interface Handoff {
  from: ConnectionRef;
  fromBinding: OwnerBinding;
  /** The grantee; null for a `backgrounded` revocation or once the grantee is superseded. */
  to: ConnectionRef | null;
  settle: ((result: CaptureAcquireResult) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set only for a navigation hold: the holder to restore if the navigation never commits. */
  navHeld?: HolderEntry;
  /** Navigation hold only: how often a still-loading document has re-armed the deadline. */
  rearms?: number;
}

interface Ceremony {
  readonly requester: ConnectionRef;
  readonly controller: AbortController;
}

let deps: CaptureLeaseDeps | null = null;
let unsubscribe: (() => void) | null = null;
let holder: HolderEntry | null = null;
let handoff: Handoff | null = null;
let ceremony: Ceremony | null = null;
let quitShutdown = false;
/** A document that has made any capture:* call, keyed to its generation (the legacy gate). */
const leaseAware = new Map<ConnectionId, Generation>();
/**
 * Connections whose holder is mid-navigation. #86 advances the generation twice per
 * cross-document navigation: at its START (the outgoing document is still live) and when it
 * COMMITS or fails for real. A cancelled navigation (ERR_ABORTED) leaves the old document, with
 * its capture tracks, in place after the first advance only. So the first `document` advance of
 * a holder holds the lease behind the ack-or-crash timer, and only the second ends it.
 */
const navigating = new Set<ConnectionId>();
/** A held connection whose navigation has actually committed (or failed for real). */
const committed = new Set<ConnectionId>();
const navWatch = new Map<ConnectionId, () => void>();

/** A holder's navigation is over (committed, restored, or its renderer is gone). */
function clearNav(id: ConnectionId): boolean {
  committed.delete(id);
  navWatch.get(id)?.();
  navWatch.delete(id);
  return navigating.delete(id);
}

const granted = (): CaptureAcquireResult => ({ status: 'granted' });
const declined = (): CaptureAcquireResult => ({ status: 'declined' });
const rejected = (reason: CaptureRejectReason): CaptureAcquireResult => ({
  status: 'rejected',
  reason,
});

function sameRef(a: ConnectionRef, b: ConnectionRef): boolean {
  return a.connectionId === b.connectionId && a.generation === b.generation;
}

function freezeRef(ref: ConnectionRef): ConnectionRef {
  return Object.freeze({ connectionId: ref.connectionId, generation: ref.generation });
}

function liveRecord(d: CaptureLeaseDeps, id: ConnectionId): ConnectionRecord | null {
  const record = d.recordFor(id);
  return record && record.state !== 'disposed' ? record : null;
}

function isRefCurrent(d: CaptureLeaseDeps, ref: ConnectionRef): boolean {
  return liveRecord(d, ref.connectionId)?.generation === ref.generation;
}

function isForeground(d: CaptureLeaseDeps, ref: ConnectionRef): boolean {
  const fg = d.foreground();
  return fg !== null && fg.state !== 'disposed' && sameRef(refOf(fg), ref);
}

/** A side effect that must not abort the state transition that triggered it. */
function effect(run: () => void): void {
  try {
    run();
  } catch {
    // Fixed text: the transition already landed and a raw error may carry ids.
    console.warn('[capture] a lease side effect failed');
  }
}

function push(d: CaptureLeaseDeps, ref: ConnectionRef, channel: string, payload: object): void {
  effect(() => d.sendToConnection(ref, channel, payload));
}

function leaseState(held: boolean, mine: boolean): CaptureLeaseState {
  return { held, mine };
}

/** Reserved for someone: a holder, or a holder whose document is mid-navigation (the hold). */
function isHeld(): boolean {
  return holder !== null || handoff?.navHeld !== undefined;
}

/**
 * R6 push targets, one push each: the holder; the foreground when it is not the
 * holder; and `formerId`, a connection whose own lease just ended, when it is
 * neither. `excludeId` is a connection being disposed, which is told nothing.
 */
function publish(
  d: CaptureLeaseDeps,
  formerId: ConnectionId | null,
  excludeId: ConnectionId | null
): void {
  const holderId = holder?.ref.connectionId ?? null;
  const fg = d.foreground();
  const fgId = fg !== null && fg.state !== 'disposed' ? fg.connectionId : null;
  if (formerId !== null && formerId !== holderId && formerId !== fgId && formerId !== excludeId) {
    const former = liveRecord(d, formerId);
    if (former) push(d, refOf(former), CAPTURE_LEASE_PUSH, leaseState(false, false));
  }
  if (holder !== null) push(d, holder.ref, CAPTURE_LEASE_PUSH, leaseState(true, true));
  if (fg !== null && fgId !== null && fgId !== holderId && fgId !== excludeId) {
    push(d, refOf(fg), CAPTURE_LEASE_PUSH, leaseState(isHeld(), false));
  }
}

function grant(
  d: CaptureLeaseDeps,
  ref: ConnectionRef,
  intent: CaptureIntent,
  legacy: boolean,
  excludeId: ConnectionId | null = null
): void {
  const frozen = freezeRef(ref);
  holder = {
    ref: frozen,
    binding: bindOwner('capture-lease', frozen),
    claims: new Set([intent]),
    legacy,
  };
  effect(() => d.setTrayOwner(frozen));
  publish(d, null, excludeId);
}

function settleOnce(h: Handoff, result: CaptureAcquireResult): void {
  const settle = h.settle;
  h.settle = null;
  if (settle) settle(result);
}

/** The grantee's own generation advanced: it is answered now; `from` must still go quiet. */
function supersedeGrantee(h: Handoff): void {
  h.to = null;
  settleOnce(h, rejected('superseded'));
}

/** `from` has acked, been replaced or is gone: grant `to` if it is still current. */
function completeHandoff(
  d: CaptureLeaseDeps,
  h: Handoff,
  excludeId: ConnectionId | null,
  formerId: ConnectionId | null = null
): void {
  if (handoff !== h) return;
  handoff = null;
  if (h.timer !== null) clearTimeout(h.timer);
  h.timer = null;
  const to = h.to;
  const live = to !== null && h.settle !== null && isRefCurrent(d, to);
  // The grantee may have gone to the background while `from` tore down (the switch is not
  // blocked during a handoff): a fresh acquisition is foreground-only, so it is re-checked.
  if (to !== null && live && isForeground(d, to)) {
    grant(d, to, 'voice-join', false, excludeId);
    settleOnce(h, granted());
    return;
  }
  effect(() => d.setTrayOwner(null));
  publish(d, formerId, excludeId);
  if (to !== null) settleOnce(h, rejected(live ? 'not-foreground' : 'superseded'));
}

function onHandoffTimeout(h: Handoff): void {
  if (handoff !== h) return;
  h.timer = null;
  const d = deps;
  if (d === null || quitShutdown || d.isQuitting()) return;
  const record = liveRecord(d, h.from.connectionId);
  if (record === null) {
    completeHandoff(d, h, null);
    return;
  }
  if (h.navHeld !== undefined) {
    // A navigation hold, not a revocation: the renderer was never told to stop. A load still
    // in progress may yet commit (which ends the hold); one that is not was cancelled, and the
    // old document is alive and well, so the lease goes back to it instead of a crash.
    const contents = record.webContents;
    const rearms = h.rearms ?? 0;
    if (!contents.isDestroyed() && contents.isLoading?.() === true) {
      if (rearms < NAV_HOLD_MAX_REARMS) {
        // Bounded: a document that stays "loading" forever must not hold capture forever.
        h.rearms = rearms + 1;
        h.timer = setTimeout(() => onHandoffTimeout(h), HANDOFF_ACK_TIMEOUT_MS);
        return;
      }
      // Out of patience: fall through to the crash below.
    } else {
      restoreAfterCancelledNavigation(d, h.navHeld, record);
      return;
    }
  }
  // Settled by the `renderer-gone` (or `document`) advance this causes, not here.
  const crash = d.crashAndReload ?? crashAndReloadRenderer;
  effect(() => crash(record));
}

/**
 * §3.4 steps 1-3. The gate flips first (`holder = null`), so the moved document
 * loses capture before it is even told; a renderer cannot veto what follows.
 */
function beginHandoff(
  d: CaptureLeaseDeps,
  entry: HolderEntry,
  to: ConnectionRef | null,
  reason: RevokeReason,
  settle: ((result: CaptureAcquireResult) => void) | null
): void {
  const h: Handoff = { from: entry.ref, fromBinding: entry.binding, to, settle, timer: null };
  holder = null;
  handoff = h;
  effect(() => d.revokeAudiocapShare());
  push(d, h.from, CAPTURE_LEASE_REVOKED_PUSH, { reason });
  push(d, h.from, CAPTURE_LEASE_PUSH, leaseState(false, false));
  if (!isRefCurrent(d, h.from)) {
    completeHandoff(d, h, null); // no document left to ack
    return;
  }
  if (quitShutdown || d.isQuitting()) return; // never crash a renderer during shutdown
  h.timer = setTimeout(() => onHandoffTimeout(h), HANDOFF_ACK_TIMEOUT_MS);
}

async function runCeremonyFlow(
  d: CaptureLeaseDeps,
  requester: ConnectionRef,
  named: HolderEntry,
  releaseModal: () => void
): Promise<CaptureAcquireResult> {
  const entry: Ceremony = { requester, controller: new AbortController() };
  ceremony = entry;
  let answer: 'join' | 'stay' | null = null;
  try {
    answer = await d.runCeremony(named.ref, requester, entry.controller.signal);
  } catch {
    answer = null;
  } finally {
    if (ceremony === entry) ceremony = null;
    effect(releaseModal);
  }
  if (!isRefCurrent(d, requester)) return rejected('superseded');
  if (entry.controller.signal.aborted || quitShutdown || d.isQuitting() || answer !== 'join') {
    return declined();
  }
  // The dialog is modal to the window, not to the requester: the user may have switched
  // connections while it was open, and a hidden connection must not take capture.
  if (!isForeground(d, requester)) return rejected('not-foreground');
  if (holder === named) {
    return new Promise((resolve) => beginHandoff(d, named, requester, 'moved', resolve));
  }
  if (isFree()) {
    grant(d, requester, 'voice-join', false);
    return granted();
  }
  return rejected('busy'); // a different holder than the one the dialog named
}

/** §3.2 step 6: the lease is held elsewhere or a handoff is pending. */
function contend(
  d: CaptureLeaseDeps,
  ref: ConnectionRef,
  intent: CaptureIntent
): CaptureAcquireResult | Promise<CaptureAcquireResult> {
  if (intent === 'device-test') return { status: 'held' };
  if (quitShutdown || d.isQuitting()) return declined();
  const named = holder;
  if (named === null || ceremony !== null || handoff !== null) return rejected('busy');
  const releaseModal = d.tryAcquireModal();
  if (releaseModal === null) return rejected('busy');
  if (!d.consumeCeremonyToken()) {
    effect(releaseModal);
    return rejected('busy');
  }
  return runCeremonyFlow(d, ref, named, releaseModal);
}

function decide(
  sender: ConnectionSender,
  input: unknown
): CaptureAcquireResult | Promise<CaptureAcquireResult> {
  const d = deps;
  if (d === null) return rejected('unavailable');
  if (sender.role !== 'primary') return rejected('untrusted-sender');
  const ref = sender.ref;
  if (!isRefCurrent(d, ref)) return rejected('superseded');
  markLeaseAware(ref);
  if (!isCaptureAcquireInput(input)) return rejected('untrusted-sender');
  const { intent } = input;
  if (holder !== null && isHolder(ref)) {
    holder.claims.add(intent);
    return granted();
  }
  if (!isForeground(d, ref)) return rejected('not-foreground');
  if (d.serviceMediaCapability(ref.connectionId) === false) return rejected('unavailable');
  if (isFree()) {
    grant(d, ref, intent, false);
    return granted();
  }
  return contend(d, ref, intent);
}

/**
 * `capture:acquire` (§3.2). Everything up to the ceremony runs synchronously in the
 * call, so leave→rejoin from one document cannot reorder; `sender` is the
 * connection-bound admission's, taken in the same tick.
 */
export function acquire(sender: ConnectionSender, input: unknown): Promise<CaptureAcquireResult> {
  return Promise.resolve(decide(sender, input));
}

function ownedBy(
  event: IpcMainInvokeEvent,
  binding: OwnerBinding,
  sender: ConnectionSender
): boolean {
  try {
    return requireOwner(event, binding) === sender.record;
  } catch {
    return false;
  }
}

/**
 * `capture:release` (§3.2): drops one claim; the lease frees when none is left. From
 * the document a handoff is waiting on, any release is the ack. No lease token
 * crosses IPC (R3): the holder is resolved from the sender's binding. Never throws.
 */
export function release(
  sender: ConnectionSender,
  event: IpcMainInvokeEvent,
  input: unknown
): boolean {
  const d = deps;
  if (d === null || sender.role !== 'primary') return false;
  markLeaseAware(sender.ref);
  if (!isCaptureAcquireInput(input)) return false;
  const h = handoff;
  if (h !== null && sameRef(sender.ref, h.from) && ownedBy(event, h.fromBinding, sender)) {
    completeHandoff(d, h, null);
    return true;
  }
  if (h?.navHeld !== undefined && sender.ref.connectionId === h.from.connectionId) {
    // A navigation hold keeps the PRE-navigation ref, but the surviving document speaks under
    // the generation the navigation start advanced to: its releases apply to the held claims
    // instead of being rejected and then undone by the restore (Codex P2). The sender is this
    // connection's current primary, admitted by the registry, which is all the hold needs.
    const held = h.navHeld;
    if (!held.claims.delete(input.intent)) return false;
    if (held.claims.size === 0) {
      effect(() => d.revokeAudiocapShare());
      // The document is not the foreground necessarily: it is told its lease is gone.
      completeHandoff(d, h, null, h.from.connectionId);
    }
    return true;
  }
  const entry = holder;
  if (entry === null || !sameRef(sender.ref, entry.ref)) return false;
  if (!ownedBy(event, entry.binding, sender) || !entry.claims.delete(input.intent)) return false;
  if (entry.claims.size > 0) {
    // A call ended on a connection that went to the background while a device test also ran:
    // `onForeground` kept both claims then, but a hidden test alone does not survive (R12).
    if (
      entry.claims.size === 1 &&
      entry.claims.has('device-test') &&
      !isForeground(d, entry.ref)
    ) {
      beginHandoff(d, entry, null, 'backgrounded', null);
    }
    return true;
  }
  holder = null;
  effect(() => d.setTrayOwner(null));
  // A share must not outlive the lease that admitted it: the renderer ends its own share
  // on a normal leave, but a release that skipped that step would leave the capture child
  // feeding the former holder while another connection is granted the lease.
  effect(() => d.revokeAudiocapShare());
  publish(d, entry.ref.connectionId, null);
  return true;
}

/** `document`, `renderer-gone`, `disposed`: the document that held capture is gone. */
function endConnection(d: CaptureLeaseDeps, id: ConnectionId, disposed: boolean): void {
  leaseAware.delete(id);
  if (ceremony?.requester.connectionId === id) ceremony.controller.abort();
  const h = handoff;
  if (h?.to?.connectionId === id) supersedeGrantee(h);
  const excludeId = disposed ? id : null;
  if (holder?.ref.connectionId === id) {
    holder = null;
    effect(() => d.setTrayOwner(null));
    publish(d, disposed ? null : id, excludeId);
  }
  if (h !== null && h.from.connectionId === id) completeHandoff(d, h, excludeId);
}

/** `credential-start` / `credential-end`: same document, same tracks, new generation. */
function rekeyConnection(
  d: CaptureLeaseDeps,
  id: ConnectionId,
  from: Generation,
  to: Generation
): void {
  const prev: ConnectionRef = { connectionId: id, generation: from };
  const next = freezeRef({ connectionId: id, generation: to });
  if (leaseAware.get(id) === from) leaseAware.set(id, to);
  // A requester or grantee is answered rather than carried: its consent was for `from`.
  if (ceremony?.requester.connectionId === id) ceremony.controller.abort();
  const h = handoff;
  if (h?.to?.connectionId === id) supersedeGrantee(h);
  if (holder !== null && sameRef(holder.ref, prev)) {
    holder.ref = next;
    holder.binding = bindOwner('capture-lease', next);
    effect(() => d.setTrayOwner(next));
  }
  if (h !== null && sameRef(h.from, prev)) {
    h.from = next;
    h.fromBinding = bindOwner('capture-lease', next);
  }
}

/**
 * The holder's document started navigating away. Its tracks may outlive a cancelled
 * navigation, so the lease is not freed yet: it stays reserved behind a handoff with no
 * grantee. The commit (a second `document` advance) or the renderer ending completes it; a
 * navigation that never commits reaches the 5 s timeout, which crashes the renderer.
 */
function holdThroughNavigation(d: CaptureLeaseDeps): void {
  if (handoff !== null) return; // a handoff already holds it behind its own timer
  const entry = holder;
  if (entry === null) return;
  const h: Handoff = {
    from: entry.ref,
    fromBinding: entry.binding,
    to: null,
    settle: null,
    timer: null,
    navHeld: entry,
  };
  holder = null;
  handoff = h;
  // The audiocap share is stopped by #86's own generation listener (RC-4), so no revoke here.
  if (quitShutdown || d.isQuitting()) return;
  h.timer = setTimeout(() => onHandoffTimeout(h), HANDOFF_ACK_TIMEOUT_MS);
}

/**
 * #86 emits the same `document` reason when a navigation STARTS and when it commits, and a
 * second start (a cancelled or superseded navigation) is indistinguishable by reason alone.
 * The hold therefore ends only on an actual commit: these listeners run BEFORE the shell
 * window's own (prepended), so the flag is set by the time the commit's advance arrives.
 */
function watchForCommit(d: CaptureLeaseDeps, id: ConnectionId): () => void {
  const contents = liveRecord(d, id)?.webContents;
  if (!contents || typeof contents.prependListener !== 'function') return () => undefined;
  const onCommit = (): void => {
    committed.add(id);
  };
  const onFail = (_e: unknown, errorCode: number, _d: string, _u: string, isMain: boolean): void => {
    if (isMain && errorCode !== -3) committed.add(id);
  };
  contents.prependListener('did-navigate', onCommit);
  contents.prependListener('did-fail-load', onFail);
  return () => {
    contents.removeListener('did-navigate', onCommit);
    contents.removeListener('did-fail-load', onFail);
  };
}

/** The navigation was cancelled: the same document keeps its tracks, under its new generation. */
function restoreAfterCancelledNavigation(
  d: CaptureLeaseDeps,
  entry: HolderEntry,
  record: ConnectionRecord
): void {
  handoff = null;
  clearNav(record.connectionId);
  const next = freezeRef(refOf(record));
  entry.ref = next;
  entry.binding = bindOwner('capture-lease', next);
  holder = entry;
  leaseAware.set(record.connectionId, next.generation);
  effect(() => d.setTrayOwner(next));
  // The connection may have gone to the background during the hold, when `onForeground` had
  // no holder to revoke: a device-test claim does not survive that (R12), so apply it now.
  if (!isForeground(d, next) && entry.claims.size === 1 && entry.claims.has('device-test')) {
    beginHandoff(d, entry, null, 'backgrounded', null);
    return;
  }
  publish(d, null, null);
}

/** The second `document` advance (or a first one for a connection that held nothing). */
function endNavigation(d: CaptureLeaseDeps, id: ConnectionId): void {
  const wasHolding = clearNav(id);
  endConnection(d, id, false);
  // The held lease ended with no `publish` naming this connection, so tell its new document
  // (unless the foreground push above already did).
  if (!wasHolding || holder?.ref.connectionId === id) return;
  if (d.foreground()?.connectionId === id) return;
  const former = liveRecord(d, id);
  if (former) push(d, refOf(former), CAPTURE_LEASE_PUSH, leaseState(false, false));
}

function onAdvance(
  id: ConnectionId,
  from: Generation,
  to: Generation,
  reason: GenerationReason
): void {
  const d = deps;
  if (d === null) return;
  switch (reason) {
    case 'document': {
      // Classified by EVENTS, never by who holds now: a connection that held nothing at the start
      // of a navigation may hold by its commit (the old document was still live and could
      // acquire), and reading that commit as a start would hold a lease for a document that
      // never captured anything. The listeners are attached on every start, before the commit.
      if (!navWatch.has(id)) navWatch.set(id, watchForCommit(d, id));
      if (committed.has(id)) {
        endNavigation(d, id);
        return;
      }
      const h = handoff;
      if (h !== null && h.navHeld === undefined && h.from.connectionId === id) {
        // A revocation is waiting on this document's ack and it started navigating: the
        // document is still the live one and answers under its new generation, so the ack
        // must be recognised under that generation or the 5 s crash would fire on a document
        // that did exactly what it was asked.
        const next = freezeRef({ connectionId: id, generation: to });
        h.from = next;
        h.fromBinding = bindOwner('capture-lease', next);
        navigating.add(id);
        return;
      }
      // A holder with nothing pending is held through the navigation whether or not this
      // connection is still marked navigating: a hold ended by release (or a cancelled
      // navigation) leaves the mark behind, and a stale mark must not hide the next start. The
      // restore of a cancelled hold clears it.
      if (holder?.ref.connectionId === id && handoff === null) {
        navigating.add(id);
        holdThroughNavigation(d);
        return;
      }
      // Held already, or another start of the same navigation: the old document is in place.
      if (navigating.has(id)) return;
      // A connection holding nothing: the start still ends what a document left behind
      // (ceremony, grantee, lease awareness).
      endConnection(d, id, false);
      return;
    }
    case 'renderer-gone':
    case 'disposed':
      clearNav(id);
      endConnection(d, id, reason === 'disposed');
      return;
    case 'credential-start':
    case 'credential-end':
      rekeyConnection(d, id, from, to);
      return;
    default: {
      // A new reason must be classified above; it never ends the holder by default.
      const unclassified: never = reason;
      return unclassified;
    }
  }
}

function onForeground(prev: ConnectionRecord | null, next: ConnectionRecord | null): void {
  const d = deps;
  if (d === null) return;
  const entry = holder;
  if (
    prev !== null &&
    entry !== null &&
    entry.ref.connectionId === prev.connectionId &&
    entry.claims.size === 1 &&
    entry.claims.has('device-test')
  ) {
    beginHandoff(d, entry, null, 'backgrounded', null); // R12
  }
  if (next === null || next.state === 'disposed') return;
  const nextRef = refOf(next);
  const mine = holder !== null && sameRef(holder.ref, nextRef);
  push(d, nextRef, CAPTURE_LEASE_PUSH, leaseState(isHeld(), mine));
}

/** Subscribes to generation and foreground changes; returns an unsubscribe. */
export function initCaptureLease(d: CaptureLeaseDeps): () => void {
  unsubscribe?.();
  deps = d;
  quitShutdown = false;
  const offGeneration = onGenerationAdvanced(onAdvance);
  const offForeground = onForegroundChanged(onForeground);
  const dispose = (): void => {
    offGeneration();
    offForeground();
    if (deps === d) deps = null;
    if (unsubscribe === dispose) unsubscribe = null;
  };
  unsubscribe = dispose;
  return dispose;
}

export function isHolder(ref: ConnectionRef): boolean {
  return holder !== null && sameRef(holder.ref, ref) && isOwnerCurrent(holder.binding);
}

export function isFree(): boolean {
  return holder === null && handoff === null;
}

export function holderRef(): ConnectionRef | null {
  return holder?.ref ?? null;
}

export function isLeaseAware(ref: ConnectionRef): boolean {
  return leaseAware.get(ref.connectionId) === ref.generation;
}

/** Only a current ref marks, so a stale call cannot overwrite a newer document's mark. */
export function markLeaseAware(ref: ConnectionRef): void {
  if (deps !== null && isRefCurrent(deps, ref)) leaseAware.set(ref.connectionId, ref.generation);
}

/**
 * §5.2: the implicit lease for a pre-35 SPA, asked from the permission request
 * handler. Same exposure as an explicit free acquire: free, no handoff pending, and
 * the requester is the foreground. The caller has already proven a primary main frame.
 */
export function legacyAcquire(ref: ConnectionRef): boolean {
  const d = deps;
  if (d === null || !isRefCurrent(d, ref) || isLeaseAware(ref) || !isFree()) return false;
  if (!isForeground(d, ref) || d.serviceMediaCapability(ref.connectionId) === false) return false;
  grant(d, ref, 'voice-join', true);
  // Once per generation by construction: a legacy holder never releases, so only an
  // advance (a new generation) frees the lease for it again.
  console.warn('[capture] legacy implicit lease');
  return true;
}

/** Both quit hooks. Synchronous: aborts an open dialog and disarms the crash timer. */
export function shutdownCaptureLeaseForQuit(): void {
  quitShutdown = true;
  ceremony?.controller.abort();
  if (handoff !== null && handoff.timer !== null) {
    clearTimeout(handoff.timer);
    handoff.timer = null;
  }
}

/**
 * R1, Q4: a crash cannot be vetoed by `beforeunload`; the reload then starts a new
 * process. The reload runs from `render-process-gone`, not right after the crash: the
 * capture-gate spike (results/macos-arm64.md, row 4) measured a `reload()` issued in the
 * same task as `forcefullyCrashRenderer()` being lost, leaving the view crashed with no
 * document.
 */
export function crashAndReloadRenderer(record: ConnectionRecord): void {
  const contents = record.webContents;
  if (contents.isDestroyed()) return;
  contents.once('render-process-gone', () => {
    if (!contents.isDestroyed()) contents.reload();
  });
  contents.forcefullyCrashRenderer();
}

export function captureLeaseCounts(): {
  holder: 0 | 1;
  handoff: 0 | 1;
  claims: number;
  leaseAware: number;
} {
  return {
    holder: holder === null ? 0 : 1,
    handoff: handoff === null ? 0 : 1,
    claims: holder?.claims.size ?? 0,
    leaseAware: leaseAware.size,
  };
}

export function _holderForTesting(): {
  ref: ConnectionRef;
  claims: CaptureIntent[];
  legacy: boolean;
} | null {
  if (holder === null) return null;
  return { ref: holder.ref, claims: [...holder.claims], legacy: holder.legacy };
}

export function _resetCaptureLeaseForTesting(): void {
  unsubscribe?.();
  unsubscribe = null;
  deps = null;
  if (handoff !== null && handoff.timer !== null) clearTimeout(handoff.timer);
  holder = null;
  handoff = null;
  ceremony = null;
  quitShutdown = false;
  leaseAware.clear();
  for (const stop of navWatch.values()) stop();
  navWatch.clear();
  navigating.clear();
  committed.clear();
}
