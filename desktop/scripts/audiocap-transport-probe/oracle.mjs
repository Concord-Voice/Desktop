// Pure maths for the audiocap transport probe: the corruption oracle for the
// synthetic waveform, and the statistics the measurement passes report.
//
// No imports, on purpose. Electron main loads this with a dynamic import and the
// probe page loads it as a module script, so it must run unchanged in both.

export const FRAMES = 480;
export const CHANNELS = 2;
export const TABLE_LEN = 47;
export const RIGHT_LEAD = 12;
// Each quantum advances the waveform phase by FRAMES mod TABLE_LEN.
export const PHASE_STEP = FRAMES % TABLE_LEN; // 10
// 10 * 33 = 330 = 7 * 47 + 1, so multiplying by 33 undoes a step of 10 (mod 47).
export const PHASE_STEP_INVERSE = 33;

const mod = (n, m) => ((n % m) + m) % m;

/**
 * The 47 IEEE-754 binary32 bit patterns of `kTable` in rt/synthetic_source.h.
 * Read from the header rather than restated here: a copy would test the copy.
 */
export function parseTable(headerText) {
  const body = /kTable\[kTableLen\]\s*=\s*\{([^}]*)\}/.exec(headerText);
  if (!body) throw new Error('kTable declaration not found in the header');
  const literals = body[1].match(/0x[0-9a-fA-F]{8}u/g) ?? [];
  if (literals.length !== TABLE_LEN) {
    throw new Error(`expected ${TABLE_LEN} table entries, found ${literals.length}`);
  }
  return Uint32Array.from(literals, (s) => Number.parseInt(s.slice(2, 10), 16));
}

/**
 * Bit-exact check of one quantum.
 *
 * `bits` is the 960 interleaved samples (L, R, L, R ...) viewed as Uint32.
 * The phase is read from the first left sample; every other sample must then be
 * exactly the table entry the waveform puts there. `index` is the interleaved
 * sample index of the first failure.
 */
export function checkQuantum(bits, table) {
  if (bits.length !== FRAMES * CHANNELS) {
    return { ok: false, reason: 'length', index: bits.length };
  }
  const phase = table.indexOf(bits[0]);
  if (phase < 0) return { ok: false, reason: 'not-in-table', index: 0 };
  for (let i = 0; i < FRAMES; i++) {
    if (bits[2 * i] !== table[(phase + i) % TABLE_LEN]) {
      return { ok: false, reason: 'mismatch', index: 2 * i };
    }
    if (bits[2 * i + 1] !== table[(phase + i + RIGHT_LEAD) % TABLE_LEN]) {
      return { ok: false, reason: 'mismatch', index: 2 * i + 1 };
    }
  }
  return { ok: true, phase };
}

/**
 * Quanta missing between two consecutively delivered quanta, from their phases.
 * Unambiguous only while fewer than 47 are missing; a duplicate reads as 46.
 */
export function missingQuanta(prevPhase, phase) {
  return mod(PHASE_STEP_INVERSE * mod(phase - prevPhase - PHASE_STEP, TABLE_LEN), TABLE_LEN);
}

/** Nearest-rank percentiles. */
export function percentiles(values) {
  if (values.length === 0) throw new Error('percentiles of an empty set');
  const sorted = Array.from(values).sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];
  return {
    n: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Offset between the renderer's `performance.now()` and the monotonic clock main
 * reads with `process.hrtime.bigint()`.
 *
 * Each sample brackets one renderer reading with two main readings. The sample
 * with the shortest round trip is kept: the renderer reading lies somewhere
 * inside that bracket, so half its width is the uncertainty.
 */
export function calibrate(samples) {
  if (samples.length === 0) throw new Error('no calibration samples');
  let best = samples[0];
  for (const s of samples) {
    if (s.t1Ns - s.t0Ns < best.t1Ns - best.t0Ns) best = s;
  }
  const halfRoundTripMs = Number(best.t1Ns - best.t0Ns) / 2e6;
  // ponytail: Number() of a nanosecond uptime loses sub-microsecond precision
  // after about 100 days of uptime; the figures reported are in milliseconds.
  const midpointMs = Number(best.t0Ns) / 1e6 + halfRoundTripMs;
  return { offsetMs: best.perfMs - midpointMs, uncertaintyMs: halfRoundTripMs };
}

/**
 * One stall's verdict from its three independent drop witnesses.
 *
 * A real stall must show at least one drop: three zeros would mean the ring
 * never overflowed, which is "nothing crashed", not "drops cleanly".
 */
export function judgeStall({ content, seqGaps, overrun, control }) {
  const seen = `content ${content}, seqGaps ${seqGaps}, overrun ${overrun}`;
  if (control) {
    return content === 0 && seqGaps === 0 && overrun === 0
      ? { ok: true }
      : { ok: false, reason: `the control stall dropped quanta (${seen})` };
  }
  if (content !== seqGaps || seqGaps !== overrun) {
    return { ok: false, reason: `the drop witnesses disagree (${seen})` };
  }
  if (overrun < 1) {
    return {
      ok: false,
      reason: 'a real stall must drop at least 1 quantum; the ring never overflowed',
    };
  }
  return { ok: true };
}
