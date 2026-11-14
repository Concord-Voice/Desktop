#!/usr/bin/env node
// Classifier and decision rule for the macOS capture evidence runner (issue 75).
// Spec: docs/superpowers/specs/2026-11-11-75-macos-tap-closeout-design.md, section 3.
//
// Pure functions turn the runner's rows into outcome classes and apply Rules A, B
// and C, which were fixed before anything was measured. Counters only: nothing here
// reads, stores or prints audio, a window title or a PID.
//
// Usage:
//   node classify.mjs <rows.jsonl> [--never-requested screen,microphone]
//
// <rows.jsonl> holds one runner row per line (a leading `ROW ` is accepted, so the
// runner's stdout can be used as is). Conventions the measurement session follows:
//   - the runs of one consent cell share a label (C1 twice, C2 twice, ...);
//   - the cell labelled C1 is the both-granted control;
//   - a row carries `seconds`, the length of its run, or a revoke row cannot be judged
//     and reads `other`;
//   - every consent and revoke run measures one window, the rule's rows come from one
//     OS build and one Electron version, and each row carries the runner's `runId`: two
//     rows with one id are one run pasted twice, and a row with none stops the rule.
// --never-requested names the grants the app never prompts for. It defaults to both,
// so a silent cell reading `not-determined` stops the rule unless the lead says
// otherwise. `--never-requested ''` names none.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MARKER = '[audiocap] liveness {';
const NUMERIC_FIELDS = [
  'callbackTotal',
  'quantaTotal',
  'signalTotal',
  'overrunTotal',
  'destroyFailures',
];
const CONSENT_CLASSES = new Set(['fault', 'carries', 'silent', 'dead', 'other']);
const GRANTS = ['screen', 'microphone'];
const CONTROL_LABEL = 'C1';
// Spec section 5: the cells needed to close, and the runs each needs.
const REQUIRED_CELLS = ['C1', 'C2', 'C3', 'C4', 'C5'];
const RUNS_PER_CELL = 2;
// Spec section 5: the grant pair that defines each cell. A cell that does not read its
// pair was not that cell: the toggle did not reach the runner's identity, and the spec
// says stop. C5 follows a reset, whose readings the spec records rather than fixes, so
// it is held only to not reading the control's pair.
const CELL_READINGS = {
  C1: ['granted', 'granted'],
  C2: ['granted', 'denied'],
  C3: ['denied', 'granted'],
  C4: ['denied', 'denied'],
};
const RESET_CELL = 'C5';
// Spec section 5, R1: a 60 s run. A known reading other than `granted` after it is the
// evidence that a grant was turned off; a missing or `unknown` reading is not.
const REVOKE_SECONDS = 60;
const NOT_HELD = new Set(['denied', 'restricted', 'not-determined']);
// Every value Electron's getMediaAccessStatus returns. The runner prints all four
// readings, before and after, on every row, so a consent row without a known one
// stops the rule.
const GRANT_VALUES = new Set(['granted', 'unknown', ...NOT_HELD]);
// A reason prints a grant pair only when both readings are values the runner can
// print. Anything else came from somewhere else and is not echoed.
const pairText = (screen, microphone) =>
  GRANT_VALUES.has(screen) && GRANT_VALUES.has(microphone)
    ? `${screen}, ${microphone}`
    : 'an unrecognised pair';

/**
 * @typedef {object} Counters
 * @property {number} callbackTotal
 * @property {number} quantaTotal
 * @property {number} signalTotal
 * @property {number} overrunTotal
 * @property {number} destroyFailures
 * @property {boolean} silentSinceStart
 * @property {boolean} faulted
 * @property {boolean} poisoned
 * @property {boolean} quiesceProved
 */

/**
 * Reads the last `[audiocap] liveness { ... }` block the capture child printed to
 * stderr (desktop/src/main/audiocapChild.ts, reportLiveness). The input is the whole
 * joined buffer, so a block split across chunks parses as one.
 * Returns null when no complete block is present or any numeric field is missing.
 * @param {string} stderrText
 * @returns {Counters | null}
 */
export function parseLiveness(stderrText) {
  if (typeof stderrText !== 'string') return null;
  const start = stderrText.lastIndexOf(MARKER);
  if (start < 0) return null;
  // ponytail: the block ends at the first `}` after the marker. Every counter comes
  // before the one string value (lastDeviceStatus), so a `}` inside that string can
  // only cut off fields this parser does not read.
  const end = stderrText.indexOf('}', start + MARKER.length);
  if (end < 0) return null;
  const body = stderrText.slice(start + MARKER.length, end);

  const fields = new Map();
  for (const m of body.matchAll(/(\w+):\s*([^,\n]*)/g)) {
    fields.set(m[1], m[2].trim());
  }

  const counters = {};
  for (const key of NUMERIC_FIELDS) {
    const raw = fields.get(key);
    if (raw === undefined || !/^\d+$/.test(raw)) return null;
    counters[key] = Number(raw);
  }
  counters.silentSinceStart = fields.get('silentSinceStart') === 'true';
  counters.quiesceProved = fields.get('quiesceProved') === 'true';
  // Fail closed: only a printed `false` reads as not faulted.
  counters.faulted = fields.get('faulted') !== 'false';
  // Fail closed: only a printed `false` reads as not poisoned (a teardown that could
  // not show the tap stopped).
  counters.poisoned = fields.get('poisoned') !== 'false';
  return counters;
}

// `fault` is the acceptable refusal with a reason (spec section 3), so only a fault
// stage earns it. No counters, or counters that say faulted with no stage, is the OS
// ending the process or an unexplained fault: `other`, which stops the rule. A run
// whose teardown latched `poisoned` or failed a destroy is not a clean run either.
const hasStage = (faultStage) => faultStage !== null && faultStage !== undefined;
const readable = (counters) =>
  counters !== null &&
  counters !== undefined &&
  counters.faulted === false &&
  counters.poisoned === false &&
  counters.destroyFailures === 0;

/** One consent run's class (spec section 3). */
export function classifyConsent(counters, faultStage, controlRatio) {
  if (hasStage(faultStage)) return 'fault';
  if (!readable(counters)) return 'other';
  const { callbackTotal, signalTotal } = counters;
  if (callbackTotal === 0) return 'dead';
  // `silent` is tested before `carries`: the two are disjoint for any positive
  // control ratio, and a zero or missing control must never read silence as carrying.
  if (callbackTotal > 0 && signalTotal === 0) return 'silent';
  if (callbackTotal > 0 && signalTotal / callbackTotal >= controlRatio / 2) return 'carries';
  return 'other';
}

/** One matrix run's class. An include row passes on any signal, not on the ratio. */
export function classifyMatrix(kind, counters, faultStage) {
  if (counters === null || counters === undefined) return 'finding';
  // Signal on an exclude run crossed the exclusion however the run ended, so it is a
  // leak even when the run also faulted.
  if (kind === 'exclude' && counters.signalTotal > 0) return 'leak';
  if (hasStage(faultStage) || !readable(counters) || !(counters.callbackTotal > 0)) {
    return 'finding';
  }
  if (kind === 'include' && counters.signalTotal > 0) return 'pass';
  if (kind === 'exclude' && counters.signalTotal === 0) return 'pass';
  return 'finding';
}

/**
 * The mid-share revoke run's class, against the both-granted control. A running tap
 * calls back on schedule, so under 90% of the control's callback rate it stopped, and
 * only 95% of the control's ratio is no-effect: a tap that ends after 30 s, or goes
 * silent after 48 s, of a 60 s run is an effect.
 * ponytail: totals cannot say when an effect began, so one in the last 3 s or so of the
 * run still reads no-effect. Reading the counters at the toggle needs a child change.
 */
export function classifyRevoke(counters, faultStage, control, controlSeconds, seconds) {
  if (hasStage(faultStage)) return 'fault';
  if (!readable(counters)) return 'other';
  const expected = 0.9 * (control.callbackTotal / controlSeconds) * seconds;
  // A run whose expected callback count cannot be computed cannot be judged.
  if (!(expected > 0)) return 'other';
  if (counters.callbackTotal < expected) return 'stopped';
  const r = counters.signalTotal / counters.callbackTotal;
  const rc = control.signalTotal / control.callbackTotal;
  if (r >= 0.95 * rc) return 'no-effect';
  if (r <= 0.5 * rc) return 'silenced';
  return 'other';
}

function cellClass(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return 'other';
  const first = runs[0];
  if (!CONSENT_CLASSES.has(first) || runs.some((run) => run !== first)) return 'other';
  return first;
}

const pairKey = (cell) => JSON.stringify([cell.screen, cell.microphone]);

/**
 * What the rows lack before the rule can be applied (spec section 5): each of C1 to
 * C5 with two runs, each reading the grant pair that defines it, and the revoke run
 * R1, which runs at least 60 s, starts with both grants held and ends with one off.
 * Every gap is a Rule C reason, so a runner that stopped early, or a toggle that never
 * reached the runner's identity, cannot read as Rule A.
 * @param {Array<{id: string, screen: string, microphone: string, runs: string[]}>} cells
 * @param {Array<object>} revokeRuns the revoke rows as the runner printed them
 */
export function incompleteCells(cells, revokeRuns) {
  const reasons = [];
  for (const id of REQUIRED_CELLS) {
    const runs = cells.find((c) => c.id === id)?.runs?.length ?? 0;
    if (runs === 0) reasons.push(`${id} has no rows`);
    else if (runs < RUNS_PER_CELL) reasons.push(`${id} has ${runs} of ${RUNS_PER_CELL} runs`);
  }
  for (const [id, [screen, microphone]] of Object.entries(CELL_READINGS)) {
    const cell = cells.find((c) => c.id === id);
    if (cell && (cell.screen !== screen || cell.microphone !== microphone)) {
      reasons.push(
        `${id} reads ${pairText(cell.screen, cell.microphone)}; expected ${screen}, ${microphone}`
      );
    }
  }
  const [heldScreen, heldMicrophone] = CELL_READINGS[CONTROL_LABEL];
  const reset = cells.find((c) => c.id === RESET_CELL);
  if (reset && reset.screen === heldScreen && reset.microphone === heldMicrophone) {
    reasons.push(
      `${RESET_CELL} reads ${heldScreen}, ${heldMicrophone}, the control's pair; ` +
        'expected the readings after a reset'
    );
  }

  const runs = Array.isArray(revokeRuns) ? revokeRuns : [];
  if (runs.length === 0) reasons.push('the revoke run R1 has no row');
  for (const run of runs) {
    const id = run.label ?? 'R1';
    if (run.screen !== 'granted' || run.microphone !== 'granted') {
      reasons.push(
        `${id} starts reading ${pairText(run.screen, run.microphone)}; expected granted, granted`
      );
    }
    if (!(run.seconds >= REVOKE_SECONDS)) {
      const ran = Number.isFinite(run.seconds) ? `${run.seconds} s` : 'for an unrecorded time';
      reasons.push(`${id} ran ${ran}; expected at least ${REVOKE_SECONDS} s`);
    }
    // The runner reads both grants again after the run. If macOS does not report a
    // mid-run change to a running process, they still read granted, this reads as no
    // revoke, and the rule fails closed to C.
    if (!NOT_HELD.has(run.screenAfter) && !NOT_HELD.has(run.microphoneAfter)) {
      reasons.push(`${id} shows no revoke`);
    }
  }
  return reasons;
}

/**
 * Rows the rule cannot pool: consent and revoke runs on more than one window, or from
 * more than one OS build or Electron version, or a consent run whose grants read after
 * it differ from those read before it (it measured two states, not its cell), or a
 * consent run with a missing or unrecognised reading before or after it (it cannot show
 * its grants held). Each is a Rule C reason.
 */
function mixedRows(rows) {
  const ruled = rows.filter((r) => r.kind === 'consent' || r.kind === 'revoke');
  const distinct = (list, key) => new Set(list.map((r) => JSON.stringify(r[key] ?? null))).size;
  const reasons = [];
  if (ruled.some((r) => !Number.isInteger(r.windowId))) {
    reasons.push('a consent or revoke run has no window id');
  }
  const windows = distinct(ruled, 'windowId');
  if (windows > 1) {
    reasons.push(`the consent and revoke runs measured ${windows} different windows`);
  }
  const builds = distinct(ruled, 'osBuild');
  if (builds > 1) reasons.push(`the rows span ${builds} OS builds`);
  const versions = distinct(ruled, 'electron');
  if (versions > 1) reasons.push(`the rows span ${versions} Electron versions`);
  for (const r of ruled) {
    if (r.kind !== 'consent') continue;
    for (const grant of GRANTS) {
      const before = r[grant];
      const after = r[`${grant}After`];
      // An unrecognised value is not echoed: it did not come from the runner.
      if (!GRANT_VALUES.has(before)) {
        reasons.push(`${r.label} has a run with no valid ${grant} reading before it`);
      }
      if (!GRANT_VALUES.has(after)) {
        reasons.push(`${r.label} has a run with no valid ${grant} reading after it`);
      } else if (GRANT_VALUES.has(before) && after !== before) {
        reasons.push(
          `${r.label} has a run that read ${grant} ${before} before it and ${after} after it`
        );
      }
    }
  }
  return reasons;
}

// The fence refuses a share whose window is unlisted because the bundle holds no Screen
// Recording grant (spec section 3; lead decision 7). A window missing from a list that
// Screen Recording could read is hidden or stale, a state a user can reach, so that
// cell counts like any other.
const excused = (cell) =>
  cell.enumerable === false && (cell.screen !== 'granted' || cell.enumerationFailed === true);

/**
 * Applies Rules A, B and C to the consent cells and the revoke result. It does not check
 * that the evidence is complete: incompleteCells does, and main() merges the two.
 * An excused cell (`enumerable` literally false, and Screen Recording not granted or the
 * enumeration failed) is left out of Rules A and B when it is silent or dead. That is
 * deliberately stricter than the spec, not looser: an excused cell that is `other`
 * still stops the rule, and one that carries still counts as carrying.
 */
export function applyRule(cells, revoke, neverRequested) {
  const classed = cells.map((cell) => ({ ...cell, cls: cellClass(cell.runs) }));
  const reasons = [];

  for (const cell of classed) {
    if (cell.cls === 'other') reasons.push(`${cell.id} is other`);
  }
  // `carries` is measured against the both-granted control (spec section 3), so a
  // missing or non-carrying C1 leaves every silent cell unjudgeable.
  const control = classed.find((c) => c.id === 'C1');
  if (control?.cls !== 'carries') reasons.push('the control C1 did not carry the tone');

  const carrying = new Set(classed.filter((c) => c.cls === 'carries').map(pairKey));
  const silent = classed.filter((c) => !excused(c) && (c.cls === 'silent' || c.cls === 'dead'));
  for (const cell of silent) {
    if (carrying.has(pairKey(cell))) {
      reasons.push(`${cell.id} is ${cell.cls} on a pair a carrying cell also has`);
    }
    for (const grant of neverRequested) {
      if (GRANTS.includes(grant) && cell[grant] === 'not-determined') {
        reasons.push(`${cell.id} reads not-determined for ${grant}, which the app never requests`);
      }
    }
  }

  // The plan names silenced, stopped and other. A revoke run that faulted also ended
  // a running tap (spec: "silences or ends"), so anything but no-effect stops the rule.
  if (revoke !== null && revoke !== undefined && revoke !== 'no-effect') {
    reasons.push(`the revoke run is ${revoke}`);
  }

  if (reasons.length > 0) return { rule: 'C', reasons };
  if (silent.length === 0) return { rule: 'A' };

  const seen = new Set();
  const predicate = [];
  for (const cell of silent) {
    const key = pairKey(cell);
    if (seen.has(key)) continue;
    seen.add(key);
    predicate.push({ screen: cell.screen, microphone: cell.microphone });
  }
  return { rule: 'B', predicate };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(reason) {
  console.error(`FAIL ${reason}`);
  process.exit(2);
}

function readRows(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`cannot read the rows file: ${err.code ?? 'unknown error'}`);
  }
  const rows = [];
  const gaps = [];
  const seen = new Set();
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim().replace(/^ROW /, '');
    if (trimmed === '') return;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      fail(`line ${i + 1} is not JSON`);
    }
    if (!['consent', 'include', 'exclude', 'revoke'].includes(row?.kind)) {
      fail(`line ${i + 1} has an unknown kind`);
    }
    // Only the run id tells a pasted copy from a second run: two runs that fault or read
    // dead print the same counters.
    if (typeof row.runId !== 'string' || row.runId === '') {
      gaps.push(`line ${i + 1} has no run id`);
    } else if (seen.has(row.runId)) {
      console.log(`line ${i + 1} repeats the run id of an earlier row: counted once`);
      return;
    } else {
      seen.add(row.runId);
    }
    rows.push(row);
  });
  return { rows, gaps };
}

function usable(row) {
  return !hasStage(row.faultStage) && readable(row.counters) && row.counters.callbackTotal > 0;
}

function ratioText(counters) {
  if (!counters) return 'no counters';
  const { signalTotal, callbackTotal } = counters;
  const ratio = callbackTotal > 0 ? (signalTotal / callbackTotal).toFixed(3) : 'n/a';
  return `${signalTotal} of ${callbackTotal} (${ratio})`;
}

function main(argv) {
  const args = argv.slice(2);
  let neverRequested = [...GRANTS];
  const at = args.indexOf('--never-requested');
  if (at >= 0) {
    if (at + 1 >= args.length) fail('--never-requested needs a value');
    neverRequested = args[at + 1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (neverRequested.some((g) => !GRANTS.includes(g))) {
      fail('--never-requested takes screen and/or microphone');
    }
    args.splice(at, 2);
  }
  if (args.length !== 1) fail('usage: node classify.mjs <rows.jsonl> [--never-requested ...]');

  const { rows, gaps: rowGaps } = readRows(args[0]);

  // The control: every usable C1 consent run, summed.
  const controlRows = rows.filter(
    (r) => r.kind === 'consent' && r.label === CONTROL_LABEL && usable(r)
  );
  const control = { callbackTotal: 0, signalTotal: 0 };
  let controlSeconds = 0;
  for (const r of controlRows) {
    control.callbackTotal += r.counters.callbackTotal;
    control.signalTotal += r.counters.signalTotal;
    controlSeconds += r.seconds;
  }
  const controlRatio = control.signalTotal / control.callbackTotal;
  console.log(
    `control ${CONTROL_LABEL}: ${controlRows.length} usable run(s), ${ratioText(control)}`
  );

  const cells = new Map();
  const revokes = [];
  for (const r of rows) {
    let cls;
    if (r.kind === 'consent') {
      cls = classifyConsent(r.counters, r.faultStage, controlRatio);
      const cell = cells.get(r.label);
      if (!cell) {
        cells.set(r.label, {
          id: r.label,
          screen: r.screen,
          microphone: r.microphone,
          enumerable: r.enumerable,
          enumerationFailed: r.enumerationFailed,
          runs: [cls],
        });
      } else {
        // Two runs of one cell that read different grants were not the same cell.
        const same =
          cell.screen === r.screen &&
          cell.microphone === r.microphone &&
          cell.enumerable === r.enumerable &&
          cell.enumerationFailed === r.enumerationFailed;
        cell.runs.push(same ? cls : 'other');
      }
    } else if (r.kind === 'revoke') {
      cls = classifyRevoke(r.counters, r.faultStage, control, controlSeconds, r.seconds);
      revokes.push(cls);
    } else {
      cls = classifyMatrix(r.kind, r.counters, r.faultStage);
    }
    const fault = r.faultStage ? `, fault ${r.faultStage}` : '';
    console.log(
      `${r.label}\t${r.kind}\t${cls}\tscreen=${r.screen} microphone=${r.microphone} ` +
        `enumerable=${r.enumerable} enumerationFailed=${r.enumerationFailed} ` +
        `window=${r.windowId}\t${ratioText(r.counters)}${fault}`
    );
  }

  for (const cell of cells.values()) {
    if (excused(cell)) {
      const why = cell.enumerationFailed
        ? 'the enumeration failed'
        : `Screen Recording reads ${cell.screen}`;
      console.log(
        `${cell.id} is not enumerable (${why}): reported, not counted (${cell.runs.join(', ')})`
      );
    }
  }

  // ponytail: several revoke rows combine to no-effect only when every one is; the
  // first other class is passed on, which stops the rule either way.
  const revoke =
    revokes.length === 0 ? null : (revokes.find((c) => c !== 'no-effect') ?? 'no-effect');
  console.log(`revoke: ${revoke ?? 'not run'}`);
  console.log(`never requested: ${neverRequested.join(', ') || 'none'}`);

  const gaps = [
    ...rowGaps,
    ...incompleteCells(
      [...cells.values()],
      rows.filter((r) => r.kind === 'revoke')
    ),
    ...mixedRows(rows),
  ];
  const ruled = applyRule([...cells.values()], revoke, neverRequested);
  const out = gaps.length > 0 ? { rule: 'C', reasons: [...gaps, ...(ruled.reasons ?? [])] } : ruled;
  console.log(`rule ${out.rule}`);
  if (out.rule === 'B') {
    for (const p of out.predicate) {
      console.log(`predicate screen=${p.screen} microphone=${p.microphone}`);
    }
  }
  if (out.rule === 'C') {
    for (const reason of out.reasons) console.log(`reason ${reason}`);
  }
}

// Run as a script, not when imported by the test. realpath so a symlinked path still
// runs; a path that cannot be resolved is not this file.
function isEntry() {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/* istanbul ignore next -- thin CLI entry; the classifiers are covered by classify.test.ts */
if (process.argv[1] && isEntry()) {
  main(process.argv);
}
