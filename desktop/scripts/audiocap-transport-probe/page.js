// Renderer half of the audiocap transport probe. Loaded as a module script by the
// probe page; the production preload and the production bridge bundle do the work,
// and this file only watches what the bridge hands to the generator.
//
// ORDER IS THE DESIGN. The waveform table is fetched first, the write hook is
// installed second, and only then is the bridge bundle loaded, so no quantum can
// reach a writer before the hook exists. Main waits on `window.__probeReady`
// before it starts the host, so the bridge's module-scope handoff listener is
// also in place before the relay posts the port.
//
// `?mode=heap` is the heap pass's page: no oracle hook and no track processor, only
// a write counter that allocates nothing, so the heap being sampled holds the
// bridge's own allocations and nothing of the probe's.
//
// Every catch reports through `console.log('FAIL <class>: ...')`, except the
// reader's cancel, which settles after the record is taken and so logs a `NOTE `
// line, never a verdict; main forwards page console lines starting with `FAIL `
// or `NOTE ` to its own stdout.
import { CHANNELS, FRAMES, checkQuantum, missingQuanta } from '/oracle.mjs';

const SAMPLES = FRAMES * CHANNELS;
// A processor frame pairs with its write only when their timestamps are this
// close. The processor's timestamps are re-stamped by the engine, not passed
// through: offsets of -132 to +160 us from E0 were seen across runs. 1 ms is about
// 6x the largest offset seen and under half the smallest E0 spacing seen (7.35 ms).
// ponytail: a fixed tolerance, not one derived from the run; its ceiling is an E0
// spacing under 2 ms, where one frame could sit within tolerance of two writes
// (the phase check below would then void the pass rather than mis-pair it).
const TOL_US = 1000;
const params = new URL(globalThis.location.href).searchParams;
const inject = params.get('inject');
const mode = params.get('mode');

let table = null;
let bridge = null;
let shape = null;
let checked = 0;
let bad = 0;
let firstBad = null;
let contentMissing = 0;
let lastWriteMs = null;
let prevPhase = null;
// Set at the end of each stall(): `checked` at that moment, and the `checked`
// count of the first quantum after it whose phase shows a gap.
let stallEnd = null;
let firstGapAt = null;

// Preallocated once: the hook copies into this on every quantum, so the probe
// adds no per-quantum allocation of its own to the page it is watching.
const copy = new Float32Array(SAMPLES);
const bits = new Uint32Array(copy.buffer);

// Latency pass (measure mode). The arrays are allocated once by startProcessor,
// indexed by the write's position in the window: E0 (AudioData.timestamp, us),
// E1 (hook entry), the hook's own cost (the stamp just before the original write,
// minus E1), the oracle's phase for the quantum (-1 when it checked bad), E2 (the
// paired processor frame) and that frame's timestamp minus E0 (us). `paired` is
// the next write still waiting for its frame.
let lat = null;
let recording = false;
let draining = false;
let written = 0;
let paired = 0;
let outsideWindow = 0;
let mismatches = 0;
let firstMismatch = null;
let overflow = 0;
let reader = null;
let processorError = null;
let visibilityChanges = 0;
// The read-back content check over the paired frames: bit-exact with the phase
// the hook saw for that write (matched), not bit-exact (unreadable), or bit-exact
// with another quantum's phase (phaseMismatch).
// `format` is the first paired frame's AudioData.format.
const content = { format: null, matched: 0, unreadable: 0, phaseMismatch: 0, first: null };
// Preallocated once: each paired frame's samples are copied here, interleaved,
// for the same oracle the hook runs. A planar frame lands in the plane buffers.
const readBits = new Uint32Array(SAMPLES);
const planeBits = [new Uint32Array(FRAMES), new Uint32Array(FRAMES)];
// Diagnostic for a void report: the first frames' timestamps as the engine hands them back.
const HEAD = 20;
const headTs = new Float64Array(HEAD);
let headN = 0;

// Heap pass (`?mode=heap`).
let audioContext = null;
let analyser = null;
let analyserBuf = null;
let writes = 0;

function errorText(err) {
  return err && typeof err.message === 'string' ? err.message : String(err);
}

function noteBad(reason, detail) {
  bad += 1;
  prevPhase = null;
  if (firstBad === null) firstBad = { quantum: checked, reason, ...detail };
}

/** Check one quantum; returns its phase, or -1 when it checked bad. */
function inspect(audioData) {
  checked += 1;
  lastWriteMs = performance.now();
  const seen = {
    format: audioData.format,
    numberOfFrames: audioData.numberOfFrames,
    numberOfChannels: audioData.numberOfChannels,
    sampleRate: audioData.sampleRate,
    allocationSize: audioData.allocationSize({ planeIndex: 0 }),
  };
  if (shape === null) shape = seen;
  // Trust the copy only for the one shape the oracle describes: interleaved f32,
  // 480 frames of 2 channels, all in plane 0.
  if (
    seen.format !== 'f32' ||
    seen.numberOfFrames !== FRAMES ||
    seen.numberOfChannels !== CHANNELS ||
    seen.allocationSize !== copy.byteLength
  ) {
    noteBad('shape', { seen });
    return -1;
  }
  audioData.copyTo(copy, { planeIndex: 0 });
  if (inject === 'bitflip') bits[SAMPLES >> 1] ^= 1;
  const verdict = checkQuantum(bits, table);
  if (!verdict.ok) {
    noteBad(verdict.reason, { index: verdict.index });
    return -1;
  }
  if (prevPhase !== null) {
    const missing = missingQuanta(prevPhase, verdict.phase);
    contentMissing += missing;
    if (missing > 0 && stallEnd !== null && firstGapAt === null) firstGapAt = checked;
  }
  prevPhase = verdict.phase;
  return verdict.phase;
}

function noteWrite(timestampUs, entryMs, phase) {
  if (written >= lat.cap) {
    overflow += 1;
    return;
  }
  lat.e0[written] = timestampUs;
  lat.e1[written] = entryMs;
  lat.phase[written] = phase;
  lat.overhead[written] = performance.now() - entryMs;
  written += 1;
}

function installHook() {
  const originalWrite = WritableStreamDefaultWriter.prototype.write;
  // Synchronous, and the same AudioData goes on to the original write: the bridge
  // writes without awaiting and hands the AudioData's ownership to the generator,
  // so the hook must neither await, close nor transfer it.
  WritableStreamDefaultWriter.prototype.write = function probeWrite(chunk) {
    if (typeof AudioData === 'function' && chunk instanceof AudioData) {
      // E1, before the oracle check.
      const entryMs = recording ? performance.now() : 0;
      let phase = -1;
      try {
        phase = inspect(chunk);
      } catch (err) {
        noteBad('hook-threw', { message: errorText(err) });
        // eslint-disable-next-line no-console -- main forwards FAIL lines to the probe's stdout
        console.log(`FAIL hook: ${errorText(err)}`);
      }
      if (recording) noteWrite(chunk.timestamp, entryMs, phase);
    }
    return originalWrite.call(this, chunk);
  };
}

// Heap page only: the heap pass's delivery witness. It allocates nothing of its own,
// but it is a frame on every write's stack, so the sampler may attribute the write's
// own allocations to it rather than to the bridge.
function installCounter() {
  const originalWrite = WritableStreamDefaultWriter.prototype.write;
  WritableStreamDefaultWriter.prototype.write = function countWrite(chunk) {
    writes += 1;
    return originalWrite.call(this, chunk);
  };
}

/**
 * A read-back frame's samples, copied bit for bit into `readBits` in the hook's
 * interleaved layout, then checked by the same oracle.
 */
function readBack(frame) {
  if (frame.numberOfChannels !== CHANNELS) {
    return { ok: false, reason: `numberOfChannels ${frame.numberOfChannels}`, index: null };
  }
  if (frame.format === 'f32') {
    const size = frame.allocationSize({ planeIndex: 0 });
    if (size !== readBits.byteLength) {
      return { ok: false, reason: `allocationSize ${size}`, index: null };
    }
    frame.copyTo(readBits, { planeIndex: 0 });
  } else if (frame.format === 'f32-planar') {
    frame.copyTo(planeBits[0], { planeIndex: 0 });
    frame.copyTo(planeBits[1], { planeIndex: 1 });
    // Through Uint32 views, so no sample passes through a float register.
    for (let i = 0; i < FRAMES; i++) {
      readBits[2 * i] = planeBits[0][i];
      readBits[2 * i + 1] = planeBits[1][i];
    }
  } else {
    return { ok: false, reason: `format ${frame.format}`, index: null };
  }
  return checkQuantum(readBits, table);
}

/** The content check for the frame just paired with write `paired`. */
function noteContent(frame) {
  if (content.format === null) content.format = frame.format;
  const verdict = readBack(frame);
  if (verdict.ok && verdict.phase === lat.phase[paired]) {
    content.matched += 1;
    return;
  }
  let failure;
  if (verdict.ok) {
    content.phaseMismatch += 1;
    failure = { reason: 'phase', index: null, phase: verdict.phase, hookPhase: lat.phase[paired] };
  } else {
    content.unreadable += 1;
    failure = { reason: verdict.reason, index: verdict.index };
  }
  if (content.first === null) content.first = { at: paired, format: frame.format, ...failure };
}

// E2. Pairs each frame with the next unpaired write: in sequence order, and only
// when its timestamp is within TOL_US of that write's E0, so a frame the track
// lost or reordered shows as a mismatch rather than shifting the pairing. The
// paired frame's samples must then carry the phase the hook saw for that write.
// ponytail: assumes the processor hands back one 480-sample frame per quantum, so
// the 480-sample boundary is the frame's arrival; a rebuffering engine voids the
// pass (counted as a mismatch) instead of being re-paired by sample offsets.
function noteFrame(frame, nowMs) {
  if (!recording && !draining) return;
  const ts = frame.timestamp;
  if (paired === 0 && (written === 0 || ts < lat.e0[0] - TOL_US)) {
    outsideWindow += 1;
    return;
  }
  if (paired >= written && ts > lat.e0[written - 1] + TOL_US) {
    outsideWindow += 1;
    return;
  }
  if (headN < HEAD) {
    headTs[headN] = ts;
    headN += 1;
  }
  const offsetUs = ts - lat.e0[paired];
  if (paired >= written || frame.numberOfFrames !== FRAMES || Math.abs(offsetUs) > TOL_US) {
    mismatches += 1;
    if (firstMismatch === null) {
      firstMismatch = {
        at: paired,
        written,
        expected: lat.e0[paired],
        seen: ts,
        offsetUs,
        next: lat.e0[paired + 1],
        numberOfFrames: frame.numberOfFrames,
      };
    }
    return;
  }
  lat.e2[paired] = nowMs;
  lat.offset[paired] = offsetUs;
  noteContent(frame);
  paired += 1;
}

async function readFrames() {
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) return;
    const nowMs = performance.now();
    try {
      noteFrame(frame, nowMs);
    } finally {
      frame.close();
    }
  }
}

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}

async function prepare() {
  if (typeof AudioData !== 'function') throw new TypeError('AudioData is not available');
  if (typeof MediaStreamTrackGenerator !== 'function') {
    throw new TypeError('MediaStreamTrackGenerator is not available');
  }
  const response = await fetch('/table.json');
  if (!response.ok) throw new Error(`table.json answered ${response.status}`);
  table = Uint32Array.from(await response.json());
  if (mode === 'heap') installCounter();
  else installHook();
  await loadClassicScript('/bridge.js');
  if (typeof globalThis.__bridge?.createScreenAudioBridge !== 'function') {
    throw new TypeError('the bridge bundle did not define createScreenAudioBridge');
  }
  return 'ready';
}

// A measured window must stay visible throughout, not only at its two ends.
document.addEventListener('visibilitychange', () => {
  if (recording) visibilityChanges += 1;
});

function windowSnapshot() {
  return {
    counts: { checked, bad, contentMissing },
    stats: bridge === null ? null : bridge.stats(),
    visibility: document.visibilityState,
  };
}

globalThis.__probe = {
  createBridge(generation) {
    bridge = globalThis.__bridge.createScreenAudioBridge(generation);
    return bridge.generation;
  },
  counts() {
    return { checked, bad, firstBad, contentMissing, lastWriteMs, stallEnd, firstGapAt };
  },
  stats() {
    return bridge === null ? null : bridge.stats();
  },
  shape() {
    return shape;
  },
  // Busy-waits on this thread, so the bridge's port handler cannot run meanwhile.
  // `--inject=nostall` returns at once, so the slow-consumer pass sees no drop and
  // must fail: the proof that it can.
  stall(ms) {
    let spins = 0;
    if (inject !== 'nostall') {
      const end = performance.now() + ms;
      while (performance.now() < end) spins += 1;
    }
    stallEnd = checked;
    firstGapAt = null;
    return spins;
  },
  // Smallest non-zero step between consecutive performance.now() readings.
  timerResolution() {
    let prev = performance.now();
    let smallest = Infinity;
    for (let i = 0; i < 2000; i++) {
      const now = performance.now();
      if (now - prev > 0 && now - prev < smallest) smallest = now - prev;
      prev = now;
    }
    return Number.isFinite(smallest) ? smallest : null;
  },
  startProcessor(cap) {
    if (typeof MediaStreamTrackProcessor !== 'function') {
      return 'MediaStreamTrackProcessor is not available';
    }
    lat = {
      cap,
      e0: new Float64Array(cap),
      e1: new Float64Array(cap),
      overhead: new Float64Array(cap),
      phase: new Int8Array(cap),
      e2: new Float64Array(cap),
      offset: new Float64Array(cap),
    };
    reader = new MediaStreamTrackProcessor({ track: bridge.track }).readable.getReader();
    readFrames().catch((err) => {
      processorError = errorText(err);
      // eslint-disable-next-line no-console -- main forwards FAIL lines to the probe's stdout
      console.log(`FAIL processor: ${processorError}`);
    });
    return 'started';
  },
  beginWindow() {
    visibilityChanges = 0;
    recording = true;
    return windowSnapshot();
  },
  endWindow() {
    recording = false;
    draining = true;
    return windowSnapshot();
  },
  // Called after the drain, so `drainedStats` covers every quantum the window wrote.
  latencyRecord() {
    draining = false;
    const out = {
      toleranceUs: TOL_US,
      written,
      paired,
      outsideWindow,
      mismatches,
      firstMismatch,
      overflow,
      processorError,
      visibilityChanges,
      content,
      drainedStats: bridge.stats(),
      headTs: Array.from(headTs.subarray(0, headN)),
      e0: Array.from(lat.e0.subarray(0, written)),
      e1: Array.from(lat.e1.subarray(0, written)),
      overhead: Array.from(lat.overhead.subarray(0, written)),
      e2: Array.from(lat.e2.subarray(0, written)),
      offset: Array.from(lat.offset.subarray(0, paired)),
    };
    // After the record is taken, so a rejection here changes no verdict: a NOTE, not a FAIL.
    reader.cancel().catch((err) => {
      // eslint-disable-next-line no-console -- main forwards NOTE lines to the probe's stdout
      console.log(`NOTE processor: cancel rejected after the record: ${errorText(err)}`);
    });
    return out;
  },
  // Heap page only: track -> source -> analyser -> gain 0 -> destination. The
  // analyser is the flow witness, read before and after the window only.
  async startHeapGraph() {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(new MediaStream([bridge.track]));
    analyser = audioContext.createAnalyser();
    analyserBuf = new Float32Array(analyser.fftSize);
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    source.connect(analyser).connect(gain).connect(audioContext.destination);
    if (audioContext.state !== 'running') await audioContext.resume();
    return audioContext.state;
  },
  heapState() {
    analyser.getFloatTimeDomainData(analyserBuf);
    let peak = 0;
    for (const v of analyserBuf) if (Math.abs(v) > peak) peak = Math.abs(v);
    return { audioState: audioContext.state, peak, writes, ...windowSnapshot() };
  },
};

globalThis.__probeReady = prepare().catch((err) => {
  // eslint-disable-next-line no-console -- main forwards FAIL lines to the probe's stdout
  console.log(`FAIL page: ${errorText(err)}`);
  throw err;
});
