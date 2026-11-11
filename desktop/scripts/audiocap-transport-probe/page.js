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
// Every catch reports through `console.log('FAIL <class>: ...')`; main forwards
// page console lines starting with `FAIL ` to its own stdout.
import { CHANNELS, FRAMES, checkQuantum, missingQuanta } from '/oracle.mjs';

const SAMPLES = FRAMES * CHANNELS;
const inject = new URL(globalThis.location.href).searchParams.get('inject');

let table = null;
let bridge = null;
let shape = null;
let checked = 0;
let bad = 0;
let firstBad = null;
let contentMissing = 0;
let lastWriteMs = null;
let prevPhase = null;

// Preallocated once: the hook copies into this on every quantum, so the probe
// adds no per-quantum allocation of its own to the page it is watching.
const copy = new Float32Array(SAMPLES);
const bits = new Uint32Array(copy.buffer);

function errorText(err) {
  return err && typeof err.message === 'string' ? err.message : String(err);
}

function noteBad(reason, detail) {
  bad += 1;
  prevPhase = null;
  if (firstBad === null) firstBad = { quantum: checked, reason, ...detail };
}

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
    return;
  }
  audioData.copyTo(copy, { planeIndex: 0 });
  if (inject === 'bitflip') bits[SAMPLES >> 1] ^= 1;
  const verdict = checkQuantum(bits, table);
  if (!verdict.ok) {
    noteBad(verdict.reason, { index: verdict.index });
    return;
  }
  if (prevPhase !== null) contentMissing += missingQuanta(prevPhase, verdict.phase);
  prevPhase = verdict.phase;
}

function installHook() {
  const originalWrite = WritableStreamDefaultWriter.prototype.write;
  // Synchronous, and the same AudioData goes on to the original write: the bridge
  // writes without awaiting and hands the AudioData's ownership to the generator,
  // so the hook must neither await, close nor transfer it.
  WritableStreamDefaultWriter.prototype.write = function probeWrite(chunk) {
    if (typeof AudioData === 'function' && chunk instanceof AudioData) {
      try {
        inspect(chunk);
      } catch (err) {
        noteBad('hook-threw', { message: errorText(err) });
        // eslint-disable-next-line no-console -- main forwards FAIL lines to the probe's stdout
        console.log(`FAIL hook: ${errorText(err)}`);
      }
    }
    return originalWrite.call(this, chunk);
  };
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
  installHook();
  await loadClassicScript('/bridge.js');
  if (typeof globalThis.__bridge?.createScreenAudioBridge !== 'function') {
    throw new TypeError('the bridge bundle did not define createScreenAudioBridge');
  }
  return 'ready';
}

globalThis.__probe = {
  createBridge(generation) {
    bridge = globalThis.__bridge.createScreenAudioBridge(generation);
    return bridge.generation;
  },
  counts() {
    return { checked, bad, firstBad, contentMissing, lastWriteMs };
  },
  stats() {
    return bridge === null ? null : bridge.stats();
  },
  shape() {
    return shape;
  },
  // Busy-waits on this thread, so the bridge's port handler cannot run meanwhile.
  stall(ms) {
    const end = performance.now() + ms;
    let spins = 0;
    while (performance.now() < end) spins += 1;
    return spins;
  },
};

globalThis.__probeReady = prepare().catch((err) => {
  // eslint-disable-next-line no-console -- main forwards FAIL lines to the probe's stdout
  console.log(`FAIL page: ${errorText(err)}`);
  throw err;
});
