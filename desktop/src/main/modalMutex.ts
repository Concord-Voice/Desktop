/**
 * One main-owned native modal at a time, across ceremony kinds (#87 R13).
 *
 * Main raises two kinds of ceremony: the self-hosted approval (`selfHosted:probeServer`
 * and `connection:create`) and the capture move (`captureCeremony.ts`). Each is
 * rationed by its own token bucket, but two dialogs stacked on one window would let a
 * compromised renderer pair a prompt it controls with one the user is already reading.
 * So whichever kind is open, the other is refused before it spends a token.
 *
 * Rejecting, not queueing: a caller that finds the slot taken answers its own busy
 * shape at once. Synchronous by construction, so a burst in one tick cannot all
 * observe a free slot.
 */
export type ModalKind = 'capture' | 'self-hosted-approval';

interface Hold {
  readonly kind: ModalKind;
}

let held: Hold | null = null;

/**
 * Takes the slot for `kind` and returns its release, or null while ANY kind is held.
 * The release is idempotent and frees only its own hold, so a stale release can never
 * free a successor's.
 */
export function tryAcquireModal(kind: ModalKind): (() => void) | null {
  if (held !== null) return null;
  const hold: Hold = { kind };
  held = hold;
  return () => {
    if (held === hold) held = null;
  };
}

/** The kind currently holding the slot, or null when it is free. */
export function modalInFlight(): ModalKind | null {
  return held?.kind ?? null;
}

export function _resetModalMutexForTesting(): void {
  held = null;
}
