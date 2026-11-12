/**
 * The `tray:setStatus` invoke (tray-status spec §4, IPC contract 33).
 *
 * Fences, in this order; nothing here throws. The result is `false` only when the
 * rate limit dropped the snapshot (the renderer resends it); every other outcome,
 * refusals included, is `true`:
 *   1. Admission (since IPC contract v34, #86): `registerIpc` as `connection-bound`
 *      admits a bound PRIMARY main frame whose URL is permitted for its connection's
 *      kind (a PiP shares the origin and is refused there).
 *   2. `isTrayOwner` (R5): the tray's owner only, the bound owner's current primary
 *      when `setTrayOwner` has named one, else the foreground connection's primary.
 *   3. A 20/s token bucket.
 *   4. `firstInvalidField` — the exact-key, closed-enum guard. A malformed payload is
 *      logged once per session with the field NAME only (a fixed-table token, never a
 *      value or a caller-chosen key).
 * Only then is the snapshot handed to `applyTraySnapshot`, which stores it while the
 * tray is inactive and renders it otherwise.
 *
 * `attachTrayResetHooks` covers R17: when the renderer reloads, crashes or hangs, the
 * tray drops back to the neutral icon and the Open/Quit menu rather than keeping live
 * voice controls for a session that may no longer exist. A hang is the one reset that
 * can end with the same session alive, so `responsive` re-applies the last accepted
 * snapshot: the renderer only sends on change and would otherwise leave the tray
 * neutral until some field moved.
 */
import type { IpcMainInvokeEvent } from 'electron';

import {
  firstInvalidField,
  TRAY_SET_STATUS,
  type TrayStatusSnapshot,
} from '../../shared/trayStatus';
import type { ConnectionRef } from '../../shared/connectionIdentity';
import { applyTraySnapshot } from '../tray';
import { foreground } from '../connectionRegistry';
import { bindOwner, requireOwner, type OwnerBinding } from '../connectionCapability';

import { CHANNEL_CLASSES } from './channelClassification';
import type { ConnectionSender } from './connectionSender';
import { registerIpc } from './registry';

const TRAY_STATUS_RATE_PER_SEC = 20;

// The last snapshot the handler accepted from the live main renderer; null once that
// renderer navigates, crashes or is destroyed.
let lastAccepted: TrayStatusSnapshot | null = null;

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
 * document, renderer loss, a credential change, dispose) admits NOBODY until main
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
}

/**
 * FENCE 1 (#86 Task 7B). The registry already admitted a bound PRIMARY main frame whose
 * URL is permitted for its connection's kind, read in the event's own tick (a PiP shares
 * the origin and is refused there, as are subframes, detached and destroyed frames).
 * This narrows it to the tray's owner: the named owner's current primary when one is
 * set, else the foreground connection's primary. What breaks it: admitting on the
 * payload, on a renderer-held id, or on window identity instead of the binding.
 */
function isTrayOwner(sender: ConnectionSender, event: IpcMainInvokeEvent): boolean {
  const owner = trayOwnerBinding;
  if (owner !== null) return requireOwner(event, owner) === sender.record;
  return foreground() === sender.record;
}

/**
 * `tray:setStatus` (#86 Task 7B: `registerIpc`, `connection-bound` plus the owner check
 * above). Every refusal still resolves `true` (the contract: a tray update never fails
 * the renderer's invoke); only a rate-limit drop resolves `false`.
 */
export function registerTrayStatusIpc(): void {
  const allow = createTokenBucket(TRAY_STATUS_RATE_PER_SEC, () => Date.now());
  let loggedMalformed = false;
  registerIpc(
    TRAY_SET_STATUS,
    CHANNEL_CLASSES[TRAY_SET_STATUS],
    (sender: ConnectionSender, event: IpcMainInvokeEvent, payload: unknown): boolean => {
      try {
        if (!isTrayOwner(sender, event)) return true;
        if (!allow()) return false;
        const invalid = firstInvalidField(payload);
        if (invalid !== null) {
          if (!loggedMalformed) {
            loggedMalformed = true;
            console.warn(`tray:setStatus dropped a malformed snapshot (field ${invalid})`);
          }
          return true;
        }
        lastAccepted = { ...(payload as TrayStatusSnapshot) };
        applyTraySnapshot({ ...lastAccepted });
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

/** Reset the tray to neutral when the main renderer reloads, crashes, hangs or goes away (R17). */
export function attachTrayResetHooks(contents: ResettableContents): void {
  const reset = (): void => {
    lastAccepted = null;
    applyTraySnapshot(null);
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
  contents.on('unresponsive', () => applyTraySnapshot(null));
  contents.on('responsive', () => {
    if (lastAccepted) applyTraySnapshot({ ...lastAccepted });
  });
  contents.on('destroyed', reset);
}
