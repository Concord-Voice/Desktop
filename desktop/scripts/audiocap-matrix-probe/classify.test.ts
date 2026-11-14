// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRule,
  classifyConsent,
  classifyMatrix,
  classifyRevoke,
  incompleteCells,
  parseLiveness,
} from './classify.mjs';

type Counters = {
  callbackTotal: number;
  quantaTotal: number;
  signalTotal: number;
  overrunTotal: number;
  destroyFailures: number;
  silentSinceStart: boolean;
  faulted: boolean;
  poisoned: boolean;
  quiesceProved: boolean;
};

function counters(
  callbackTotal: number,
  signalTotal: number,
  over: Partial<Counters> = {}
): Counters {
  return {
    callbackTotal,
    quantaTotal: callbackTotal,
    signalTotal,
    overrunTotal: 0,
    destroyFailures: 0,
    silentSinceStart: signalTotal === 0,
    faulted: false,
    poisoned: false,
    quiesceProved: true,
    ...over,
  };
}

// Shape of the object the child passes to console.warn in
// desktop/src/main/audiocapChild.ts (reportLiveness), as Node's util.inspect
// prints it: a multi-line block of `key: value` pairs, one per line, strings
// single-quoted, undefined printed bare. Written from the call shape, not a run.
const LIVENESS_BLOCK = [
  '[audiocap] liveness {',
  '  callbackTotal: 2315,',
  '  quantaTotal: 2315,',
  '  signalTotal: 856,',
  '  silentSinceStart: false,',
  '  overrunTotal: 3,',
  '  faulted: false,',
  '  poisoned: false,',
  '  quiesceProved: true,',
  '  destroyFailures: 0,',
  "  lastDeviceStatus: 'ok'",
  '}',
].join('\n');

const EXPECTED = {
  callbackTotal: 2315,
  quantaTotal: 2315,
  signalTotal: 856,
  overrunTotal: 3,
  destroyFailures: 0,
  silentSinceStart: false,
  faulted: false,
  poisoned: false,
  quiesceProved: true,
};

describe('parseLiveness', () => {
  it('reads the counters from the liveness block', () => {
    expect(parseLiveness(`noise before\n${LIVENESS_BLOCK}\n`)).toEqual(
      expect.objectContaining(EXPECTED)
    );
  });

  it('parseLiveness returns null when the line is absent', () => {
    expect(parseLiveness('')).toBeNull();
    expect(parseLiveness('[audiocap] something else { callbackTotal: 1 }\n')).toBeNull();
  });

  it('returns null when a numeric field is missing', () => {
    const missing = LIVENESS_BLOCK.replace('  signalTotal: 856,\n', '');
    expect(parseLiveness(missing)).toBeNull();
  });

  // Fail closed: an unexplained fault is `other`, which stops the rule; only a fault
  // stage is the acceptable refusal `fault`.
  it('reads a missing faulted field as faulted, so the run is other', () => {
    const read = parseLiveness(LIVENESS_BLOCK.replace('  faulted: false,\n', ''));
    expect(read?.faulted).toBe(true);
    expect(classifyConsent(read, null, 1.0)).toBe('other');
  });

  // Fail closed like faulted: only a printed false counts as not poisoned.
  it('reads a missing poisoned field as poisoned, so the run is other', () => {
    const read = parseLiveness(LIVENESS_BLOCK.replace('  poisoned: false,\n', ''));
    expect(read?.poisoned).toBe(true);
    expect(classifyConsent(read, null, 1.0)).toBe('other');
  });

  it('reads a printed poisoned: true as poisoned', () => {
    const read = parseLiveness(LIVENESS_BLOCK.replace('poisoned: false', 'poisoned: true'));
    expect(read?.poisoned).toBe(true);
  });

  it('parseLiveness reads a line split across chunks', () => {
    const cut = LIVENESS_BLOCK.indexOf('signalTotal') + 'signal'.length; // mid-key
    const chunks = [LIVENESS_BLOCK.slice(0, cut), LIVENESS_BLOCK.slice(cut)];
    expect(chunks[0].endsWith('signal')).toBe(true);
    expect(parseLiveness(chunks.join(''))).toEqual(expect.objectContaining(EXPECTED));
  });

  it('reads the last block when the child printed more than one', () => {
    const first = LIVENESS_BLOCK.replace('callbackTotal: 2315', 'callbackTotal: 7');
    expect(parseLiveness(`${first}\n${LIVENESS_BLOCK}\n`)?.callbackTotal).toBe(2315);
  });
});

describe('classifyConsent', () => {
  // No counters and no fault stage: the OS ended the process (spec section 3: other).
  it('classifyConsent of null counters is other', () => {
    expect(classifyConsent(null, null, 1.0)).toBe('other');
  });

  it('is fault when a fault stage is set even with no counters', () => {
    expect(classifyConsent(null, 'start', 1.0)).toBe('fault');
  });

  it('is fault when a fault stage is set', () => {
    expect(classifyConsent(counters(2000, 2000), 'target', 1.0)).toBe('fault');
  });

  it('is other when the counters say faulted but no stage is set', () => {
    expect(classifyConsent(counters(2000, 2000, { faulted: true }), null, 1.0)).toBe('other');
  });

  it('carries at exactly half the control ratio', () => {
    expect(classifyConsent(counters(2000, 1000), null, 1.0)).toBe('carries');
  });

  it('is other just under half the control ratio', () => {
    expect(classifyConsent(counters(2000, 980), null, 1.0)).toBe('other');
  });

  it('is silent at 0 signal of 2000 callbacks', () => {
    expect(classifyConsent(counters(2000, 0), null, 1.0)).toBe('silent');
  });

  it('is dead at 0 callbacks with no fault', () => {
    expect(classifyConsent(counters(0, 0), null, 1.0)).toBe('dead');
  });

  it('is other when the run was poisoned, even with a carrying ratio', () => {
    expect(classifyConsent(counters(2000, 2000, { poisoned: true }), null, 1.0)).toBe('other');
  });

  it('is other when a destroy failed, even with a carrying ratio', () => {
    expect(classifyConsent(counters(2000, 2000, { destroyFailures: 1 }), null, 1.0)).toBe('other');
  });
});

describe('classifyMatrix', () => {
  it('include 856 of 2315 passes', () => {
    expect(classifyMatrix('include', counters(2315, 856), null)).toBe('pass');
  });

  it('exclude 1 of 2984 is leak', () => {
    expect(classifyMatrix('exclude', counters(2984, 1), null)).toBe('leak');
  });

  it('exclude with no signal passes', () => {
    expect(classifyMatrix('exclude', counters(2984, 0), null)).toBe('pass');
  });

  it('a poisoned include run is a finding', () => {
    expect(classifyMatrix('include', counters(2315, 856, { poisoned: true }), null)).toBe(
      'finding'
    );
  });

  // A leak stays a leak: the leak check comes before the readable check.
  it('a poisoned exclude run with signal is still a leak', () => {
    expect(classifyMatrix('exclude', counters(2984, 1, { poisoned: true }), null)).toBe('leak');
  });

  it('a fault is a finding', () => {
    expect(classifyMatrix('include', counters(2315, 856), 'start')).toBe('finding');
    expect(classifyMatrix('include', null, null)).toBe('finding');
  });
});

describe('classifyRevoke', () => {
  const control = counters(2000, 2000); // ratio 1.0 over 10 s
  it('0.95 x control is no-effect', () => {
    expect(classifyRevoke(counters(2000, 1900), null, control, 10, 10)).toBe('no-effect');
  });

  it('0.3 x control is silenced', () => {
    expect(classifyRevoke(counters(2000, 600), null, control, 10, 10)).toBe('silenced');
  });

  it('between 0.5 and 0.95 of control is other', () => {
    expect(classifyRevoke(counters(2000, 1300), null, control, 10, 10)).toBe('other');
  });

  it('under 0.9 of the expected callbacks is stopped', () => {
    expect(classifyRevoke(counters(500, 500), null, control, 10, 10)).toBe('stopped');
  });

  it('a fault stage is fault', () => {
    expect(classifyRevoke(counters(2000, 2000), 'run', control, 10, 10)).toBe('fault');
  });

  it('no counters and no fault stage is other', () => {
    expect(classifyRevoke(null, null, control, 10, 10)).toBe('other');
  });

  // R1 runs 60 s against 20 s control runs, and the second toggle can land late.
  const control20 = counters(2000, 2000); // 100 callbacks a second over 20 s
  it('a tap that ends after 31 s of a 60 s run is stopped, not no-effect', () => {
    expect(classifyRevoke(counters(3100, 3100), null, control20, 20, 60)).toBe('stopped');
  });

  it('a revoke run with a failed destroy is other', () => {
    expect(
      classifyRevoke(counters(2000, 2000, { destroyFailures: 1 }), null, control, 10, 10)
    ).toBe('other');
  });

  it('a tap that goes silent after 48 s of a 60 s run is not no-effect', () => {
    expect(classifyRevoke(counters(6000, 4800), null, control20, 20, 60)).toBe('other');
  });
});

describe('applyRule', () => {
  const cell = (
    id: string,
    screen: string,
    microphone: string,
    runs: string[],
    enumerable = true,
    enumerationFailed = false
  ) => ({ id, screen, microphone, enumerable, enumerationFailed, runs });

  const carryingCells = () => [
    cell('C1', 'granted', 'granted', ['carries', 'carries']),
    cell('C2', 'granted', 'denied', ['carries', 'carries']),
    cell('C3', 'denied', 'granted', ['carries', 'carries']),
    cell('C4', 'denied', 'denied', ['carries', 'carries']),
  ];

  // applyRule alone does not check completeness (no C5, no revoke row here); that is
  // incompleteCells, which main() merges in. This is not the spec's Rule A.
  it('applyRule alone gives A when C1 to C4 all carry', () => {
    expect(applyRule(carryingCells(), null, [])).toEqual({ rule: 'A' });
  });

  // `carries` is defined against the both-granted control; without a carrying C1 no
  // silent cell can be told apart from a tap that carried nothing at all.
  it('is Rule C when there is no control cell', () => {
    const cells = carryingCells().slice(1);
    cells[2] = cell('C4', 'denied', 'denied', ['silent', 'silent']);
    expect(applyRule(cells, null, []).rule).toBe('C');
  });

  it('is Rule C when the control itself is silent', () => {
    const cells = carryingCells();
    cells[0] = cell('C1', 'granted', 'granted', ['silent', 'silent']);
    expect(applyRule(cells, null, []).rule).toBe('C');
  });

  it('is Rule B with the silent cell pair alone', () => {
    const cells = carryingCells();
    cells[3] = cell('C4', 'denied', 'denied', ['silent', 'silent']);
    cells[1] = cell('C2', 'granted', 'denied', ['carries', 'carries']);
    expect(applyRule(cells, null, [])).toEqual({
      rule: 'B',
      predicate: [{ screen: 'denied', microphone: 'denied' }],
    });
  });

  it('is Rule C when a silent cell shares its pair with a carrying cell', () => {
    const cells = carryingCells();
    cells[3] = cell('C4', 'denied', 'denied', ['silent', 'silent']);
    cells.push(cell('C5', 'denied', 'denied', ['carries', 'carries']));
    const out = applyRule(cells, null, []);
    expect(out.rule).toBe('C');
  });

  it('is Rule C when revoke === silenced', () => {
    const out = applyRule(carryingCells(), 'silenced', []);
    expect(out.rule).toBe('C');
  });

  it.each(['stopped', 'other'])('is Rule C when revoke is %s', (revoke) => {
    expect(applyRule(carryingCells(), revoke, []).rule).toBe('C');
  });

  it('is Rule A when revoke is no-effect', () => {
    expect(applyRule(carryingCells(), 'no-effect', [])).toEqual({ rule: 'A' });
  });

  it('disagreeing runs make the cell other and the rule C', () => {
    const cells = carryingCells();
    cells[2] = cell('C3', 'denied', 'granted', ['carries', 'silent']);
    expect(applyRule(cells, null, []).rule).toBe('C');
  });

  it('a non-enumerable silent cell does not block Rule A', () => {
    const cells = [...carryingCells(), cell('C5', 'denied', 'denied', ['silent', 'silent'], false)];
    expect(applyRule(cells, null, [])).toEqual({ rule: 'A' });
  });

  it('a non-enumerable silent cell does not decide Rule B', () => {
    const cells = [
      ...carryingCells(),
      cell('C5', 'not-determined', 'denied', ['dead', 'dead'], false),
    ];
    expect(applyRule(cells, null, [])).toEqual({ rule: 'A' });
  });

  // A window missing from a list Screen Recording could read is hidden or stale, a
  // state a user can reach, not the share the fence refuses.
  it('counts a non-enumerable cell while Screen Recording reads granted', () => {
    const cells = carryingCells();
    cells[1] = cell('C2', 'granted', 'denied', ['silent', 'silent'], false);
    expect(applyRule(cells, null, [])).toEqual({
      rule: 'B',
      predicate: [{ screen: 'granted', microphone: 'denied' }],
    });
  });

  it('excuses a non-enumerable cell whose enumeration failed', () => {
    const cells = carryingCells();
    cells[1] = cell('C2', 'granted', 'denied', ['silent', 'silent'], false, true);
    expect(applyRule(cells, null, [])).toEqual({ rule: 'A' });
  });

  // Deliberately stricter than the spec: the excuse covers silence, not `other`.
  it('an excused cell that is other still stops the rule', () => {
    const cells = [
      ...carryingCells(),
      cell('C5', 'denied', 'denied', ['carries', 'silent'], false),
    ];
    expect(applyRule(cells, null, []).rule).toBe('C');
  });

  it('an unrecognised reading is a distinct pair, never held', () => {
    const cells = carryingCells();
    cells.push(cell('C5', 'granted', 'somethingnew', ['silent', 'silent']));
    // 'somethingnew' is not 'granted', so the pair is its own and is not
    // folded into the ('granted','granted') carrying cell.
    expect(applyRule(cells, null, [])).toEqual({
      rule: 'B',
      predicate: [{ screen: 'granted', microphone: 'somethingnew' }],
    });
  });

  it('is Rule C when a silent cell reads not-determined for a never-requested grant', () => {
    const cells = [
      cell('C1', 'granted', 'granted', ['carries', 'carries']),
      cell('C4', 'granted', 'not-determined', ['silent', 'silent']),
    ];
    expect(applyRule(cells, null, ['microphone']).rule).toBe('C');
  });
});

describe('incompleteCells', () => {
  const cell = (id: string, screen: string, microphone: string, runs: number) => ({
    id,
    screen,
    microphone,
    enumerable: true,
    runs: Array(runs).fill('carries'),
  });
  // Spec section 5: C1 to C5 are needed to close, two runs each; R1 is taken.
  const complete = () => [
    cell('C1', 'granted', 'granted', 2),
    cell('C2', 'granted', 'denied', 2),
    cell('C3', 'denied', 'granted', 2),
    cell('C4', 'denied', 'denied', 2),
    cell('C5', 'not-determined', 'not-determined', 2),
  ];

  // Spec section 5, R1: a 60 s run that starts with both grants held; by its end a
  // grant reads turned off.
  const r1 = (over: Record<string, unknown> = {}) => ({
    label: 'R1',
    screen: 'granted',
    microphone: 'granted',
    screenAfter: 'denied',
    microphoneAfter: 'denied',
    seconds: 60,
    ...over,
  });

  it('is empty for a complete set of rows', () => {
    expect(incompleteCells(complete(), [r1()])).toEqual([]);
  });

  it('names a required cell with no rows', () => {
    const cells = complete().filter((c) => c.id !== 'C4');
    expect(incompleteCells(cells, [r1()])).toEqual(['C4 has no rows']);
  });

  it('names a cell with one run of two', () => {
    const cells = complete();
    cells[1] = cell('C2', 'granted', 'denied', 1);
    expect(incompleteCells(cells, [r1()])).toEqual(['C2 has 1 of 2 runs']);
  });

  it('names a control that does not read granted, granted', () => {
    const cells = complete();
    cells[0] = cell('C1', 'granted', 'denied', 2);
    expect(incompleteCells(cells, [r1()])).toEqual([
      'C1 reads granted, denied; expected granted, granted',
    ]);
  });

  it('names a missing revoke run', () => {
    expect(incompleteCells(complete(), [])).toEqual(['the revoke run R1 has no row']);
  });

  // The toggles never reached the runner's identity: every cell reads the control's pair.
  it('names every cell that does not read the pair that defines it', () => {
    const cells = complete().map((c) => ({ ...c, screen: 'granted', microphone: 'granted' }));
    expect(incompleteCells(cells, [r1()])).toEqual([
      'C2 reads granted, granted; expected granted, denied',
      'C3 reads granted, granted; expected denied, granted',
      'C4 reads granted, granted; expected denied, denied',
      "C5 reads granted, granted, the control's pair; expected the readings after a reset",
    ]);
  });

  it('names a revoke run shorter than 60 s', () => {
    expect(incompleteCells(complete(), [r1({ seconds: 20 })])).toEqual([
      'R1 ran 20 s; expected at least 60 s',
    ]);
  });

  it('names a revoke run with no recorded length', () => {
    expect(incompleteCells(complete(), [r1({ seconds: undefined })])).toEqual([
      'R1 ran for an unrecorded time; expected at least 60 s',
    ]);
  });

  it('names a revoke run that did not start with both grants held', () => {
    expect(incompleteCells(complete(), [r1({ microphone: 'denied' })])).toEqual([
      'R1 starts reading granted, denied; expected granted, granted',
    ]);
  });

  it.each([
    ['both still read granted', { screenAfter: 'granted', microphoneAfter: 'granted' }],
    ['no after-readings', { screenAfter: undefined, microphoneAfter: undefined }],
    ['an unknown after-reading', { screenAfter: 'unknown', microphoneAfter: 'granted' }],
  ])('names a revoke run that shows no revoke: %s', (_, over) => {
    expect(incompleteCells(complete(), [r1(over)])).toEqual(['R1 shows no revoke']);
  });

  it('one grant read turned off after the run is a revoke', () => {
    expect(incompleteCells(complete(), [r1({ screenAfter: 'granted' })])).toEqual([]);
  });
});

describe('classify.mjs CLI, a whole session through main()', () => {
  const session = {
    osBuild: '26B123',
    electron: '45.0.0',
    windowId: 7,
    enumerable: true,
    enumerationFailed: false,
    faultStage: null,
  };
  let runs = 0;
  // A lowercase v4 UUID, the form crypto.randomUUID() prints.
  const runId = () => `00000000-0000-4000-8000-${String(++runs).padStart(12, '0')}`;
  const consent = (label: string, screen: string, microphone: string, cb: number, sig: number) => ({
    ...session,
    runId: runId(),
    label,
    kind: 'consent',
    screen,
    microphone,
    screenAfter: screen,
    microphoneAfter: microphone,
    counters: counters(cb, sig),
    seconds: 20,
  });
  const revoke = (cb: number, sig: number, over: Record<string, unknown> = {}) => ({
    ...session,
    runId: runId(),
    label: 'R1',
    kind: 'revoke',
    screen: 'granted',
    microphone: 'granted',
    screenAfter: 'denied',
    microphoneAfter: 'granted',
    counters: counters(cb, sig),
    seconds: 60,
    ...over,
  });
  // The two C1 runs give 150 callbacks a second summed, 100 for the first alone. The
  // runs of one cell differ by a callback, so no two rows are identical.
  const consentRows = () => [
    consent('C1', 'granted', 'granted', 2000, 2000),
    consent('C1', 'granted', 'granted', 4000, 4000),
    consent('C2', 'granted', 'denied', 3000, 3000),
    consent('C2', 'granted', 'denied', 3001, 3001),
    consent('C3', 'denied', 'granted', 3000, 3000),
    consent('C3', 'denied', 'granted', 3001, 3001),
    consent('C4', 'denied', 'denied', 3000, 3000),
    consent('C4', 'denied', 'denied', 3001, 3001),
    consent('C5', 'not-determined', 'not-determined', 3000, 3000),
    consent('C5', 'not-determined', 'not-determined', 3001, 3001),
  ];

  // Runs the CLI on a rows file holding `text`; extraArgs go after the file name.
  function runCli(text: string, extraArgs: string[] = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-'));
    const file = path.join(dir, 'rows.jsonl');
    fs.writeFileSync(file, text);
    const cli = path.join(path.dirname(new URL(import.meta.url).pathname), 'classify.mjs');
    const run = spawnSync(process.execPath, [cli, file, ...extraArgs], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return run;
  }

  function classify(rows: object[], extraArgs: string[] = []): string {
    const run = runCli(rows.map((r) => `ROW ${JSON.stringify(r)}\n`).join(''), extraArgs);
    expect(run.status).toBe(0);
    return run.stdout;
  }

  // The runner can stop early; a rows file that holds only the control must not
  // read as Rule A.
  it('gives Rule C for a rows file that holds only the control', () => {
    const out = classify(consentRows().slice(0, 2));
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason C2 has no rows');
    expect(out).toContain('reason the revoke run R1 has no row');
  });

  it('reaches Rule A for a complete carrying set and a no-effect revoke', () => {
    const out = classify([...consentRows(), revoke(9000, 9000)]);
    expect(out).toContain('R1\trevoke\tno-effect');
    expect(out).toMatch(/^rule A$/m);
  });

  it("reaches Rule B with the silent cell's pair as the predicate", () => {
    const rows = consentRows();
    rows[6] = consent('C4', 'denied', 'denied', 3000, 0);
    rows[7] = consent('C4', 'denied', 'denied', 3001, 0);
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule B$/m);
    expect(out).toContain('predicate screen=denied microphone=denied');
  });

  // 7000 is under 90% of the summed control's 9000 for 60 s, but over 90% of the
  // first run's 6000: only summing both control runs reads it as stopped.
  it('judges the revoke run against both control runs summed', () => {
    const out = classify([...consentRows(), revoke(7000, 7000)]);
    expect(out).toContain('R1\trevoke\tstopped');
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason the revoke run is stopped');
  });

  it('gives Rule C for a revoke row with no seconds', () => {
    const out = classify([...consentRows(), revoke(9000, 9000, { seconds: undefined })]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason R1 ran for an unrecorded time; expected at least 60 s');
  });

  it.each([
    ['-1e21', -1e21, '1e+21'],
    ['59.5', 59.5, '59.5'],
  ])('gives Rule C for an R1 length of %s and does not print the raw value', (_, seconds, raw) => {
    const out = classify([...consentRows(), revoke(9000, 9000, { seconds })]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason R1 ran for an unrecorded time; expected at least 60 s');
    expect(out).not.toContain(raw);
  });

  it('prints a whole-number R1 length of 30 as 30 s', () => {
    const out = classify([...consentRows(), revoke(9000, 9000, { seconds: 30 })]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason R1 ran 30 s; expected at least 60 s');
  });

  // The toggles reached another identity: every cell reads the control's pair and carries.
  it('gives Rule C when all five cells read granted, granted and carry', () => {
    const rows = consentRows().map((r) => ({ ...r, screen: 'granted', microphone: 'granted' }));
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason C2 reads granted, granted; expected granted, denied');
    expect(out).toContain('reason C4 reads granted, granted; expected denied, denied');
  });

  it('counts two rows with one run id as one run', () => {
    const rows = consentRows();
    rows[3] = { ...rows[3], runId: rows[2].runId };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason C2 has 1 of 2 runs');
  });

  // Two real runs that fault, or read dead, print the same counters; only the run id
  // tells them apart, so neither may be dropped as a copy.
  it('counts two identical faulted runs with their own run ids as two runs', () => {
    const rows = consentRows().map((r) =>
      r.label === 'C3' ? { ...r, faultStage: 'target', counters: null } : r
    );
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).not.toContain('C3 has 1 of 2 runs');
  });

  it('gives Rule C for a row with no run id', () => {
    const rows = consentRows();
    const { runId: _dropped, ...noId } = rows[4];
    rows[4] = noId as (typeof rows)[number];
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toMatch(/reason line \d+ has no run id/);
  });

  describe('repeated run ids', () => {
    it('gives Rule C when a repeated run id carries other values', () => {
      const rows = consentRows();
      rows[3] = { ...rows[3], runId: rows[2].runId };
      const out = classify([...rows, revoke(9000, 9000)]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).toContain('reason line 4 repeats the run id of line 3 with other values');
    });

    it('still counts an exact repeat once and keeps Rule A', () => {
      const rows = consentRows();
      const out = classify([...rows, rows[8], revoke(9000, 9000)]);
      expect(out).toMatch(/^rule A$/m);
      expect(out).toContain('repeats the run id of an earlier row: counted once');
      expect(out).not.toContain('with other values');
    });
  });

  // Rule C is the safe outcome: any value the runner never prints must reach it.
  describe('values the runner never prints', () => {
    const withRows = (over: (r: Record<string, unknown>) => Record<string, unknown>) =>
      consentRows().map(over);
    const ruleLines = (out: string) => out.split(/\r\n|[\n\r\u2028\u2029]/);
    const expectC = (out: string, reason: string) => {
      expect(out).toMatch(/^rule C$/m);
      expect(out).toContain(`reason ${reason}`);
    };

    it('gives Rule C for a run id that is not a v4 UUID', () => {
      const rows = consentRows();
      rows[4] = { ...rows[4], runId: 'run-5' };
      const out = classify([...rows, revoke(9000, 9000)]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).toMatch(/reason line \d+ has a run id the runner does not print/);
    });

    it('gives Rule C for an OS build that is null on every row', () => {
      const rows = withRows((r) => ({ ...r, osBuild: null }));
      const out = classify([...rows, revoke(9000, 9000, { osBuild: null })]);
      expectC(out, 'a consent or revoke run has no OS build');
    });

    it('gives Rule C for an Electron version that is null', () => {
      const rows = withRows((r) => ({ ...r, electron: null }));
      const out = classify([...rows, revoke(9000, 9000, { electron: null })]);
      expectC(out, 'a consent or revoke run has no Electron version');
    });

    it.each([0, -3, 1.5, 4294967296, '7'])('gives Rule C for window id %j', (windowId) => {
      const out = classify([...consentRows(), revoke(9000, 9000, { windowId })]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).toContain('reason a consent or revoke run has no window id');
    });

    it.each([
      ['"20"', '20'],
      ['1e9', 1e9],
      ['700', 700],
      ['0', 0],
    ])('gives Rule C for seconds %s on C1', (_, seconds) => {
      const rows = consentRows();
      rows[0] = { ...rows[0], seconds };
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C1 has a run whose length is not a whole number of seconds from 1 to 600');
    });

    it('gives Rule C for seconds on a revoke run that is not a number', () => {
      const out = classify([...consentRows(), revoke(9000, 9000, { seconds: '60' })]);
      expectC(out, 'R1 has a run whose length is not a whole number of seconds from 1 to 600');
    });

    it.each([
      ['a string count', { signalTotal: '3000' }],
      ['a missing flag', { poisoned: undefined }],
      ['a negative count', { overrunTotal: -1 }],
      ['an unsafe count', { callbackTotal: 2 ** 60 }],
    ])('gives Rule C for counters with %s', (_, over) => {
      const rows = consentRows();
      rows[4] = { ...rows[4], counters: { ...counters(3000, 3000), ...over } };
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C3 has a run with counters the runner does not print');
    });

    it.each([
      ['callbackTotal', { callbackTotal: 4294967296, quantaTotal: 4294967296 }],
      ['signalTotal', { callbackTotal: 4294967296, signalTotal: 4294967296 }],
    ])('gives Rule C for %s above 4294967295', (_, over) => {
      const rows = consentRows();
      rows[4] = { ...rows[4], counters: { ...counters(3000, 3000), ...over } };
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C3 has a run with counters the runner does not print');
    });

    it('accepts counters at 4294967295', () => {
      const rows = consentRows();
      rows[4] = { ...rows[4], counters: counters(4294967295, 4294967295) };
      const out = classify([...rows, revoke(9000, 9000)]);
      expect(out).not.toContain('counters the runner does not print');
    });

    it('gives Rule C when signalTotal is above callbackTotal', () => {
      const rows = consentRows();
      rows[4] = { ...rows[4], counters: counters(3000, 3001) };
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C3 has a run with counters the runner does not print');
    });

    it('gives Rule C for a revoke row with a newline label', () => {
      const out = classify([...consentRows(), revoke(9000, 9000, { label: 'R1\nrule A' })]);
      expectC(out, 'a revoke run has a label the runner does not print');
      expect(ruleLines(out).filter((l) => l.startsWith('rule '))).toEqual(['rule C']);
    });

    it.each([
      ['enumerable', { enumerable: 'true' }],
      ['enumerationFailed', { enumerationFailed: 1 }],
      ['both true', { enumerable: true, enumerationFailed: true }],
    ])('gives Rule C for a revoke row with non-boolean enumeration flags: %s', (_, over) => {
      const out = classify([...consentRows(), revoke(9000, 9000, over)]);
      expectC(out, 'R1 has a run with enumeration flags the runner does not print');
    });

    it('gives Rule C for counters that are missing', () => {
      const rows = consentRows();
      rows[4] = { ...rows[4], counters: undefined };
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C3 has a run with counters the runner does not print');
    });

    it('gives Rule C for counters on a revoke run with a string count', () => {
      const bad = { ...counters(9000, 9000), quantaTotal: '1' };
      const out = classify([...consentRows(), revoke(9000, 9000, { counters: bad })]);
      expectC(out, 'R1 has a run with counters the runner does not print');
    });

    it.each([
      ['a number', 5],
      ['bogus', 'bogus'],
      ['missing', undefined],
    ])('gives Rule C for a fault stage that is %s', (_, faultStage) => {
      const rows = consentRows();
      rows[4] = { ...rows[4], faultStage };
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C3 has a run with a fault stage the runner does not print');
    });

    it('accepts a fault stage the runner prints', () => {
      const rows = consentRows().map((r) =>
        r.label === 'C3' ? { ...r, faultStage: 'unknown', counters: null } : r
      );
      const out = classify([...rows, revoke(9000, 9000)]);
      expect(out).not.toContain('fault stage the runner does not print');
    });

    it("gives Rule C, not Rule B, for enumerable 'false' on a silent cell", () => {
      const rows = consentRows().map((r) =>
        r.label === 'C4' ? { ...r, enumerable: 'false', counters: counters(3000, 0) } : r
      );
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C4 has a run with enumeration flags the runner does not print');
      expect(out).not.toMatch(/^rule B$/m);
    });

    it('gives Rule C when a run is enumerable and its enumeration failed', () => {
      const rows = consentRows();
      rows[6] = { ...rows[6], enumerable: true, enumerationFailed: true };
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C4 has a run with enumeration flags the runner does not print');
    });

    it('gives Rule C for a missing enumerationFailed flag', () => {
      const rows = consentRows();
      rows[0] = { ...rows[0], enumerationFailed: undefined };
      const out = classify([...rows, revoke(9000, 9000)]);
      expectC(out, 'C1 has a run with enumeration flags the runner does not print');
    });

    it('gives Rule C when a revoke run reads one grant off and the other unrecognised', () => {
      const out = classify([
        ...consentRows(),
        revoke(9000, 9000, { screenAfter: 'bogus', microphoneAfter: 'denied' }),
      ]);
      expectC(out, 'R1 ends with an unrecognised grant reading');
      expect(out).not.toContain('bogus');
    });

    it('gives Rule C when a revoke run reads one grant off and the other missing', () => {
      const out = classify([
        ...consentRows(),
        revoke(9000, 9000, { screenAfter: 'denied', microphoneAfter: undefined }),
      ]);
      expectC(out, 'R1 ends with an unrecognised grant reading');
    });

    describe('output cannot be forged by a row value', () => {
      const forged = '\nrule A\npredicate screen=denied microphone=denied';
      const expectNoForgery = (out: string) => {
        const lines = ruleLines(out);
        expect(lines).not.toContain('rule A');
        expect(lines.filter((l) => l.startsWith('rule '))).toEqual(['rule C']);
        expect(lines.some((l) => l.startsWith('predicate'))).toBe(false);
        expect(out).not.toMatch(/[^\x00-\x7f]/);
      };

      it('prints a runner-valid label with a dot, such as C5.retry, as given', () => {
        const rows = consentRows();
        rows[8] = { ...rows[8], label: 'C5.retry' };
        const out = classify([...rows, revoke(9000, 9000)]);
        expectC(out, 'a consent run is labelled C5.retry, not one of C1 to C5');
        expect(out).not.toContain('(unprintable)');
      });

      it('prints a dotted label longer than 16 characters as given', () => {
        const long = 'C5.retry.attempt-2.x';
        const rows = consentRows();
        rows[8] = { ...rows[8], label: long };
        const out = classify([...rows, revoke(9000, 9000)]);
        expectC(out, `a consent run is labelled ${long}, not one of C1 to C5`);
        expect(out).not.toContain('(unprintable)');
      });

      it.each(['rule', 'predicate'])(
        'gives no extra rule or predicate line for a matrix row labelled %s',
        (label) => {
          const matrix = { ...consentRows()[0], kind: 'include', label };
          const out = classify([...consentRows(), revoke(9000, 9000), matrix]);
          const lines = ruleLines(out);
          expect(lines.filter((l) => l.startsWith('rule '))).toEqual(['rule A']);
          expect(lines.some((l) => l.startsWith('predicate'))).toBe(false);
        }
      );

      it.each(['rule', 'predicate'])(
        'gives no extra rule line, and no predicate line outside Rule B, for a consent label %s',
        (label) => {
          const rows = consentRows();
          rows[8] = { ...rows[8], label };
          const out = classify([...rows, revoke(9000, 9000)]);
          const lines = ruleLines(out);
          expect(lines.filter((l) => l.startsWith('rule '))).toEqual(['rule C']);
          expect(lines.some((l) => l.startsWith('predicate'))).toBe(false);
        }
      );

      it.each(['rule', 'predicate'])(
        'gives no extra rule or predicate line for a revoke label %s',
        (label) => {
          const out = classify([...consentRows(), revoke(9000, 9000, { label })]);
          const lines = ruleLines(out);
          expect(lines.filter((l) => l.startsWith('rule '))).toHaveLength(1);
          expect(lines.some((l) => l.startsWith('predicate'))).toBe(false);
        }
      );

      it('starts every row line with "row " and every not-enumerable line with "cell "', () => {
        const rows = consentRows().map((r) =>
          r.label === 'C4'
            ? { ...r, enumerable: false, enumerationFailed: true, counters: counters(2000, 0) }
            : r
        );
        const lines = ruleLines(classify([...rows, revoke(9000, 9000)]));
        expect(lines.some((l) => l.startsWith('row C1\t'))).toBe(true);
        expect(lines.some((l) => l.startsWith('cell C4'))).toBe(true);
      });

      it('does not let a consent label inject a rule or predicate line', () => {
        const rows = consentRows();
        rows[8] = { ...rows[8], label: forged };
        const out = classify([...rows, revoke(9000, 9000)]);
        expectC(out, 'a consent run is labelled (unprintable), not one of C1 to C5');
        expectNoForgery(out);
      });

      it('does not let U+2028 or a carriage return in a label split a line', () => {
        const rows = consentRows();
        rows[8] = { ...rows[8], label: 'x\u2028rule A\rrule A\u2029rule A' };
        const out = classify([...rows, revoke(9000, 9000)]);
        expectNoForgery(out);
      });

      it('does not let a revoke label inject a line', () => {
        const out = classify([...consentRows(), revoke(9000, 9000, { label: forged })]);
        expectC(out, 'a revoke run has a label the runner does not print');
        expectNoForgery(out);
        expect(out).toContain('(unprintable)');
      });

      it('does not let a screen reading inject a line', () => {
        const rows = consentRows();
        rows[4] = { ...rows[4], screen: forged };
        const out = classify([...rows, revoke(9000, 9000)]);
        expectNoForgery(out);
      });

      it('does not let a fault stage inject a line', () => {
        const rows = consentRows();
        rows[4] = { ...rows[4], faultStage: forged };
        const out = classify([...rows, revoke(9000, 9000)]);
        expectNoForgery(out);
      });

      it('prints unrecognised counters on the control line for a string signal count', () => {
        const rows = consentRows();
        rows[0] = { ...rows[0], counters: { ...counters(2000, 2000), signalTotal: forged } };
        const out = classify([...rows, revoke(9000, 9000)]);
        expectNoForgery(out);
        expect(out).toContain('unrecognised counters');
      });

      it('survives a matrix row whose value cannot be stringified', () => {
        const matrix = {
          ...consentRows()[0],
          kind: 'include',
          label: 'include',
          enumerable: { toString: 5 },
        };
        const out = classify([...consentRows(), revoke(9000, 9000), matrix]);
        expect(out).toMatch(/^rule A$/m);
        expect(out).toContain('(unprintable)');
      });
    });
  });

  it('says why a non-enumerable cell is excused', () => {
    const rows = consentRows().map((r) =>
      r.label === 'C4'
        ? { ...r, enumerable: false, enumerationFailed: true, counters: counters(2000, 0) }
        : r
    );
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toContain('C4 is not enumerable (the enumeration failed): reported, not counted');
  });

  it('reads a cell whose runs differ in enumerationFailed as other', () => {
    const rows = consentRows();
    const c2 = rows.findIndex((r) => r.label === 'C2');
    rows[c2] = { ...rows[c2], enumerable: false, enumerationFailed: true };
    rows[c2 + 1] = { ...rows[c2 + 1], enumerable: false, enumerationFailed: false };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toContain('reason C2 is other');
  });

  it('gives Rule C for rows from two OS builds or two Electron versions', () => {
    const rows = consentRows();
    rows[3] = { ...rows[3], osBuild: '26C5' };
    rows[5] = { ...rows[5], electron: '46.0.0' };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason the rows span 2 OS builds');
    expect(out).toContain('reason the rows span 2 Electron versions');
  });

  it('gives Rule C when the consent runs measured different windows', () => {
    const rows = consentRows();
    rows[3] = { ...rows[3], windowId: 8 };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason the consent and revoke runs measured 2 different windows');
  });

  it('gives Rule C when R1 measured another window than the consent runs', () => {
    const out = classify([...consentRows(), revoke(9000, 9000, { windowId: 8 })]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason the consent and revoke runs measured 2 different windows');
  });

  it('gives Rule C when a consent or revoke run has no window id', () => {
    const out = classify([...consentRows(), revoke(9000, 9000, { windowId: undefined })]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason a consent or revoke run has no window id');
  });

  // F21: a consent run whose grant changed during the run measured two states.
  it('gives Rule C when a consent run read a grant change during the run', () => {
    const rows = consentRows();
    const c2 = rows.findIndex((r) => r.label === 'C2');
    rows[c2] = { ...rows[c2], microphoneAfter: 'granted' };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain(
      'reason C2 has a run that read microphone denied before it and granted after it'
    );
  });

  it('gives Rule C when a consent run has no after-reading', () => {
    const rows = consentRows();
    const c2 = rows.findIndex((r) => r.label === 'C2');
    const { screenAfter: _dropped, ...noAfter } = rows[c2];
    rows[c2] = noAfter as (typeof rows)[number];
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason C2 has a run with no valid screen reading after it');
  });

  it('gives Rule C for an invalid after-reading without printing it', () => {
    const rows = consentRows();
    const c3 = rows.findIndex((r) => r.label === 'C3');
    rows[c3] = { ...rows[c3], microphoneAfter: 'bogus' };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason C3 has a run with no valid microphone reading after it');
    expect(out).not.toContain('bogus');
  });

  // The log lines still echo row values; only the reason lines are held to this.
  it('gives Rule C for an invalid start value without printing it in a reason', () => {
    const rows = consentRows();
    const c3 = rows.findIndex((r) => r.label === 'C3');
    rows[c3] = { ...rows[c3], microphone: 'bogus-start' };
    const out = classify([...rows, revoke(9000, 9000)]);
    const reasons = out.split('\n').filter((l) => l.startsWith('reason '));
    expect(out).toMatch(/^rule C$/m);
    expect(reasons).toContain('reason C3 has a run with no valid microphone reading before it');
    expect(reasons.join('\n')).not.toContain('bogus-start');
  });

  it('still prints both valid values when the start and end readings differ', () => {
    const rows = consentRows();
    const c3 = rows.findIndex((r) => r.label === 'C3');
    rows[c3] = { ...rows[c3], microphone: 'denied', microphoneAfter: 'granted' };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain(
      'reason C3 has a run that read microphone denied before it and granted after it'
    );
    expect(out).not.toContain('no valid microphone reading before it');
  });

  it('does not need after-readings on the revoke row for this reason', () => {
    const out = classify([
      ...consentRows(),
      revoke(9000, 9000, { screenAfter: undefined, microphoneAfter: undefined }),
    ]);
    expect(out).not.toContain('reading after it');
  });

  it('gives Rule C when a consent run has no window id', () => {
    const rows = consentRows();
    rows[2] = { ...rows[2], windowId: undefined } as (typeof rows)[number];
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason a consent or revoke run has no window id');
  });

  it('stays Rule A when the after-readings match the start readings', () => {
    const rows = consentRows().map((r) => ({
      ...r,
      screenAfter: r.screen,
      microphoneAfter: r.microphone,
    }));
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule A$/m);
  });

  // F9: one poisoned run, or one failed destroy, stops the rule at C.
  it('gives Rule C when one consent run was poisoned', () => {
    const rows = consentRows();
    rows[4] = { ...rows[4], counters: counters(3000, 3000, { poisoned: true }) };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason C3 is other');
  });

  it('gives Rule C when one consent run had a destroy failure', () => {
    const rows = consentRows();
    rows[4] = { ...rows[4], counters: counters(3000, 3000, { destroyFailures: 1 }) };
    const out = classify([...rows, revoke(9000, 9000)]);
    expect(out).toMatch(/^rule C$/m);
    expect(out).toContain('reason C3 is other');
  });

  // F3: --never-requested defaults to both grants, and '' names none.
  describe('--never-requested', () => {
    const silentC5 = () =>
      consentRows().map((r) => (r.label === 'C5' ? { ...r, counters: counters(3000, 0) } : r));

    it('defaults to both grants, so a silent not-determined cell is Rule C', () => {
      const out = classify([...silentC5(), revoke(9000, 9000)]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).toContain(
        'reason C5 reads not-determined for screen, which the app never requests'
      );
      expect(out).toContain('never requested: screen, microphone');
    });

    it("an explicit '' names none, so the same rows are Rule B", () => {
      const out = classify([...silentC5(), revoke(9000, 9000)], ['--never-requested', '']);
      expect(out).toMatch(/^rule B$/m);
      expect(out).toContain('predicate screen=not-determined microphone=not-determined');
      expect(out).toContain('never requested: none');
    });
  });

  // Codex P2: an unreadable grant fails closed, even though unknown is a known value.
  describe('C5 unknown grant readings', () => {
    const unknownC5 = (
      over: Record<string, unknown> = {},
      counts: [number, number] = [3000, 3000]
    ) =>
      consentRows().map((r) =>
        r.label === 'C5'
          ? {
              ...r,
              screen: 'unknown',
              microphone: 'unknown',
              screenAfter: 'unknown',
              microphoneAfter: 'unknown',
              counters: counters(counts[0], counts[1]),
              ...over,
            }
          : r
      );

    it('gives Rule C, not Rule A, when both C5 runs read unknown before and after', () => {
      const out = classify([...unknownC5(), revoke(9000, 9000)]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).not.toMatch(/^rule A$/m);
      expect(out).toContain('C5 has a run that read');
      expect(out).toContain('an unreadable grant cannot decide the rule');
    });

    it('does not give Rule B with an unknown predicate for a silent enumerable C5', () => {
      const out = classify(
        [...unknownC5({}, [3000, 0]), revoke(9000, 9000)],
        ['--never-requested', '']
      );
      expect(out).toMatch(/^rule C$/m);
      expect(out).not.toMatch(/^rule B$/m);
      expect(out).not.toContain('predicate screen=unknown');
    });

    it('gives Rule C for an excused silent C5 that reads unknown', () => {
      const out = classify([
        ...unknownC5({ enumerable: false, enumerationFailed: true }, [2000, 0]),
        revoke(9000, 9000),
      ]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).not.toMatch(/^rule A$/m);
      expect(out).toContain('C5 has a run that read');
    });

    const c6Runs = (screen: string, microphone: string) =>
      [3000, 3001].map((cb) => ({
        ...consentRows()[0],
        runId: `00000000-0000-4000-8000-${String(cb).padStart(12, '0')}`,
        label: 'C6',
        screen,
        microphone,
        screenAfter: screen,
        microphoneAfter: microphone,
        counters: counters(cb, 0),
      }));

    it('gives Rule C, not Rule B, for a silent extra-labelled cell that reads unknown', () => {
      const out = classify([...consentRows(), ...c6Runs('unknown', 'unknown'), revoke(9000, 9000)]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).not.toMatch(/^rule B$/m);
      expect(out).not.toContain('predicate screen=unknown');
      expect(out).toContain('reason a consent run is labelled C6, not one of C1 to C5');
      expect(out).not.toContain('run id the runner does not print');
    });

    it('gives Rule C with the label reason for an extra-labelled cell with known readings', () => {
      const out = classify([
        ...consentRows(),
        ...c6Runs('restricted', 'denied'),
        revoke(9000, 9000),
      ]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).not.toMatch(/^rule B$/m);
      expect(out).toContain('a consent run is labelled C6, not one of C1 to C5');
      expect(out).not.toContain('run id the runner does not print');
    });

    it('gives Rule C when one C5 run reads microphone unknown after only', () => {
      const rows = consentRows();
      rows[8] = { ...rows[8], microphoneAfter: 'unknown' };
      const out = classify([...rows, revoke(9000, 9000)]);
      expect(out).toMatch(/^rule C$/m);
      expect(out).toContain('C5 has a run that read microphone unknown');
    });
  });

  // Argument and input errors all exit 2 with a FAIL line on stderr.
  describe('argument and input errors', () => {
    it('exits 2 for a flag with no value', () => {
      const run = runCli('', ['--never-requested']);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('FAIL --never-requested needs a value');
    });

    it('exits 2 for an unknown grant', () => {
      const run = runCli('', ['--never-requested', 'camera']);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('FAIL --never-requested takes screen and/or microphone');
    });

    it('exits 2 for a rows line that is not JSON', () => {
      const run = runCli('ROW {not json\n');
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('FAIL line 1 is not JSON');
    });

    it('exits 2 for an unreadable rows file', () => {
      const cli = path.join(path.dirname(new URL(import.meta.url).pathname), 'classify.mjs');
      const run = spawnSync(process.execPath, [cli, '/nonexistent/rows.jsonl'], {
        encoding: 'utf8',
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('FAIL cannot read the rows file');
    });

    it('exits 2 for extra positional arguments', () => {
      const run = runCli('', ['extra']);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('FAIL usage');
    });

    it('exits 2 for a rows line with an unknown kind', () => {
      const run = runCli(`ROW ${JSON.stringify({ kind: 'bogus', runId: 'x' })}\n`);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('FAIL line 1 has an unknown kind');
    });
  });
});
