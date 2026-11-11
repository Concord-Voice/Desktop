// THE THREE-PROCESS AUDIOCAP TRANSPORT PROBE (issue 73).
//
// Main, the capture utility process and a sandboxed renderer, all running
// production code: the host and child from `dist/main`, the unmodified addon
// loader, the production preload bundle, and the renderer bridge bundled from
// source at run time. The one re-stated seam is the port hand-over, and the
// probe refuses to run if `main.ts` no longer makes that call.
//
// The synthetic addon reaches the unmodified loader through a staged tree under
// the OS temp directory (design section 3.2). The stage is deleted on every exit
// path.
//
// Exit codes: 0 every invariant held; 1 an invariant was violated; 2 a check
// could not run.
'use strict';

const { app, BrowserWindow, protocol } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../..');
const REPO = path.resolve(ROOT, '..');
const SCHEME = 'audiocap-probe';
const ORIGIN = `${SCHEME}://probe`;
const INJECT = (process.argv.find((arg) => arg.startsWith('--inject=')) ?? '').slice(9) || null;
const RELEASE_DIR = path.join(ROOT, 'native/concord-audiocap/build/Release');
const SYNTHETIC = path.join(RELEASE_DIR, 'concord_audiocap_synthetic.node');
const SHIPPED = path.join(RELEASE_DIR, 'concord_audiocap.node');

class CouldNotRun extends Error {}

let stage = null;
let host = null;
let win = null;
let failed = 0;
let exiting = false;
const interrupts = [];

function errorText(err) {
  return err && typeof err.message === 'string' ? err.message : String(err);
}

function say(line) {
  // eslint-disable-next-line no-console -- this IS the probe output; a CI job reads stdout
  console.log(line);
}

function removeStage() {
  if (stage === null) return;
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    stage = null;
  } catch (err) {
    say(`FAIL cleanup: could not delete the stage: ${errorText(err)}`);
  }
}

process.on('exit', removeStage);

function finish(code) {
  if (exiting) return;
  exiting = true;
  if (host !== null) {
    try {
      host.killAudiocapHost();
    } catch (err) {
      say(`FAIL cleanup: killAudiocapHost threw: ${errorText(err)}`);
    }
  }
  if (win !== null && !win.isDestroyed()) win.destroy();
  removeStage();
  app.exit(code);
}

function couldNotRun(reason) {
  say(`FAIL guard: ${reason}`);
  say('PROBE FAIL (could not run)');
  finish(2);
}

/**
 * Run one pass and print its result line. A thrown `CouldNotRun` ends the probe
 * with exit 2; any other throw is a violated invariant and counts toward exit 1.
 */
async function runPass(name, fn) {
  try {
    const notes = await fn();
    say(`ok   ${name}`);
    for (const note of notes ?? []) say(`     ${note}`);
    return true;
  } catch (err) {
    say(`FAIL ${name}: ${errorText(err)}`);
    if (err instanceof CouldNotRun) {
      say('PROBE FAIL (could not run)');
      finish(2);
      // app.exit() is already terminating the process; never settle, so no later
      // pass runs against a half-torn-down probe.
      return new Promise(() => undefined);
    }
    failed += 1;
    return false;
  }
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const page = (expr) => win.webContents.executeJavaScript(expr);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isStale(artifact, sources) {
  if (!fs.existsSync(artifact)) return true;
  const built = fs.statSync(artifact).mtimeMs;
  return sources.some((src) => fs.statSync(path.join(ROOT, src)).mtimeMs > built);
}

/** Every precondition the passes rely on. Returns a reason, or null when all hold. */
function guardFailure() {
  if (app.isPackaged) return 'the probe refuses to run in a packaged app';
  const build = 'run `npm run build:main && npm run build:preload`';
  const hostJs = path.join(ROOT, 'dist/main/audiocapHost.js');
  if (isStale(hostJs, ['src/main/audiocapHost.ts', 'src/main/audiocapChild.ts'])) {
    return `dist/main is missing or older than its source; ${build}`;
  }
  const preloadJs = path.join(ROOT, 'dist/preload/preload.js');
  if (isStale(preloadJs, ['src/preload/preload.ts', 'src/preload/audiocapRelay.ts'])) {
    return `dist/preload/preload.js is missing or older than its source; ${build}`;
  }
  if (!fs.existsSync(SYNTHETIC)) {
    return 'the synthetic addon is missing; run `npm run build:native -- --synthetic`';
  }
  const mainTs = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8');
  if (!mainTs.includes("webContents.postMessage('audiocap:port'")) {
    return "main.ts no longer hands the port over with webContents.postMessage('audiocap:port'; update the probe's port sink to match";
  }
  return null;
}

/** Copy dist/, the loader and the synthetic binary (under the release name) to a fresh temp tree. */
function buildStage() {
  stage = fs.mkdtempSync(path.join(os.tmpdir(), 'audiocap-probe-'));
  const realStage = fs.realpathSync(stage);
  const realRepo = fs.realpathSync(REPO);
  if (realStage === realRepo || realStage.startsWith(realRepo + path.sep)) {
    return `the stage ${realStage} resolves inside the repository`;
  }
  fs.cpSync(path.join(ROOT, 'dist'), path.join(stage, 'dist'), { recursive: true });
  const loaderDir = path.join(stage, 'native/concord-audiocap');
  fs.mkdirSync(path.join(loaderDir, 'build/Release'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'native/concord-audiocap/index.js'),
    path.join(loaderDir, 'index.js')
  );
  const staged = path.join(loaderDir, 'build/Release/concord_audiocap.node');
  fs.copyFileSync(SYNTHETIC, staged);
  const stagedHash = sha256(staged);
  if (stagedHash !== sha256(SYNTHETIC)) return 'the staged binary differs from the synthetic build';
  if (fs.existsSync(SHIPPED) && stagedHash === sha256(SHIPPED)) {
    return 'the staged binary is the shipped build, not the synthetic one; run `npm run build:native -- --synthetic`';
  }
  return null;
}

function stagedBinary() {
  return fs.realpathSync(
    path.join(stage, 'native/concord-audiocap/build/Release/concord_audiocap.node')
  );
}

/** The audiocap child's PID, from Chromium's own process list; the child is never asked. */
function audiocapUtilityPid() {
  const utilities = app.getAppMetrics().filter((m) => m.type === 'Utility');
  const node = utilities.filter((m) => m.serviceName === 'node.mojom.NodeService');
  if (node.length !== 1) {
    const seen = utilities.map((m) => `${m.pid}:${m.serviceName}:${m.name}`).join(', ');
    throw new CouldNotRun(`expected exactly one node utility process, saw [${seen}]`);
  }
  return node[0];
}

/** The CGWindowID (macOS) or HWND (Windows) of a window, from its `window:<id>:0` source id. */
function windowHandleOf(browserWindow) {
  const match = /^window:(\d+):/.exec(browserWindow.getMediaSourceId());
  if (match === null) throw new CouldNotRun('the probe window has no window:<id> media source id');
  return Number(match[1]);
}

function lsofLists(pid, file) {
  const out = spawnSync('lsof', ['-n', '-P', '-p', String(pid)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.error) throw new CouldNotRun(`lsof could not run: ${out.error.message}`);
  if (!out.stdout) throw new CouldNotRun(`lsof -p ${pid} printed nothing (status ${out.status})`);
  return out.stdout.includes(file);
}

async function waitFor(what, ms, poll) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await poll();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`);
    await sleep(50);
  }
}

function serve(routes) {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const route = url.host === 'probe' ? routes[url.pathname] : undefined;
    if (route === undefined) return new Response(null, { status: 404 });
    return new Response(route.body, { headers: { 'content-type': route.type } });
  });
}

async function openWindow() {
  const oracle = await import(pathToFileURL(path.join(__dirname, 'oracle.mjs')).href);
  const header = fs.readFileSync(
    path.join(ROOT, 'native/concord-audiocap/rt/synthetic_source.h'),
    'utf8'
  );
  const table = Array.from(oracle.parseTable(header));
  const bridge = require('esbuild').buildSync({
    entryPoints: [path.join(ROOT, 'src/renderer/services/voice/screenAudioBridge.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__bridge',
    write: false,
  });
  const js = 'text/javascript; charset=utf-8';
  serve({
    '/': {
      type: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>audiocap transport probe</title><script type="module" src="/page.js"></script><body>audiocap transport probe</body>',
    },
    '/oracle.mjs': { type: js, body: fs.readFileSync(path.join(__dirname, 'oracle.mjs'), 'utf8') },
    '/page.js': { type: js, body: fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8') },
    '/table.json': { type: 'application/json', body: JSON.stringify(table) },
    '/bridge.js': { type: js, body: bridge.outputFiles[0].text },
  });
  win = new BrowserWindow({
    show: true,
    width: 480,
    height: 240,
    webPreferences: {
      preload: path.join(stage, 'dist/preload/preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (details) => {
    if (typeof details.message === 'string' && details.message.startsWith('FAIL ')) {
      say(details.message);
    }
  });
  win.webContents.on('preload-error', (_event, preload, error) => {
    say(`FAIL preload: ${path.basename(preload)}: ${errorText(error)}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    say(`FAIL renderer: the renderer process is gone (${details.reason})`);
    say('PROBE FAIL (could not run)');
    finish(2);
  });
  const query = INJECT === null ? '' : `?inject=${encodeURIComponent(INJECT)}`;
  await win.loadURL(`${ORIGIN}/${query}`);
  await page('window.__probeReady');
}

async function main() {
  await app.whenReady();
  say(
    `=== audiocap transport probe (${process.platform}, electron ${process.versions.electron}) ===`
  );
  if (INJECT !== null) say(`     inject = ${INJECT}`);
  const guard = guardFailure() ?? buildStage();
  if (guard !== null) {
    couldNotRun(guard);
    return;
  }
  host = require(path.join(stage, 'dist/main/audiocapHost.js'));
  try {
    await openWindow();
  } catch (err) {
    couldNotRun(`the probe page could not be prepared: ${errorText(err)}`);
    return;
  }

  // Registered before the start, exactly as main.ts registers them.
  host.setAudiocapInterruptListener((interrupt) => {
    interrupts.push({ generation: interrupt.generation, reason: interrupt.reason });
  });
  host.setAudiocapPortSink((generation, port) => {
    if (win === null || win.isDestroyed()) throw new Error('audiocap port sink: no live window');
    win.webContents.postMessage('audiocap:port', { generation }, [port]);
  });

  const started = await runPass('start', async () => {
    // NOT `null`: the host reads a null handle as the app-start capability probe and
    // settles without ever posting `start` or a port. The child still resolves the
    // handle to a live owner through the addon, so it must name a real window; the
    // probe's own window is one, and the synthetic backend ignores the target.
    const handle = windowHandleOf(win);
    const result = await host.startAudiocapHost(1, handle);
    check(
      result && result.ok === true,
      `startAudiocapHost(1, ${handle}) -> ${JSON.stringify(result)}`
    );
    check(
      (await page('__probe.createBridge(1)')) === 1,
      'the bridge was not built for generation 1'
    );
    try {
      await waitFor(
        'a first checked quantum',
        5000,
        async () => (await page('__probe.counts()')).checked > 0
      );
    } catch (err) {
      const seen = await page('[__probe.counts(), __probe.stats()]');
      throw new Error(`${errorText(err)}; counts and stats ${JSON.stringify(seen)}`);
    }
    return [
      `start -> ${JSON.stringify(result)}`,
      `audio data -> ${JSON.stringify(await page('__probe.shape()'))}`,
    ];
  });
  if (!started) {
    say('PROBE FAIL (1)');
    finish(1);
    return;
  }

  await runPass('isolation', async () => {
    const world = await page('typeof require + "," + typeof process');
    check(world === 'undefined,undefined', `the page main world sees require,process = ${world}`);
    if (process.platform !== 'darwin') return [`skip lsof: ${process.platform}`];
    const binary = stagedBinary();
    const utility = audiocapUtilityPid();
    if (!lsofLists(utility.pid, binary)) {
      throw new CouldNotRun(
        `positive control: lsof -p ${utility.pid} (the utility) does not list ${binary}`
      );
    }
    const rendererPid = win.webContents.getOSProcessId();
    check(!lsofLists(process.pid, binary), `main (pid ${process.pid}) has the addon open`);
    check(!lsofLists(rendererPid, binary), `the renderer (pid ${rendererPid}) has the addon open`);
    return [
      `utility ${utility.pid} (${utility.serviceName}, ${utility.name}) lists the staged addon; main ${process.pid} and renderer ${rendererPid} do not`,
    ];
  });

  await runPass('steady', async () => {
    const before = await page('__probe.counts()');
    await sleep(3000);
    const after = await page('__probe.counts()');
    const stats = await page('__probe.stats()');
    const delta = after.checked - before.checked;
    check(delta >= 250, `only ${delta} quanta checked in 3 s (floor 250)`);
    check(after.bad === 0, `${after.bad} bad quanta, first ${JSON.stringify(after.firstBad)}`);
    check(after.contentMissing === 0, `${after.contentMissing} quanta missing from the waveform`);
    check(
      stats && stats.overrun === 0 && stats.seqGaps === 0 && stats.faulted === false,
      `bridge stats ${JSON.stringify(stats)}`
    );
    return [
      `${delta} quanta in 3 s, ${after.checked} checked in all; stats ${JSON.stringify(stats)}`,
    ];
  });

  say(failed === 0 ? 'PROBE PASS' : `PROBE FAIL (${failed})`);
  finish(failed === 0 ? 0 : 1);
}

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.on('window-all-closed', () => undefined);

main().catch((err) => {
  say(`FAIL probe: ${errorText(err)}`);
  say('PROBE FAIL (could not run)');
  finish(2);
});

// A hung probe must fail the job, not hang the runner.
setTimeout(() => {
  say('PROBE FAIL (timeout)');
  finish(2);
}, 120_000).unref();
