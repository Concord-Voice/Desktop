// Connection registry (spec 2026-11-09-86-connection-context-isolation §3.2).
//
// The main process's only record of which services exist, which connection
// (document) each one has open, and which `WebContents` speaks for which
// connection. Everything that grants authority — `requireConnectionSender`,
// `requireOwner`, `sendToConnection` — resolves through here, never through a
// payload, a URL or an `apiBase`.
//
// INVARIANTS, and what breaks each one:
//
// 1. ONE ORIGIN, ONE SERVICE. `serviceByOrigin` and `services` agree, and a
//    ServiceId already bound to a different origin is refused
//    (`service-id-collision`). `profileIdForApiBase` keeps only 64 bits of the
//    origin hash, so two origins CAN share an id; admitting the second would hand
//    it the first's session and custody. Breaks if a record is written before the
//    collision check, or keyed by anything but the canonical `URL.origin`.
//
// 2. GENERATION IS MONOTONIC AND HAS ONE WRITER. A record's generation starts at 1
//    and only `advanceGeneration` moves it, by exactly +1, synchronously. Every
//    `OwnerBinding` is current only while its captured generation equals the
//    record's, so an older binding is revoked the instant the write lands —
//    before any listener runs. The record exposes `generation` as a getter over a
//    closure that only this module's `advance` can reach, and the record is sealed,
//    so no other module can assign it or redefine it. Breaks if anything restores
//    an older generation (an aborted navigation must stay revoked, §3.9).
//
// 3. A BINDING NAMES EXACTLY ONE CONNECTION FOR ITS WEBCONTENTS' LIFE.
//    `bindings` is a WeakMap keyed by object identity, never by `id`. A webContents
//    lives on one Session for its whole life, so re-binding it to another
//    connection would let a document on A's session speak with B's authority;
//    `bindSender` throws instead, and it also refuses to bind one connection's
//    primary webContents to another connection (or as a PiP) before that primary
//    has been bound itself. Admission additionally requires that the binding
//    agrees with the record's own membership (`boundRecordFor`).
//
// 4. LISTENERS SEE EACH CONNECTION'S TRANSITIONS IN ORDER. A listener that itself
//    advances a generation (a credential-end that disposes, say) has its write land
//    immediately — revocation is never deferred — but its notification is queued
//    behind the one being delivered, so no listener observes `(2→3)` after `(3→4)`.
//    One listener throwing does not starve the rest.

import { randomBytes } from 'node:crypto';
import type { Session, WebContents, WebContentsView } from 'electron';
import {
  CONNECTION_ID_BYTES,
  isServiceId,
  serviceKindOf,
  type ConnectionId,
  type ConnectionRef,
  type Generation,
  type GenerationReason,
  type ServiceId,
  type ServiceKind,
} from '../shared/connectionIdentity';
import { dirKeyForApiBase, serviceIdForApiBase } from './selfHostedProfile';
import type { ProfileCustody } from './tokenManager';

/**
 * At most this many connections are live at once. Spec §9 item 2 requires >= 3
 * (CVNet + A + B); the Task 0 footprint spike kept the provisional 4.
 */
export const MAX_LIVE_CONNECTIONS = 4;

// Re-exported so the registry's consumers keep one import site for the record types.
export type { ProfileCustody };

export interface ServiceRecord {
  readonly serviceId: ServiceId;
  readonly kind: ServiceKind;
  /** Canonical `new URL(x).origin`; the only form ever stored or compared. */
  readonly origin: string;
  /** `profiles/<dirKey>/`; `''` for saas, whose files live at the userData root. */
  readonly dirKey: string;
  readonly session: Session;
  readonly custody: ProfileCustody;
}

export type ConnectionState = 'loading' | 'ready' | 'disposed';

export interface ConnectionRecord {
  readonly connectionId: ConnectionId;
  readonly serviceId: ServiceId;
  /** Read-only: `advanceGeneration` is the only writer (invariant 2). */
  readonly generation: Generation;
  view: WebContentsView | null;
  readonly webContents: WebContents;
  readonly pips: Set<WebContents>;
  state: ConnectionState;
}

export type BindingRole = 'primary' | 'pip';

export interface SenderBinding {
  readonly connectionId: ConnectionId;
  readonly role: BindingRole;
}

export type RegisterServiceRefusal = 'invalid-origin' | 'not-approved' | 'service-id-collision';

export interface RegisterServiceDeps {
  makeSession(service: Omit<ServiceRecord, 'session' | 'custody'>): Session;
  makeCustody(serviceId: ServiceId, origin: string): ProfileCustody;
  isValidatedSelfHostedApiBase(origin: string): boolean;
}

export type GenerationListener = (
  id: ConnectionId,
  from: Generation,
  to: Generation,
  reason: GenerationReason
) => void;

interface ConnectionEntry {
  readonly record: ConnectionRecord;
  /** Writes generation + 1 and returns `[from, to]`. Reachable only from this module. */
  readonly advance: () => readonly [Generation, Generation];
  /** Set on entry to `disposeConnection`, so a listener re-entering it is a no-op. */
  disposing: boolean;
}

interface PendingNotification {
  readonly id: ConnectionId;
  readonly from: Generation;
  readonly to: Generation;
  readonly reason: GenerationReason;
}

const FIRST_GENERATION = 1 as Generation;

const services = new Map<ServiceId, ServiceRecord>();
const serviceByOrigin = new Map<string, ServiceId>();
const connections = new Map<ConnectionId, ConnectionEntry>();
let bindings = new WeakMap<WebContents, SenderBinding>();
/** The remote-SPA origin main loaded each PiP from, fixed when it is bound. */
let pipSpaOrigins = new WeakMap<WebContents, string>();
let foregroundId: ConnectionId | null = null;
const listeners = new Set<GenerationListener>();
const pendingNotifications: PendingNotification[] = [];
let delivering = false;

/** The canonical http(s) origin of `value`, or null. `URL.origin` is the only canonicaliser. */
function canonicalOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

/**
 * Register (or find) the service for `origin`. Nothing is written — no session, no
 * custody, no map entry — until every refusal has been ruled out, so a refusal has
 * no side effect. A self-hosted origin is admitted only while the approvals ledger
 * says so, on every call: the registry never mints origin trust.
 */
export function registerService(
  origin: string,
  deps: RegisterServiceDeps
): { ok: true; service: ServiceRecord } | { ok: false; reason: RegisterServiceRefusal } {
  const canonical = canonicalOrigin(origin);
  if (canonical === null) return { ok: false, reason: 'invalid-origin' };
  const serviceId = serviceIdForApiBase(canonical);
  if (!isServiceId(serviceId)) return { ok: false, reason: 'invalid-origin' };
  const kind = serviceKindOf(serviceId);
  if (kind === 'selfhost' && !deps.isValidatedSelfHostedApiBase(canonical)) {
    return { ok: false, reason: 'not-approved' };
  }

  const knownId = serviceByOrigin.get(canonical);
  if (knownId !== undefined) {
    const known = services.get(knownId);
    if (known) return { ok: true, service: known };
  }
  if (services.has(serviceId)) return { ok: false, reason: 'service-id-collision' };

  const base = Object.freeze({
    serviceId,
    kind,
    origin: canonical,
    dirKey: dirKeyForApiBase(canonical),
  });
  const session = deps.makeSession(base);
  const custody = deps.makeCustody(serviceId, canonical);
  const service: ServiceRecord = Object.freeze({ ...base, session, custody });
  services.set(serviceId, service);
  serviceByOrigin.set(canonical, serviceId);
  return { ok: true, service };
}

/**
 * Forget a service no connection uses (#86 Task 7B, X4): `connection:create` calls it
 * when the view it registered the service for does not open, so a refused open
 * leaves no orphan record behind. Refused, returning false, while any connection
 * entry still names the service, so a live or still-disposing view never loses the
 * record its binding points at. The custody cache and the session are not touched:
 * a later `registerService` for the same origin gets the same custody back.
 */
export function unregisterService(id: ServiceId): boolean {
  const service = services.get(id);
  if (!service) return false;
  for (const entry of connections.values()) {
    if (entry.record.serviceId === id) return false;
  }
  services.delete(id);
  serviceByOrigin.delete(service.origin);
  return true;
}

export function getService(id: ServiceId): ServiceRecord | undefined {
  return services.get(id);
}

/** Every registered service, live or not (the dev Connections menu). Grants nothing. */
export function allServices(): ServiceRecord[] {
  return [...services.values()];
}

export function serviceForOrigin(origin: string): ServiceRecord | undefined {
  const canonical = canonicalOrigin(origin);
  if (canonical === null) return undefined;
  const id = serviceByOrigin.get(canonical);
  return id === undefined ? undefined : services.get(id);
}

/** 128 random bits, base64url without padding (22 chars). Runtime-only, never persisted. */
export function mintConnectionId(): ConnectionId {
  return randomBytes(CONNECTION_ID_BYTES).toString('base64url') as ConnectionId;
}

function createEntry(
  connectionId: ConnectionId,
  serviceId: ServiceId,
  webContents: WebContents,
  view: WebContentsView | null
): ConnectionEntry {
  let generation = FIRST_GENERATION;
  const record: ConnectionRecord = Object.seal({
    connectionId,
    serviceId,
    get generation(): Generation {
      return generation;
    },
    view,
    webContents,
    pips: new Set<WebContents>(),
    state: 'loading' as ConnectionState,
  });
  const advance = (): readonly [Generation, Generation] => {
    const from = generation;
    // 2**53 bumps is unreachable (one per navigation / credential event); past it
    // the value would fail isGeneration downstream and the preload would refuse it.
    generation = (from + 1) as Generation;
    return [from, generation];
  };
  return { record, advance, disposing: false };
}

function webContentsInUse(webContents: WebContents): boolean {
  if (bindings.has(webContents)) return true;
  for (const { record } of connections.values()) {
    if (record.webContents === webContents || record.pips.has(webContents)) return true;
  }
  return false;
}

/**
 * Open the (single, in v1) connection for `serviceId`, at generation 1 in the
 * `loading` state. Does not bind the webContents: the caller binds before it wires
 * listeners and loads (§3.9 creation order). Throws if `webContents` already
 * belongs to a connection — a document cannot change which session it runs on.
 */
export function openConnection(
  serviceId: ServiceId,
  webContents: WebContents,
  view: WebContentsView | null
):
  | { ok: true; record: ConnectionRecord }
  | { ok: false; reason: 'limit' | 'already-open' | 'unknown-service' } {
  if (!services.has(serviceId)) return { ok: false, reason: 'unknown-service' };
  for (const { record } of connections.values()) {
    if (record.serviceId === serviceId) return { ok: false, reason: 'already-open' };
  }
  if (connections.size >= MAX_LIVE_CONNECTIONS) return { ok: false, reason: 'limit' };
  if (webContentsInUse(webContents)) {
    throw new Error('openConnection: webContents already belongs to a connection');
  }
  let connectionId = mintConnectionId();
  while (connections.has(connectionId)) connectionId = mintConnectionId();
  const entry = createEntry(connectionId, serviceId, webContents, view);
  connections.set(connectionId, entry);
  return { ok: true, record: entry.record };
}

/**
 * Bind `wc` to a live connection. Idempotent for the same binding; throws for an
 * unknown connection, for a webContents already bound differently, and for one
 * that is a live connection's primary unless this is that primary's own binding
 * (invariant 3). A PiP joins its opener's `record.pips`.
 *
 * `pipSpaOrigin` is the remote-SPA origin main loaded a PiP from (null: bundled or
 * cached). It is written once, with the binding, and read only for role `'pip'`:
 * it records the origin main loaded into the PiP, and admission requires it to equal
 * the current remote-SPA origin (`pipSpaOriginFor`). Never renderer-supplied.
 */
export function bindSender(
  wc: WebContents,
  connectionId: ConnectionId,
  role: BindingRole,
  pipSpaOrigin: string | null = null
): void {
  const entry = connections.get(connectionId);
  if (!entry) throw new Error('bindSender: unknown connection');
  const existing = bindings.get(wc);
  if (existing) {
    if (existing.connectionId === connectionId && existing.role === role) return;
    throw new Error('bindSender: webContents is already bound to another connection or role');
  }
  for (const { record } of connections.values()) {
    if (record.webContents === wc && (record.connectionId !== connectionId || role !== 'primary')) {
      throw new Error("bindSender: webContents is another connection's primary");
    }
  }
  bindings.set(wc, Object.freeze({ connectionId, role }));
  if (role === 'pip') {
    entry.record.pips.add(wc);
    if (pipSpaOrigin !== null) pipSpaOrigins.set(wc, pipSpaOrigin);
  }
}

export function bindingFor(wc: WebContents): SenderBinding | undefined {
  return bindings.get(wc);
}

/** The remote-SPA origin `wc` was bound with as a PiP, or null (bundled, cached, unknown). */
export function pipSpaOriginFor(wc: WebContents): string | null {
  return bindings.get(wc)?.role === 'pip' ? (pipSpaOrigins.get(wc) ?? null) : null;
}

export function recordFor(id: ConnectionId): ConnectionRecord | undefined {
  return connections.get(id)?.record;
}

/**
 * The live record `wc` speaks for, only when its binding agrees with the record's
 * own membership: a primary must BE `record.webContents`, a PiP must be in
 * `record.pips`. A binding that disagrees (a main-process bug) admits nothing.
 */
export function boundRecordFor(
  wc: WebContents
): { readonly record: ConnectionRecord; readonly role: BindingRole } | undefined {
  const binding = bindings.get(wc);
  if (!binding) return undefined;
  const record = connections.get(binding.connectionId)?.record;
  if (!record || record.state === 'disposed') return undefined;
  const member = binding.role === 'primary' ? record.webContents === wc : record.pips.has(wc);
  return member ? { record, role: binding.role } : undefined;
}

/** A fresh frozen snapshot; never the record itself. */
export function refOf(record: ConnectionRecord): ConnectionRef {
  return Object.freeze({ connectionId: record.connectionId, generation: record.generation });
}

function deliver(notification: PendingNotification): void {
  pendingNotifications.push(notification);
  if (delivering) return; // the outer delivery drains it, in order (invariant 4)
  delivering = true;
  try {
    for (let next = pendingNotifications.shift(); next; next = pendingNotifications.shift()) {
      for (const listener of [...listeners]) {
        try {
          listener(next.id, next.from, next.to, next.reason);
        } catch {
          // Not rethrown: revocation already landed, the remaining listeners must
          // still run, and a throw here reaches main.ts's uncaughtException exit.
          console.warn(`[connectionRegistry] a generation listener threw (${next.reason})`);
        }
      }
    }
  } finally {
    delivering = false;
  }
}

/**
 * THE ONLY generation mutator. One synchronous block: write generation + 1 (which
 * revokes every older OwnerBinding, since currentness compares against the record)
 * → notify listeners. Throws for an unknown or already-disposed connection: there
 * is nothing left to revoke, and a caller reaching here with a dead id has its
 * lifecycle wrong. Event-driven callers that can fire after dispose (`destroyed`)
 * must resolve the record first.
 */
export function advanceGeneration(id: ConnectionId, reason: GenerationReason): Generation {
  const entry = connections.get(id);
  if (!entry) throw new Error('advanceGeneration: unknown connection');
  const [from, to] = entry.advance();
  deliver({ id, from, to, reason });
  return to;
}

/** Fired AFTER revocation, synchronously within `advanceGeneration`. Returns an unsubscribe. */
export function onGenerationAdvanced(listener: GenerationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Throws for an id that is not live; `null` clears. */
export function setForeground(id: ConnectionId | null): void {
  if (id !== null && !connections.has(id)) throw new Error('setForeground: unknown connection');
  foregroundId = id;
}

export function foreground(): ConnectionRecord | null {
  if (foregroundId === null) return null;
  return connections.get(foregroundId)?.record ?? null;
}

/**
 * advanceGeneration('disposed') → state 'disposed' → clear foreground if it was this
 * one → drop its bindings and the record. Idempotent: an unknown id is a no-op, and
 * so is a call made from a listener while this connection is already being
 * disposed, so `'disposed'` is announced once. The caller still owns destroying
 * the PiPs (`record.pips` is left intact for it), removing the view and closing
 * the webContents (§3.9 dispose order).
 */
export function disposeConnection(id: ConnectionId): void {
  const entry = connections.get(id);
  if (!entry || entry.disposing) return;
  entry.disposing = true;
  advanceGeneration(id, 'disposed');
  const { record } = entry;
  record.state = 'disposed';
  if (foregroundId === id) foregroundId = null;
  bindings.delete(record.webContents);
  for (const pip of record.pips) {
    bindings.delete(pip);
    pipSpaOrigins.delete(pip);
  }
  connections.delete(id);
}

export function liveConnections(): ConnectionRecord[] {
  return [...connections.values()].map((entry) => entry.record);
}

/** The bound primary webContents of every live connection (broadcast targets; grant nothing). */
export function primaries(): WebContents[] {
  const out: WebContents[] = [];
  for (const { record } of connections.values()) {
    if (boundRecordFor(record.webContents)?.role === 'primary') out.push(record.webContents);
  }
  return out;
}

export function _resetConnectionRegistryForTesting(): void {
  services.clear();
  serviceByOrigin.clear();
  connections.clear();
  bindings = new WeakMap<WebContents, SenderBinding>();
  pipSpaOrigins = new WeakMap<WebContents, string>();
  foregroundId = null;
  listeners.clear();
  pendingNotifications.length = 0;
  delivering = false;
}
