import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { _electron as electron } from '@playwright/test';
import { createLocalSfu } from './local-sfu.mjs';
import { createVideoProgressGate, initialConsumersVerified, replacementVerified, requireDuration,
  requireElectronAlignment, requireNoRuntimeFailure, verifiedConsumerId, launchProbeElectron,
  summarizeRuntimeWitnesses, continuousCallDecision, planContinuousCallPoll, POLL_INTERVAL_MS,
  withDeadline, watchdogBudgetMs } from './witness-contract.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(directory, '../..');
const media = path.resolve(process.env.MEDIA_PROBE_SERVER_DIR ?? path.join(desktop, '../../Self-Hosted/services/media-plane'));
const require = createRequire(path.join(desktop, 'package.json'));
const electronDirectory = path.dirname(require.resolve('electron'));
const duration = requireDuration(Number(process.env.MEDIA_PROBE_DURATION_MS ?? 95_000));
const result = { status: 'FAIL', scope: 'production media hooks and sampler; fixture account/key/signaling setup',
  durationRequiredMs: duration, versions: {}, witnesses: [], detectorFaultControl: 'NOT RUN' };
let sfu, vite, app, profile;
let stage;
const startedAtMs = performance.now();
// Stage changes go to stderr so a hung run still shows where it stopped.
function setStage(next) {
  stage = next;
  process.stderr.write(`[voice-probe] ${Math.round(performance.now() - startedAtMs)} ms stage: ${next}\n`);
}
setStage('setup');
const pages = [];
const markers = { selectedPair: 0, transformVerified: 0, transformFailure: false, priorityUpdateFailure: false,
  pageErrors: 0, workerInitialized: 0, transformEvents: 0, firstEncrypted: 0, firstDecrypted: 0 };
const verifiedByPeer = [new Set(), new Set()];
const pendingMarkers = new Set();

async function until(operation, predicate, label, timeout = 30_000) {
  process.stderr.write(`[voice-probe] waiting for: ${label}\n`);
  const deadline = Date.now() + timeout;
  do {
    const value = await withDeadline(operation(), Math.max(1, deadline - Date.now()), label);
    if (predicate(value)) return value;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Missing runtime witness: ${label}`);
}

// Every renderer call gets its own deadline, so a stall names the call that hung
// instead of waiting for the run-wide watchdog.
const RENDERER_CALL_MS = 30_000;
const DIAGNOSE_MS = 8_000;
function inRenderer(page, label, fn, arg) {
  return withDeadline(page.evaluate(fn, arg), RENDERER_CALL_MS, label);
}

function writeResult() {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.MEDIA_PROBE_OUTPUT) {
    const output = path.resolve(process.env.MEDIA_PROBE_OUTPUT);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, text);
  }
  process.stdout.write(text);
}

// A stuck renderer, worker or close call must still produce a result that names
// its stage, before the CI step limit kills the process without one. Kept ref'd:
// a stuck await with no live handle behind it would otherwise let Node exit
// (code 13) before the finally block writes anything. Cleared after cleanup.
const watchdogMs = watchdogBudgetMs(duration);
const watchdog = setTimeout(() => {
  result.status = 'FAIL';
  result.stage = stage;
  result.reason = `Watchdog: no result within ${watchdogMs} ms`;
  result.markers = { ...markers };
  try { app?.process()?.kill('SIGKILL'); } catch { /* engine may already be gone */ }
  writeResult();
  process.exit(1);
}, watchdogMs);

try {
  const mediaLock = JSON.parse(await readFile(path.join(media, 'package-lock.json'), 'utf8'));
  sfu = await createLocalSfu(media);
  assert.equal(sfu.version, mediaLock.packages['node_modules/mediasoup'].version, 'Actual SFU must match selected lockfile');
  result.versions.mediasoupPackage = sfu.version;
  result.nativeWorker = sfu.nativeWorker;
  result.versions.mediasoupClient = require('mediasoup-client').version;
  const clientLock = JSON.parse(await readFile(path.join(desktop, 'package-lock.json'), 'utf8'));
  const clientManifest = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'));
  const electronBinding = {
    manifest: clientManifest.devDependencies.electron,
    lockManifest: clientLock.packages[''].devDependencies.electron,
    locked: clientLock.packages['node_modules/electron'].version,
    installed: JSON.parse(await readFile(path.join(electronDirectory, 'package.json'), 'utf8')).version,
  };
  requireElectronAlignment(electronBinding, require('semver').satisfies);
  assert.equal(result.versions.mediasoupClient, clientLock.packages['node_modules/mediasoup-client'].version);
  vite = await createServer({
    configFile: path.join(desktop, 'vite.config.ts'), root: desktop,
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
    plugins: [{ name: 'local-voice-runtime-probe', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/__voice_runtime_probe') {
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml(request.url,
            '<!doctype html><html><head><title>Voice runtime probe</title></head><body><script type="module" src="/scripts/voice-runtime-probe/page.mjs"></script></body></html>'));
          return;
        }
        if (url.pathname !== '/__voice_runtime_probe/rpc') { next(); return; }
        // The fixture binds loopback and admits only same-origin POSTs. It is
        // never a deployed or user-authenticated signaling endpoint.
        if (request.method !== 'POST' || request.headers.origin !== `http://${request.headers.host}`) {
          response.writeHead(403); response.end(); return;
        }
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 32_768) throw new Error('Fixture body limit');
          }
          const data = await sfu.rpc(JSON.parse(body));
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data));
        } catch {
          response.writeHead(400); response.end('Invalid local fixture operation');
        }
      });
    } }],
  });
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  // Resolve without importing electron/index.js: recent releases download at
  // import time, which would hide a missing normal installation prerequisite.
  const executablePath = process.env.MEDIA_PROBE_ELECTRON ?? path.join(electronDirectory, 'dist',
    (await readFile(path.join(electronDirectory, 'path.txt'), 'utf8')).trim());
  profile = await mkdtemp(path.join(os.tmpdir(), 'concord-voice-runtime-'));
  setStage('engine-launch');
  app = await launchProbeElectron(electron, { executablePath, timeout: 30_000,
    args: [path.join(directory, 'main.cjs'), `--user-data-dir=${profile}`, '--allow-loopback-in-peer-connection',
      '--autoplay-policy=no-user-gesture-required'],
  });
  setStage('renderer-setup');
  result.runtimeDiagnostics = { windows: {}, peers: [] };
  await until(async () => {
    result.runtimeDiagnostics.windows = {
      ...await app.evaluate(({ BrowserWindow }) => ({
        native: BrowserWindow.getAllWindows().length,
        rendererCrashes: globalThis.voiceProbeLifecycle?.rendererCrashes ?? 0,
        navigationFailures: globalThis.voiceProbeLifecycle?.navigationFailures ?? 0,
      })),
      playwright: app.windows().length,
    };
    return app.windows().length;
  }, (count) => count === 2, 'two isolated renderer windows');
  result.versions = { ...result.versions, ...await withDeadline(app.evaluate(({ BrowserWindow }) => ({
    electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
    sandbox: BrowserWindow.getAllWindows().every((window) => {
      const preferences = window.webContents.getLastWebPreferences();
      return preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration && preferences.webSecurity;
    }),
  })), RENDERER_CALL_MS, 'engine versions') };
  requireElectronAlignment({ ...electronBinding, runtime: result.versions.electron }, require('semver').satisfies);
  assert(result.versions.sandbox, 'Renderer isolation is required');
  await app.context().route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort('blockedbyclient');
  });
  pages.push(...app.windows());
  const testKey = [...randomBytes(32)];
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', () => { markers.pageErrors++; });
    page.on('console', (message) => {
      // Do not retain or print the original console arguments, SDP, keys or stats.
      const text = message.text();
      if (text.startsWith('E2EE Worker: initialized')) markers.workerInitialized++;
      if (text.startsWith('E2EE: rtctransform event fired')) markers.transformEvents++;
      if (text.startsWith('E2EE: first frame encrypted')) markers.firstEncrypted++;
      if (text.startsWith('E2EE: first frame decrypted')) markers.firstDecrypted++;
      if (text.startsWith('[ice] selected-pair ') || text === '[ice] selected-pair') markers.selectedPair++;
      if (text.startsWith('E2EE: receive transform verified')) {
        const pending = (async () => {
          const id = verifiedConsumerId(await message.args()[1]?.jsonValue());
          if (!id) { markers.transformFailure = true; return; }
          verifiedByPeer[index].add(id); markers.transformVerified++;
        })().catch(() => { markers.transformFailure = true; });
        pendingMarkers.add(pending);
        void pending.finally(() => pendingMarkers.delete(pending));
      }
      if (/BYPASSED|still bypassed|E2EE Worker error|encrypt transform failed/.test(text)) markers.transformFailure = true;
      if (text.startsWith('[video-settings] Video priority update failed')) markers.priorityUpdateFailure = true;
    });
    await page.goto(`${origin}/__voice_runtime_probe?peer=${index === 0 ? 'a' : 'b'}`);
    await page.waitForFunction(() => Boolean(globalThis.mediaProbe));
    const setup = await inRenderer(page, 'renderer setup', (key) => globalThis.mediaProbe.setup(key), testKey);
    assert.equal(setup.nodeVisibleInRenderer, false);
  }
  setStage('publish-consume');
  const descriptors = [];
  for (const [index, page] of pages.entries()) {
    descriptors.push(await inRenderer(page, `publish peer ${index}`, () => globalThis.mediaProbe.publish()));
  }
  const consumeWithVideoRefresh = async (index, descriptor, label) => {
    const pending = inRenderer(pages[index], label,
      (entry) => globalThis.mediaProbe.consume(entry), descriptor);
    if (descriptor.kind === 'video') {
      // A macOS runner can miss the publisher's only pre-join keyframe. If
      // playback has not begun, replace the real sending track to restart its
      // encoder. Always exercise one refresh; retry only while playback waits.
      // The E2EE transform and every receive witness remain in use.
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = await Promise.race([
          pending.then(() => 'success', () => 'failure'), delay(1500).then(() => 'pending'),
        ]);
        if (state === 'failure' || (state === 'success' && attempt > 0)) break;
        await inRenderer(pages[1 - index], `refresh video sender peer ${1 - index}`,
          () => globalThis.mediaProbe.refreshVideoTrack());
      }
    }
    await pending;
  };
  try {
    for (let index = 0; index < pages.length; index++) {
      for (const descriptor of descriptors[1 - index]) {
        await consumeWithVideoRefresh(index, descriptor, `consume peer ${index} ${descriptor.kind}`);
      }
    }
  } catch (error) {
    // Record which side starved before cleanup tears the call down. Both peers in
    // parallel on a short deadline: diagnose() needs about 2 s, and a wedged
    // renderer must not spend the cleanup headroom.
    result.consumeDiagnostics = await Promise.all(pages.map(async (page, index) => {
      try {
        return { peer: index, ...await withDeadline(page.evaluate(() => globalThis.mediaProbe.diagnose()),
          DIAGNOSE_MS, `diagnose peer ${index}`) };
      } catch (diagnoseError) {
        return { peer: index, error: diagnoseError.message };
      }
    }));
    try {
      result.consumeDiagnostics.push({ sfu: await withDeadline(sfu.rpc({ peer: 'a', action: 'sfuDiagnose' }), DIAGNOSE_MS, 'SFU diagnose') });
    } catch (sfuError) { result.consumeDiagnostics.push({ sfuError: sfuError.message }); }
    process.stderr.write(`[voice-probe] consume diagnostics: ${JSON.stringify(result.consumeDiagnostics)}\n`);
    throw error;
  }
  const readWitnesses = async () => {
    const witnesses = await Promise.all(pages.map((page, index) =>
      inRenderer(page, `witness peer ${index}`, () => globalThis.mediaProbe.witness())));
    await Promise.all([...pendingMarkers]);
    result.runtimeDiagnostics.peers = summarizeRuntimeWitnesses(witnesses);
    result.runtimeDiagnostics.verifiedConsumers = verifiedByPeer.map((ids) => ids.size);
    return witnesses;
  };
  await until(readWitnesses, (witnesses) => witnesses.every((entry) => entry.audioSignalPresent && entry.decodedVideoPresent && entry.e2eeEntered.every((count) => count > 0)), 'decrypted audio and video');
  for (const [index, page] of pages.entries()) {
    await inRenderer(page, `updatePriority peer ${index}`, () => globalThis.mediaProbe.updatePriority());
  }
  await until(readWitnesses, (witnesses) => witnesses.every((entry) => entry.layeredPriorityApplied), 'live layered encoding priority update');
  const initialWitnesses = await until(readWitnesses, (witnesses) => witnesses.every((entry, index) =>
    initialConsumersVerified(entry, verifiedByPeer[index])), 'each original audio/video consumer production verification');
  const originalAudioIds = initialWitnesses.map((entry) => entry.consumerEvidence.find((consumer) => consumer.kind === 'audio').id);
  setStage('continuous-call');
  const progress = pages.map(() => createVideoProgressGate());
  (await readWitnesses()).forEach((entry, index) => progress[index](entry));
  for (const [index, page] of pages.entries()) await inRenderer(page, `arm peer ${index}`, () => globalThis.mediaProbe.arm());
  // No getStats replacement, mocked RTC or manually advanced observation counter.
  const continuousStartedAtMs = performance.now();
  for (;;) {
    const poll = planContinuousCallPoll(Math.ceil(performance.now() - continuousStartedAtMs));
    if (!poll) throw new Error('No admissible continuous-call observation remains');
    await delay(poll.delayMs);
    const live = await readWitnesses();
    assert(live.every((entry, index) => entry.audioSignalPresent && entry.decodedVideoPresent &&
      entry.sourceTracksLive && progress[index](entry, { allowRecentProgress: poll.delayMs < POLL_INTERVAL_MS })),
    'Continuous decoded/presented delivery stopped');
    requireNoRuntimeFailure(markers);
    assert(live.every((entry) => !entry.independentTickFailure), 'Independent detector observation failed');
    const decision = continuousCallDecision({ elapsedMs: Math.ceil(performance.now() - continuousStartedAtMs),
      pollAdmittedElapsedMs: poll.pollAdmittedElapsedMs, requiredDurationMs: duration, witnesses: live });
    if (decision === 'fail') throw new Error('Continuous-call drift evidence did not meet the bounded admission contract');
    if (decision === 'verify') break;
  }
  result.witnesses = await readWitnesses();
  for (const entry of result.witnesses) {
    assert(entry.measuredDurationMs >= duration && entry.productionTimerArmed && entry.productionObservationCount > 0);
    assert(entry.independentUsableCount > 0 && entry.independentCurrentWindowUsable &&
      !entry.independentDrift && !entry.productionDrift && !entry.independentTickFailure);
    assert(entry.e2eeEntered.length === 2 && entry.e2eeEntered.every((count) => count > 0));
    assert(entry.layeredPriorityApplied && entry.audioExtensionsNegotiated && entry.videoExtensionsNegotiated);
    assert(entry.injectedDetectorTripped, 'Separate detector fault control did not trip');
  }
  result.detectorFaultControl = 'PASS: separate copied-report 2 ms/s injection; production RTC/sampler untouched';
  setStage('camera-reproduce');
  const previousVideoIds = result.witnesses.map((entry) => entry.videoConsumerId);
  for (const [index, page] of pages.entries()) {
    await inRenderer(page, `closeRemoteVideo peer ${index}`, () => globalThis.mediaProbe.closeRemoteVideo());
  }
  const replacement = [];
  for (const [index, page] of pages.entries()) {
    replacement.push(await inRenderer(page, `reproduceVideo peer ${index}`, () => globalThis.mediaProbe.reproduceVideo()));
  }
  for (let index = 0; index < pages.length; index++) {
    await consumeWithVideoRefresh(index, replacement[1 - index], `consume replacement peer ${index}`);
  }
  const replacementProgress = pages.map(() => createVideoProgressGate());
  result.replacementWitnesses = await until(readWitnesses, (witnesses) => witnesses.every((entry, index) => {
    const advancing = replacementProgress[index](entry);
    return entry.decodedVideoPresent && entry.sourceTracksLive && advancing &&
      replacementVerified(entry, previousVideoIds[index], verifiedByPeer[index], originalAudioIds[index]);
  }), 'each replacement consumer progressing and independently verified by production E2EE probe');
  await Promise.all([...pendingMarkers]);
  requireNoRuntimeFailure(markers);
  assert(markers.selectedPair >= 2, 'Production ICE markers missing');
  result.cameraReproduce = 'PASS'; result.markers = markers; result.status = 'PASS';
} catch (error) {
  result.markers = { ...markers };
  result.stage = stage;
  result.status = stage === 'engine-launch' ? 'NOT RUN' : 'FAIL';
  // Keep failures reviewable without browser launch logs or raw console/stat dumps.
  result.reason = stage === 'engine-launch' ? 'Sandboxed Electron failed to start; inspect runner sandbox support' : error.message;
  process.exitCode = 1;
} finally {
  setStage('cleanup');
  const CLEANUP_MS = 15_000;
  // A close that times out is not cancelled and can hold the event loop open.
  let shutdownUnconfirmed = false;
  for (const page of pages) {
    try { await withDeadline(page.evaluate(() => globalThis.mediaProbe?.cleanup()), CLEANUP_MS, 'renderer cleanup'); }
    catch { /* renderer may have exited */ }
  }
  try { await withDeadline(app?.close(), CLEANUP_MS, 'Electron close'); }
  catch { result.status = 'FAIL'; result.cleanup = 'Electron close failed'; process.exitCode = 1; shutdownUnconfirmed = true; }
  if (profile) {
    try { await rm(profile, { recursive: true }); }
    catch { result.status = 'FAIL'; result.cleanup = 'Owned temporary profile cleanup failed'; process.exitCode = 1; }
  }
  try { await withDeadline(vite?.close(), CLEANUP_MS, 'Vite close'); }
  catch { result.status = 'FAIL'; result.cleanup = 'Vite close failed'; process.exitCode = 1; shutdownUnconfirmed = true; }
  try { await withDeadline(sfu?.close(), CLEANUP_MS, 'SFU close'); result.nativeSubprocessClosed = Boolean(sfu); }
  catch { result.status = 'FAIL'; result.cleanup = 'Native worker exit unconfirmed'; process.exitCode = 1; shutdownUnconfirmed = true; }
  writeResult();
  if (shutdownUnconfirmed) {
    // The result is written; do not wait on a resource that never confirmed it closed.
    try { app?.process()?.kill('SIGKILL'); } catch { /* engine may already be gone */ }
    process.exit(1);
  }
  clearTimeout(watchdog);
}
