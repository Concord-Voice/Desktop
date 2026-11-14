// THE macOS CAPTURE EVIDENCE RUNNER (issue 75).
//
// Spec: docs/superpowers/specs/2026-11-11-75-macos-tap-closeout-design.md, section 5.
//
// One run, one row. It reads both grant statuses, enumerates windows with the
// product fence's own call, forks the REAL capture child with the REAL addon,
// lets the tap run for --seconds, stops it, reads both grant statuses again, and
// prints the child's end-of-run liveness counters as one `ROW <json>` line.
// `classify.mjs` (beside this file) turns rows into classes and applies Rules A, B
// and C.
//
// WHAT IT NEVER DOES.
//   - Read audio. The PCM port's far end is held for the whole run, so it is not
//     collected and the child does not lose its consumer, but it gets no listener
//     and is never started. Nothing is stored or printed but counters.
//   - Print a window title or a PID (invariant I-PID). The row carries --label in
//     place of the title; the child's own stderr and stdout are buffered or drained
//     and never echoed; a fault's message text is never read, only its stage.
//   - Load the addon. Main reads grants and enumerates windows only; the child
//     owns the addon (ADR-0043 D5).
//
// USAGE. Development build, darwin only; it refuses when packaged.
//
//     cd desktop && npm run build:main && npm run build:native
//     open -n -W -a "$PWD/node_modules/electron/dist/Electron.app" \
//       --stdout "$PWD/rows.out" --args "$PWD/scripts/audiocap-matrix-probe" \
//       --label C1 --title <part of one window's title> --kind consent --seconds 20
//
// `open -a` launches the bundle under its own identity, so the grants read and used
// are the bundle's own (spec section 5, "Cells"); `--stdout` is how its ROW line is
// kept. The bundle path and the runner directory must both be absolute: `open -a`
// does not find a relative bundle path. The terminal form,
// `./node_modules/.bin/electron scripts/audiocap-matrix-probe ...`, runs under the
// terminal's grants instead: use it only for a run whose grants do not matter.
//
//   --label      required; 1 to 64 of [A-Za-z0-9._-]. Printed instead of the title.
//   --title      a case-sensitive substring of exactly one enumerated window's name,
//   --window-id  or a window id (decimal CGWindowID). Exactly one of the two.
//   --kind       required; consent | include | exclude | revoke. Copied into the row.
//   --seconds    how long the tap runs, 1 to 600; default 20. Copied into the row,
//                which classify.mjs needs to judge a revoke run. R1 needs 60.
//
// --title matches the name the enumeration gives a window, which is its title and
// not its application's name: a Terminal window's name does not contain "Terminal"
// (macOS 27.2, Electron 45.0.0, the first local run).
//
// OUTPUT. `ROW {label, kind, osRelease, osVersion, osBuild, electron, buildKind,
// runId, screen, microphone, screenAfter, microphoneAfter, windowId, enumerable,
// enumerationFailed, faultStage, counters, seconds}` and exit 0, or `FAIL <reason>`
// and exit 2 with no row: the run did not happen. `screenAfter` and
// `microphoneAfter` are the grants read again after the run, which is how R1 shows
// that a grant was turned off. A consent run whose grants differ before and after
// measured two states, not its cell, so classify.mjs reads it as Rule C.
// `counters: null` means the child printed no liveness block (it died, or no
// capture started); with no fault stage classify.mjs reads that as `other`, never
// as silence. `windowId` is the handle the run used, so a later cell can target the
// same window with --window-id; every consent and revoke run must measure one
// window, or classify.mjs reads Rule C. `enumerable` is false for a --window-id the
// fence's enumeration does not list, and `enumerationFailed` is true when the
// enumeration itself rejected (the bundle holds no Screen Recording grant), so only
// --window-id can run. Either way the run goes ahead, because what the child does
// with such a handle is the evidence.
//
// The runner bounds itself: 40 s past --seconds it prints `FAIL timeout`, kills the
// capture child and exits. An outside bound is only a backstop, and it must reach
// Electron itself. Not every supported macOS release ships `timeout`, so put a perl
// alarm on the Electron binary, in the terminal form:
//
//     perl -e 'alarm 60; exec @ARGV' "$(node -p "require('electron')")" \
//       scripts/audiocap-matrix-probe --label t1 --title <...> --kind consent --seconds 5
//
// Not on `./node_modules/.bin/electron`, a Node wrapper that forwards only SIGINT,
// SIGTERM and SIGUSR2, and not on `open`, which is not the app's parent: either way
// the alarm ends the launcher and Electron keeps running. After an alarm, check for a
// leftover Electron or Electron Helper process and stop it before the next run. As
// for the target probe, judge a run by its ROW or FAIL line.
//
// It is deliberately NOT wired to CI: it needs real grants and a real window.
'use strict';

const {
  app,
  desktopCapturer,
  MessageChannelMain,
  systemPreferences,
  utilityProcess,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WINDOW_SOURCE_ID = /^window:([1-9]\d*):(0|[1-9]\d*)$/;
const CHILD = path.resolve(__dirname, '../../dist/main/audiocapChild.js');
const HELLO_TIMEOUT_MS = 10_000;
const LIVENESS_WAIT_MS = 10_000;
// Room for the enumeration and the classifier import around the timed parts.
const DEADLINE_SLACK_MS = 20_000;

const FLAGS = new Set(['--label', '--title', '--window-id', '--kind', '--seconds']);
const KINDS = new Set(['consent', 'include', 'exclude', 'revoke']);
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const DECIMAL = /^[1-9]\d*$/;
const MAX_WINDOW_ID = 0xff_ff_ff_ff;
const MAX_SECONDS = 600;

let activeChild = null;
let finished = false;

function finish(code, line) {
  if (finished) return;
  finished = true;
  activeChild?.kill();
  // eslint-disable-next-line no-console -- this IS the runner's output; one line per run
  console.log(line);
  app.exit(code);
}

const fail = (reason) => finish(2, `FAIL ${reason}`);

/**
 * `--flag value` pairs only. A refusal names the flag or its position, never the
 * value, which for --title is part of a window title.
 */
function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!FLAGS.has(key)) return { error: `unknown argument at position ${i + 1}` };
    if (flags.has(key)) return { error: `${key} given twice` };
    if (value === undefined || value.startsWith('--')) return { error: `${key} needs a value` };
    flags.set(key, value);
  }

  const label = flags.get('--label');
  if (label === undefined) return { error: '--label is required' };
  if (!LABEL.test(label)) return { error: '--label must be 1 to 64 of [A-Za-z0-9._-]' };

  const kind = flags.get('--kind');
  if (kind === undefined) return { error: '--kind is required' };
  if (!KINDS.has(kind)) return { error: '--kind must be consent, include, exclude or revoke' };

  const title = flags.get('--title');
  const rawWindowId = flags.get('--window-id');
  if ((title === undefined) === (rawWindowId === undefined)) {
    return { error: 'give exactly one of --title or --window-id' };
  }
  let windowId = null;
  if (rawWindowId !== undefined) {
    if (!DECIMAL.test(rawWindowId) || Number(rawWindowId) > MAX_WINDOW_ID) {
      return { error: '--window-id must be a decimal window id' };
    }
    windowId = Number(rawWindowId);
  }

  const rawSeconds = flags.get('--seconds') ?? '20';
  if (!DECIMAL.test(rawSeconds) || Number(rawSeconds) > MAX_SECONDS) {
    return { error: `--seconds must be a whole number from 1 to ${MAX_SECONDS}` };
  }

  return { args: { label, kind, title, windowId, seconds: Number(rawSeconds) } };
}

/**
 * The OS build (spec section 5: "OS build" on every row), e.g. `26B123`. Electron
 * reports only the version, which two builds of one release share. null if unread.
 */
function osBuild() {
  try {
    const plist = fs.readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    const m = /<key>ProductBuildVersion<\/key>\s*<string>([0-9A-Za-z]+)<\/string>/.exec(plist);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The window handle in a `window:<handle>:<n>` source id, as the target probe reads it. */
function windowHandle(sourceId) {
  const parsed = WINDOW_SOURCE_ID.exec(sourceId);
  return parsed ? Number(parsed[1]) : null;
}

/**
 * Fork the capture child as the target probe's `runStart` does -- same `start`
 * message, same `hello` wait -- with three differences: the child's output is
 * buffered (stderr) or drained (stdout) and never echoed; `port2` is held and gets
 * no listener; the tap runs for `seconds`. Then `stop`, wait up to 10 s for the
 * liveness block, and kill the child.
 */
async function runCapture(handle, seconds, parseLiveness) {
  const child = utilityProcess.fork(CHILD, [], { stdio: 'pipe' });
  activeChild = child;
  // The liveness block arrives on stderr (console.warn), possibly split across
  // chunks, so it is parsed from the joined buffer. stdout is drained only so a
  // full pipe cannot stall the child: nothing the runner reads goes there.
  let stderr = '';
  child.stderr?.on('data', (c) => {
    stderr += String(c);
  });
  child.stdout?.on('data', () => {});

  let faultStage = null;
  let exited = false;
  child.on('message', (m) => {
    // The first fault decides; its message text is never read.
    if (m && m.kind === 'fault' && faultStage === null) {
      faultStage = typeof m.stage === 'string' ? m.stage : 'unknown';
    }
  });
  const exit = new Promise((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });

  let port2 = null;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no hello within the handshake budget')),
        HELLO_TIMEOUT_MS
      );
      child.on('message', (m) => {
        if (m && m.kind === 'hello') {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('the child exited before saying hello'));
      });
    });

    const channel = new MessageChannelMain();
    port2 = channel.port2;
    child.postMessage(
      {
        kind: 'start',
        quantumMs: 10,
        sampleRate: 48000,
        channels: 2,
        frameCount: 480,
        creditBound: 8,
        ringSlots: 8,
        windowHandle: handle,
      },
      [channel.port1]
    );

    // A child that dies mid-run ends the wait; its row then has no counters.
    await Promise.race([new Promise((r) => setTimeout(r, seconds * 1000)), exit]);
    if (!exited) child.postMessage({ kind: 'stop' });

    await new Promise((resolve) => {
      if (exited || parseLiveness(stderr) !== null) {
        resolve();
        return;
      }
      // Registered after the buffering listener above, so it sees the joined text.
      const onData = () => {
        if (parseLiveness(stderr) !== null) done();
      };
      const timer = setTimeout(() => done(), LIVENESS_WAIT_MS);
      function done() {
        clearTimeout(timer);
        child.stderr?.off('data', onData);
        resolve();
      }
      child.stderr?.on('data', onData);
      exit.then(done);
    });

    return { faultStage, counters: parseLiveness(stderr) };
  } catch (err) {
    const stage = faultStage === null ? '' : ` (fault stage ${faultStage})`;
    return { error: `${err instanceof Error ? err.message : 'runner error'}${stage}` };
  } finally {
    child.kill();
    activeChild = null;
    port2?.close();
  }
}

async function main(parsed) {
  if (process.platform !== 'darwin') return fail('not darwin');
  if (app.isPackaged) return fail('packaged build');
  if (parsed.error) return fail(parsed.error);
  const { label, kind, title, windowId, seconds } = parsed.args;

  const { parseLiveness } = await import('./classify.mjs');

  const screen = systemPreferences.getMediaAccessStatus('screen');
  const microphone = systemPreferences.getMediaAccessStatus('microphone');

  // Copied from FENCE 4 in desktop/src/main/ipc/audiocap.ts (the getSources call at
  // line 175): the same types and options, so `enumerable` is the fence's answer.
  // It rejects ("Failed to get sources.") when the bundle holds no Screen Recording
  // grant, which is the very cell a screen-denied run measures. So a failed
  // enumeration is recorded, not fatal; only --title needs the list.
  let live = null;
  try {
    live = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  } catch {
    if (title !== undefined) {
      return fail('window enumeration failed (no Screen Recording grant?); give --window-id');
    }
  }

  let handle = windowId;
  if (title !== undefined) {
    // Names are compared and dropped here; none is kept or printed.
    const matches = live.filter((s) => s.name.includes(title));
    if (matches.length === 0) return fail('no window matches --title');
    if (matches.length > 1) return fail(`--title matches ${matches.length} windows`);
    handle = windowHandle(matches[0].id);
    if (handle === null) return fail('the matching source id did not parse');
  }
  // The fence compares whole source ids; a --window-id has only the handle, so the
  // handles are compared. For --title this is true by construction.
  const enumerable = live !== null && live.some((s) => windowHandle(s.id) === handle);

  const run = await runCapture(handle, seconds, parseLiveness);
  if (run.error) return fail(run.error);

  // Read again after the run, so a revoke row shows whether a grant was turned off.
  // If macOS does not report a mid-run change to a running process, these still read
  // granted and classify.mjs reads R1 as no revoke: Rule C, never no-effect.
  const screenAfter = systemPreferences.getMediaAccessStatus('screen');
  const microphoneAfter = systemPreferences.getMediaAccessStatus('microphone');

  const row = {
    // A random id, so two runs that print the same counters are still two runs.
    runId: crypto.randomUUID(),
    label,
    kind,
    osRelease: os.release(),
    osVersion: process.getSystemVersion(),
    osBuild: osBuild(),
    electron: process.versions.electron,
    buildKind: 'development',
    screen,
    microphone,
    screenAfter,
    microphoneAfter,
    windowId: handle,
    enumerable,
    enumerationFailed: live === null,
    faultStage: run.faultStage,
    counters: run.counters,
    seconds,
  };
  return finish(0, `ROW ${JSON.stringify(row)}`);
}

const parsed = parseArgs(process.argv.slice(process.defaultApp ? 2 : 1));

app
  .whenReady()
  .then(() => main(parsed))
  .catch((err) => fail(`runner error (${err instanceof Error ? err.name : typeof err})`));

// A hung run must fail, not hang the machine.
const budgetSeconds = parsed.args ? parsed.args.seconds : 0;
setTimeout(
  () => fail('timeout'),
  HELLO_TIMEOUT_MS + budgetSeconds * 1000 + LIVENESS_WAIT_MS + DEADLINE_SLACK_MS
).unref();
