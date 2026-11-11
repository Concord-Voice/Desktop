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
// Validated at the top of main(), before anything is staged.
const INJECTS = new Set(['bitflip', 'nostall', 'measuredrop']);
const INJECT_FLAG = process.argv.find((arg) => arg.startsWith('--inject='));
const INJECT = INJECT_FLAG === undefined ? null : INJECT_FLAG.slice(9);
const RELEASE_DIR = path.join(ROOT, 'native/concord-audiocap/build/Release');
const SYNTHETIC = path.join(RELEASE_DIR, 'concord_audiocap_synthetic.node');
const SHIPPED = path.join(RELEASE_DIR, 'concord_audiocap.node');
// After a stall the quanta already in flight (credit bound 8) and in the ring (8
// slots) arrive first, stale: at most 16 before the first gap shows. The bridge's
// overrun total lags a drop by up to 8 more, so the witnesses are read 32 fresh
// quanta after the stall, never sooner.
const STALE_LIMIT = 16;
const SETTLE_QUANTA = 32;

// `--measure` adds the latency and heap passes (design sections 4 and 6).
// `--seconds=N` shortens each measured window for iteration; the record uses 60.
const MEASURE = process.argv.includes('--measure');
const MEASURE_PASSES = new Set(['latency', 'heap']);
const SECONDS_FLAG = process.argv.find((arg) => arg.startsWith('--seconds='));
const SECONDS_ARG = SECONDS_FLAG === undefined ? '' : SECONDS_FLAG.slice(10);
const SECONDS = SECONDS_FLAG === undefined ? 60 : Number(SECONDS_ARG);
const DISCARD_MS = 5000;
const CALIBRATION_SAMPLES = 500;
// Frames written just before the window closes are still in the track; this is
// how long the processor is given to hand them back, and the bridge to count any
// drop among them, before the counts and stats compare (20 quanta; at least 2).
const DRAIN_MS = 200;
const QUANTA_PER_SECOND = 100;
const LIMITS = {
  retainedGrowthBytes: 65536,
  bytesPerQuantum: 2048,
  largestTransportAddedGapMs: 20,
};
const measured = { timerResolutionMs: null, crossOriginIsolated: null, latency: null, heap: null };
// oracle.mjs, imported once by main().
let oracle = null;

class CouldNotRun extends Error {}
// A measurement pass whose preconditions did not hold. It exits 2 like CouldNotRun,
// but only after the remaining passes and the record have run, so a void latency
// pass still leaves the heap figures on the page.
class Void extends Error {}

let stage = null;
let host = null;
let win = null;
let failed = 0;
let voided = 0;
let exiting = false;
const interrupts = [];

function errorText(err) {
  return err && typeof err.message === 'string' ? err.message : String(err);
}

function say(line) {
  // eslint-disable-next-line no-console -- this IS the probe output; a CI job reads stdout
  console.log(line);
}

/** Delete the stage. Returns false when it could not be deleted. */
function removeStage() {
  if (stage === null) return true;
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    stage = null;
    return true;
  } catch (err) {
    say(`FAIL cleanup: could not delete the stage: ${errorText(err)}`);
    return false;
  }
}

process.on('exit', removeStage);

/** Tear down and exit; a cleanup step that failed raises the code to at least 2. */
function finish(code) {
  if (exiting) return;
  exiting = true;
  let cleanedUp = true;
  if (host !== null) {
    try {
      host.killAudiocapHost();
    } catch (err) {
      say(`FAIL cleanup: killAudiocapHost threw: ${errorText(err)}`);
      cleanedUp = false;
    }
  }
  if (win !== null && !win.isDestroyed()) win.destroy();
  if (!removeStage()) cleanedUp = false;
  app.exit(cleanedUp ? code : Math.max(code, 2));
}

function couldNotRun(reason) {
  say(`FAIL guard: ${reason}`);
  say('PROBE FAIL (could not run)');
  finish(2);
}

/**
 * Run one pass and print its result line. A thrown `CouldNotRun` ends the probe
 * with exit 2, or exit 1 when an earlier pass already failed; any other throw is
 * a violated invariant and counts toward exit 1.
 */
async function runPass(name, fn) {
  try {
    const notes = await fn();
    say(`ok   ${name}`);
    for (const note of notes ?? []) say(`     ${note}`);
    return true;
  } catch (err) {
    say(`FAIL ${name}: ${errorText(err)}`);
    if (err instanceof Void) {
      voided += 1;
      return false;
    }
    if (err instanceof CouldNotRun) {
      // A measure pass prints what it had measured before the run ends. An earlier
      // violated invariant is not masked: exit 1 over exit 2.
      if (MEASURE_PASSES.has(name)) printMeasurements();
      say(failed > 0 ? `PROBE FAIL (${failed}; could not run)` : 'PROBE FAIL (could not run)');
      finish(failed > 0 ? 1 : 2);
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

// ponytail: whole input directories, not a file list that drifts as imports change; an
// unrelated edit under them asks for a rebuild it did not strictly need.
function isStale(artifact, inputs) {
  if (!fs.existsSync(artifact)) return true;
  const built = fs.statSync(artifact).mtimeMs;
  const newer = (file) => fs.statSync(file).mtimeMs > built;
  return inputs.some((input) => {
    const abs = path.join(ROOT, input);
    if (fs.statSync(abs).isFile()) return newer(abs);
    return fs
      .readdirSync(abs, { recursive: true })
      .some((rel) => fs.statSync(path.join(abs, rel)).isFile() && newer(path.join(abs, rel)));
  });
}

/** Every precondition the passes rely on. Returns a reason, or null when all hold. */
function guardFailure() {
  if (app.isPackaged) return 'the probe refuses to run in a packaged app';
  const build = 'run `npm run build:main && npm run build:preload`';
  const hostJs = path.join(ROOT, 'dist/main/audiocapHost.js');
  // tsconfig.main.json compiles src/main and src/shared; the preload bundle also
  // imports from src/main.
  if (isStale(hostJs, ['src/main', 'src/shared'])) {
    return `dist/main is missing or older than its source; ${build}`;
  }
  const preloadJs = path.join(ROOT, 'dist/preload/preload.js');
  if (isStale(preloadJs, ['src/preload', 'src/shared', 'src/main'])) {
    return `dist/preload/preload.js is missing or older than its source; ${build}`;
  }
  const native = 'native/concord-audiocap';
  if (isStale(SYNTHETIC, [`${native}/rt`, `${native}/napi`, `${native}/binding.gyp`])) {
    return 'the synthetic addon is missing or older than its source; run `npm run build:native -- --synthetic`';
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
  const own = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
  // The page is a static file, not a string here: every body below is the probe's own
  // file or data, and keeping the <script> tag out of this map keeps that visible.
  serve({
    '/': { type: 'text/html; charset=utf-8', body: own('page.html') },
    '/oracle.mjs': { type: js, body: own('oracle.mjs') },
    '/page.js': { type: js, body: own('page.js') },
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
  // A measured window must stay visible (the latency pass is void otherwise), so
  // in measure mode it sits above the other windows rather than behind them.
  if (MEASURE) win.setAlwaysOnTop(true);
  win.webContents.on('console-message', (details) => {
    // FAIL lines carry a verdict; NOTE lines are logged and change none.
    const line = details.message;
    if (typeof line === 'string' && (line.startsWith('FAIL ') || line.startsWith('NOTE '))) {
      say(line);
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
  await loadProbePage(null);
}

/** Load (or reload) the probe page; `mode` 'heap' loads it without hook or processor. */
async function loadProbePage(mode) {
  const params = new URLSearchParams();
  if (INJECT !== null) params.set('inject', INJECT);
  if (mode !== null) params.set('mode', mode);
  const query = params.size === 0 ? '' : `?${params}`;
  await win.loadURL(`${ORIGIN}/${query}`);
  await page('window.__probeReady');
}

/** Design section 6: the renderer clock against main's `process.hrtime` (uv_hrtime). */
async function calibrateClocks(calibrate) {
  const samples = [];
  for (let i = 0; i < CALIBRATION_SAMPLES; i++) {
    const t0Ns = process.hrtime.bigint();
    const perfMs = await page('performance.now()');
    const t1Ns = process.hrtime.bigint();
    samples.push({ t0Ns, perfMs, t1Ns });
  }
  return calibrate(samples);
}

/** min, p50 and max of each paired frame's timestamp minus its write's E0, in us. */
function offsetSummary(values) {
  if (values.length === 0) return null;
  const { p50, max } = oracle.percentiles(values);
  return { n: values.length, min: Math.min(...values), p50, max };
}

/**
 * The read-back content verdict over the paired frames. Read-back that is never
 * bit-exact is systematic (the engine converts the samples on the way back), so
 * the pairing stands on timestamps alone. Read-back that is bit-exact for some
 * frames and not others, or that carries another quantum's phase, means frames
 * were dropped or mixed: a void.
 */
function judgeContent(rec) {
  const { matched, unreadable, phaseMismatch, first } = rec.content;
  if (unreadable === 0 && phaseMismatch === 0) {
    return {
      pairing: 'content+timestamp',
      contentCheck: { ok: true, matched, format: rec.content.format },
      contentVoid: null,
    };
  }
  if (unreadable === rec.paired) {
    return {
      pairing: 'timestamp-only',
      contentCheck: {
        ok: false,
        reason: first.reason,
        firstIndex: first.index,
        format: first.format,
      },
      contentVoid: null,
    };
  }
  return {
    pairing: null,
    contentCheck: { ok: false, matched, unreadable, phaseMismatch, first },
    contentVoid: `the read-back content is not systematic: of ${rec.paired} paired frames ${matched} matched, ${unreadable} were not bit-exact, ${phaseMismatch} carried another quantum's phase; first ${JSON.stringify(first)}`,
  };
}

/** Await one setup step; a rejection means the pass could not run, not that it failed. */
async function setup(what, step) {
  try {
    return await step();
  } catch (err) {
    throw new CouldNotRun(`${what} rejected: ${errorText(err)}`);
  }
}

/**
 * The write-gap figures, from the hook's E0 and E1 alone. An E1 gap is not all
 * write delay: a late wake of the synthetic source in the capture process widens
 * the E0 gap between the same two quanta as much. The transport-added gap is the
 * E1 gap less that E0 gap, and only it is judged; the write delay is the largest
 * raw L_transport.
 */
function writeGaps(rec, offsetMs) {
  const n = rec.written;
  let largestWriteGapMs = null;
  let e0GapAtLargestWriteGapMs = null;
  let largestTransportAddedGapMs = null;
  let largestWriteDelayMs = null;
  for (let i = 0; i < n; i++) {
    const delay = rec.e1[i] - offsetMs - rec.e0[i] / 1000;
    if (largestWriteDelayMs === null || delay > largestWriteDelayMs) largestWriteDelayMs = delay;
  }
  for (let i = 1; i < n; i++) {
    const e1Gap = rec.e1[i] - rec.e1[i - 1];
    const e0Gap = rec.e0[i] / 1000 - rec.e0[i - 1] / 1000;
    if (largestWriteGapMs === null || e1Gap > largestWriteGapMs) {
      largestWriteGapMs = e1Gap;
      e0GapAtLargestWriteGapMs = e0Gap;
    }
    const added = e1Gap - e0Gap;
    if (largestTransportAddedGapMs === null || added > largestTransportAddedGapMs) {
      largestTransportAddedGapMs = added;
    }
  }
  return {
    largestWriteGapMs,
    e0GapAtLargestWriteGapMs,
    largestTransportAddedGapMs,
    largestWriteDelayMs,
  };
}

/**
 * The latency pass (design section 6). Throws `Void` when a precondition of the
 * window did not hold, after recording what it measured, and `CouldNotRun` when
 * the processor, the timer or a calibration could not be set up.
 */
async function latencyPass() {
  const { calibrate, percentiles } = oracle;
  const cap = (SECONDS + 10) * QUANTA_PER_SECOND;
  let started;
  try {
    started = await page(`__probe.startProcessor(${cap})`);
  } catch (err) {
    throw new CouldNotRun(`the track processor could not be set up: ${errorText(err)}`);
  }
  if (started !== 'started') throw new CouldNotRun(started);
  await sleep(DISCARD_MS);
  const resolution = await setup('__probe.timerResolution()', () =>
    page('__probe.timerResolution()')
  );
  if (resolution === null) throw new CouldNotRun('performance.now() never ticked in 2000 readings');
  measured.timerResolutionMs = resolution;
  measured.crossOriginIsolated = await page('globalThis.crossOriginIsolated');
  const before = await setup('the calibration before the window', () => calibrateClocks(calibrate));
  const start = await page('__probe.beginWindow()');
  const openedAt = Date.now();
  if (INJECT === 'measuredrop') {
    await sleep(2000);
    await page('__probe.stall(300)');
  }
  await sleep(Math.max(0, openedAt + SECONDS * 1000 - Date.now()));
  const end = await page('__probe.endWindow()');
  await sleep(DRAIN_MS);
  const rec = await page('__probe.latencyRecord()');
  const after = await setup('the calibration after the window', () => calibrateClocks(calibrate));

  const n = rec.written;
  const offsetMs = (before.offsetMs + after.offsetMs) / 2;
  // Recorded before any invariant or void rule can throw, so a failed or void
  // window still reports them.
  const gaps = writeGaps(rec, offsetMs);
  measured.latency = { windowSeconds: SECONDS, written: n, ...gaps };
  // Both snapshots: a fault among the window's last writes shows only after the drain.
  check(
    end.stats.faulted === false && rec.drainedStats.faulted === false,
    'the bridge faulted in the latency window'
  );
  // seqGaps and overrun from the snapshot taken after the drain, so a drop among
  // the window's last writes is counted too.
  const deltas = {
    seqGaps: rec.drainedStats.seqGaps - start.stats.seqGaps,
    overrun: rec.drainedStats.overrun - start.stats.overrun,
    bad: end.counts.bad - start.counts.bad,
    contentMissing: end.counts.contentMissing - start.counts.contentMissing,
  };
  // A calibration's uncertaintyMs is its half round trip only; the timer
  // resolution is added here, once for each calibration.
  const driftLimitMs = before.uncertaintyMs + after.uncertaintyMs + 2 * resolution;
  const drift = after.offsetMs - before.offsetMs;
  const { pairing, contentCheck, contentVoid } = judgeContent(rec);
  const voids = [];
  if (n < SECONDS * QUANTA_PER_SECOND - 10) voids.push(`only ${n} writes in a ${SECONDS} s window`);
  if (n !== rec.paired) voids.push(`E1 count ${n} != E2 count ${rec.paired}`);
  if (rec.mismatches !== 0) {
    voids.push(
      `${rec.mismatches} processor frames did not pair with their quantum's E0 within ${rec.toleranceUs} us, first ${JSON.stringify(rec.firstMismatch)}`
    );
  }
  if (contentVoid !== null) voids.push(contentVoid);
  if (rec.overflow !== 0) voids.push(`${rec.overflow} writes overflowed the ${cap}-slot record`);
  if (rec.processorError !== null) voids.push(`the processor failed: ${rec.processorError}`);
  if (deltas.seqGaps !== 0 || deltas.overrun !== 0) {
    voids.push(`seqGaps delta ${deltas.seqGaps}, overrun delta ${deltas.overrun}`);
  }
  if (deltas.bad !== 0) voids.push(`${deltas.bad} bad quanta in the window`);
  if (deltas.contentMissing !== 0) {
    voids.push(`${deltas.contentMissing} quanta missing from the waveform in the window`);
  }
  if (Math.abs(drift) > driftLimitMs) {
    voids.push(`the calibration offset moved ${drift} ms (limit ${driftLimitMs} ms)`);
  }
  if (start.visibility !== 'visible' || end.visibility !== 'visible') {
    voids.push(`visibilityState ${start.visibility} at start, ${end.visibility} at end`);
  }
  if (rec.visibilityChanges !== 0) {
    voids.push(`${rec.visibilityChanges} visibilitychange events in the window`);
  }
  const common = {
    windowSeconds: SECONDS,
    written: n,
    paired: rec.paired,
    pairing,
    toleranceUs: rec.toleranceUs,
    contentCheck,
    frameMinusE0Us: offsetSummary(rec.offset),
    ...gaps,
    largestWriteGapJudged:
      n > 1 &&
      deltas.seqGaps === 0 &&
      deltas.overrun === 0 &&
      deltas.bad === 0 &&
      deltas.contentMissing === 0,
    windowDeltas: deltas,
    visibilityChanges: rec.visibilityChanges,
    framesOutsideWindow: rec.outsideWindow,
    calibrationBefore: before,
    calibrationAfter: after,
  };
  if (voids.length > 0) {
    measured.latency = {
      void: voids,
      ...common,
      firstMismatch: rec.firstMismatch,
      processorFrameTsHead: rec.headTs,
      e0Head: rec.e0.slice(0, rec.headTs.length),
    };
    throw new Void(`void: ${voids.join('; ')}`);
  }

  const generator = [];
  const generatorAdjusted = [];
  const transport = [];
  const total = [];
  const totalAdjusted = [];
  for (let i = 0; i < n; i++) {
    const e0Ms = rec.e0[i] / 1000;
    generator.push(rec.e2[i] - rec.e1[i]);
    generatorAdjusted.push(rec.e2[i] - rec.e1[i] - rec.overhead[i]);
    transport.push(rec.e1[i] - offsetMs - e0Ms);
    total.push(rec.e2[i] - offsetMs - e0Ms);
    totalAdjusted.push(rec.e2[i] - offsetMs - e0Ms - rec.overhead[i]);
  }
  const segment = (values) => {
    const floor = Math.min(...values);
    return {
      absolute: percentiles(values),
      offsetFree: percentiles(values.map((v) => v - floor)),
    };
  };
  // One clock: each stamp is quantised to the resolution. Two clocks: the wider
  // calibration bracket as well.
  const quantisationMs = 2 * resolution;
  const twoClockMs = Math.max(before.uncertaintyMs, after.uncertaintyMs) + quantisationMs;
  const generatorRaw = segment(generator);
  const overhead = percentiles(rec.overhead);
  measured.latency = {
    ...common,
    offsetUsedMs: offsetMs,
    L_generator: {
      uncertaintyPlusMinusMs: quantisationMs,
      // In whole ticks: a p99 of exactly two ticks reads 0.2000000030 against a
      // 2 x resolution of 0.1999999881, so a float comparison would miss it.
      atResolutionFloor: Math.round(generatorRaw.absolute.p99 / resolution) <= 2,
      raw: generatorRaw,
      adjusted: segment(generatorAdjusted),
    },
    L_transport: { uncertaintyPlusMinusMs: twoClockMs, raw: segment(transport) },
    L_total: {
      uncertaintyPlusMinusMs: twoClockMs,
      raw: segment(total),
      adjusted: segment(totalAdjusted),
    },
    hookOverheadMs: {
      resolutionMs: resolution,
      p50: overhead.p50,
      p95: overhead.p95,
      max: overhead.max,
    },
  };
  return [
    `n ${n}; pairing ${pairing}; L_total p50 ${measured.latency.L_total.raw.absolute.p50} ms (+/-${twoClockMs}); largest write gap ${gaps.largestWriteGapMs} ms (E0 gap ${gaps.e0GapAtLargestWriteGapMs} ms); largest transport-added gap ${gaps.largestTransportAddedGapMs} ms; largest write delay ${gaps.largestWriteDelayMs} ms`,
  ];
}

/** Sum of selfSize over the sampling profile, and its largest sites by function and line. */
function profileSites(head) {
  let sampledBytes = 0;
  const sites = new Map();
  const stack = [head];
  while (stack.length > 0) {
    const node = stack.pop();
    sampledBytes += node.selfSize;
    if (node.selfSize > 0) {
      const { functionName, url, lineNumber } = node.callFrame;
      const file = url.slice(url.lastIndexOf('/') + 1);
      const key = `${functionName}\u0000${file}\u0000${lineNumber}`;
      const site = sites.get(key) ?? { functionName, file, lineNumber, selfSize: 0 };
      site.selfSize += node.selfSize;
      sites.set(key, site);
    }
    stack.push(...node.children);
  }
  const top = [...sites.values()].sort((a, b) => b.selfSize - a.selfSize).slice(0, 5);
  return { sampledBytes, top };
}

/** The heap pass (design section 4), on a fresh page load and a new host generation. */
async function heapPass() {
  try {
    await loadProbePage('heap');
  } catch (err) {
    throw new CouldNotRun(`the heap page could not be prepared: ${errorText(err)}`);
  }
  const handle = windowHandleOf(win);
  const result = await setup(`startAudiocapHost(2, ${handle})`, () =>
    host.startAudiocapHost(2, handle)
  );
  if (!(result && result.ok === true)) {
    throw new CouldNotRun(
      `generation 2 did not start after the kill: startAudiocapHost(2, ${handle}) -> ${JSON.stringify(result)}`
    );
  }
  check((await page('__probe.createBridge(2)')) === 2, 'the bridge was not built for generation 2');
  let graph;
  try {
    graph = await page('__probe.startHeapGraph()');
  } catch (err) {
    throw new CouldNotRun(`the heap page's audio graph could not be built: ${errorText(err)}`);
  }
  if (graph !== 'running') throw new Void(`void: audioContext.state is ${graph}, not running`);
  try {
    await waitFor(
      'signal at the analyser',
      5000,
      async () => (await page('__probe.heapState()')).peak > 0
    );
  } catch (err) {
    throw new Void(`void: no quanta reach the audio graph: ${errorText(err)}`);
  }
  await sleep(DISCARD_MS);
  const before = await page('__probe.heapState()');
  const dbg = win.webContents.debugger;
  const send = async (method, params) => {
    try {
      return await dbg.sendCommand(method, params);
    } catch (err) {
      throw new CouldNotRun(`${method} was rejected: ${errorText(err)}`);
    }
  };
  try {
    dbg.attach();
  } catch (err) {
    throw new CouldNotRun(`debugger.attach() threw: ${errorText(err)}`);
  }
  let usageBefore;
  let usageAfter;
  let profile;
  let elapsedS;
  // A detach that throws fails the pass once the record below is built. It is
  // logged here too, for when the window itself threw first.
  let detachFailure = null;
  try {
    await send('HeapProfiler.enable');
    await send('HeapProfiler.collectGarbage');
    usageBefore = await send('Runtime.getHeapUsage');
    const t0 = process.hrtime.bigint();
    await send('HeapProfiler.startSampling', {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    // Nothing may call into the page here: every executeJavaScript allocates in
    // the heap being sampled.
    await sleep(SECONDS * 1000);
    ({ profile } = await send('HeapProfiler.stopSampling'));
    elapsedS = Number(process.hrtime.bigint() - t0) / 1e9;
    await send('HeapProfiler.collectGarbage');
    usageAfter = await send('Runtime.getHeapUsage');
  } finally {
    try {
      dbg.detach();
    } catch (err) {
      detachFailure = `debugger.detach() threw: ${errorText(err)}`;
      say(`FAIL heap: ${detachFailure}`);
    }
  }
  const after = await page('__probe.heapState()');
  const seqGaps = after.stats.seqGaps - before.stats.seqGaps;
  const overrun = after.stats.overrun - before.stats.overrun;
  const quantaNominal = Math.round(elapsedS * QUANTA_PER_SECOND) - seqGaps;
  const { sampledBytes, top } = profileSites(profile.head);
  measured.heap = {
    scope: 'renderer isolate: bridge plus preload relay',
    windowSeconds: SECONDS,
    elapsedSeconds: elapsedS,
    generation2Start: result,
    sampledBytes,
    quantaNominal,
    denominatorNote: 'nominal: elapsed x 100 minus seqGaps; the bridge has no delivered counter',
    bytesPerQuantum: sampledBytes / quantaNominal,
    usedSizeBefore: usageBefore.usedSize,
    usedSizeAfter: usageAfter.usedSize,
    usedSizeDelta: usageAfter.usedSize - usageBefore.usedSize,
    backingStorageSizeDelta:
      typeof usageBefore.backingStorageSize === 'number' &&
      typeof usageAfter.backingStorageSize === 'number'
        ? usageAfter.backingStorageSize - usageBefore.backingStorageSize
        : 'not exposed',
    seqGapsDelta: seqGaps,
    overrunDelta: overrun,
    largestSites: top,
  };
  const voids = [];
  if (before.audioState !== 'running' || after.audioState !== 'running') {
    voids.push(`audioContext.state ${before.audioState} before, ${after.audioState} after`);
  }
  if (after.peak === 0) voids.push('no signal at the analyser after the window');
  if (seqGaps !== 0 || overrun !== 0) {
    voids.push(`seqGaps delta ${seqGaps}, overrun delta ${overrun} in the heap window`);
  }
  if (voids.length > 0) measured.heap.void = voids;
  // A debugger left attached fails the pass, and a failure outranks a void.
  if (detachFailure !== null) throw new Error(detachFailure);
  if (voids.length > 0) throw new Void(`void: ${voids.join('; ')}`);
  return [
    `generation 2 -> ${JSON.stringify(result)}; ${sampledBytes} B sampled over ${quantaNominal} nominal quanta; usedSize delta ${measured.heap.usedSizeDelta} B`,
  ];
}

/** Print the record. A measure pass that could not run still prints what it had. */
function printMeasurements() {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  const env = {
    gitSha: git.status === 0 ? git.stdout.trim() : `unavailable (git status ${git.status})`,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    uv: process.versions.uv,
    osVersion: os.version(),
    osRelease: os.release(),
    arch: process.arch,
    timerResolutionMs: measured.timerResolutionMs,
    crossOriginIsolated: measured.crossOriginIsolated,
    windowSeconds: SECONDS,
  };
  say('=== MEASURE JSON BEGIN ===');
  say(JSON.stringify({ env, latency: measured.latency, heap: measured.heap }, null, 2));
  say('=== MEASURE JSON END ===');
}

/** Print the record, then judge the limits, so the numbers show even when one trips. */
function reportMeasurements() {
  printMeasurements();
  const flag = (name, value, limit) => {
    if (value <= limit) return;
    say(`FLAG ${name}: ${value} over ${limit}`);
    failed += 1;
  };
  // A void heap window was not clean, so its figures are not judged.
  if (measured.heap !== null && measured.heap.void === undefined) {
    flag('retained-growth', measured.heap.usedSizeDelta, LIMITS.retainedGrowthBytes);
    flag('sampled-allocation-per-quantum', measured.heap.bytesPerQuantum, LIMITS.bytesPerQuantum);
  }
  // The transport-added gap is from the hook's E0 and E1 alone, so it is judged on
  // a void latency pass too, whenever the window dropped nothing, every quantum
  // checked clean and none was missing from the waveform.
  if (measured.latency !== null && measured.latency.largestWriteGapJudged === true) {
    flag(
      'largest-transport-added-gap',
      measured.latency.largestTransportAddedGapMs,
      LIMITS.largestTransportAddedGapMs
    );
  }
}

/** The command line, checked before anything is staged. Returns a reason, or null. */
function flagFailure() {
  if (INJECT !== null && !INJECTS.has(INJECT)) return `unknown --inject=${INJECT}`;
  if (INJECT === 'measuredrop' && !MEASURE) return '--inject=measuredrop needs --measure';
  if (SECONDS_FLAG !== undefined && !MEASURE) return `${SECONDS_FLAG} needs --measure`;
  const stray = process.argv.find((arg) => arg.startsWith('--measure') && arg !== '--measure');
  if (stray !== undefined) return `unknown flag ${stray}; the measure flag is exactly --measure`;
  if (MEASURE && !(Number.isInteger(SECONDS) && SECONDS >= 1)) {
    return `--seconds must be a positive integer, got ${JSON.stringify(SECONDS_ARG)}`;
  }
  return null;
}

async function main() {
  await app.whenReady();
  say(
    `=== audiocap transport probe (${process.platform}, electron ${process.versions.electron}) ===`
  );
  const flags = flagFailure();
  if (flags !== null) {
    couldNotRun(flags);
    return;
  }
  if (INJECT !== null) say(`     inject = ${INJECT}`);
  if (MEASURE) say(`     measure, ${SECONDS} s windows`);
  const guard = guardFailure() ?? buildStage();
  if (guard !== null) {
    couldNotRun(guard);
    return;
  }
  host = require(path.join(stage, 'dist/main/audiocapHost.js'));
  try {
    oracle = await import(pathToFileURL(path.join(__dirname, 'oracle.mjs')).href);
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

  await runPass('slow consumer', async () => {
    const { judgeStall } = oracle;
    const notes = [];
    for (const ms of [80, 300, 450]) {
      const tag = `stall ${ms} ms`;
      const control = ms === 80;
      // Counts and stats in one page turn, so no quantum lands between the two.
      const [before, beforeStats] = await page('[__probe.counts(), __probe.stats()]');
      await page(`__probe.stall(${ms})`);
      let after = null;
      let stats = null;
      await waitFor(`${tag}: ${SETTLE_QUANTA} quanta checked after the stall`, 2000, async () => {
        [after, stats] = await page('[__probe.counts(), __probe.stats()]');
        return after.checked >= after.stallEnd + SETTLE_QUANTA;
      });
      const content = after.contentMissing - before.contentMissing;
      const seqGaps = stats.seqGaps - beforeStats.seqGaps;
      const overrun = stats.overrun - beforeStats.overrun;
      const verdict = judgeStall({ content, seqGaps, overrun, control });
      check(verdict.ok, `${tag}: ${verdict.reason}`);
      check(
        after.bad === 0,
        `${tag}: ${after.bad} bad quanta, first ${JSON.stringify(after.firstBad)}`
      );
      check(stats.faulted === false, `${tag}: the bridge faulted`);
      let gapNote = '';
      if (!control) {
        check(after.firstGapAt !== null, `${tag}: no content gap after the stall ended`);
        const stale = after.firstGapAt - after.stallEnd - 1;
        check(
          stale <= STALE_LIMIT,
          `${tag}: the first gap came after ${stale} stale quanta (at most ${STALE_LIMIT})`
        );
        gapNote = `, first gap after ${stale} stale quanta`;
      }
      notes.push(`${tag} -> content ${content}, seqGaps ${seqGaps}, overrun ${overrun}${gapNote}`);
    }
    return notes;
  });

  if (MEASURE) await runPass('latency', latencyPass);

  // LAST on this page: it ends the capture, and only the heap pass (a fresh page
  // and a new generation, no hook) may follow it.
  await runPass('kill', async () => {
    const utility = audiocapUtilityPid();
    const seen = interrupts.length;
    const killedAt = Date.now();
    const until = (ms) => sleep(Math.max(0, killedAt + ms - Date.now()));
    process.kill(utility.pid, 'SIGKILL');
    await until(1000);
    const checkedAt1s = (await page('__probe.counts()')).checked;
    await until(2000);
    const checkedAt2s = (await page('__probe.counts()')).checked;
    const survivors = app
      .getAppMetrics()
      .filter((m) => m.type === 'Utility' && m.serviceName === 'node.mojom.NodeService');
    await until(5000);
    const arrived = interrupts.slice(seen);
    check(
      arrived.length === 1,
      `${arrived.length} interrupts within 5 s of the SIGKILL, expected exactly 1: ${JSON.stringify(arrived)}`
    );
    check(
      arrived[0].reason === 'child-crash',
      `the interrupt reason is ${arrived[0].reason}, expected child-crash`
    );
    const generation = host.currentAudiocapGeneration();
    check(
      generation === 0,
      `currentAudiocapGeneration() is ${generation} after the kill, expected 0`
    );
    check(
      checkedAt2s === checkedAt1s,
      `writes continued after the kill: ${checkedAt1s} checked at 1 s, ${checkedAt2s} at 2 s`
    );
    check(
      survivors.length === 0,
      `a node utility process exists 2 s after the kill: ${survivors.map((m) => m.pid).join(', ')}`
    );
    return [
      `utility ${utility.pid} killed; interrupt ${JSON.stringify(arrived[0])}; ${checkedAt1s} checked at 1 s and 2 s; no node utility at 2 s`,
    ];
  });

  if (MEASURE) {
    await runPass('heap', heapPass);
    reportMeasurements();
  }
  // A violated invariant outranks a void: exit 1 over exit 2.
  if (failed > 0) {
    say(`PROBE FAIL (${failed})`);
    finish(1);
    return;
  }
  if (voided > 0) {
    say(`PROBE FAIL (could not run: ${voided} void)`);
    finish(2);
    return;
  }
  say('PROBE PASS');
  finish(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.on('window-all-closed', () => undefined);
// The heap pass's AudioContext must run with no user gesture.
if (MEASURE) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

main().catch((err) => {
  say(`FAIL probe: ${errorText(err)}`);
  say('PROBE FAIL (could not run)');
  finish(2);
});

// A hung probe must fail the job, not hang the runner. A measure run adds two
// windows, their 5 s discards and two calibrations.
setTimeout(
  () => {
    say('PROBE FAIL (timeout)');
    finish(2);
  },
  MEASURE && Number.isInteger(SECONDS) ? 180_000 + 2 * SECONDS * 1000 : 120_000
).unref();
