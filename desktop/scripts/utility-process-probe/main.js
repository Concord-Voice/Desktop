// THE UTILITY-PROCESS LAUNCH-FAILURE PROBE (issue 213).
//
// Decision record: docs/adr/0043-per-process-screen-share-audio-capture.md, "Record
// correction: issue 213, the `reapChild` spawn-listener residual is settled". The decision
// is that `reapChild` (desktop/src/main/audiocapHost.ts) arms a bare `once('spawn')`
// re-kill listener with no timeout. That is safe only while three things hold in the
// Electron under test, and no unit test can check them because they are behaviours of
// `utilityProcess.fork`, not of our code:
//
//   1. A fork that fails at launch emits `exit` and nothing else: no `spawn`, no `error`.
//   2. `spawn` is never delivered after the same child's `exit`.
//   3. The wrapper is collectable after `exit`, so an unfired listener goes with it.
//
// This probe forks real utility processes in a headless Electron and prints what each one
// does, so a person can re-check the three properties against a new Electron.
//
// KEPT: re-run on every Electron major bump; the reapChild decision in ADR-0043 rests on
// what it prints. If any property below prints false, the decision is open again: stop and
// re-read the ADR entry before shipping the bump.
//
// WHAT IT CHECKS, per run (one failure mode per run, chosen by PROBE_MODE):
//   - c1  a fork that fails at launch, killed at once: what `kill()` returns, which events
//         arrive, and whether anything arrives in the 2 s after `exit`.
//   - c2  a normal fork killed before it spawns, then killed again inside its `spawn`
//         listener: the shape `reapChild` relies on.
//   - c5  `kill()` called INSIDE an `exit` listener, for a child that ran and exited on its
//         own and for the launch-failure child. Recorded, not asserted. `retire` no longer
//         makes this call: on the crash path the child has already exited, so `retire` skips
//         `reapChild`, and the host does not rely on what it returns. Kept as the record
//         that `kill()` inside `exit` returned false on both measured Electron versions.
//   - c3  collectability: after `exit` and a forced GC, a FinalizationRegistry callback
//         fires for the launch-failure child and for a normal-exit control child.
//
// PROBE_MODE picks how the launch fails:
//   nproc        the main process's soft RLIMIT_NPROC is dropped to 1 around each fork, so
//                the browser's fork() fails (EAGAIN). This is the real "never launches"
//                case: the child emits `exit` (code 1) and never `spawn`.
//   cwd-missing  the fork's `cwd` does not exist. The child process starts, fails its
//                chdir and exits (code 5), so `spawn` is delivered BEFORE `exit`. This is a
//                launch that fails after spawn, not a fork that fails; it is here to show
//                that `spawn` still never follows `exit`.
//
// WHAT IT NEVER PRINTS. A PID, a window title, or any audio. A `pid` is read only to say
// whether one exists (`hasPid`, a boolean). Every line of its own output starts `EV ` and
// carries no PID. Chromium's own stderr lines DO carry the browser PID in their `[pid:...]`
// prefix, which is why the run commands below discard stderr; keep it that way, and never
// commit a log that was captured with stderr. It reads no environment value into its output
// and takes no window: it forks utility processes and nothing else.
//
// WHAT IT NEVER DOES. Run on a host: it refuses unless it is inside the image built from
// the Dockerfile beside it (that image sets UTILITY_PROCESS_PROBE_CONTAINER=1), under
// Xvfb (DISPLAY set), on Linux, as a non-root user, from an unpackaged Electron. Each
// refusal prints `FAIL <reason>` and exits 2. It is not wired to CI.
//
// USAGE. Docker only; run from the repository root. ELECTRON_VERSION is exact, with no
// default. `desktop/package-lock.json` pins the shipped version (45.2.3 when this was
// written); also run the version before it to see whether anything moved.
//
//     docker build --build-arg ELECTRON_VERSION=45.2.3 \
//       -t utility-process-probe:45.2.3 desktop/scripts/utility-process-probe
//
//     # case 1: a fork that fails at launch (RLIMIT_NPROC)
//     docker run --rm -e PROBE_MODE=nproc \
//       -v "$PWD/desktop/scripts/utility-process-probe:/probe:ro" \
//       utility-process-probe:45.2.3 2>/dev/null
//
//     # case 2: a launch that fails after the process starts (missing cwd)
//     docker run --rm -e PROBE_MODE=cwd-missing \
//       -v "$PWD/desktop/scripts/utility-process-probe:/probe:ro" \
//       utility-process-probe:45.2.3 2>/dev/null
//
// `2>/dev/null` is part of the command, not a convenience (see WHAT IT NEVER PRINTS).
// Never add `--privileged`, a host mount other than the probe directory, or a prune/reset
// of Docker to make a run work.
//
// OUTPUT. `EV <json>` lines, each with `t` (ms since start), then one
// `EV {"ev":"summary", ok, properties, killInExit, ...}` line. `properties` is the three
// properties above plus the two `kill()` shapes `reapChild` relies on; `ok` is true when
// every one holds. Exit 0 when `ok`, 1 when a property failed or a child never exited,
// 2 on a refusal or the 60 s backstop.
'use strict';

const { app, utilityProcess } = require('electron');
const cp = require('node:child_process');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');

const MODES = ['nproc', 'cwd-missing'];
const MODE = process.env.PROBE_MODE ?? '';
const STAY = path.join(__dirname, 'child-stay.js');
const QUICK = path.join(__dirname, 'child-exit.js');
const T0 = performance.now();

function emit(o) {
  process.stdout.write(
    'EV ' + JSON.stringify({ t: Math.round(performance.now() - T0), ...o }) + '\n'
  );
}

function preflight() {
  if (app.isPackaged) return 'packaged build';
  if (process.platform !== 'linux') return 'not linux';
  if (!process.env.DISPLAY) return 'DISPLAY unset';
  if (process.env.UTILITY_PROCESS_PROBE_CONTAINER !== '1') return 'not the probe container image';
  if (process.getuid() === 0) return 'running as root';
  if (!MODES.includes(MODE)) return 'PROBE_MODE must be one of: ' + MODES.join(', ');
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The collectability case needs gc(); expose it without a command-line flag.
function loadGc() {
  if (typeof global.gc === 'function') return global.gc;
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc');
}

// How the launch fails, per PROBE_MODE.
function failOpts() {
  return MODE === 'cwd-missing' ? { cwd: '/nonexistent-dir-213' } : { cwd: '/tmp' };
}

// nproc mode: a helper shell drops this process's soft RLIMIT_NPROC to 1 so the next fork
// fails, and puts it back when told. Resolves to a restore function. The helper is spawned
// BEFORE the limit drops, and the limit is on this process only, so the helper itself can
// still fork. Other modes get a no-op.
function lowerNproc() {
  if (MODE !== 'nproc') return Promise.resolve(async () => {});
  return new Promise((resolve, reject) => {
    const target = String(process.pid);
    const script =
      `orig=$(prlimit --pid ${target} --nproc --noheadings --output SOFT | tr -d ' '); ` +
      `prlimit --pid ${target} --nproc=1: && echo SET; read x; ` +
      `prlimit --pid ${target} --nproc="$orig": && echo "RESTORED $orig"`;
    const helper = cp.spawn('sh', ['-c', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let isSet = false;
    let restored = null;
    helper.stdout.on('data', (d) => {
      buf += d;
      if (!isSet && buf.includes('SET')) {
        isSet = true;
        emit({ ev: 'nproc-limit-set' });
        resolve(
          () =>
            new Promise((done) => {
              restored = done;
              helper.stdin.write('x\n');
            })
        );
      }
      if (restored && buf.includes('RESTORED')) {
        emit({
          ev: 'nproc-limit-restored',
          origSoft: buf.trim().split('\n').pop().replace('RESTORED ', ''),
        });
        restored();
      }
    });
    helper.on('exit', (code) => {
      if (!isSet) reject(new Error('nproc helper exited ' + code));
    });
  });
}

// Persistent listeners on a child: the order its events arrive in, and the one thing
// property 2 forbids (a `spawn` after `exit`).
function track(child, tag, obs) {
  const st = { events: [], exitCode: null, spawned: false, errored: false, exited: false };
  child.on('spawn', () => {
    if (st.exited) obs.spawnAfterExit = true;
    st.spawned = true;
    st.events.push('spawn');
    emit({ case: tag, ev: 'spawn', afterExit: st.exited });
  });
  child.on('error', (type) => {
    st.errored = true;
    st.events.push('error');
    emit({ case: tag, ev: 'error', type: String(type) });
  });
  child.on('exit', (code) => {
    st.exited = true;
    st.exitCode = code;
    st.events.push('exit');
    emit({ case: tag, ev: 'exit', code });
  });
  return st;
}

function waitExit(child, tag, obs, ms = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      obs.exitTimeout = true;
      emit({ case: tag, ev: 'exit-timeout', ms });
      resolve();
    }, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const hasPid = (child) => typeof child.pid === 'number';

// c1: a launch failure, killed at once, then watched for 2 s after it exits.
async function launchFailure(obs) {
  const tag = 'c1/' + MODE;
  const restore = await lowerNproc();
  const child = utilityProcess.fork(STAY, [], failOpts());
  const killSync = child.kill();
  emit({ case: tag, ev: 'kill-sync-after-fork', ret: killSync, hasPid: hasPid(child) });
  const st = track(child, tag, obs);
  await waitExit(child, tag, obs);
  await restore();
  await sleep(2000);
  const killAfterExit = child.kill();
  emit({
    case: tag,
    ev: 'after-2s-wait',
    events: st.events,
    hasPidNow: hasPid(child),
    killAfterExit,
  });
  return { killSync, events: st.events, killAfterExit };
}

// c2: kill before the process exists, then again inside `spawn` (the shape reapChild uses).
async function killBeforeSpawn(obs) {
  const tag = 'c2';
  const child = utilityProcess.fork(STAY);
  const before = child.kill();
  emit({ case: tag, ev: 'kill-sync-after-fork', ret: before, hasPid: hasPid(child) });
  track(child, tag, obs);
  let inSpawn = null;
  child.once('spawn', () => {
    inSpawn = child.kill();
    emit({ case: tag, ev: 'kill-in-spawn', ret: inSpawn });
  });
  await waitExit(child, tag, obs);
  return { before, inSpawn };
}

// c5: kill() inside an `exit` listener, and once more on the next turn, for one child.
async function killInExitFor(label, child, obs) {
  const tag = 'c5/' + MODE + '/' + label;
  const st = track(child, tag, obs);
  let inExit = null;
  let afterExit = null;
  child.once('exit', () => {
    inExit = child.kill();
    setImmediate(() => {
      afterExit = child.kill();
    });
  });
  await waitExit(child, tag, obs);
  await sleep(100);
  emit({
    case: tag,
    ev: 'kill-in-exit',
    events: st.events,
    exitCode: st.exitCode,
    retInExit: inExit,
    retAfterExit: afterExit,
  });
  return { events: st.events, inExit, afterExit };
}

async function killInExit(obs) {
  const ranAndExited = await killInExitFor('ran-and-exited', utilityProcess.fork(QUICK), obs);
  const restore = await lowerNproc();
  const failed = await killInExitFor(
    'launch-failure',
    utilityProcess.fork(STAY, [], failOpts()),
    obs
  );
  await restore();
  return { ranAndExited, launchFailure: failed };
}

// c3: collectability after `exit`. A plain object is registered too, so a run where gc()
// does nothing shows up as a missing sanity label rather than as a false "not collectable".
async function collectability(obs, gc) {
  const tag = 'c3/' + MODE;
  const finalized = [];
  const reg = new FinalizationRegistry((label) => {
    finalized.push(label);
    emit({ case: tag, ev: 'finalized', label });
  });
  reg.register({ junk: 1 }, 'plain-object-sanity');

  await (async () => {
    const restore = await lowerNproc();
    let child = utilityProcess.fork(STAY, [], failOpts());
    child.once('spawn', () => emit({ case: tag, ev: 'spawn', label: 'launch-failure-child' }));
    track(child, tag + ':fail', obs);
    reg.register(child, 'launch-failure-child');
    await waitExit(child, tag + ':fail', obs);
    await restore();
    child = null;
  })();

  await (async () => {
    let child = utilityProcess.fork(QUICK);
    track(child, tag + ':control', obs);
    reg.register(child, 'control-normal-exit-child');
    await waitExit(child, tag + ':control', obs);
    child = null;
  })();

  for (let i = 0; i < 8; i++) {
    gc();
    await sleep(250);
  }
  await sleep(200);
  emit({ case: tag, ev: 'gc-done', gcCalls: 8, finalized });
  return finalized;
}

async function run() {
  const obs = { spawnAfterExit: false, exitTimeout: false };
  const gc = loadGc();
  emit({
    ev: 'start',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    mode: MODE,
    gc: typeof gc,
  });
  const c1 = await launchFailure(obs);
  const c2 = await killBeforeSpawn(obs);
  const c5 = await killInExit(obs);
  const finalized = await collectability(obs, gc);

  // nproc: the fork itself fails, so `exit` alone. cwd-missing: the process starts and then
  // fails its chdir, so `spawn` then `exit`.
  const expectedEvents = MODE === 'nproc' ? ['exit'] : ['spawn', 'exit'];
  const properties = {
    failedForkEmitsOnlyExit:
      c1.events.join() === expectedEvents.join() &&
      c5.launchFailure.events.join() === expectedEvents.join(),
    spawnNeverFollowsExit: !obs.spawnAfterExit,
    collectableAfterExit:
      finalized.includes('launch-failure-child') && finalized.includes('control-normal-exit-child'),
    killReturnsFalseBeforeSpawn: c1.killSync === false && c2.before === false,
    killReturnsTrueInsideSpawn: c2.inSpawn === true,
    everyChildExited: !obs.exitTimeout,
  };
  const ok = Object.values(properties).every((v) => v === true);
  emit({
    ev: 'summary',
    ok,
    mode: MODE,
    electron: process.versions.electron,
    properties,
    killInExit: {
      ranAndExited: { retInExit: c5.ranAndExited.inExit, retAfterExit: c5.ranAndExited.afterExit },
      launchFailure: {
        retInExit: c5.launchFailure.inExit,
        retAfterExit: c5.launchFailure.afterExit,
      },
    },
    launchFailureEvents: c1.events,
    killAfterExitAtTwoSeconds: c1.killAfterExit,
  });
  return ok;
}

const why = preflight();
if (why) {
  process.stdout.write('FAIL ' + why + '\n');
  app.exit(2);
} else {
  setTimeout(() => {
    emit({ ev: 'hard-timeout' });
    app.exit(2);
  }, 60000);

  app.whenReady().then(async () => {
    let ok = false;
    try {
      ok = await run();
    } catch (e) {
      emit({ ev: 'fatal', name: e instanceof Error ? e.name : 'unknown' });
    }
    app.exit(ok ? 0 : 1);
  });
}
