// IPC admission registry (spec 2026-11-09-86-connection-context-isolation §3.7, §3.9).
//
// `registerIpc` is the ONLY place main calls `ipcMain.handle|on|once|handleOnce`
// (eslint.config.mjs bans the raw calls everywhere else). Every channel carries an
// admission class from the checked-in CHANNEL_CLASSES table, and the wrapper admits
// the sender BEFORE the handler runs:
//   - admission is synchronous. The wrapper reads `event.senderFrame`, resolves the
//     sender binding and captures the `ConnectionSender` in the same tick the event
//     arrived, then calls the handler. Nothing suspends between the two, so a
//     navigation that lands later cannot change which connection the handler
//     speaks for (§3.9). This file must never contain a suspension point: the
//     registry suite greps it.
//   - the connection, its service and its custody come from the main-held binding
//     alone (connectionSender.ts); nothing the renderer sends selects them.
//   - a refused `handle` resolves `opts.refusal(reason)`, or
//     `{ status: 'rejected', reason }` by default, and the handler never runs.
//     `exempt-low-stakes` refusals are a silent `undefined`.
// What breaks it: a handler registered outside this file, or a wrapper that defers
// the handler call to a later tick.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { CHANNEL_CLASSES } from './channelClassification';
import {
  requireConnectionSender,
  requireForegroundPrimary,
  requireSaasPrimary,
  type ConnectionSender,
  type SenderRefusal,
} from './connectionSender';

export type AdmissionClass =
  | 'connection-bound'
  | 'app-global-read'
  | 'app-global-mutate'
  | 'saas-only'
  | 'pip-scoped'
  | 'exempt-low-stakes';

export type IpcMethod = 'handle' | 'on' | 'once' | 'handleOnce';

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;

type Admission =
  | { readonly ok: true; readonly sender: ConnectionSender }
  | { readonly ok: false; readonly reason: SenderRefusal };

const PRIMARY_ONLY = ['primary'] as const;
const PIP_OR_PRIMARY = ['pip', 'primary'] as const;

const registered = new Map<string, AdmissionClass>();

const NO_REMOTE_SPA = (): string | null => null;
let remoteSpaOriginSource: () => string | null = NO_REMOTE_SPA;

/**
 * Where the `saas` remote-SPA origin comes from (main.ts: `getRemoteSpaBaseUrl`).
 * Until it is set, only the bundled and cached documents are admitted: the remote
 * SPA document fails closed, never open.
 */
export function setRemoteSpaOriginSource(source: () => string | null): void {
  remoteSpaOriginSource = source;
}

/** The current remote-SPA origin, or null (also when the source throws). */
export function currentRemoteSpaOrigin(): string | null {
  try {
    return remoteSpaOriginSource();
  } catch {
    return null;
  }
}

const refused = (reason: SenderRefusal): Admission => ({ ok: false, reason });
const admitted = (sender: ConnectionSender): Admission => ({ ok: true, sender });

/** A bound primary of a foreground (or saas) connection, distinguishing the refusal. */
function admitNarrowed(
  event: IpcEvent,
  spa: string | null,
  narrow: (event: IpcEvent, spa: string | null) => ConnectionSender | null,
  reason: SenderRefusal
): Admission {
  if (requireConnectionSender(event, { roles: PRIMARY_ONLY }, spa) === null) {
    return refused('untrusted-sender');
  }
  const sender = narrow(event, spa);
  return sender ? admitted(sender) : refused(reason);
}

/** Synchronous by construction: every check below is a map lookup or a frame read. */
function admit(cls: AdmissionClass, event: IpcEvent): Admission {
  const spa = currentRemoteSpaOrigin();
  switch (cls) {
    case 'connection-bound':
    case 'app-global-read': {
      const sender = requireConnectionSender(event, { roles: PRIMARY_ONLY }, spa);
      return sender ? admitted(sender) : refused('untrusted-sender');
    }
    case 'pip-scoped': {
      const sender = requireConnectionSender(event, { roles: PIP_OR_PRIMARY }, spa);
      return sender ? admitted(sender) : refused('untrusted-sender');
    }
    case 'app-global-mutate':
    case 'exempt-low-stakes':
      return admitNarrowed(event, spa, requireForegroundPrimary, 'not-foreground');
    case 'saas-only':
      return admitNarrowed(event, spa, requireSaasPrimary, 'not-saas');
    default:
      return refused('untrusted-sender');
  }
}

function classOf(channel: string): AdmissionClass | undefined {
  return Object.prototype.hasOwnProperty.call(CHANNEL_CLASSES, channel)
    ? CHANNEL_CLASSES[channel]
    : undefined;
}

/**
 * Register `handler` for `channel` behind its admission class. Throws, registering
 * nothing, for a channel absent from CHANNEL_CLASSES, for a class that differs from
 * the table's, and for a channel already registered.
 */
export function registerIpc<A extends unknown[], R>(
  channel: string,
  cls: AdmissionClass,
  handler: (sender: ConnectionSender, event: IpcEvent, ...args: A) => R,
  opts?: { method?: IpcMethod; refusal?: (reason: SenderRefusal) => R }
): void {
  const expected = classOf(channel);
  if (expected === undefined) throw new Error(`Unclassified IPC channel: ${channel}`);
  if (expected !== cls) {
    throw new Error(`IPC channel ${channel} is classified ${expected}, not ${cls}`);
  }
  if (registered.has(channel)) throw new Error(`IPC channel already registered: ${channel}`);

  const refusal =
    opts?.refusal ?? ((reason: SenderRefusal) => ({ status: 'rejected', reason }) as R);
  const wrapped = (event: IpcEvent, ...args: unknown[]): R | undefined => {
    const admission = admit(cls, event);
    if (!admission.ok) {
      if (cls === 'exempt-low-stakes') return undefined;
      // Fixed vocabulary only: the channel is a code constant, the reason a closed enum.
      console.warn(`[ipc] ${channel} refused (${admission.reason})`);
      return refusal(admission.reason);
    }
    return handler(admission.sender, event, ...(args as A));
  };

  const method = opts?.method ?? 'handle';
  switch (method) {
    case 'handle':
      ipcMain.handle(channel, wrapped);
      break;
    case 'handleOnce':
      ipcMain.handleOnce(channel, wrapped);
      break;
    case 'on':
      ipcMain.on(channel, wrapped);
      break;
    case 'once':
      ipcMain.once(channel, wrapped);
      break;
  }
  registered.set(channel, cls);
}

/** Every channel registered through `registerIpc`, in registration order. */
export function registeredChannels(): ReadonlyMap<string, AdmissionClass> {
  return new Map(registered);
}

export function _resetIpcRegistryForTesting(): void {
  registered.clear();
  remoteSpaOriginSource = NO_REMOTE_SPA;
}
