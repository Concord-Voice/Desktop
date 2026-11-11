// Shell window composition (spec 2026-11-09-86-connection-context-isolation §3.4, §3.9).
//
// One `BaseWindow` is the trusted shell. Each live connection is one `WebContentsView`
// child on that service's own `Session` (`saas` on `defaultSession`, a self-hosted
// service on its `fromPath` session). Exactly one view is the foreground: it fills the
// window's content area and the rest are hidden. This module owns the views, their
// PiP windows, and the only paths main uses to push into a connection's document.
//
// INVARIANTS, and what breaks each one:
//
// 1. EVERY LISTENER EXISTS BEFORE THE DOCUMENT CAN RUN (§3.9, #3394). A view is opened
//    in this order: `openConnection` → `bindSender('primary')` → the R1 check →
//    `wireAudiocapRendererLoss` → `attachTrayResetHooks` → the `did-start-loading`
//    deep-link reset → the generation hooks → `addChildView` → load. The renderer is
//    live long before an awaited load resolves, so a hook wired after the load misses
//    every loss inside it. Breaks if any wiring moves below the load call.
//
// 2. REVOCATION LANDS BEFORE TEARDOWN. `disposeConnectionView` runs
//    `advanceGeneration('disposed')` (inside `disposeConnection`, which also clears the
//    foreground and the bindings) → destroys the connection's PiPs → `removeChildView`
//    → `webContents.close()`. A handler resuming after an `await` then finds its ref
//    stale before any window it might touch has gone. Breaks if a destroy or close
//    moves above `disposeConnection`.
//
// 3. A PUSH REACHES ONLY THE DOCUMENT IT WAS MEANT FOR. `sendToConnection` delivers only
//    while the ref's generation equals the record's at send time, so a push computed
//    for a document that has since navigated, crashed, changed credential or been
//    disposed is dropped. Breaks if it compares connection ids alone, or reads the
//    generation when the push was computed rather than when it is sent.
//
// 4. NO ORPHAN RENDERERS (Task 0, Review Focus 5). A child view's webContents is NOT
//    destroyed when its `BaseWindow` closes: measured on Electron 45, both children and
//    their renderer pids outlived `closed`. The `closed` handler therefore disposes
//    every live connection and closes its webContents explicitly. Breaks if `closed`
//    only drops the window reference.
//
// 5. R1: NOTHING BUT `saas` RUNS ON `defaultSession`. A view is checked with
//    `assertDefaultSessionIsSaas` over every live connection's contents (primaries and
//    PiPs, never the unbound splash) after it is bound and before anything is wired or
//    loaded. A breach disposes the new connection and closes its view. A PiP is built on
//    its opener's session, never on a session named by the caller.
//
// 6. A HIDDEN VIEW NEVER PAINTS OVER THE FOREGROUND. `layoutViews` runs after every
//    geometry change (`resize`, `maximize`, `unmaximize`, `enter-full-screen`,
//    `leave-full-screen`, `restore`) and every foreground change: the foreground gets
//    the content area (`{ x: 0, y: 0 }` — view bounds are relative to the window) and
//    every other view `setVisible(false)`.
//
// ─── `mainWindow.webContents` consumers (Task 4 checklist §5) ───────────────────────
//
// The 27 sites `grep -n 'mainWindow\.webContents\|mainWindow?\.webContents' main.ts`
// found before #86, and what each became. "saas primary" is the `saas` connection's
// view: the remote SPA, deep links and the legacy single-renderer handlers live only
// there. Task 7B re-derives the transitional rows from the sender binding.
//
// | main.ts site (pre-#86)                         | Class             | Now                                           |
// |------------------------------------------------|-------------------|-----------------------------------------------|
// | :879 `deeplink:friend-code` send               | saas-only push    | `sendToConnection(ref of saas primary)`       |
// | :882 `invite:received` send                    | saas-only push    | `sendToConnection(ref of saas primary)`       |
// | :1347 `did-start-loading` → deep-link reset    | view wiring       | `openConnectionView`, saas view only          |
// | :1358 `wireAudiocapRendererLoss`               | view wiring       | `openConnectionView`, every view              |
// | :1424 dev `openDevTools()`                     | view wiring       | saas view, `{ mode: 'detach' }`               |
// | :1430/:1431 developer-mode `openDevTools`      | view wiring       | saas view, `{ mode: 'detach' }`               |
// | :1436/:1442/:1443/:1445 DevTools key toggle    | view wiring       | per view (`wireView`), toggles that view      |
// | :1520 `attachTrayResetHooks`                   | view wiring       | `openConnectionView`, every view              |
// | :1534 `render-process-gone` log + reset        | view wiring       | per view; deep-link reset on the saas view    |
// | :1611 `audiocap:interrupted` send              | owner push        | saas primary (audiocap admits it alone, T7B)  |
// | :1635 `audiocap:port` postMessage              | owner push        | saas primary (audiocap admits it alone, T7B)  |
// | :1846 `update:rollback` send                   | updater push      | `broadcastToPrimaries`                        |
// | :1857 `auth:token-refreshed` send              | connection push   | `sendToConnection(ref of the refreshing service's view)` |
// | :1888 `audiocap:capability` send               | machine-fact push | `broadcastToPrimaries`                        |
// | :2310/:2311/:2313/:2314 developer-mode toggle  | app-global-mutate | `foregroundWebContents()`                     |
// | :3028 PiP spa-cache origin check               | PiP               | the opener's own `webContents.getURL()`       |
// | :3055 `pip:closed` send                        | PiP push          | `sendToConnection(opener ref at open)`        |
// | :3062 `pip:opened` send                        | PiP push          | `sendToConnection(opener ref at open)`        |
// | :3114 `invite:renderer-ready` sender check     | saas-only         | `event.sender === saas primary`               |
// | :3123 `deeplink:renderer-ready` sender check   | saas-only         | `event.sender === saas primary`               |
//
// Window-level consumers (not in the grep) moved to `shellWindow()`: content
// protection, window state, the close/minimize intercepts, flash/focus, the tray's
// activate, dialogs' parent, the title-bar overlay and the billing sheet's parent.
// The tray status/action pair and permission pushes use the foreground primary.

import {
  app,
  BaseWindow,
  BrowserWindow,
  Menu,
  WebContentsView,
  type BaseWindowConstructorOptions,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebPreferences,
} from 'electron';
import {
  SAAS_SERVICE_ID,
  type ConnectionId,
  type ConnectionRef,
  type GenerationReason,
  type ServiceId,
} from '../shared/connectionIdentity';
import {
  advanceGeneration,
  allServices,
  bindSender,
  bindingFor,
  boundRecordFor,
  disposeConnection,
  foreground,
  getService,
  liveConnections,
  openConnection,
  primaries,
  recordFor,
  setForeground,
  type ConnectionRecord,
  type ServiceRecord,
} from './connectionRegistry';
import { assertDefaultSessionIsSaas } from './connectionSession';
import { writeConnectionsFile, type ConnectionsFileEntry } from './connectionsFile';

export interface ShellDeps {
  /** `buildBrowserWindowConfig` minus `webPreferences`, plus the restored bounds. */
  windowOptions: BaseWindowConstructorOptions;
  preloadPath: string;
  /** `buildBrowserWindowConfig`'s `webPreferences`, used unchanged for every view. */
  webPreferences?: WebPreferences;
  /** Painted behind a view's first frame, as the BrowserWindow's own colour was. */
  viewBackgroundColor?: string;
  contentProtectionEnabled: boolean;
  applyContentProtectionAtCreation(win: BaseWindow, enabled: boolean, label: string): void;
  wireAudiocapRendererLoss(webContents: WebContents): void;
  attachTrayResetHooks(webContents: WebContents): void;
  resetDeepLinkDelivery(): void;
  /** `configureConnectionSession` for the service; may throw (Review Focus 2). */
  prepareSession(service: ServiceRecord): void;
  isQuitting(): boolean;
  /** The client-behaviour close intercept; runs only while no quit is underway (#1383). */
  onClose(event: Electron.Event): void;
  /** After every connection of the window has been disposed. */
  onClosed?(): void;
  /** main.ts's own per-view listeners; runs before the view is loaded (invariant 1). */
  wireView?(webContents: WebContents, service: ServiceRecord): void;
  /** What the dev Connections menu loads into a view it opens. */
  devConnectionUrl?: string;
}

export type OpenConnectionViewResult =
  | { ok: true; record: ConnectionRecord }
  | { ok: false; reason: 'limit' | 'already-open' | 'unknown-service' | 'session-unavailable' };

/** Loads the view's first document; the default is a plain `loadURL(url)`. */
export type ConnectionViewLoader = (webContents: WebContents, url: string) => Promise<unknown>;

const DEFAULT_CONNECTION_URL = 'app://concord/index.html';

let shell: BaseWindow | null = null;
let deps: ShellDeps | null = null;
let devMenuInstalled = false;
const credentialUnsubscribers = new Map<ConnectionId, () => void>();
const tearingDown = new Set<ConnectionId>();
/** PiP windows this module built, by their webContents (record.pips holds only contents). */
const pipWindows = new Map<WebContents, BrowserWindow>();

function closeQuietly(webContents: WebContents): void {
  try {
    if (!webContents.isDestroyed()) webContents.close();
  } catch {
    // Already gone; nothing is left to close.
  }
}

function viewPreferences(d: ShellDeps, service: ServiceRecord): WebPreferences {
  return {
    ...d.webPreferences,
    preload: d.preloadPath,
    session: service.session,
    // Spec §9 item 4: hidden views keep Chromium's default throttling; Task 0 kept it.
    backgroundThrottling: true,
    // Pinned last so no caller-supplied preference can loosen them (spec §4).
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  };
}

/** Invariant 5. Every live connection's contents — primaries and PiPs, nothing unbound. */
function defaultSessionStaysSaas(): boolean {
  const live: WebContents[] = [];
  for (const record of liveConnections()) live.push(record.webContents, ...record.pips);
  try {
    assertDefaultSessionIsSaas(live, bindingFor, recordFor);
    return true;
  } catch {
    return false;
  }
}

function advanceIfLive(id: ConnectionId, reason: GenerationReason): void {
  const record = recordFor(id);
  if (!record || record.state === 'disposed') return;
  advanceGeneration(id, reason);
}

/** R6: the only generation triggers a view has (spec §0 R6). */
function installGenerationHooks(record: ConnectionRecord, service: ServiceRecord): void {
  const id = record.connectionId;
  const contents = record.webContents;
  contents.on('did-start-navigation', (details) => {
    // A same-document navigation (hash route, pushState) keeps the document.
    if (!details.isMainFrame || details.isSameDocument) return;
    advanceIfLive(id, 'document');
  });
  contents.on('render-process-gone', () => advanceIfLive(id, 'renderer-gone'));
  contents.on('destroyed', () => disposeConnectionView(id));
  credentialUnsubscribers.set(
    id,
    service.custody.onCredentialEvent((phase) => advanceIfLive(id, phase))
  );
}

const loadUrl: ConnectionViewLoader = (webContents, url) => webContents.loadURL(url);

/**
 * Open `serviceId`'s connection in a new view and load it (§3.9 creation order,
 * invariant 1). Refusals have no lasting side effect: a view built for a refused
 * connection is closed before this returns. The first view opened becomes the
 * foreground. `load` replaces the plain `loadURL` (the saas view's remote → cache →
 * bundled chain); a load that rejects is logged and leaves the connection open.
 */
export async function openConnectionView(
  serviceId: ServiceId,
  url: string,
  load: ConnectionViewLoader = loadUrl
): Promise<OpenConnectionViewResult> {
  const win = shell;
  const d = deps;
  if (!win || win.isDestroyed() || !d) throw new Error('openConnectionView: no shell window');
  const service = getService(serviceId);
  if (!service) return { ok: false, reason: 'unknown-service' };
  try {
    d.prepareSession(service);
  } catch {
    // Fixed text: the error can carry a filesystem path under the user's profile.
    console.warn('[shellWindow] connection session unavailable; the connection was not opened');
    return { ok: false, reason: 'session-unavailable' };
  }

  const view = new WebContentsView({ webPreferences: viewPreferences(d, service) });
  if (d.viewBackgroundColor) view.setBackgroundColor(d.viewBackgroundColor);
  const contents = view.webContents;
  const opened = openConnection(serviceId, contents, view);
  if (!opened.ok) {
    closeQuietly(contents);
    return opened;
  }
  const { record } = opened;
  bindSender(contents, record.connectionId, 'primary');
  if (!defaultSessionStaysSaas()) {
    console.error('[shellWindow] R1: a non-saas connection reached defaultSession; refused');
    disposeConnection(record.connectionId);
    closeQuietly(contents);
    return { ok: false, reason: 'session-unavailable' };
  }

  d.wireAudiocapRendererLoss(contents);
  d.attachTrayResetHooks(contents);
  // Deep links are saas-only (§3.7): another view's load must not clear the saas
  // renderer's readiness, or links queue until the saas view itself reloads.
  if (service.kind === 'saas') contents.on('did-start-loading', () => d.resetDeepLinkDelivery());
  installGenerationHooks(record, service);
  d.wireView?.(contents, service);

  win.contentView.addChildView(view);
  if (foreground() === null) setForeground(record.connectionId);
  layoutViews();
  refreshDevConnectionMenu();

  try {
    await load(contents, url);
  } catch {
    console.warn('[shellWindow] connection view load failed');
  }
  return { ok: true, record };
}

/** The restored `connections.json` entries, kept so a foreground change can be recorded. */
let persisted: { root: string; entries: ConnectionsFileEntry[] } | null = null;

/** Layout only: stamps `lastForegroundAt` on the entry, never adds or admits one. */
function recordForeground(serviceId: ServiceId): void {
  const state = persisted;
  if (!state) return;
  const index = state.entries.findIndex((e) => e.serviceId === serviceId);
  if (index < 0) return;
  const entries = [...state.entries];
  entries[index] = { ...entries[index], lastForegroundAt: new Date().toISOString() };
  state.entries = entries;
  writeConnectionsFile(state.root, entries).catch(() => {
    console.warn('[shellWindow] connections.json was not updated');
  });
}

/**
 * Append the entries `connection:create` opened (#86 §3.7) to the restored list and
 * write the whole list. An entry whose serviceId is already listed is kept as it is.
 * Refuses (rejects, writing nothing) before startup restore has run: without the
 * restored list, a write would replace the user's other connections.
 */
export function persistAddedConnections(added: readonly ConnectionsFileEntry[]): Promise<void> {
  const state = persisted;
  if (!state) return Promise.reject(new Error('connections.json not restored yet'));
  const fresh = added.filter((a) => !state.entries.some((e) => e.serviceId === a.serviceId));
  if (fresh.length === 0) return Promise.resolve();
  state.entries = [...state.entries, ...fresh];
  return writeConnectionsFile(state.root, state.entries);
}

function showConnection(serviceId: ServiceId, record: boolean): boolean {
  const target = liveConnections().find((r) => r.serviceId === serviceId && r.state !== 'disposed');
  if (!target) return false;
  const changed = foreground()?.connectionId !== target.connectionId;
  setForeground(target.connectionId);
  layoutViews();
  if (record && changed) recordForeground(serviceId);
  try {
    target.webContents.focus();
  } catch {
    // Keyboard focus is best-effort; the view is shown either way.
  }
  refreshDevConnectionMenu();
  return true;
}

/** The live connection of `serviceId` becomes the only visible view. */
export function activateConnection(serviceId: ServiceId): boolean {
  return showConnection(serviceId, true);
}

/**
 * The entry to show first: the latest `lastForegroundAt`, else the first in file
 * order (P0 puts the self-hosted profile the pointer named first). Layout only.
 */
function entryToForeground(entries: readonly ConnectionsFileEntry[]): ConnectionsFileEntry | null {
  let best: ConnectionsFileEntry | null = null;
  for (const entry of entries) {
    if (entry.lastForegroundAt === null) continue;
    if (best === null || entry.lastForegroundAt > (best.lastForegroundAt ?? '')) {
      best = entry;
    }
  }
  return best ?? entries[0] ?? null;
}

/**
 * Startup (#86 §3.6): open one view per validated `connections.json` entry after the
 * saas view, which the caller has already opened. `register` re-admits each origin
 * through the registry, so an entry whose origin is no longer approved opens nothing.
 * The views are created in file order before any of them finishes loading.
 */
export async function restorePersistedConnections(
  userDataRoot: string,
  entries: readonly ConnectionsFileEntry[],
  register: (origin: string) => ServiceRecord | null
): Promise<void> {
  persisted = { root: userDataRoot, entries: [...entries] };
  const url = deps?.devConnectionUrl ?? DEFAULT_CONNECTION_URL;
  const loads: Promise<void>[] = [];
  for (const entry of entries) {
    if (entry.serviceId === SAAS_SERVICE_ID) continue;
    if (liveConnections().some((r) => r.serviceId === entry.serviceId)) continue;
    const service = register(entry.origin);
    if (!service || service.serviceId !== entry.serviceId) continue;
    // Everything before the view's load runs synchronously, so the record exists on return.
    loads.push(
      openConnectionView(service.serviceId, url).then((result) => {
        if (!result.ok) console.warn(`[shellWindow] connection not restored (${result.reason})`);
      })
    );
  }
  const first = entryToForeground(entries);
  if (first) showConnection(first.serviceId, false);
  await Promise.all(loads);
}

/** Invariant 6. A no-op with no window; with no foreground every view is hidden. */
export function layoutViews(): void {
  const win = shell;
  if (!win || win.isDestroyed()) return;
  const fg = foreground();
  const { width, height } = win.getContentBounds();
  for (const record of liveConnections()) {
    const view = record.view;
    if (!view) continue;
    if (fg !== null && record.connectionId === fg.connectionId) {
      view.setBounds({ x: 0, y: 0, width, height });
      view.setVisible(true);
    } else {
      view.setVisible(false);
    }
  }
}

export function shellWindow(): BaseWindow | null {
  return shell && !shell.isDestroyed() ? shell : null;
}

export function foregroundWebContents(): WebContents | null {
  const fg = foreground();
  if (!fg || fg.state === 'disposed' || fg.webContents.isDestroyed()) return null;
  return fg.webContents;
}

export function foregroundView(): WebContentsView | null {
  return foreground()?.view ?? null;
}

/** The live `saas` connection: the remote SPA, deep links and the legacy handlers. */
export function saasPrimary(): ConnectionRecord | null {
  return liveConnections().find((r) => r.serviceId === SAAS_SERVICE_ID) ?? null;
}

/**
 * TRANSITIONAL (#86 Task 4 → Task 7B): a primary in the `{ isDestroyed, webContents }`
 * shape the pre-#86 handlers took from the main `BrowserWindow`. A handle reads as
 * destroyed once its connection is no longer the one it was taken for. Task 7B
 * resolves those handlers' connection from the sender binding and deletes these.
 */
export interface PrimaryHandle {
  isDestroyed(): boolean;
  readonly webContents: WebContents;
}

function handleFor(record: ConnectionRecord | null): PrimaryHandle | null {
  if (!record || record.state === 'disposed') return null;
  const { connectionId, webContents } = record;
  return {
    isDestroyed: () => webContents.isDestroyed() || recordFor(connectionId) !== record,
    webContents,
  };
}

/** TRANSITIONAL: the foreground view (tray status/actions, permission pushes). */
export function foregroundPrimaryHandle(): PrimaryHandle | null {
  return handleFor(foreground());
}

/** TRANSITIONAL: the saas view (audiocap admission and its owner pushes). */
export function saasPrimaryHandle(): PrimaryHandle | null {
  return handleFor(saasPrimary());
}

function sendTo(contents: WebContents, channel: string, args: unknown[]): boolean {
  try {
    if (contents.isDestroyed()) return false;
    contents.send(channel, ...args);
    return true;
  } catch {
    // Destroyed between the check and the send.
    return false;
  }
}

/** Invariant 3. `false`, and nothing sent, unless `ref` is current and its contents alive. */
export function sendToConnection(ref: ConnectionRef, channel: string, ...args: unknown[]): boolean {
  const record = recordFor(ref.connectionId);
  if (!record || record.state === 'disposed' || record.generation !== ref.generation) {
    return false;
  }
  return sendTo(record.webContents, channel, args);
}

/** Every live primary. For pushes that grant nothing (updater, machine facts). */
export function broadcastToPrimaries(channel: string, ...args: unknown[]): void {
  for (const contents of primaries()) sendTo(contents, channel, args);
}

function destroyPip(pipContents: WebContents): void {
  const pip = pipWindows.get(pipContents);
  pipWindows.delete(pipContents);
  try {
    // destroy(), not close(): a PiP's beforeunload guard must not veto (#2207).
    if (pip && !pip.isDestroyed()) pip.destroy();
  } catch {
    // Already gone.
  }
}

function teardown(connectionId: ConnectionId, detach: boolean): void {
  const record = recordFor(connectionId);
  if (!record || tearingDown.has(connectionId)) return;
  tearingDown.add(connectionId);
  try {
    const pips = [...record.pips];
    const view = record.view;
    credentialUnsubscribers.get(connectionId)?.();
    credentialUnsubscribers.delete(connectionId);
    disposeConnection(connectionId); // 'disposed' → foreground cleared → bindings dropped
    for (const pip of pips) destroyPip(pip);
    const win = shell;
    if (detach && view && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        // The window went away underneath us; closing the contents still follows.
      }
    }
    closeQuietly(record.webContents);
    record.view = null;
  } finally {
    tearingDown.delete(connectionId);
  }
  layoutViews();
  refreshDevConnectionMenu();
}

/** Invariant 2. A no-op for an id that is not live. */
export function disposeConnectionView(connectionId: ConnectionId): void {
  teardown(connectionId, true);
}

/**
 * Build a PiP window for `opener`'s connection (R8): on the opener's own session
 * whatever `options` names, sandboxed, and bound `'pip'` to that connection. Only a
 * bound, live primary may open one; anything else gets `null` and no window.
 */
export function createPipWindow(
  opener: WebContents,
  options: BrowserWindowConstructorOptions
): BrowserWindow | null {
  const bound = boundRecordFor(opener);
  if (!bound || bound.role !== 'primary') return null;
  const service = getService(bound.record.serviceId);
  if (!service) return null;
  const connectionId = bound.record.connectionId;
  const pip = new BrowserWindow({
    ...options,
    webPreferences: {
      ...options.webPreferences,
      session: service.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Captured now: reading `.webContents` off a destroyed window throws.
  const pipContents = pip.webContents;
  try {
    bindSender(pipContents, connectionId, 'pip');
  } catch {
    pip.destroy();
    return null;
  }
  pipWindows.set(pipContents, pip);
  pip.on('closed', () => {
    pipWindows.delete(pipContents);
    // A closed PiP stops counting as a member, so its stale binding admits nothing.
    recordFor(connectionId)?.pips.delete(pipContents);
  });
  return pip;
}

function disposeAll(): void {
  for (const record of liveConnections()) teardown(record.connectionId, false);
}

/**
 * Create the one shell window. Content protection is applied before any child view
 * exists, so no connection's first paint is ever unprotected.
 */
export function createShellWindow(shellDeps: ShellDeps): BaseWindow {
  deps = shellDeps;
  const win = new BaseWindow(shellDeps.windowOptions);
  shell = win;
  shellDeps.applyContentProtectionAtCreation(
    win,
    shellDeps.contentProtectionEnabled,
    'main window'
  );
  shellDeps.resetDeepLinkDelivery();

  // #1383: a genuine quit must close the window; the intercept may veto only otherwise.
  win.on('close', (event) => {
    if (shellDeps.isQuitting()) return;
    shellDeps.onClose(event);
  });
  win.on('closed', () => {
    disposeAll(); // invariant 4
    if (shell === win) shell = null;
    shellDeps.onClosed?.();
  });
  const relayout = (): void => layoutViews();
  win.on('resize', relayout);
  win.on('maximize', relayout);
  win.on('unmaximize', relayout);
  win.on('enter-full-screen', relayout);
  win.on('leave-full-screen', relayout);
  win.on('restore', relayout);
  return win;
}

function serviceLabel(service: ServiceRecord): string {
  return service.kind === 'saas' ? `CVNet — ${service.origin}` : `Self-hosted — ${service.origin}`;
}

async function showOrOpen(service: ServiceRecord): Promise<void> {
  if (activateConnection(service.serviceId)) return;
  if (!shellWindow()) return;
  const result = await openConnectionView(
    service.serviceId,
    deps?.devConnectionUrl ?? DEFAULT_CONNECTION_URL
  );
  if (result.ok) activateConnection(service.serviceId);
  else console.warn(`[shellWindow] dev menu: connection not opened (${result.reason})`);
}

function closeForeground(): void {
  const fg = foreground();
  if (!fg || fg.serviceId === SAAS_SERVICE_ID) return;
  disposeConnectionView(fg.connectionId);
  const saas = saasPrimary();
  if (saas) activateConnection(saas.serviceId);
}

function connectionMenuItems(): MenuItemConstructorOptions[] {
  const fg = foreground();
  const items: MenuItemConstructorOptions[] = allServices().map((service) => {
    const live = liveConnections().find((r) => r.serviceId === service.serviceId);
    return {
      label: serviceLabel(service),
      type: 'radio',
      checked: live !== undefined && fg?.connectionId === live.connectionId,
      click: () => {
        void showOrOpen(service);
      },
    };
  });
  items.push(
    { type: 'separator' },
    {
      label: 'Close foreground connection',
      enabled: fg !== null && fg.serviceId !== SAAS_SERVICE_ID,
      click: closeForeground,
    }
  );
  return items;
}

function buildDevMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Connections', submenu: connectionMenuItems() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function refreshDevConnectionMenu(): void {
  if (devMenuInstalled && !app.isPackaged) buildDevMenu();
}

/**
 * Development builds only (R3): a native Connections menu to open and switch views.
 * There is no shell document in #86, so this is the only switcher.
 */
export function installDevConnectionMenu(): void {
  if (app.isPackaged) return;
  devMenuInstalled = true;
  buildDevMenu();
}
