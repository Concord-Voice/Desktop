// Capture-gate probe (Desktop #87, Task 0).
//
// THROWAWAY MEASUREMENT PROTOTYPE. Not production code, not in CI, not linted:
// `.mjs` is outside the tsc/eslint/vitest globs on purpose. It answers seven
// questions about Electron 45's permission and capture behaviour that the #87
// lease design depends on (spec §6 T0, §3.5, §5.2), and writes nothing but
// stdout. results/*.md are written by hand from that output.
//
// Composition: one BaseWindow with two WebContentsViews, A (visible) and B
// (hidden with setVisible(false)), each on its own session.fromPath() under a
// fresh temporary userData. Each view loads renderer.html, which exposes
// window.probe. Main installs counting permission handlers on both sessions and
// logs every call as (view, permission, phase, mediaTypes, isMainFrame).
//
// Usage (from desktop/):
//   npx electron spikes/capture-gate/main.mjs --row=N [--check=true|false] [--throttle=true|false]
//   npx electron spikes/capture-gate/main.mjs --row=4 --activation=false
//   npx electron spikes/capture-gate/main.mjs --row=5 --fake-ui            (row 5 ONLY)
//
// Flag rule: --use-fake-device-for-media-stream is always appended here.
// --use-fake-ui-for-media-stream is appended ONLY for row 5 (--fake-ui), because
// that flag bypasses the very permission path rows 1-4 measure. Any other row
// refuses to run if it sees the fake-UI flag.

import { app, BaseWindow, dialog, session, WebContentsView } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pageFile = join(here, 'renderer.html');

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

function fail(msg, code = 2) {
  console.error(`[gate] ${msg}`);
  process.exit(code);
}

function boolArg(name, dflt) {
  const raw = argv[name] ?? String(dflt);
  if (raw !== 'true' && raw !== 'false') fail(`--${name} must be true or false`);
  return raw === 'true';
}

const ROW = Number(argv.row);
if (!Number.isInteger(ROW) || ROW < 1 || ROW > 7) fail('--row must be 1..7');
const CHECK = boolArg('check', true); // what the check handler answers for media / display-capture
const THROTTLE = boolArg('throttle', true); // shellWindow.ts uses backgroundThrottling: true
const ACTIVATION = boolArg('activation', true); // row 4: install the veto with user activation
const FAKE_UI = boolArg('fake-ui', false);
const TIMEOUT_MS = Number(argv['timeout-ms'] ?? 30_000);
const RUN = argv.run ?? `row${ROW}-${Date.now()}`;

const fakeUiOnCli = process.argv.some((a) => a.startsWith('--use-fake-ui-for-media-stream'));
if ((FAKE_UI || fakeUiOnCli) && ROW !== 5) fail('--use-fake-ui-for-media-stream is for row 5 only');
if (ROW === 5 && !FAKE_UI) fail('row 5 measures the fake-UI flag: pass --fake-ui');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (FAKE_UI) app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

// ── Isolated profile: a fresh temp dir, never the real Electron/Concord one ──
// Set before app.whenReady(), so no session, cache, crash dump or log is ever
// opened under a real profile. Deleted by the reaper below once this process
// has exited, however it exits.
app.setName('concord-capture-gate-spike');
const PROFILE_PREFIX = 'concord-capture-gate-';
const tmpRoot = fs.mkdtempSync(join(os.tmpdir(), PROFILE_PREFIX));
const userData = join(tmpRoot, 'userData');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setPath('crashDumps', join(tmpRoot, 'crashDumps'));
app.setPath('logs', join(tmpRoot, 'logs'));
console.log(`[gate] profile ${tmpRoot}`);

// Chromium keeps writing into the profile ("Local State", the partitions) after
// app 'quit' and after process 'exit' (observed on 45.0.0: an in-process rmSync
// at either point left the directory behind). So a detached reaper, run as plain
// Node via ELECTRON_RUN_AS_NODE, waits for this pid to die and then removes the
// directory. It only ever removes this run's own mkdtemp directory.
const REAPER = `
const fs = require('fs'); const path = require('path'); const os = require('os');
const [pid, dir, prefix] = process.argv.slice(1);
const ok = path.dirname(dir) === fs.realpathSync(os.tmpdir()) || path.dirname(dir) === os.tmpdir();
if (!ok || !path.basename(dir).startsWith(prefix)) process.exit(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const tick = setInterval(() => {
  if (alive()) return;
  clearInterval(tick);
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(0); }, 750);
}, 200);
setTimeout(() => process.exit(0), 180000);
`;
spawn(process.execPath, ['-e', REAPER, String(process.pid), tmpRoot, PROFILE_PREFIX], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
}).unref();

app.on('window-all-closed', () => {}); // quit explicitly, after measuring

// Hard timeout: a hung row (a dialog that did not close, a load that never
// finished) exits rather than leaving windows open.
const hardTimer = setTimeout(() => {
  log('hard-timeout', { ms: TIMEOUT_MS });
  app.exit(3);
}, TIMEOUT_MS);

// ── Output ──────────────────────────────────────────────────────────────────
const t0 = performance.now();
const events = [];
function log(kind, data = {}) {
  const line = { run: RUN, kind, t: Math.round(performance.now() - t0), ...data };
  events.push(line);
  console.log(`[gate] ${JSON.stringify(line)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, sleep(ms).then(() => ({ timedOut: true, label }))]);

// ── Permission handlers ─────────────────────────────────────────────────────
const CAPTURE = new Set(['media', 'display-capture']);
const labels = new Map(); // webContents.id -> 'A' | 'B'
const viewOf = (wc) => (wc ? (labels.get(wc.id) ?? `wc${wc.id}`) : null);

// Rows set this. Default: grant.
let requestAnswer = () => true;

function installHandlers(ses) {
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    const answer = CAPTURE.has(permission) ? CHECK : false;
    log('handler', {
      phase: 'check',
      view: viewOf(wc),
      permission,
      mediaType: details?.mediaType ?? null,
      isMainFrame: details?.isMainFrame ?? null,
      answer,
    });
    return answer;
  });
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const answer = requestAnswer(permission, details);
    log('handler', {
      phase: 'request',
      view: viewOf(wc),
      permission,
      mediaTypes: details?.mediaTypes ?? null,
      isMainFrame: details?.isMainFrame ?? null,
      answer,
    });
    callback(answer);
  });
}

const handlerCalls = (phase, view, permission) =>
  events.filter(
    (e) =>
      e.kind === 'handler' &&
      e.phase === phase &&
      (view === undefined || e.view === view) &&
      (permission === undefined || e.permission === permission)
  ).length;

// Every handler event logged since `mark` (an index into events).
const handlerSince = (mark) =>
  events
    .slice(mark)
    .filter((e) => e.kind === 'handler')
    .map((e) => `${e.phase}:${e.view}:${e.permission}${e.mediaTypes ? `[${e.mediaTypes}]` : ''}${e.mediaType ? `(${e.mediaType})` : ''}=${e.answer}`);

// ── Composition ─────────────────────────────────────────────────────────────
async function compose() {
  const win = new BaseWindow({ show: false, width: 480, height: 360, title: 'capture-gate spike' });
  const views = {};
  for (const [i, name] of ['A', 'B'].entries()) {
    const dir = join(userData, 'spike', String(i), 'session');
    fs.mkdirSync(dir, { recursive: true });
    const ses = session.fromPath(dir);
    installHandlers(ses);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: THROTTLE,
      },
    });
    labels.set(view.webContents.id, name);
    win.contentView.addChildView(view);
    view.setVisible(name === 'A');
    views[name] = view;
  }
  const layout = () => {
    const { width, height } = win.getContentBounds();
    for (const v of Object.values(views)) v.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on('resize', layout);
  // showInactive: do not steal focus from whoever is at the machine.
  win.showInactive();
  await Promise.all(
    Object.entries(views).map(([name, v]) => v.webContents.loadFile(pageFile, { query: { view: name } }))
  );
  log('composed', { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch, check: CHECK, throttle: THROTTLE, fakeUi: FAKE_UI });
  return { win, views };
}

const js = (view, code, gesture = false) => view.webContents.executeJavaScript(code, gesture);
const gum = (view, constraints) => js(view, `probe.gum(${JSON.stringify(constraints)})`);

// ── Rows ────────────────────────────────────────────────────────────────────

// Row 1: with the check handler answering --check, does the request handler
// fire on EVERY getUserMedia({audio:true})? Calls 1-2 keep the earlier tracks
// live; call 3 follows stopAll().
async function row1({ views: { A } }) {
  requestAnswer = () => true;
  const before = { devices: await js(A, 'probe.devices()'), mic: await js(A, "probe.permState('microphone')") };
  const calls = [];
  for (let k = 1; k <= 3; k++) {
    if (k === 3) await js(A, 'probe.stopAll()');
    const mark = events.length;
    const r = await gum(A, { audio: true });
    calls.push({ call: k, result: r, handlers: handlerSince(mark) });
  }
  const after = { devices: await js(A, 'probe.devices()'), mic: await js(A, "probe.permState('microphone')") };
  const requestsPerCall = calls.map((c) => c.handlers.filter((h) => h.startsWith('request:A:media')).length);
  return {
    check: CHECK,
    calls,
    requestsPerCall,
    requestFiredEveryCall: requestsPerCall.every((n) => n === 1),
    gumOk: calls.map((c) => c.result.ok),
    before,
    after,
  };
}

// Row 2: the request handler answers callback(false). What does the renderer see?
async function row2({ views: { A } }) {
  requestAnswer = () => false;
  const out = {};
  for (const [label, c] of [
    ['audio', { audio: true }],
    ['video', { video: true }],
  ]) {
    const mark = events.length;
    out[label] = { result: await gum(A, c), handlers: handlerSince(mark) };
  }
  return { check: CHECK, ...out };
}

// Row 3: which permission string does getUserMedia with chromeMediaSource
// 'desktop' raise? The request handler DENIES every call, so no screen is ever
// captured (and no macOS Screen Recording prompt can be triggered).
async function row3({ views: { A } }) {
  requestAnswer = () => false;
  const cases = [
    ['desktop-video-no-id', { audio: false, video: { mandatory: { chromeMediaSource: 'desktop' } } }],
    [
      'desktop-video-with-id',
      { audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } } },
    ],
    [
      'desktop-video+loopback-audio',
      {
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } },
      },
    ],
  ];
  const out = {};
  for (const [label, c] of cases) {
    const mark = events.length;
    out[label] = { result: await gum(A, c), handlers: handlerSince(mark) };
  }
  // getDisplayMedia with no setDisplayMediaRequestHandler installed (§3.5 keeps it
  // uninstalled). Transient activation via a userGesture executeJavaScript.
  const mark = events.length;
  out['getDisplayMedia-no-handler'] = {
    result: await js(A, 'probe.gdm({ video: true })', true),
    handlers: handlerSince(mark),
  };
  return { check: CHECK, ...out };
}

// Row 4: a live mic+camera track in a document with a beforeunload veto.
// (a) reload() alone: does the document survive with its tracks?
// (b) forcefullyCrashRenderer() + reload(): is the document replaced, is the
//     old renderer process gone, and what does render-process-gone report?
async function row4({ views: { A } }) {
  requestAnswer = () => true;
  const wc = A.webContents;
  const wcEvents = [];
  wc.on('will-prevent-unload', () => wcEvents.push({ ev: 'will-prevent-unload', t: Math.round(performance.now() - t0) }));
  wc.on('did-start-navigation', (d) => {
    if (d?.isMainFrame) wcEvents.push({ ev: 'did-start-navigation', t: Math.round(performance.now() - t0) });
  });
  wc.on('did-finish-load', () => wcEvents.push({ ev: 'did-finish-load', t: Math.round(performance.now() - t0) }));
  let gone = null;
  const goneP = new Promise((res) =>
    wc.once('render-process-gone', (_e, d) => {
      gone = { reason: d.reason, exitCode: d.exitCode };
      wcEvents.push({ ev: 'render-process-gone', reason: d.reason, t: Math.round(performance.now() - t0) });
      res(gone);
    })
  );
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // executeJavaScript rejects while a frame is being swapped ("Render frame was
  // disposed before WebFrameMain could be accessed"), so reads after a reload or
  // crash are retried until the new document answers.
  const read = async (code, label) => {
    let last = null;
    for (let i = 0; i < 20; i++) {
      try {
        return await js(A, code);
      } catch (e) {
        last = String(e?.message ?? e);
        await sleep(250);
      }
    }
    return { unreadable: label, error: last };
  };

  log('row4-step', { step: 'veto' });
  const veto = await js(A, 'probe.vetoUnload()', ACTIVATION);
  const captured = await gum(A, { audio: true, video: true });
  const nonce0 = await js(A, 'probe.nonce');
  const pid0 = wc.getOSProcessId();
  const tracks0 = await js(A, 'probe.trackStates()');

  // (a) reload() alone.
  log('row4-step', { step: 'reload-alone', tracks: tracks0 });
  wc.reload();
  await sleep(2500);
  const nonceA = await read('probe.nonce', 'nonce-a');
  const tracksA = await read('probe.trackStates()', 'tracks-a');
  const reloadAlone = {
    documentReplaced: nonceA !== nonce0,
    tracks: tracksA,
    tracksStillLive: Array.isArray(tracksA) && tracksA.length > 0 && tracksA.every((t) => t.readyState === 'live'),
    pidAlive: alive(pid0),
  };

  for (const ev of ['did-start-loading', 'did-stop-loading']) {
    wc.on(ev, () => wcEvents.push({ ev, t: Math.round(performance.now() - t0) }));
  }
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame) wcEvents.push({ ev: 'did-fail-load', code, desc, t: Math.round(performance.now() - t0) });
  });
  const state = () => ({
    isCrashed: wc.isCrashed(),
    isLoading: wc.isLoading(),
    pidIsZero: wc.getOSProcessId() === 0,
    pidIsOld: wc.getOSProcessId() === pid0,
  });

  // (b) forcefullyCrashRenderer() + reload() in the same task (spec §3.4 step 4).
  log('row4-step', { step: 'crash+reload' });
  const finished = new Promise((res) => wc.once('did-finish-load', res));
  wc.forcefullyCrashRenderer();
  const afterCrashSync = state();
  wc.reload();
  const goneResult = await withTimeout(goneP, 5000, 'render-process-gone');
  const finishedB = await withTimeout(finished, 5000, 'did-finish-load');
  await sleep(500);
  const nonceB = await read('probe.nonce', 'nonce-b');
  const tracksB = await read('probe.trackStates()', 'tracks-b');
  const crashReload = {
    afterCrashSync,
    renderProcessGone: goneResult?.timedOut ? 'not fired within 5 s' : gone,
    didFinishLoadWithin5s: !finishedB?.timedOut,
    documentReplaced: typeof nonceB === 'string' && nonceB !== nonce0,
    oldPidAlive: alive(pid0),
    stateAfter: state(),
    tracksInNewDocument: tracksB,
  };

  // (c) Only when (b) left no live document: a second reload() issued after
  // render-process-gone has been delivered.
  let reloadAfterGone = 'not needed';
  if (!crashReload.documentReplaced) {
    log('row4-step', { step: 'reload-after-gone' });
    const finishedC = new Promise((res) => wc.once('did-finish-load', res));
    wc.reload();
    const fin = await withTimeout(finishedC, 5000, 'did-finish-load-c');
    await sleep(300);
    const nonceC = await read('probe.nonce', 'nonce-c');
    reloadAfterGone = {
      didFinishLoadWithin5s: !fin?.timedOut,
      documentReplaced: typeof nonceC === 'string' && nonceC !== nonce0,
      tracksInNewDocument: await read('probe.trackStates()', 'tracks-c'),
      stateAfter: state(),
    };
  }
  return {
    activation: ACTIVATION,
    veto,
    captured,
    tracksBefore: tracks0,
    reloadAlone,
    crashReload,
    reloadAfterGone,
    wcEvents,
  };
}

// Row 5 (--fake-ui): which handlers still fire? The request handler DENIES, so
// any getUserMedia that resolves was granted without it. Desktop capture is not
// exercised here: under fake UI a grant could start a real screen capture and
// raise a macOS Screen Recording prompt on the executor's machine.
async function row5({ views: { A } }) {
  requestAnswer = () => false;
  const out = {};
  for (const [label, c] of [
    ['audio', { audio: true }],
    ['video', { video: true }],
  ]) {
    const mark = events.length;
    out[label] = { result: await gum(A, c), handlers: handlerSince(mark) };
  }
  return { check: CHECK, fakeUi: FAKE_UI, ...out };
}

// Row 6: a parented showMessageBox(baseWindow, { signal }) with the spec §3.3
// option shape. Is A's view inert while it is open (sendInputEvent mousedown),
// does the OS report a sheet, and does controller.abort() close and resolve it?
async function row6({ win, views: { A } }) {
  const sheet = [];
  win.on('sheet-begin', () => sheet.push({ ev: 'sheet-begin', t: Math.round(performance.now() - t0) }));
  win.on('sheet-end', () => sheet.push({ ev: 'sheet-end', t: Math.round(performance.now() - t0) }));
  const click = async () => {
    const wc = A.webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: 120, y: 120, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 120, y: 120, button: 'left', clickCount: 1 });
    await sleep(300);
    return js(A, 'probe.clicks()');
  };

  const clicksControl = await click(); // no dialog: proves the injection reaches A
  const controller = new AbortController();
  const opened = performance.now();
  const boxP = dialog
    .showMessageBox(win, {
      type: 'question',
      noLink: true,
      normalizeAccessKeys: true,
      signal: controller.signal,
      title: 'Concord Voice',
      message: 'Join voice on example.test?',
      detail: 'capture-gate spike (Desktop #87 T0). This dialog closes itself; no click is needed.',
      buttons: ['&Stay on Concord Voice', '&Join on example.test'],
      defaultId: 0,
      cancelId: 0,
    })
    .then((r) => ({ resolved: true, response: r.response, ms: Math.round(performance.now() - opened) }))
    .catch((e) => ({ resolved: false, rejected: String(e?.message ?? e) }));
  await sleep(1000);
  const clicksWhileOpen = await click();
  const abortAt = performance.now();
  controller.abort();
  const box = await withTimeout(boxP, 3000, 'showMessageBox-after-abort');
  const abortToSettleMs = Math.round(performance.now() - abortAt);
  await sleep(300);
  const clicksAfter = await click();
  return {
    clicksControl,
    clicksWhileOpen,
    clicksAfter,
    injectedClickReachedAWhileOpen: clicksWhileOpen > clicksControl,
    box,
    abortToSettleMs,
    sheet,
  };
}

// Row 7: document.visibilityState in a hidden view. A is visible, B is hidden
// from creation; then the two are swapped (A gets setVisible(false) while live).
async function row7({ views: { A, B } }) {
  await sleep(800);
  const phase1 = { A: await js(A, 'probe.vis()'), B: await js(B, 'probe.vis()') };
  A.setVisible(false);
  B.setVisible(true);
  await sleep(800);
  const phase2 = { A: await js(A, 'probe.vis()'), B: await js(B, 'probe.vis()') };
  return {
    throttle: THROTTLE,
    controlVisibleViewReportsVisible: phase1.A.state === 'visible',
    hiddenFromCreation: phase1.B,
    visibleAtStart: phase1.A,
    afterSetVisibleFalse: phase2.A,
    afterSetVisibleTrue: phase2.B,
  };
}

const ROWS = { 1: row1, 2: row2, 3: row3, 4: row4, 5: row5, 6: row6, 7: row7 };

// ── Main ────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  let code = 0;
  let comp = null;
  try {
    comp = await compose();
    const result = await ROWS[ROW](comp);
    console.log(`[gate] SUMMARY ${JSON.stringify({ run: RUN, row: ROW, result, handlerTotals: { check: handlerCalls('check'), request: handlerCalls('request') } })}`);
  } catch (e) {
    console.error(`[gate] failed: ${e?.message ?? String(e)}`);
    code = 1;
  }
  try {
    if (comp) {
      for (const v of Object.values(comp.views)) if (!v.webContents.isDestroyed()) v.webContents.close();
      comp.win.destroy();
    }
  } catch {
    // Exiting anyway.
  }
  clearTimeout(hardTimer);
  process.exitCode = code;
  app.quit();
});
