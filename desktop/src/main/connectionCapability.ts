// Owner-binding primitive (spec 2026-11-09-86-connection-context-isolation §3.8, R4).
//
// #87's import surface. A capability (an audiocap session, an SSO loopback, the
// tray, a capture lease) is bound in MAIN to the `ConnectionRef` that started it;
// the renderer never holds a bearer secret for it. A binding is current exactly
// while its captured generation equals the live record's, so every
// `advanceGeneration` (document change, renderer loss, credential start/end,
// dispose) revokes every older binding in the same synchronous write — before any
// `onGenerationAdvanced` listener runs.
//
// UNFORGEABLE BY CONSTRUCTION. Bindings are instances of a module-private class
// with a private constructor, and currentness is checked with an ergonomic brand
// check on a private field (`#minted in b`), not `instanceof`: `instanceof` passes
// for `Object.create(Object.getPrototypeOf(realBinding))` carrying any ref the
// caller likes, while a private field can only be installed by the constructor.
// The ref is copied and frozen at bind time, so mutating the object the caller
// passed in cannot move an old binding onto a newer generation.

import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { isConnectionId, isGeneration, type ConnectionRef } from '../shared/connectionIdentity';
import { boundRecordFor, recordFor, type ConnectionRecord } from './connectionRegistry';
import { senderMainFrame } from './ipc/frameValidation';

export type CapabilityKind = 'audiocap' | 'sso-loopback' | 'tray' | 'capture-lease';

const CAPABILITY_KINDS: ReadonlySet<string> = new Set<CapabilityKind>([
  'audiocap',
  'sso-loopback',
  'tray',
  'capture-lease',
]);

export interface OwnerBinding {
  readonly kind: CapabilityKind;
  readonly ref: ConnectionRef;
}

class OwnerBindingImpl implements OwnerBinding {
  readonly #minted = true;
  readonly kind: CapabilityKind;
  readonly ref: ConnectionRef;

  private constructor(kind: CapabilityKind, ref: ConnectionRef) {
    this.kind = kind;
    this.ref = Object.freeze({ connectionId: ref.connectionId, generation: ref.generation });
    Object.freeze(this);
  }

  static mint(kind: CapabilityKind, ref: ConnectionRef): OwnerBinding {
    return new OwnerBindingImpl(kind, ref);
  }

  static isMinted(value: unknown): value is OwnerBindingImpl {
    return typeof value === 'object' && value !== null && #minted in value;
  }
}

/**
 * Bind a capability of `kind` to `ref`. Main-only. A ref that is not current
 * (the connection advanced or is gone) still binds — the binding is simply stale
 * from birth, so `isOwnerCurrent` refuses it. Throws on a malformed kind or ref.
 */
export function bindOwner(kind: CapabilityKind, ref: ConnectionRef): OwnerBinding {
  if (!CAPABILITY_KINDS.has(kind)) throw new TypeError('bindOwner: unknown capability kind');
  if (!isConnectionId(ref.connectionId) || !isGeneration(ref.generation)) {
    throw new TypeError('bindOwner: malformed ConnectionRef');
  }
  return OwnerBindingImpl.mint(kind, ref);
}

/** True only for a binding minted by `bindOwner` whose generation is still the record's. */
export function isOwnerCurrent(b: OwnerBinding): boolean {
  if (!OwnerBindingImpl.isMinted(b)) return false;
  return recordFor(b.ref.connectionId)?.generation === b.ref.generation;
}

/**
 * The owning connection's record when the IPC sender may act on `b`, else null:
 * the sender's current main frame (read once), a PRIMARY binding to `b`'s
 * connection that agrees with the record's membership, and `b` still current.
 * Re-check `isOwnerCurrent(b)` after every `await` before any effect (§3.9).
 *
 * Primary only, never a PiP of the same connection. The generation fences the
 * primary document alone: a PiP reload advances nothing, so a PiP has no
 * generation that could make its claim stale. And the owner-only handlers this
 * replaces already exclude the PiP (`audiocap:stop` since #3394, `tray:setStatus`
 * since contract v33), because a PiP loads the same SPA from the same origin.
 */
export function requireOwner(
  event: IpcMainEvent | IpcMainInvokeEvent,
  b: OwnerBinding
): ConnectionRecord | null {
  if (senderMainFrame(event) === null) return null;
  const bound = boundRecordFor(event.sender);
  if (!bound || bound.role !== 'primary' || !OwnerBindingImpl.isMinted(b)) return null;
  if (bound.record.connectionId !== b.ref.connectionId) return null;
  return isOwnerCurrent(b) ? bound.record : null;
}

export { onGenerationAdvanced } from './connectionRegistry';
