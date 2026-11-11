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
//     and reads `other`.
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

/**
 * @typedef {object} Counters
 * @property {number} callbackTotal
 * @property {number} quantaTotal
 * @property {number} signalTotal
 * @property {number} overrunTotal
 * @property {number} destroyFailures
 * @property {boolean} silentSinceStart
 * @property {boolean} faulted
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
  return counters;
}

// `fault` is the acceptable refusal with a reason (spec section 3), so only a fault
// stage earns it. No counters, or counters that say faulted with no stage, is the OS
// ending the process or an unexplained fault: `other`, which stops the rule.
const hasStage = (faultStage) => faultStage !== null && faultStage !== undefined;
const readable = (counters) =>
  counters !== null && counters !== undefined && counters.faulted === false;

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

/** The mid-share revoke run's class, against the both-granted control. */
export function classifyRevoke(counters, faultStage, control, controlSeconds, seconds) {
  if (hasStage(faultStage)) return 'fault';
  if (!readable(counters)) return 'other';
  const expected = 0.5 * (control.callbackTotal / controlSeconds) * seconds;
  // A run whose expected callback count cannot be computed cannot be judged.
  if (!(expected > 0)) return 'other';
  if (counters.callbackTotal < expected) return 'stopped';
  const r = counters.signalTotal / counters.callbackTotal;
  const rc = control.signalTotal / control.callbackTotal;
  if (r >= 0.8 * rc) return 'no-effect';
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
 * C5 with two runs, a control that reads granted for both, and the revoke run R1.
 * Every gap is a Rule C reason, so a runner that stopped early cannot read as Rule A.
 */
export function incompleteCells(cells, revoke) {
  const reasons = [];
  for (const id of REQUIRED_CELLS) {
    const runs = cells.find((c) => c.id === id)?.runs?.length ?? 0;
    if (runs === 0) reasons.push(`${id} has no rows`);
    else if (runs < RUNS_PER_CELL) reasons.push(`${id} has ${runs} of ${RUNS_PER_CELL} runs`);
  }
  const control = cells.find((c) => c.id === CONTROL_LABEL);
  if (control && (control.screen !== 'granted' || control.microphone !== 'granted')) {
    reasons.push(`${CONTROL_LABEL} does not read granted, granted`);
  }
  if (revoke === null || revoke === undefined) reasons.push('the revoke run R1 has no row');
  return reasons;
}

/**
 * Applies Rules A, B and C to the consent cells and the revoke result.
 * A cell is non-enumerable only when `enumerable` is literally false; such a cell is
 * reported by the caller and never decides Rule A or B.
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
  const silent = classed.filter(
    (c) => c.enumerable !== false && (c.cls === 'silent' || c.cls === 'dead')
  );
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
    rows.push(row);
  });
  return rows;
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

  const rows = readRows(args[0]);

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
          runs: [cls],
        });
      } else {
        // Two runs of one cell that read different grants were not the same cell.
        const same =
          cell.screen === r.screen &&
          cell.microphone === r.microphone &&
          cell.enumerable === r.enumerable;
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
        `enumerable=${r.enumerable}\t${ratioText(r.counters)}${fault}`
    );
  }

  for (const cell of cells.values()) {
    if (cell.enumerable === false) {
      console.log(`${cell.id} is not enumerable: reported, not counted (${cell.runs.join(', ')})`);
    }
  }

  // ponytail: several revoke rows combine to no-effect only when every one is; the
  // first other class is passed on, which stops the rule either way.
  const revoke =
    revokes.length === 0 ? null : (revokes.find((c) => c !== 'no-effect') ?? 'no-effect');
  console.log(`revoke: ${revoke ?? 'not run'}`);
  console.log(`never requested: ${neverRequested.join(', ') || 'none'}`);

  const gaps = incompleteCells([...cells.values()], revoke);
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
