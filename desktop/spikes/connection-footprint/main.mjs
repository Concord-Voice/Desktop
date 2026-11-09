// Connection footprint + composition spike (Desktop #86, Task 0).
//
// THROWAWAY MEASUREMENT PROTOTYPE. Not production code, not in CI, not linted:
// `.mjs` is outside the tsc/eslint/vitest globs on purpose. It exists to put
// honest numbers into results/*.md for ADR-0051 and MAX_LIVE_CONNECTIONS.
//
// Composition measured: one BaseWindow; 0..3 WebContentsViews. View 0 runs on
// session.defaultSession (the `saas` connection in the spec); view i>=1 runs on
// session.fromPath(<userData>/spike/profiles/<i>/session) (a self-hosted
// connection). Every view uses the real preload and the real webPreferences
// from buildBrowserWindowConfig (dev, unpackaged) plus its own `session`. View 0
// is the foreground view; views >=1 are hidden with setVisible(false) from
// creation, which is how background connections would be restored.
//
// The spike's main process registers NO ipcMain handlers. The renderer boots to
// its login screen; it cannot complete a login, because Login.tsx fails closed
// when `auth:storeRefreshToken` has no handler. See README § logged-in-idle.
//
// Usage (from desktop/, with `npm run dev:renderer` serving :3001 and
// `npm run build:preload && npm run build:main` done once):
//   npx electron spikes/connection-footprint/main.mjs --views=3 --throttle=true \
//     --state=login-idle --minutes=10 [--run=<label>] [--sample-seconds=30]
//   npx electron spikes/connection-footprint/main.mjs --check=platform [--drag=true]

import { app, BaseWindow, BrowserWindow, WebContentsView, session, webContents } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..', '..');
const resultsDir = join(here, 'results');

// ── Args ────────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : 'true'];
    })
);
const CHECK = argv.check ?? null; // 'platform' | null
const VIEWS = Number(argv.views ?? 1);
const THROTTLE = (argv.throttle ?? 'true') === 'true';
const STATE = argv.state ?? 'login-idle';
const MINUTES = Number(argv.minutes ?? 10);
const SAMPLE_S = Number(argv['sample-seconds'] ?? 30);
const RUN = argv.run ?? `v${VIEWS}-t${THROTTLE}-${STATE}-${Date.now()}`;
const OUT = argv.out ?? join(resultsDir, `raw-${process.platform}-${process.arch}.jsonl`);
const RENDERER_URL = argv.url ?? 'http://localhost:3001';

if (!CHECK) {
  if (!Number.isInteger(VIEWS) || VIEWS < 0 || VIEWS > 3) fail('--views must be 0..3');
  if (!['cold', 'login-idle', 'logged-in-idle'].includes(STATE)) fail('bad --state');
  if (!(MINUTES > 0)) fail('--minutes must be > 0');
  if (STATE === 'logged-in-idle') {
    // Fail closed rather than record a login-screen run under the wrong label.
    fail(
      'logged-in-idle is not measurable with this harness: it registers no custody ' +
        'IPC handlers (auth:storeRefreshToken etc.), so the renderer cannot log in, and ' +
        'it needs a running control plane. See README.',
      2
    );
  }
}

function fail(msg, code = 1) {
  console.error(`[spike] ${msg}`);
  process.exit(code);
}

// ── Isolated profile: never touch the real Concord userData ────────────────
app.setName('concord-connection-footprint-spike');
const userData = join(app.getPath('appData'), 'concord-connection-footprint-spike');
if (!CHECK && STATE === 'cold') fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
app.on('window-all-closed', () => {}); // quit explicitly, after measuring

// The real webPreferences. tsc output of src/main/browserWindowConfig.ts.
const require = createRequire(import.meta.url);
let buildBrowserWindowConfig;
try {
  ({ buildBrowserWindowConfig } = require(join(desktopRoot, 'dist/main/browserWindowConfig.js')));
} catch {
  fail('dist/main/browserWindowConfig.js missing: run `npm run build:preload && npm run build:main`');
}
const preloadPath = join(desktopRoot, 'dist/preload/preload.js');
if (!fs.existsSync(preloadPath)) fail('dist/preload/preload.js missing: run `npm run build:preload`');

const isWayland = () =>
  process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY));

const baseConfig = buildBrowserWindowConfig({
  platform: process.platform,
  isWayland: isWayland(),
  preloadPath,
  isPackaged: app.isPackaged,
});
const { webPreferences: realWebPreferences, ...windowOptions } = baseConfig;

// ── Output ──────────────────────────────────────────────────────────────────
fs.mkdirSync(resultsDir, { recursive: true });
let tReady = 0;
const now = () => Math.round(performance.now() - tReady);
function emit(kind, data) {
  const line = JSON.stringify({ run: RUN, kind, t: now(), ...data });
  fs.appendFileSync(OUT, `${line}\n`);
}

// ── Heartbeat probe (hidden-view throttling vs websocket heartbeat) ────────
// Mirrors the live contract: the renderer sends an APPLICATION heartbeat from a
// 30 s setInterval (websocketService.startPingInterval); the server sends a
// protocol ping every 54 s (control-plane client.go pingPeriod) that Chromium's
// network service answers without renderer JS, plus an app frame the page
// echoes from onmessage. The server timestamps everything, so a throttled page
// cannot misreport its own timing.
function startProbeServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const lastHb = new Map();
  wss.on('connection', (ws) => {
    let view = null;
    let pingAt = 0;
    let echoAt = 0;
    ws.on('message', (buf) => {
      let m;
      try {
        m = JSON.parse(String(buf));
      } catch {
        return;
      }
      if (m.k === 'hello') {
        view = m.view;
        emit('probe', { view, ev: 'hello', vis: m.vis });
        return;
      }
      if (m.k === 'hb') {
        const at = Date.now();
        const prev = lastHb.get(view);
        lastHb.set(view, at);
        emit('probe', { view, ev: 'hb', vis: m.vis, gapMs: prev ? at - prev : null });
      } else if (m.k === 'echo') {
        emit('probe', { view, ev: 'echo', vis: m.vis, rttMs: Date.now() - echoAt });
      } else if (m.k === 'vis') {
        emit('probe', { view, ev: 'vis', vis: m.vis });
      }
    });
    ws.on('pong', () => emit('probe', { view, ev: 'pong', rttMs: Date.now() - pingAt }));
    const timer = setInterval(() => {
      pingAt = Date.now();
      ws.ping();
      echoAt = Date.now();
      ws.send(JSON.stringify({ k: 'srv' }));
    }, 54_000);
    ws.on('close', () => clearInterval(timer));
  });
  return new Promise((res) => wss.on('listening', () => res({ wss, port: wss.address().port })));
}

const probeSource = (port, view) => `(() => {
  const ws = new WebSocket('ws://127.0.0.1:${port}');
  const vis = () => document.visibilityState;
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  ws.onopen = () => send({ k: 'hello', view: ${view}, vis: vis() });
  ws.onmessage = (e) => { try { if (JSON.parse(e.data).k === 'srv') send({ k: 'echo', vis: vis() }); } catch {} };
  setInterval(() => send({ k: 'hb', vis: vis() }), 30000);
  document.addEventListener('visibilitychange', () => send({ k: 'vis', vis: vis() }));
  return vis();
})()`;

// ── Composition ─────────────────────────────────────────────────────────────
function sessionFor(i) {
  if (i === 0) return session.defaultSession;
  const dir = join(userData, 'spike', 'profiles', String(i), 'session');
  fs.mkdirSync(dir, { recursive: true });
  return session.fromPath(dir);
}

function createComposition(n, { throttle, visibleIndex = 0 }) {
  const win = new BaseWindow({ ...windowOptions, show: false });
  const views = [];
  for (let i = 0; i < n; i++) {
    const view = new WebContentsView({
      webPreferences: { ...realWebPreferences, session: sessionFor(i), backgroundThrottling: throttle },
    });
    win.contentView.addChildView(view);
    view.setVisible(i === visibleIndex);
    views.push(view);
  }
  const layout = () => {
    const { width, height } = win.getContentBounds();
    for (const v of views) v.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on('resize', layout);
  // showInactive, not show: the spike must not steal focus from whatever the
  // person at the machine is doing. Visibility is recorded per sample anyway.
  win.showInactive();
  return { win, views };
}

function loadView(view, i) {
  return new Promise((res) => {
    const wc = view.webContents;
    wc.once('did-finish-load', () => res({ view: i, ok: true, ms: now() }));
    wc.once('did-fail-load', (_e, code, desc) => res({ view: i, ok: false, ms: now(), code, desc }));
    wc.on('render-process-gone', (_e, d) => emit('gone', { view: i, reason: d.reason }));
    wc.loadURL(RENDERER_URL).catch(() => {});
  });
}

// ── Sampling ────────────────────────────────────────────────────────────────
function pidMap(views) {
  const m = new Map();
  views.forEach((v, i) => {
    if (!v.webContents.isDestroyed()) m.set(v.webContents.getOSProcessId(), i);
  });
  return m;
}

function sample(views) {
  const byPid = pidMap(views);
  for (const p of app.getAppMetrics()) {
    emit('sample', {
      pid: p.pid,
      type: p.type,
      name: p.name ?? p.serviceName ?? null,
      view: byPid.has(p.pid) ? byPid.get(p.pid) : null,
      wsKB: p.memory.workingSetSize,
      peakKB: p.memory.peakWorkingSetSize,
      cpuPct: p.cpu.percentCPUUsage,
      cpuCumS: p.cpu.cumulativeCPUUsage ?? null,
      wakeups: p.cpu.idleWakeupsPerSecond,
    });
  }
}

// macOS phys_footprint (what Activity Monitor calls Memory) as a cross-check on
// workingSetSize, which on macOS counts shared resident pages too.
function footprints(views) {
  if (process.platform !== 'darwin') return;
  const byPid = pidMap(views);
  for (const p of app.getAppMetrics()) {
    try {
      const out = execFileSync('footprint', ['--noCategories', '-f', 'bytes', '-p', String(p.pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = /Footprint:\s*([\d,]+)\s*B/.exec(out);
      emit('footprint', {
        pid: p.pid,
        type: p.type,
        view: byPid.has(p.pid) ? byPid.get(p.pid) : null,
        bytes: m ? Number(m[1].replaceAll(',', '')) : null,
      });
    } catch {
      emit('footprint', { pid: p.pid, type: p.type, bytes: null, error: 'footprint failed' });
    }
  }
}

function duKB(dir) {
  try {
    return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split(/\s+/)[0]);
  } catch {
    return null;
  }
}

async function visibility(views) {
  const out = {};
  for (const [i, v] of views.entries()) {
    out[i] = v.webContents.isDestroyed()
      ? 'destroyed'
      : await v.webContents.executeJavaScript('document.visibilityState').catch(() => 'error');
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMeasurement() {
  const { port, wss } = await startProbeServer();
  emit('run', {
    views: VIEWS,
    throttle: THROTTLE,
    state: STATE,
    minutes: MINUTES,
    sampleSeconds: SAMPLE_S,
    url: RENDERER_URL,
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  });
  const { win, views } = createComposition(VIEWS, { throttle: THROTTLE });
  const loads = await Promise.all(views.map((v, i) => loadView(v, i)));
  for (const l of loads) emit('load', l);
  for (const [i, v] of views.entries()) {
    const vis = await v.webContents.executeJavaScript(probeSource(port, i)).catch(() => 'error');
    emit('probe-injected', { view: i, vis });
  }
  console.log(`[spike] ${RUN} loads: ${loads.map((l) => `${l.view}:${l.ms}ms`).join(' ') || 'none'}`);

  const end = performance.now() + MINUTES * 60_000;
  sample(views);
  while (performance.now() + SAMPLE_S * 1000 <= end + 500) {
    await sleep(SAMPLE_S * 1000);
    sample(views);
  }
  emit('visibility', { states: await visibility(views) });
  footprints(views);

  const disk = {};
  const rootKB = duKB(userData);
  const spikeKB = duKB(join(userData, 'spike'));
  disk[0] = rootKB != null ? rootKB - (spikeKB ?? 0) : null; // defaultSession = userData root
  for (let i = 1; i < VIEWS; i++) disk[i] = duKB(join(userData, 'spike', 'profiles', String(i), 'session'));
  emit('disk', { kb: disk });
  for (const [i, kb] of Object.entries(disk)) {
    console.log(`[spike] du -sk session view ${i}: ${kb} KB`);
  }

  for (const v of views) if (!v.webContents.isDestroyed()) v.webContents.close();
  win.destroy();
  wss.close();
}

// ── Platform rows (macOS manual checks, captured) ──────────────────────────
function cgWindowId(win) {
  const m = /^window:(\d+):/.exec(win.getMediaSourceId());
  return m ? m[1] : null;
}

function capture(win, name) {
  const file = join(resultsDir, name);
  const id = cgWindowId(win);
  try {
    execFileSync('screencapture', ['-x', '-o', `-l${id}`, file]);
    return file;
  } catch (e) {
    return `capture failed: ${e.message}`;
  }
}

const DRAG_CSS = `
  #spike-drag { position: fixed; top: 0; left: 120px; right: 0; height: 48px;
    -webkit-app-region: drag; background: rgba(255, 0, 0, 0.45); z-index: 2147483647;
    color: #fff; font: 600 14px system-ui; display: flex; align-items: center; padding-left: 12px; }`;
const DRAG_JS = (label) => `(() => {
  const d = document.createElement('div'); d.id = 'spike-drag';
  d.textContent = ${JSON.stringify(label)}; document.body.appendChild(d); return true; })()`;

const SWIFT_DRAG = `import CoreGraphics
import Foundation
let a = CommandLine.arguments.dropFirst().compactMap { Double($0) }
let (x0, y0, x1, y1) = (a[0], a[1], a[2], a[3])
print("preflightPostEventAccess=\\(CGPreflightPostEventAccess())")
func post(_ t: CGEventType, _ x: Double, _ y: Double) {
  CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
}
post(.mouseMoved, x0, y0); usleep(200_000)
post(.leftMouseDown, x0, y0); usleep(200_000)
for i in 1...25 { let f = Double(i) / 25.0; post(.leftMouseDragged, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f); usleep(20_000) }
usleep(200_000)
post(.leftMouseUp, x1, y1)
`;

function compileDragTool() {
  const dir = join(app.getPath('temp'), 'concord-connection-footprint-spike');
  fs.mkdirSync(dir, { recursive: true });
  const src = join(dir, 'drag.swift');
  const bin = join(dir, 'drag');
  fs.writeFileSync(src, SWIFT_DRAG);
  execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'ignore' });
  return bin;
}

// Synthesise an OS-level drag starting inside the drag strip; report whether the
// window moved. Only an OS event exercises the native hit test that
// -webkit-app-region feeds; webContents.sendInputEvent would bypass it.
async function dragTest(tool, win, label) {
  win.setAlwaysOnTop(true);
  win.focus();
  await sleep(800);
  const before = win.getBounds();
  const x0 = before.x + 420;
  const y0 = before.y + 24;
  const out = execFileSync(tool, [x0, y0, x0 + 140, y0 + 90].map(String), { encoding: 'utf8' }).trim();
  await sleep(800);
  const after = win.getBounds();
  const moved = after.x !== before.x || after.y !== before.y;
  const r = { label, before, after, moved, tool: out };
  emit('platform', { row: 'drag-region', ...r });
  console.log(`[spike] drag ${label}: moved=${moved} ${JSON.stringify(before)} -> ${JSON.stringify(after)} ${out}`);
  win.setAlwaysOnTop(false);
  return r;
}

async function runPlatformChecks() {
  // The drag rows post real OS mouse events. Opt-in only (--drag=true), and only
  // with someone at the machine who expects it: the events land on whatever is
  // frontmost, which is not necessarily the spike window.
  const DRAG = argv.drag === 'true' && process.platform === 'darwin';
  const tool = DRAG ? compileDragTool() : null;
  emit('run', {
    check: 'platform',
    drag: DRAG,
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  });

  // Control: a plain BrowserWindow with the same config + drag strip. If this
  // does not move, event synthesis is not permitted and the child-view result
  // below says nothing.
  if (tool) {
    const ctrl = new BrowserWindow({ ...baseConfig, show: true });
    await ctrl.loadURL(RENDERER_URL);
    await ctrl.webContents.insertCSS(DRAG_CSS);
    await ctrl.webContents.executeJavaScript(DRAG_JS('CONTROL: BrowserWindow own webContents drag strip'));
    await sleep(1500);
    await dragTest(tool, ctrl, 'control-browserwindow');
    ctrl.destroy();
  }

  // Row 1 + 2a: BaseWindow, hiddenInset, view 0 (defaultSession) visible.
  const a = createComposition(2, { throttle: true, visibleIndex: 0 });
  await Promise.all(a.views.map((v, i) => loadView(v, i)));
  await sleep(2500);
  emit('platform', { row: 'hiddenInset', file: capture(a.win, 'macos-hiddeninset-child-view.png') });
  for (const v of a.views) {
    await v.webContents.insertCSS(DRAG_CSS);
  }
  await a.views[0].webContents.executeJavaScript(DRAG_JS('CHILD VIEW 0 (defaultSession) drag strip'));
  await a.views[1].webContents.executeJavaScript(DRAG_JS('CHILD VIEW 1 (fromPath session) drag strip'));
  await sleep(1500);
  emit('platform', { row: 'drag-strip-view0', file: capture(a.win, 'macos-drag-strip-view0.png') });
  if (tool) await dragTest(tool, a.win, 'basewindow-child-view0');

  // Row 2b: switch foreground to view 1 (fromPath session), view 0 hidden.
  a.views[0].setVisible(false);
  a.views[1].setVisible(true);
  await sleep(1500);
  emit('platform', { row: 'drag-strip-view1', file: capture(a.win, 'macos-drag-strip-view1.png') });
  if (tool) await dragTest(tool, a.win, 'basewindow-child-view1-after-switch');

  // Row 3: child webContents survival on BaseWindow.close().
  // Hold the WebContents objects: after webContents.close() the view's
  // `webContents` property reads undefined (observed on 45.0.0), so probe the
  // held references and record the view-side property separately.
  const wcs = a.views.map((v) => v.webContents);
  const pids = wcs.map((wc) => wc.getOSProcessId());
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const probe = (phase) => {
    const r = {
      phase,
      destroyed: wcs.map((wc) => wc.isDestroyed()),
      viewWebContentsProperty: a.views.map((v) => (v.webContents === undefined ? 'undefined' : 'present')),
      pidAlive: pids.map(alive),
      liveWebContents: webContents.getAllWebContents().length,
    };
    emit('platform', { row: 'close-survival', ...r, pids });
    console.log(`[spike] close-survival ${phase}: ${JSON.stringify(r)} pids=${pids}`);
  };
  probe('before-close');
  const closed = new Promise((r) => a.win.once('closed', r));
  a.win.close();
  await closed;
  probe('after-closed+0ms');
  await sleep(3000);
  probe('after-closed+3000ms');
  for (const wc of wcs) if (!wc.isDestroyed()) wc.close();
  await sleep(1500);
  probe('after-explicit-webContents.close()+1500ms');
}

// ── Main ────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  tReady = performance.now();
  try {
    if (CHECK === 'platform') await runPlatformChecks();
    else await runMeasurement();
  } catch (e) {
    console.error(`[spike] failed: ${e?.message ?? String(e)}`);
    process.exitCode = 1;
  }
  app.quit();
});
