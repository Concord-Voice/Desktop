/**
 * The `audiocap:start` invoke — the ONE handler the #3198 sender-frame criterion
 * binds (A4, R5). PR 1's `audiocap:capability` is a `webContents.send` PUSH and
 * has no sender to validate; reading the absence of a check there as an oversight
 * is the mistake this module's existence is meant to prevent.
 *
 * FOUR FENCES, in this order, and the order is the design:
 *   1. sender frame   -- read on the FIRST statement (A4). Since IPC contract v34
 *                        (#86): `app-global-mutate` admission (the foreground
 *                        connection's primary), then `isOwnerPrimaryFrame` for the
 *                        connection the share is bound to, then the capture-lease holder
 *                        gate (#87), which replaced #86's refusal while another
 *                        connection owns a live share. Re-run after the only await, with
 *                        a foreground and holder re-check, because the requester can go
 *                        away or go to the background during it.
 *   2. payload shape  -- one known field; extras are dropped, never honoured
 *   3. prefix + shape -- re-parsed HERE, never trusted from the renderer (D4a)
 *   4. liveness       -- the id must still be in desktopCapturer's enumeration
 *
 * NO PID APPEARS IN THIS FILE (I-PID, A7). Main resolves a HANDLE and sends that;
 * the capture child is the only process that ever learns a PID, and it never
 * sends one back.
 */
import { desktopCapturer, type IpcMainInvokeEvent } from 'electron';

import {
  audiocapRendererLossEpoch,
  killAudiocapCapture,
  startAudiocapHost,
  stopAudiocapHost,
  type AudiocapStartResult,
} from '../audiocapHost';
import { isHolder } from '../captureLease';
import type { ConnectionId } from '../../shared/connectionIdentity';
import { parseWindowSourceId } from '../../shared/parseWindowSourceId';
import {
  bindOwner,
  onGenerationAdvanced,
  requireOwner,
  type OwnerBinding,
} from '../connectionCapability';

import { CHANNEL_CLASSES } from './channelClassification';
import {
  requireConnectionSender,
  requireForegroundPrimary,
  type ConnectionSender,
} from './connectionSender';
import { currentRemoteSpaOrigin, registerIpc } from './registry';

/**
 * FENCE 1 (#86 Task 7B), shared by the start, the post-await re-check and the stop.
 *
 * THE OWNER IS A CONNECTION, NOT A WINDOW. Before #86 the share belonged to "the main
 * window", proven by `event.sender === getMainWindow().webContents`. With one view per
 * connection that identity names nothing, so the share is bound in main to the
 * `ConnectionRef` that started it (`bindOwner('audiocap', ref)`, spec §3.8 R4):
 *
 *   - `requireOwner` admits only a PRIMARY binding to the owner's connection whose
 *     current main frame sent the event (`senderMainFrame`: no parent, not detached,
 *     the webContents' own `frameTreeNodeId`), and only while the owner's captured
 *     generation is still the record's. A PiP shares the origin and is refused, as
 *     #3394 PR 1 refused it; a document change, renderer loss, credential change or
 *     dispose advances the generation and revokes the binding;
 *   - `requireConnectionSender` re-runs the registry's whole admission (binding,
 *     membership, the frame URL permitted for the connection's kind), so the re-check
 *     after the await is the same fence the wrapper ran before it, not a subset.
 *
 * Both read `event.senderFrame` inside a try (a destroyed frame throws on access), so
 * nothing that cannot be proven to be the owner's current primary main frame passes.
 * What breaks it: comparing the payload, the window, or a renderer-held id instead of
 * the binding, or dropping the generation half of `requireOwner`.
 */
function isOwnerPrimaryFrame(event: IpcMainInvokeEvent, owner: OwnerBinding): boolean {
  if (requireOwner(event, owner) === null) return false;
  const sender = requireConnectionSender(event, { roles: ['primary'] }, currentRemoteSpaOrigin());
  return sender !== null && sender.ref.connectionId === owner.ref.connectionId;
}

/**
 * The connection that owns the live or pending share, or null. Set synchronously when a
 * well-formed start is admitted (before its await), so the owner's stop during the
 * enumeration wins and another connection's stop is refused. Cleared by the owner's
 * stop, by any generation advance of the owner's connection (below) and by the capture
 * lease's handoff (`revokeAudiocapShare`).
 */
let shareOwner: OwnerBinding | null = null;
/** Matches no live connection: used where a kill must reach only an ownerless capture. */
const NO_CONNECTION = '' as ConnectionId;

/** The owner of the live or pending share, for main's port and interrupt routing. */
export function audiocapShareOwner(): OwnerBinding | null {
  return shareOwner;
}

/**
 * THE HOLDER GATE (#87 RC-3, spec §3.6). Only the capture-lease holder may start a share,
 * so with exclusive capture no two connections can hold a tap. It REPLACES #86's
 * refuse-while-another-connection-owns-a-live-share rule: that rule judged a share by the
 * host's liveness, while the lease judges the connection, and the consent handoff
 * (`revokeAudiocapShare`, then the ceremony's grant) is now the only way another
 * connection's share ends early. Checked before the await and again after it, beside the
 * foreground re-check, because the lease can move while the enumeration is pending. A
 * refusal is `protocol-fault`, the one refusal member `AudiocapStartResult` has. What
 * breaks it: reading the holder from the payload or the window, or checking it only once.
 */
function ownerHoldsLease(owner: OwnerBinding): boolean {
  return isHolder(owner.ref);
}

/** True while the owner's connection is still the foreground one (re-checked after the await). */
function isOwnerForeground(event: IpcMainInvokeEvent, owner: OwnerBinding): boolean {
  const sender = requireForegroundPrimary(event, currentRemoteSpaOrigin());
  return sender !== null && sender.ref.connectionId === owner.ref.connectionId;
}

function forgetShareOwner(): void {
  shareOwner = null;
}

/**
 * The share path's OWN generation mint, monotonic and module-local.
 *
 * NOT `currentAudiocapGeneration()`, which returns `session?.generation ?? 0` — the
 * LIVE child's number, or 0 when nothing is live. A share starts when nothing is
 * live, so that helper would hand `0` to every share forever and the generation the
 * result carries back would carry no information at all. `audiocapHost.ts` says it
 * outright: "#3198's share path mints its own generations, and a collision with
 * [the probe's] is harmless because I2 fences on session IDENTITY rather than on
 * the number." So this number is not a fence — it is how the renderer tells a
 * result for THIS share from a result for a superseded one.
 */
let shareGeneration = 0;
let shareOperationEpoch = 0;
function nextShareGeneration(): number {
  shareGeneration += 1;
  return shareGeneration;
}

/**
 * Exported for test. `registerIpc` registers it below behind the `app-global-mutate`
 * admission (the foreground primary), so the tests exercise the same function production
 * does rather than a copy.
 * `sender` is the main-held binding the registry admitted in the event's own tick.
 *
 * `request: unknown` IS THE POINT, and it is a deliberate divergence from the plan's
 * draft, which declared it `AudiocapStartRequest` and then immediately cast back to
 * `unknown` to read the field. The value arrives from the renderer across a trust
 * boundary, so a declared shape is a claim TypeScript will believe and never check —
 * and the cast the draft needed is the tell. Typed `unknown`, fence 2 is the only way
 * to reach the field at all, so it cannot be deleted without the compiler objecting.
 */
export async function handleAudiocapStart(
  sender: ConnectionSender,
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<AudiocapStartResult> {
  // FENCE 1 -- first statement. A4 is specific about this: a validation that
  // runs after any other work is a validation a future edit can reorder past. Only the
  // FOREGROUND primary may start a share (#86 Task 7B pass 2: the registry admits this
  // channel as app-global-mutate); the share is bound to THAT connection's current
  // generation, captured here, synchronously, before any await.
  if (sender.role !== 'primary') return { ok: false, reason: 'protocol-fault' };
  const owner = bindOwner('audiocap', sender.ref);
  if (!isOwnerPrimaryFrame(event, owner)) return { ok: false, reason: 'protocol-fault' };
  // The holder gate (#87): a foreground non-holder is refused before any OS work, so the
  // holder's share is never superseded. The refusal reuses `protocol-fault`, the member this
  // fence already answers with: the degrade union is closed and every member carries
  // renderer copy, so a new reason is not additive.
  if (!ownerHoldsLease(owner)) return { ok: false, reason: 'protocol-fault' };

  // FENCE 2. Read exactly the one field. An extra `systemAudio: true` is not
  // rejected, because rejecting it would tell a hostile renderer which fields
  // exist; it is simply never read, so it cannot influence anything.
  // `protocol-fault`, NOT `target-unresolved`: a non-record payload or a non-string
  // sourceId is a CONTRACT violation, not a target problem, and protocol-fault is
  // the member the child's own off-protocol messages already use (spec §4.2).
  const sourceId: unknown = (request as { sourceId?: unknown } | null | undefined)?.sourceId;
  if (typeof sourceId !== 'string') {
    return { ok: false, reason: 'protocol-fault' };
  }

  // FENCE 3. `parseWindowSourceId` is "a handle or nothing" and admits ONLY
  // `window:` ids, so a `screen:` id is refused here -- which is also the D6
  // main-side fence: a whole-desktop id can never reach a per-process start.
  //
  // `target-unresolved`, DELIBERATELY DIVERGING from spec §4.2's table, which gives
  // `no-backend` for an id failing the window: regex. The degrade reason's own member
  // comment states the collapse covers "a malformed id, a `screen:` id, a window that
  // closed between pick and start, and an OS call that refused" under A7 /
  // observability principle 7 -- and A7 is a Global Constraint, which outranks that
  // one spec row. Spec §4.3 independently argues `no-backend` would be "a mechanism
  // string naming the wrong mechanism". RECORDED IN THE PR BODY.
  const handle = parseWindowSourceId(sourceId);
  if (handle === null) {
    return { ok: false, reason: 'target-unresolved' };
  }

  // A trusted stop or a newer valid start wins while source enumeration is pending.
  // There is no await between the epoch check below and startAudiocapHost, so a stop
  // cannot land after the check but before the native host is registered.
  shareOperationEpoch += 1;
  const operationEpoch = shareOperationEpoch;
  shareOwner = owner;
  // A reload or renderer crash during the await below finds no session to kill, so the
  // start must notice it here instead, or it forks a tap for a document that is gone.
  // The owner's connection's count only: another connection's loss is not this start's.
  const lossEpoch = audiocapRendererLossEpoch(owner.ref.connectionId);

  // FENCE 4. A well-formed id for a window that has since closed is STALE, and
  // "a stale id must never silently widen a capture" (D4a). Thumbnail-free, so
  // this is a cheap enumeration rather than a screenshot of every window.
  const live = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  if (
    operationEpoch !== shareOperationEpoch ||
    lossEpoch !== audiocapRendererLossEpoch(owner.ref.connectionId)
  ) {
    return { ok: false, reason: 'target-unresolved' };
  }
  // FENCE 1 again, the WHOLE fence and not only its origin half, because the await above
  // can outlive the requester in ways the loss epoch does not see: Electron nulls
  // `senderFrame` once its document navigates, the connection can advance its generation
  // (document, credential, renderer loss) or be disposed, and the frame that asked can
  // stop being its webContents' main frame. Any of those means the port would be handed
  // to a document that did not ask for it: a superseded request's effect is dropped.
  if (!isOwnerPrimaryFrame(event, owner)) {
    return { ok: false, reason: 'protocol-fault' };
  }
  // A start admitted while foreground is refused if its connection went to the background
  // during the enumeration: a hidden connection must not start capture (#86 Task 7B pass 2).
  if (!isOwnerForeground(event, owner)) {
    return { ok: false, reason: 'protocol-fault' };
  }
  // The holder gate again (#87): the lease can move during the enumeration (a handoff, a
  // backgrounded revocation, the holder's release), and a start its connection no longer
  // holds the lease for must not fork a tap.
  if (!ownerHoldsLease(owner)) {
    return { ok: false, reason: 'protocol-fault' };
  }
  if (!live.some((s) => s.id === sourceId)) {
    return { ok: false, reason: 'target-unresolved' };
  }

  const generation = nextShareGeneration();
  return startAudiocapHost(generation, handle, owner);
}

/**
 * End the live capture (#3198 PR 3).
 *
 * ZERO-ARGUMENT BY CONSTRUCTION, matching `spa:reloadLatest`. The renderer TRIGGERS a
 * stop; it names nothing and chooses nothing. Main resolves which child to reap from its
 * own `session`, so a hostile renderer's only reachable effect is ending a share it can
 * already end by closing its own track.
 *
 * WHY THIS CHANNEL HAS TO EXIST. Every `killAudiocapHost` caller is a quit or crash hook,
 * and `audiocapChild.ts`'s `handleStop` "deliberately does NOT exit" -- so without this, a
 * share the user ENDED left the capture child holding its OS tap until the app quit or the
 * next share superseded it. That is a live tap outliving the share it belonged to, which
 * is the outcome ADR-0043 exists to prevent.
 *
 * `stopAudiocapHost`, never `killAudiocapHost`: the graceful path posts `{kind:'stop'}`
 * first, and the child's `handleStop` is the only reader of the liveness and teardown
 * evidence the addon's `status()` carries -- the R9 silence detector, `quiesceProved` and
 * `destroyFailures`. (The child's fault watch also calls `status()` while a capture is
 * live, #3394 PR 2, but reads only `faulted` and `faultReason`.) Killing outright destroys
 * the tap just as well and reads none of that evidence.
 *
 * Returns nothing. There is no outcome to report: the stop is unconditional, and a
 * renderer that calls it when nothing is live simply gets a no-op -- as does one that
 * calls it while only the windowless app-start probe is live, which `stopAudiocapHost`
 * spares because it is no renderer's capture (#3394 PR 1, R4).
 */
export function handleAudiocapStop(_sender: ConnectionSender, event: IpcMainInvokeEvent): void {
  // FENCE 1, first statement, and the SAME helper as the start handler. This reaches a
  // process kill, so only the connection the share belongs to -- its current primary main
  // frame -- may end it; another connection, a PiP or a subframe may not. With no owner
  // there is no renderer's share to end, and the windowless probe is no renderer's.
  const owner = shareOwner;
  if (owner === null || !isOwnerPrimaryFrame(event, owner)) return;
  forgetShareOwner();
  shareOperationEpoch += 1;
  stopAudiocapHost();
}

/**
 * End the share for the capture lease's consent handoff (#87 RC-4, spec §3.6): the lease
 * moves to another connection, so the old holder's share must end before the grantee can
 * start one. Forgets the owner (a bare `killAudiocapCapture()` would leave `shareOwner` set,
 * so the old holder's stop and main's port routing would still name it), supersedes a start
 * still awaiting its enumeration through the operation epoch, and kills the renderer capture
 * at once. `killAudiocapCapture`, never `killAudiocapHost`: it spares the windowless
 * app-start probe (ADR-0043 A9). The immediate kill rather than the graceful stop because
 * the grantee is waiting on it.
 *
 * The lease calls this from its handoff only, never from its generation listener: the
 * listener in `registerAudiocapIpc` below already stops the owner's share gracefully on
 * every advance of its connection, and a kill there would race and cut that stop short.
 */
export function revokeAudiocapShare(): void {
  // The kill is scoped to a connection (#86): read the owner BEFORE forgetting it, so the
  // holder's own share is ended in its name. An ownerless capture (a host-level start) ends
  // for any id, which the empty one is.
  const owner = shareOwner;
  forgetShareOwner();
  shareOperationEpoch += 1;
  killAudiocapCapture(owner?.ref.connectionId ?? NO_CONNECTION);
}

/**
 * Registers `audiocap:start` behind `app-global-mutate` (the foreground primary, #86 Task 7B
 * pass 2) and `audiocap:stop` behind `connection-bound` (#86 Task 7B). The
 * legacy `(getRemoteSpaOrigin, getMainWindow)` providers are gone: the remote-SPA origin
 * comes from the registry and the owner from the binding.
 *
 * A generation advance on the owner's connection (document change, renderer loss,
 * credential start or end, dispose) revokes the share: the owner is forgotten, a pending
 * start is superseded through the operation epoch, and the live capture is stopped, so a
 * tap can never outlive the document that asked for it. Registered once per process.
 */
export function registerAudiocapIpc(): void {
  const refusal = (): Promise<AudiocapStartResult> =>
    Promise.resolve({ ok: false, reason: 'protocol-fault' });
  registerIpc('audiocap:start', CHANNEL_CLASSES['audiocap:start'], handleAudiocapStart, {
    refusal,
  });
  registerIpc('audiocap:stop', CHANNEL_CLASSES['audiocap:stop'], handleAudiocapStop, {
    refusal: () => undefined,
  });
  onGenerationAdvanced((id) => {
    if (shareOwner?.ref.connectionId !== id) return;
    forgetShareOwner();
    shareOperationEpoch += 1;
    stopAudiocapHost();
  });
}
