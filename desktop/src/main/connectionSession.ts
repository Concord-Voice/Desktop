// Per-connection session factory (spec 2026-11-09-86-connection-context-isolation §3.3).
//
// Each service runs on one Electron `Session`: `saas` keeps `session.defaultSession`,
// and every self-hosted service gets its own `session.fromPath` cookie jar, cache,
// storage and permission store. This module is the only place that configures one,
// and the only place that decides where a connection's document may navigate. The
// handler bodies are the ones `main.ts` installs on `defaultSession` today
// (`protocol.handle` ×2, the permission/device handlers, `select-hid-device`, the
// KLIPY injector, the `web-contents-created` gate), parametrised by service; #86
// Task 4 deletes those copies and calls this factory instead.
//
// INVARIANTS, and what breaks each one:
//
// 1. CONFIGURED ONCE, SECURITY HANDLERS FIRST. A `WeakSet<Session>` makes every call
//    after the first a no-op. `session.fromPath` returns the SAME `Session` for the
//    same path, so a retried `registerService` reaches that early return even after a
//    first attempt threw part-way. The permission handlers are therefore registered
//    before anything that can throw (`protocol.handle`): a session that failed
//    part-way is missing a protocol (nothing loads — closed), never its permission
//    handlers (Electron's default with no handler grants every request — open).
//    Breaks if a step that can throw moves above the permission handlers.
//
// 2. AUTHORITY COMES FROM THE BINDING, RESOLVED AT EACH EVENT. Every permission
//    request, every document permission check and every navigation resolves
//    `bindingFor(wc)` → `recordFor(connectionId)` when it happens, never when the
//    handler is installed: a view is bound AFTER `web-contents-created` fires (§3.9
//    creation order). No binding, no live record, or no service → the arbiter is
//    asked with `ref === null` (the default denies) and the navigation gate refuses
//    without externalizing. Breaks if a binding is captured at install time, or if an
//    unresolved binding falls through to a permissive default.
//
// 3. A SERVICE'S CREDENTIAL REACHES ONLY ITS OWN ORIGIN. The KLIPY injector reads
//    THIS service's custody, synchronously per request, and adds `Authorization` only
//    when the request's `URL.origin` equals `service.origin` exactly. The webRequest
//    filter is a pre-filter, not the guard: a URL pattern that omits the port matches
//    every port. Another service's origin loaded inside this session gets no header.
//
// 4. THE REMOTE SPA AND ITS LKG CACHE ARE SAAS-ONLY (C7). `spa-cache://` is handled
//    only on the `saas` session, and the navigation gate admits the remote SPA origin
//    and `spa-cache://concord` only for a `saas`-bound document. A self-hosted document
//    may navigate to `app://concord` alone (any `localhost` in dev builds).
//
// 5. R1: NOTHING BUT `saas` RUNS ON `defaultSession`. `assertDefaultSessionIsSaas`
//    throws for any webContents on `defaultSession` whose binding does not resolve to
//    the `saas` service — unbound included.
//
// Calls that carry NO webContents — a permission check made off-document (Electron
// documents `notifications` checks and service-worker checks as always `null`) and
// every device check — have no binding to resolve. They keep today's static policy
// rather than reach the arbiter with `null`, which would deny every desktop
// notification and every security key on every connection. A check is a status
// query; the grant itself goes through the request handler, which always names a
// webContents and so always goes through the binding.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, net, session, shell, type Session, type WebContents } from 'electron';
import {
  SAAS_SERVICE_ID,
  type ConnectionId,
  type ConnectionRef,
  type ServiceId,
  type ServiceKind,
} from '../shared/connectionIdentity';
import { isSupportedDesktopClientVersion } from '../shared/stableDesktopVersion';
import { resolveAppProtocolPath } from './appProtocol';
import { isBillingWebContents } from './billing/billingWindow';
import type { ConnectionRecord, SenderBinding, ServiceRecord } from './connectionRegistry';
import { isPermittedFrameUrlForKind } from './ipc/frameValidation';
import { handleCacheProtocolRequest } from './spaCache/cacheProtocol';
import { SPA_CACHE_HOST, SPA_CACHE_SCHEME } from './spaCache/manifestSchema';

/**
 * Decides every permission a connection's document asks for (#86 §3.3 item 2). #87
 * replaces the default through {@link setCaptureArbiter}. The parameter list is
 * deliberately open: #87 adds an optional context argument, so nothing here may
 * check `decide.length`.
 */
export interface CaptureArbiter {
  decide(ref: ConnectionRef | null, permission: string, details: unknown): boolean;
}

/** Today's policy: deny `geolocation`, allow the rest. */
const DENIED_PERMISSIONS: ReadonlySet<string> = new Set(['geolocation']);

/** Device classes today's handler permits (`hid` carries WebAuthn security keys). */
const PERMITTED_DEVICE_TYPES: ReadonlySet<string> = new Set([
  'camera',
  'microphone',
  'speaker',
  'hid',
]);

/** One path segment: `profiles/<dirKey>/session` must not climb out of `profiles/`. */
const SAFE_DIR_KEY = /^[0-9A-Za-z_-]+$/;

function staticPolicyAllows(permission: string): boolean {
  return !DENIED_PERMISSIONS.has(permission);
}

/** An unbound requester (`ref === null`) is denied; otherwise today's policy. */
export const defaultCaptureArbiter: CaptureArbiter = Object.freeze({
  decide(ref: ConnectionRef | null, permission: string): boolean {
    if (ref === null) return false;
    return staticPolicyAllows(permission);
  },
});

let currentArbiter: CaptureArbiter = defaultCaptureArbiter;

export function captureArbiter(): CaptureArbiter {
  return currentArbiter;
}

/**
 * Install `arbiter` (#87's hook). The returned function restores the default, and
 * only while `arbiter` is still the installed one, so a stale unsubscribe cannot
 * remove its successor.
 */
export function setCaptureArbiter(arbiter: CaptureArbiter): () => void {
  if (typeof arbiter?.decide !== 'function') {
    throw new TypeError('setCaptureArbiter: arbiter.decide must be a function');
  }
  currentArbiter = arbiter;
  return () => {
    if (currentArbiter === arbiter) currentArbiter = defaultCaptureArbiter;
  };
}

export interface ConnectionSessionDeps {
  isPackaged: boolean;
  /** The asar renderer root `app://concord` serves from. */
  bundleRoot: string;
  /** The verified LKG cache directory; `null` serves nothing. */
  getLiveDir(): string | null;
  /** The active remote SPA's canonical origin, or `null`. */
  remoteSpaOrigin(): string | null;
  bindingFor(wc: WebContents): SenderBinding | undefined;
  recordFor(id: ConnectionId): ConnectionRecord | undefined;
  getService(id: ServiceId): ServiceRecord | undefined;
  /** The foreground connection, or null (connectionRegistry `foreground`). */
  foreground(): ConnectionRecord | null;
}

/** `saas` → `defaultSession`; a self-hosted service → its own `fromPath` session. */
export function sessionForService(
  kind: ServiceKind,
  dirKey: string,
  userDataRoot: string
): Session {
  if (kind === 'saas') return session.defaultSession;
  if (kind === 'selfhost' && SAFE_DIR_KEY.test(dirKey)) {
    return session.fromPath(path.join(userDataRoot, 'profiles', dirKey, 'session'));
  }
  throw new Error('sessionForService: no session for this service kind or directory key');
}

let configuredSessions = new WeakSet<Session>();

/** The live record `wc` is bound to, or null (invariant 2). */
function boundRecord(wc: WebContents, deps: ConnectionSessionDeps): ConnectionRecord | null {
  const binding = deps.bindingFor(wc);
  if (!binding) return null;
  const record = deps.recordFor(binding.connectionId);
  if (!record || record.state === 'disposed') return null;
  return record;
}

/** Web clipboard permissions: never decided by the capture arbiter (#199). */
const CLIPBOARD_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'clipboard-read',
]);

/**
 * #199 re-expressed for #86: "the live main window's main frame" is the FOREGROUND
 * connection's bound primary, asking from its main frame at a URL permitted for its
 * service kind. A PiP, a background view, a subframe and an unbound webContents are
 * denied. What breaks it: routing clipboard through the arbiter, which #87 replaces.
 */
function clipboardAllowed(wc: WebContents, details: unknown, deps: ConnectionSessionDeps): boolean {
  const binding = deps.bindingFor(wc);
  if (!binding || binding.role !== 'primary') return false;
  const record = deps.recordFor(binding.connectionId);
  if (!record || record.state === 'disposed' || record.webContents !== wc) return false;
  if (deps.foreground() !== record) return false;
  const d = details as { isMainFrame?: unknown; requestingUrl?: unknown } | null | undefined;
  if (d?.isMainFrame !== true || typeof d.requestingUrl !== 'string') return false;
  const service = deps.getService(record.serviceId);
  if (!service) return false;
  return isPermittedFrameUrlForKind(d.requestingUrl, service.kind, deps.remoteSpaOrigin());
}

/** Ask the installed arbiter. A throw, or anything but `true`, denies. */
function decideFor(
  wc: WebContents,
  permission: string,
  details: unknown,
  deps: ConnectionSessionDeps
): boolean {
  try {
    if (CLIPBOARD_PERMISSIONS.has(permission)) return clipboardAllowed(wc, details, deps);
    const record = boundRecord(wc, deps);
    const ref: ConnectionRef | null = record
      ? Object.freeze({ connectionId: record.connectionId, generation: record.generation })
      : null;
    return currentArbiter.decide(ref, permission, details) === true;
  } catch {
    return false;
  }
}

/**
 * KLIPY media proxy auth injection (#626): `<img>`/`<video>` src attributes send
 * plain GETs without Authorization headers, so this adds the cached JWT for the
 * authenticated media proxy. Origin-restricted to THIS service (invariant 3).
 */
function injectKlipyHeaders(
  details: Electron.OnBeforeSendHeadersListenerDetails,
  service: ServiceRecord
): void {
  try {
    if (new URL(details.url).origin !== service.origin) return;
    const token = service.custody.getCachedAccessToken();
    if (typeof token !== 'string' || token === '') return;
    details.requestHeaders['Authorization'] = `Bearer ${token}`;
    const clientVersion = app.getVersion();
    if (isSupportedDesktopClientVersion(clientVersion)) {
      details.requestHeaders['X-Concord-Client-Version'] = clientVersion;
    }
  } catch {
    // Malformed URL or a custody read that threw — skip injection, never block the request.
  }
}

function registerPermissionHandlers(ses: Session, deps: ConnectionSessionDeps): void {
  // Requests always name a webContents, so every grant goes through the binding.
  // Notifications are allowed (JIT-managed by permissionManager #197).
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(decideFor(wc, permission, details, deps));
  });

  // Chromium queries this synchronously to verify grants; a document check resolves
  // its binding like a request. `null` is an off-document check (module header).
  ses.setPermissionCheckHandler((wc, permission, _requestingOrigin, details) =>
    wc === null
      ? !CLIPBOARD_PERMISSIONS.has(permission) && staticPolicyAllows(permission)
      : decideFor(wc, permission, details, deps)
  );

  // Device checks carry an origin and no webContents (module header).
  ses.setDevicePermissionHandler((details) => PERMITTED_DEVICE_TYPES.has(details.deviceType));

  // HID device selection: auto-select for WebAuthn hardware security keys in every
  // connection, self-hosted views included.
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    if (details.deviceList && details.deviceList.length > 0) {
      callback(details.deviceList[0].deviceId);
    } else {
      callback('');
    }
  });
}

/** `spa-cache://` (#1870) — the VERIFIED last-known-good SPA cache, resolved per request. */
function serveSpaCache(request: Request, deps: ConnectionSessionDeps): Promise<Response> {
  const liveDir = deps.getLiveDir();
  if (liveDir === null) return Promise.resolve(new Response(null, { status: 404 }));
  return handleCacheProtocolRequest(request, () => liveDir);
}

function registerProtocols(
  ses: Session,
  service: ServiceRecord,
  deps: ConnectionSessionDeps
): void {
  if (!deps.isPackaged) return;
  const { bundleRoot } = deps;
  // app:// (#830) — serves the bundled SPA from the asar bundle root. The pure
  // resolver validates the URL and rejects path traversal; net.fetch reads asar
  // paths transparently. pathToFileURL, not string concat, for Windows drive paths.
  ses.protocol.handle('app', async (request) => {
    const result = resolveAppProtocolPath(request.url, bundleRoot);
    if (!result.ok || !result.absolutePath) {
      return new Response(null, { status: result.status });
    }
    return net.fetch(pathToFileURL(result.absolutePath).href);
  });
  // A self-hosted view never loads the remote SPA or its cache (invariant 4).
  if (service.kind === 'saas') {
    ses.protocol.handle(SPA_CACHE_SCHEME, (request) => serveSpaCache(request, deps));
  }
}

/** Configure `ses` for `service`, exactly once per Session (invariant 1). */
export function configureConnectionSession(
  ses: Session,
  service: ServiceRecord,
  deps: ConnectionSessionDeps
): void {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  registerPermissionHandlers(ses, deps);
  ses.webRequest.onBeforeSendHeaders(
    { urls: [`${service.origin}/api/v1/klipy/media*`] },
    (details, callback) => {
      injectKlipyHeaders(details, service);
      callback({ requestHeaders: details.requestHeaders });
    }
  );
  registerProtocols(ses, service, deps);
}

/** The kind of the service `wc` is bound to, or null when it is not bound. */
function boundKind(wc: WebContents, deps: ConnectionSessionDeps): ServiceKind | null {
  const record = boundRecord(wc, deps);
  if (!record) return null;
  return deps.getService(record.serviceId)?.kind ?? null;
}

/**
 * Packaged in-window navigation allowlist for a connection of `kind`. `app://concord`
 * for every kind; the remote SPA origin and `spa-cache://concord` for `saas` only.
 * The two non-special schemes compare protocol + host (`URL.origin` is the literal
 * "null" for them); the remote SPA compares canonical origins.
 */
function isPermittedPackagedNavTarget(
  parsedUrl: URL,
  kind: ServiceKind,
  spaOrigin: string | null
): boolean {
  if (parsedUrl.protocol === 'app:' && parsedUrl.host === 'concord') return true;
  if (kind !== 'saas') return false;
  if (spaOrigin && parsedUrl.origin === spaOrigin) return true;
  return parsedUrl.protocol === `${SPA_CACHE_SCHEME}:` && parsedUrl.host === SPA_CACHE_HOST;
}

/** Fire-and-forget; https only, symmetric with the open-external IPC handler (#754). */
function externalizeHttps(url: string): void {
  try {
    if (new URL(url).protocol !== 'https:') return;
  } catch {
    return;
  }
  shell.openExternal(url).catch(() => {});
}

function gateNavigation(
  event: { preventDefault(): void },
  navigationUrl: string,
  kind: ServiceKind | null,
  deps: ConnectionSessionDeps
): void {
  // Unbound fails closed: no navigation and no externalization (invariant 2).
  if (kind === null) {
    event.preventDefault();
    return;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(navigationUrl);
  } catch {
    // Malformed URL — fail closed. Do not navigate, do not externalize.
    event.preventDefault();
    return;
  }
  if (deps.isPackaged) {
    if (isPermittedPackagedNavTarget(parsedUrl, kind, deps.remoteSpaOrigin())) return;
  } else if (parsedUrl.hostname === 'localhost') {
    // Dev mode: allow any localhost port (HMR), block everything else.
    return;
  }
  event.preventDefault();
  // Drift safety net: an https: navigation goes to the OS browser so a bare <a> link
  // or SPA-driven redirect does not silently fail. javascript:, data:, file:, http:
  // and the rest are dropped after preventDefault.
  externalizeHttps(navigationUrl);
}

/**
 * The navigation gate for one webContents (`web-contents-created`). Every in-app
 * `window.open` is denied; a bound document's https: target goes to the OS browser.
 * `will-navigate` admits only the targets of the connection's kind.
 */
export function installNavigationGate(contents: WebContents, deps: ConnectionSessionDeps): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (boundKind(contents, deps) !== null) externalizeHttps(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, navigationUrl) => {
    // The billing view runs its own Stripe-only gate (billing/billingWindow.ts), and
    // this check must stay first: the view joins that set before its loadURL.
    if (isBillingWebContents(contents)) return;
    gateNavigation(event, navigationUrl, boundKind(contents, deps), deps);
  });
}

/** Main-process requests that must carry this service's cookies use its own session. */
export function sessionFetchFor(
  service: ServiceRecord
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init) => service.session.fetch(url, init);
}

/** Throws on the R1 breach (invariant 5). Pass every live webContents. */
export function assertDefaultSessionIsSaas(
  live: Iterable<WebContents>,
  bindingFor: (wc: WebContents) => SenderBinding | undefined,
  recordFor: (id: ConnectionId) => ConnectionRecord | undefined
): void {
  for (const wc of live) {
    if (wc.session !== session.defaultSession) continue;
    const binding = bindingFor(wc);
    const serviceId = binding ? recordFor(binding.connectionId)?.serviceId : undefined;
    if (serviceId !== SAAS_SERVICE_ID) {
      throw new Error('R1: a webContents that is not the saas connection runs on defaultSession');
    }
  }
}

export function _resetConnectionSessionForTesting(): void {
  currentArbiter = defaultCaptureArbiter;
  configuredSessions = new WeakSet<Session>();
}
