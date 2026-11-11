// connection:* channels, IPC contract v34 (spec 2026-11-09-86-connection-context-isolation
// §3.7, §3.9).
//
//   connection:whoAmI      sendSync, read ONCE at preload evaluation. A synchronous map
//                          lookup: the identity of the bound primary or PiP whose MAIN
//                          frame asked, with a frame URL allowed for its kind; else null.
//   connection:create      foreground primary only. One create at a time (a second one is
//                          `busy`). probe → ceremony budget → ceremony → re-check →
//                          commit approval → registerService → openConnectionView →
//                          activate → append to connections.json.
//   connection:activate    foreground primary only → boolean.
//   connection:generation  push to the record's OWN webContents on every generation advance.
//
// Invariants:
//   - who is asking comes only from the main-held sender binding; the renderer names an
//     origin to open or a service to show, never which connection it speaks for.
//   - after EVERY await, `create` re-checks that its opener is still a live primary at the
//     generation it was admitted at and still the foreground; anything else opens nothing.
//   - after the ceremony, an origin another path opened meanwhile is shown, not opened a
//     second time.
//   - a declined ceremony registers nothing and commits nothing.

import { ipcMain, type IpcMainEvent } from 'electron';
import {
  isServiceId,
  SAAS_SERVICE_ID,
  type ConnectionId,
  type ConnectionIdentity,
  type Generation,
  type GenerationReason,
  type ServiceId,
} from '../../shared/connectionIdentity';
import {
  foreground,
  liveConnections,
  MAX_LIVE_CONNECTIONS,
  onGenerationAdvanced,
  recordFor,
  registerService,
  unregisterService,
  serviceForOrigin,
  type ConnectionRecord,
  type RegisterServiceDeps,
  type RegisterServiceRefusal,
} from '../connectionRegistry';
import type { ConnectionsFileEntry } from '../connectionsFile';
import type { ConnectionCreateResult, ConnectionGenerationPush } from '../ipcContract';
import { consumeCeremonyToken } from '../selfHostedCeremonyBudget';
import { commitSelfHostedApproval, serviceIdForApiBase } from '../selfHostedProfile';
import type { ConnectionViewLoader, OpenConnectionViewResult } from '../shellWindow';
import { requireConnectionSender, type ConnectionSender } from './connectionSender';
import { currentRemoteSpaOrigin, registerIpc } from './registry';

export type { ConnectionCreateResult, ConnectionGenerationPush };

type CreateRefusal = Extract<ConnectionCreateResult, { status: 'rejected' }>['reason'];

/** What main's pre-ceremony step reports. `needsApproval: false` skips the ceremony. */
export interface ConnectionProbe {
  readonly status: string;
  readonly needsApproval?: boolean;
}

export type ConnectionCeremonyVerdict =
  { readonly approved: true; readonly address: string } | { readonly approved: false };

export interface ConnectionIpcDeps<P extends ConnectionProbe = ConnectionProbe> {
  openConnectionView(
    serviceId: ServiceId,
    url: string,
    load: ConnectionViewLoader
  ): Promise<OpenConnectionViewResult>;
  activateConnection(serviceId: ServiceId): boolean;
  /** Resolve the origin for the ceremony; any status but 'ok' opens nothing. */
  probe(origin: string): Promise<P>;
  /** The native approval dialog plus the provisional server probe it authorises. */
  ceremony(origin: string, probe: P): Promise<ConnectionCeremonyVerdict>;
  /** Append entries to connections.json (merged with the restored list by serviceId). */
  writeConnections(added: readonly ConnectionsFileEntry[]): Promise<void>;
  /** Session and custody factories for `registerService`. */
  serviceDeps: RegisterServiceDeps;
  /** The URL a new view loads; defaults to the bundled renderer. */
  viewUrl?: () => string;
}

/** The deps a create uses once the origin is approved. */
type ViewDeps = Omit<ConnectionIpcDeps, 'probe' | 'ceremony'>;

const GENERATION_PUSH = 'connection:generation';
const DEFAULT_VIEW_URL = 'app://concord/index.html';
/** Longer than any origin a user types; bounds the URL parse of a hostile value. */
const MAX_ORIGIN_LENGTH = 2048;
const PIP_OR_PRIMARY = ['pip', 'primary'] as const;

const loadView: ConnectionViewLoader = (contents, url) => contents.loadURL(url);

/** Origins with a create in flight. At most one: see `createConnection`. */
const createsInFlight = new Set<string>();
let unsubscribeGenerationPush: (() => void) | null = null;

const rejected = (reason: CreateRefusal): ConnectionCreateResult => ({
  status: 'rejected',
  reason,
});

/** `value` only when it already IS a canonical http(s) origin (`new URL(x).origin`). */
function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin === value ? value : null;
}

/** The identity `event`'s main frame speaks for, or null. Synchronous by construction. */
function identityFor(event: IpcMainEvent): ConnectionIdentity | null {
  const sender = requireConnectionSender(
    event,
    { roles: PIP_OR_PRIMARY },
    currentRemoteSpaOrigin()
  );
  if (!sender) return null;
  const { ref, service } = sender;
  return {
    connectionId: ref.connectionId,
    generation: ref.generation,
    serviceId: service.serviceId,
    kind: service.kind,
    apiOrigin: service.origin,
  };
}

function liveConnectionFor(origin: string): ConnectionRecord | null {
  const service = serviceForOrigin(origin);
  if (!service) return null;
  return (
    liveConnections().find((r) => r.serviceId === service.serviceId && r.state !== 'disposed') ??
    null
  );
}

/** A live connection for `origin` is shown instead of opened again. */
function showExisting(deps: ViewDeps, origin: string): ConnectionCreateResult | null {
  const live = liveConnectionFor(origin);
  if (!live) return null;
  deps.activateConnection(live.serviceId);
  return { status: 'opened', serviceId: live.serviceId };
}

/** Null while the opener is still a live primary at its admitted generation AND foreground. */
function openerRefusal(opener: ConnectionSender): CreateRefusal | null {
  const record = recordFor(opener.ref.connectionId);
  if (!record || record.state === 'disposed' || record.generation !== opener.ref.generation) {
    return 'untrusted-sender';
  }
  return foreground() === record ? null : 'not-foreground';
}

function registerRefusal(reason: RegisterServiceRefusal): CreateRefusal {
  if (reason === 'service-id-collision') return 'service-id-collision';
  return reason === 'invalid-origin' ? 'invalid-origin' : 'declined';
}

function openRefusal(
  reason: Extract<OpenConnectionViewResult, { ok: false }>['reason']
): CreateRefusal {
  return reason === 'limit' ? 'limit' : 'invalid-origin';
}

/**
 * The ceremony branch. Null when the origin is approved and the create continues;
 * otherwise the result to return. The budget rations the DIALOG, so its token is
 * spent before the dialog opens (as `selfHosted:probeServer` does).
 */
async function approve<P extends ConnectionProbe>(
  deps: ConnectionIpcDeps<P>,
  opener: ConnectionSender,
  origin: string,
  probed: P
): Promise<ConnectionCreateResult | null> {
  if (!consumeCeremonyToken()) return rejected('busy');
  const verdict = await deps.ceremony(origin, probed);
  const refusal = openerRefusal(opener);
  if (refusal) return rejected(refusal);
  if (!verdict.approved) return rejected('declined');
  const meanwhile = showExisting(deps, origin);
  if (meanwhile) return meanwhile;
  return commitSelfHostedApproval(origin, verdict.address) ? null : rejected('declined');
}

async function openService(
  deps: ViewDeps,
  opener: ConnectionSender,
  origin: string
): Promise<ConnectionCreateResult> {
  const meanwhile = showExisting(deps, origin);
  if (meanwhile) return meanwhile;
  // X4: only a service THIS call registers is forgotten when its view does not open.
  // Checked synchronously with the register, so no other call can interleave.
  const registeredHere = serviceForOrigin(origin) === undefined;
  const registered = registerService(origin, deps.serviceDeps);
  if (!registered.ok) return rejected(registerRefusal(registered.reason));
  const { serviceId } = registered.service;
  const forgetIfOrphaned = (): void => {
    if (registeredHere) unregisterService(serviceId);
  };
  let opened: OpenConnectionViewResult;
  try {
    opened = await deps.openConnectionView(serviceId, deps.viewUrl?.() ?? DEFAULT_VIEW_URL, loadView);
  } catch (err) {
    forgetIfOrphaned();
    throw err;
  }
  if (!opened.ok) {
    if (opened.reason === 'already-open') return showExisting(deps, origin) ?? rejected('limit');
    forgetIfOrphaned();
    return rejected(openRefusal(opened.reason));
  }
  // The view is open whatever happens next; it is shown only if the opener still is.
  const activated = openerRefusal(opener) === null && deps.activateConnection(serviceId);
  const now = new Date().toISOString();
  deps
    .writeConnections([
      { serviceId, origin, addedAt: now, lastForegroundAt: activated ? now : null },
    ])
    .catch(() => {
      console.warn('[connection:create] connections.json was not updated');
    });
  return { status: 'opened', serviceId };
}

async function runCreate<P extends ConnectionProbe>(
  deps: ConnectionIpcDeps<P>,
  opener: ConnectionSender,
  origin: string
): Promise<ConnectionCreateResult> {
  const probed = await deps.probe(origin);
  const refusal = openerRefusal(opener);
  if (refusal) return rejected(refusal);
  if (probed.status !== 'ok') return rejected('invalid-origin');
  if (probed.needsApproval !== false) {
    const stopped = await approve(deps, opener, origin, probed);
    if (stopped) return stopped;
  }
  return openService(deps, opener, origin);
}

/**
 * Everything before the first await runs in the tick the event arrived, so the busy
 * mark is set before a burst can observe an empty set. One create at a time, not one
 * per origin: each probe starts an uncancellable `dns.lookup` on libuv's 4-slot
 * threadpool, and N concurrent creates of N names would head-of-line-block main's
 * credential IO exactly as N concurrent `selfHosted:probeServer` calls would.
 */
function createConnection<P extends ConnectionProbe>(
  deps: ConnectionIpcDeps<P>,
  opener: ConnectionSender,
  value: unknown
): ConnectionCreateResult | Promise<ConnectionCreateResult> {
  const origin = canonicalOrigin(value);
  if (origin === null) return rejected('invalid-origin');
  const existing = showExisting(deps, origin);
  if (existing) return existing;
  // saas is opened by main at startup, never through a ceremony.
  if (serviceIdForApiBase(origin) === SAAS_SERVICE_ID) return rejected('invalid-origin');
  if (createsInFlight.size > 0) return rejected('busy');
  if (liveConnections().length >= MAX_LIVE_CONNECTIONS) return rejected('limit');
  createsInFlight.add(origin);
  return runCreate(deps, opener, origin)
    .catch(() => {
      // Fixed text: the error can carry a hostname or a filesystem path.
      console.warn('[connection:create] create failed');
      return rejected('declined');
    })
    .finally(() => {
      createsInFlight.delete(origin);
    });
}

function pushGeneration(
  id: ConnectionId,
  _from: Generation,
  to: Generation,
  reason: GenerationReason
): void {
  const record = recordFor(id);
  if (!record) return;
  const contents = record.webContents;
  const payload: ConnectionGenerationPush = { connectionId: id, generation: to, reason };
  try {
    if (contents.isDestroyed()) return;
    contents.send(GENERATION_PUSH, payload);
  } catch {
    // Destroyed between the check and the send; the document is gone either way.
  }
}

/** The view deps `registerConnectionIpc` was given; null until it runs. */
let registeredViewDeps: ViewDeps | null = null;

/**
 * Open (or show) `value`, an origin the CALLER has already normalised, resolved and
 * approved, in its own connection: a create's final step without its probe and
 * ceremony (#86 §3.7, `selfHosted:probeServer`'s 'opened-in-connection'). The
 * opener's own view is never navigated. Refused before `registerConnectionIpc` has
 * run, for a non-canonical origin, for saas, at the live-connection cap, and unless
 * the opener is still the live foreground primary at its admitted generation.
 */
export function openApprovedConnection(
  opener: ConnectionSender,
  value: string
): Promise<ConnectionCreateResult> {
  const deps = registeredViewDeps;
  const origin = canonicalOrigin(value);
  if (deps === null || origin === null) return Promise.resolve(rejected('invalid-origin'));
  const refusal = openerRefusal(opener);
  if (refusal) return Promise.resolve(rejected(refusal));
  const existing = showExisting(deps, origin);
  if (existing) return Promise.resolve(existing);
  if (serviceIdForApiBase(origin) === SAAS_SERVICE_ID) {
    return Promise.resolve(rejected('invalid-origin'));
  }
  if (liveConnections().length >= MAX_LIVE_CONNECTIONS) return Promise.resolve(rejected('limit'));
  return openService(deps, opener, origin).catch(() => {
    // Fixed text: the error can carry a hostname or a filesystem path.
    console.warn('[connection:create] open failed');
    return rejected('declined');
  });
}

export function registerConnectionIpc<P extends ConnectionProbe>(deps: ConnectionIpcDeps<P>): void {
  registeredViewDeps = deps;
  // eslint-disable-next-line no-restricted-syntax -- #86 §3.7: whoAmI is sendSync, answered through event.returnValue in the same tick; registerIpc's invoke-style refusal value cannot express that. Admission is requireConnectionSender, the same check registerIpc runs.
  ipcMain.on('connection:whoAmI', (event: IpcMainEvent) => {
    // Always set: a sendSync with no returnValue blocks the renderer.
    try {
      event.returnValue = identityFor(event);
    } catch {
      event.returnValue = null;
    }
  });

  registerIpc(
    'connection:create',
    'app-global-mutate',
    (opener, _event, origin: unknown) => createConnection(deps, opener, origin),
    { refusal: (reason) => rejected(reason === 'not-foreground' ? reason : 'untrusted-sender') }
  );

  registerIpc(
    'connection:activate',
    'app-global-mutate',
    (_sender, _event, serviceId: unknown) =>
      isServiceId(serviceId) && deps.activateConnection(serviceId),
    { refusal: () => false }
  );

  unsubscribeGenerationPush?.();
  unsubscribeGenerationPush = onGenerationAdvanced(pushGeneration);
}
