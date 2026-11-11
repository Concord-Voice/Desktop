// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyRule,
  classifyConsent,
  classifyMatrix,
  classifyRevoke,
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

  it('reads a missing faulted field as faulted, so the run is a fault', () => {
    const read = parseLiveness(LIVENESS_BLOCK.replace('  faulted: false,\n', ''));
    expect(read?.faulted).toBe(true);
    expect(classifyConsent(read, null, 1.0)).toBe('fault');
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
  it('classifyConsent of null counters is fault', () => {
    expect(classifyConsent(null, null, 1.0)).toBe('fault');
  });

  it('is fault when a fault stage is set', () => {
    expect(classifyConsent(counters(2000, 2000), 'target', 1.0)).toBe('fault');
  });

  it('is fault when the counters say faulted', () => {
    expect(classifyConsent(counters(2000, 2000, { faulted: true }), null, 1.0)).toBe('fault');
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

  it('between 0.5 and 0.8 of control is other', () => {
    expect(classifyRevoke(counters(2000, 1300), null, control, 10, 10)).toBe('other');
  });

  it('fewer than half the expected callbacks is stopped', () => {
    expect(classifyRevoke(counters(500, 500), null, control, 10, 10)).toBe('stopped');
  });

  it('a fault stage is fault', () => {
    expect(classifyRevoke(counters(2000, 2000), 'run', control, 10, 10)).toBe('fault');
  });
});

describe('applyRule', () => {
  const cell = (
    id: string,
    screen: string,
    microphone: string,
    runs: string[],
    enumerable = true
  ) => ({ id, screen, microphone, enumerable, runs });

  const carryingCells = () => [
    cell('C1', 'granted', 'granted', ['carries', 'carries']),
    cell('C2', 'granted', 'denied', ['carries', 'carries']),
    cell('C3', 'denied', 'granted', ['carries', 'carries']),
    cell('C4', 'denied', 'denied', ['carries', 'carries']),
  ];

  it('is Rule A when C1 to C4 all carry', () => {
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

  it('an unknown reading is a distinct pair, never held', () => {
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
