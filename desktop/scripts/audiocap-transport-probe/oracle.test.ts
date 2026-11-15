// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS,
  FRAMES,
  RIGHT_LEAD,
  TABLE_LEN,
  calibrate,
  checkQuantum,
  judgeStall,
  missingQuanta,
  parseTable,
  percentiles,
} from './oracle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const headerPath = path.resolve(here, '../../native/concord-audiocap/rt/synthetic_source.h');
const headerText = readFileSync(headerPath, 'utf8');
const table = parseTable(headerText);

function buildQuantum(phase: number): Uint32Array {
  const bits = new Uint32Array(FRAMES * CHANNELS);
  for (let i = 0; i < FRAMES; i++) {
    bits[2 * i] = table[(phase + i) % TABLE_LEN];
    bits[2 * i + 1] = table[(phase + i + RIGHT_LEAD) % TABLE_LEN];
  }
  return bits;
}

describe('parseTable', () => {
  it('returns the 47 distinct waveform patterns from the real header', () => {
    expect(table).toHaveLength(47);
    expect(new Set(table).size).toBe(47);
    expect(table[0]).toBe(0x00000000);
    expect(table[1]).toBe(0x3d087c60);
  });

  it('throws when the table has 46 entries', () => {
    const entries = Array.from(table.slice(0, 46), (v) => `0x${v.toString(16).padStart(8, '0')}u`);
    const text = `static constexpr u32 kTable[kTableLen] = { ${entries.join(', ')} };`;
    expect(() => parseTable(text)).toThrow();
  });

  it('throws when the table has 48 entries', () => {
    const entries = Array.from(
      [...table, table[0]],
      (v) => `0x${v.toString(16).padStart(8, '0')}u`
    );
    const text = `static constexpr u32 kTable[kTableLen] = { ${entries.join(', ')} };`;
    expect(() => parseTable(text)).toThrow(/expected 47 table entries, found 48/);
  });

  it('throws when the header has no kTable declaration', () => {
    expect(() => parseTable('static constexpr u32 kTableLen = 47u;')).toThrow(
      /kTable declaration not found/
    );
  });

  // The oracle restates the header's table length and right-channel lead; the
  // quanta below are built from the oracle's copy, so only this ties it to the header.
  it("matches the header's table length and right-channel lead", () => {
    expect(Number(/kTableLen = (\d+)u;/.exec(headerText)?.[1])).toBe(TABLE_LEN);
    expect(Number(/kRightPhaseOffset = (\d+)u;/.exec(headerText)?.[1])).toBe(RIGHT_LEAD);
  });
});

describe('checkQuantum', () => {
  it.each([0, 46])('accepts a valid quantum at phase %i', (phase) => {
    expect(checkQuantum(buildQuantum(phase), table)).toEqual({ ok: true, phase });
  });

  it('rejects a flipped bit and points at the corrupted sample', () => {
    const bits = buildQuantum(5);
    bits[101] = (bits[101] ^ 1) >>> 0;
    const result = checkQuantum(bits, table);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['not-in-table', 'mismatch']).toContain(result.reason);
      expect(result.index).toBe(101);
    }
  });

  it('rejects a wrong left sample mid-quantum that is still a table entry', () => {
    const bits = buildQuantum(5);
    // Frame 100's left sample, replaced by frame 101's: in the table, but wrong here.
    bits[200] = table[(5 + 101) % TABLE_LEN];
    expect(checkQuantum(bits, table)).toEqual({ ok: false, reason: 'mismatch', index: 200 });
  });

  it('rejects left and right channels swapped in every frame', () => {
    const bits = buildQuantum(3);
    for (let i = 0; i < FRAMES; i++) {
      const left = bits[2 * i];
      bits[2 * i] = bits[2 * i + 1];
      bits[2 * i + 1] = left;
    }
    expect(checkQuantum(bits, table).ok).toBe(false);
  });

  it('rejects a buffer shifted by one sample', () => {
    const src = buildQuantum(7);
    const shifted = new Uint32Array(src.length);
    shifted.set(src.subarray(1), 0);
    shifted[src.length - 1] = src[0];
    expect(checkQuantum(shifted, table).ok).toBe(false);
  });

  it('reports length for a 958-sample buffer', () => {
    const result = checkQuantum(new Uint32Array(958), table);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('length');
  });

  it('reports not-in-table when the first left sample is foreign', () => {
    const bits = buildQuantum(0);
    bits[0] = 0xdeadbeef;
    const result = checkQuantum(bits, table);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-in-table');
  });
});

describe('missingQuanta', () => {
  it('is 0 for consecutive delivery at every phase', () => {
    for (let p = 0; p < 47; p++) expect(missingQuanta(p, (p + 10) % 47)).toBe(0);
  });

  it.each([0, 31])('recovers k missing quanta from phase %i', (p) => {
    for (let k = 1; k <= 46; k++) expect(missingQuanta(p, (p + 10 * (k + 1)) % 47)).toBe(k);
  });

  it('reads a duplicated quantum as 46 missing', () => {
    for (const p of [0, 12, 46]) expect(missingQuanta(p, p)).toBe(46);
  });

  it('flags a reordered pair at every step around the swap', () => {
    for (const p of [0, 12, 46]) {
      const at = (i: number) => (p + 10 * i) % 47;
      // Delivered 0, 2, 1, 3 instead of 0, 1, 2, 3.
      expect(missingQuanta(at(0), at(2))).toBe(1);
      expect(missingQuanta(at(2), at(1))).toBe(45);
      expect(missingQuanta(at(1), at(3))).toBe(1);
    }
  });
});

describe('percentiles', () => {
  it('computes nearest-rank percentiles for 1..100', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentiles(values)).toEqual({ n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('throws on empty input', () => {
    expect(() => percentiles([])).toThrow();
  });
});

describe('calibrate', () => {
  it('keeps the shortest round trip and reports half of it as uncertainty', () => {
    const base = 1_000_000_000n;
    const result = calibrate([
      { t0Ns: base, perfMs: 7000, t1Ns: base + 400_000n },
      { t0Ns: base, perfMs: 5000.25, t1Ns: base + 100_000n },
      { t0Ns: base, perfMs: 6000, t1Ns: base + 250_000n },
    ]);
    // midpoint of the 100000 ns sample is 1000.05 ms
    expect(result.offsetMs).toBeCloseTo(5000.25 - 1000.05, 6);
    expect(result.uncertaintyMs).toBeCloseTo(0.05, 9);
  });
});

describe('judgeStall', () => {
  it('accepts an equal, non-zero drop on a real stall', () => {
    expect(judgeStall({ content: 14, seqGaps: 14, overrun: 14, control: false }).ok).toBe(true);
  });

  it('rejects a real stall with no drop and says at least one is required', () => {
    const verdict = judgeStall({ content: 0, seqGaps: 0, overrun: 0, control: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/at least (1|one)/i);
  });

  it('accepts a clean control stall', () => {
    expect(judgeStall({ content: 0, seqGaps: 0, overrun: 0, control: true }).ok).toBe(true);
  });

  it.each([
    { content: 1, seqGaps: 0, overrun: 0 },
    { content: 0, seqGaps: 1, overrun: 0 },
    { content: 0, seqGaps: 0, overrun: 1 },
  ])('rejects a control stall that dropped anything: %o', (counts) => {
    expect(judgeStall({ ...counts, control: true }).ok).toBe(false);
  });

  it.each([
    { content: 14, seqGaps: 14, overrun: 13 },
    { content: 13, seqGaps: 14, overrun: 14 },
    // A duplicated quantum inside the stall reads as 46 more missing by content.
    { content: 60, seqGaps: 14, overrun: 14 },
  ])('rejects a real stall whose counters disagree: %o', (counts) => {
    const verdict = judgeStall({ ...counts, control: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/disagree/);
  });
});
