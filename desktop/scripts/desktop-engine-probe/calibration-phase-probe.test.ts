// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { createCalibrationPhaseProbe } = require('./calibration-phase-probe.js');

afterEach(() => vi.useRealTimers());

describe('calibration phase synchronization in the engine probe', () => {
  it('does not advance offline rendering until the commanded phase is acknowledged', async () => {
    const events: unknown[] = [];
    const probe = createCalibrationPhaseProbe((event: unknown) => events.push(event));
    const setCalibrationPhase = vi.fn();
    const resume = vi.fn();
    const pending = probe.setPhase({ setCalibrationPhase }, 2, 'quiet').then(resume);
    expect(setCalibrationPhase).toHaveBeenCalledWith(2, 'quiet');
    await Promise.resolve();
    expect(resume).not.toHaveBeenCalled();
    probe.onEvent({ type: 'calibrationAck', epoch: 1, phase: 'quiet' });
    probe.onEvent({ type: 'calibrationAck', epoch: 2, phase: 'speech' });
    probe.onEvent({ type: 'calibrationWindow', epoch: 2, phase: 'quiet' });
    await Promise.resolve();
    expect(resume).not.toHaveBeenCalled();
    probe.onEvent({ type: 'calibrationAck', epoch: 2, phase: 'quiet' });
    await pending;
    expect(resume).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(4);
  });

  it('fails on a missing acknowledgement without resuming or leaking a timer', async () => {
    vi.useFakeTimers();
    const probe = createCalibrationPhaseProbe(() => {}, 2000);
    const resume = vi.fn();
    const pending = probe.setPhase({ setCalibrationPhase: vi.fn() }, 2, 'quiet').then(resume);
    const outcome = pending.then(
      () => null,
      (error: Error) => error
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await outcome).toEqual(
      new Error('Calibration acknowledgement deadline: epoch=2 phase=quiet')
    );
    expect(resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('registers before sending, allowing a synchronous acknowledgement', async () => {
    vi.useFakeTimers();
    const probe = createCalibrationPhaseProbe(() => {});
    await probe.setPhase(
      {
        setCalibrationPhase(epoch: number, phase: string) {
          probe.onEvent({ type: 'calibrationAck', epoch, phase });
        },
      },
      3,
      'speech'
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a command error and clears the deadline', async () => {
    vi.useFakeTimers();
    const probe = createCalibrationPhaseProbe(() => {});
    await expect(
      probe.setPhase(
        {
          setCalibrationPhase() {
            throw new Error('closed host');
          },
        },
        1,
        'quiet'
      )
    ).rejects.toThrow('closed host');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects overlapping commands without disturbing the first observer', async () => {
    vi.useFakeTimers();
    const probe = createCalibrationPhaseProbe(() => {});
    const handle = { setCalibrationPhase: vi.fn() };
    const first = probe.setPhase(handle, 2, 'quiet');
    await expect(probe.setPhase(handle, 3, 'speech')).rejects.toThrow('already pending');
    expect(handle.setCalibrationPhase).toHaveBeenCalledTimes(1);
    probe.onEvent({ type: 'calibrationAck', epoch: 2, phase: 'quiet' });
    await first;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs self-contained when serialized into the renderer probe', async () => {
    const create = runInNewContext(`(${createCalibrationPhaseProbe.toString()})`, {
      setTimeout,
      clearTimeout,
    });
    const probe = create(() => {});
    const pending = probe.setPhase({ setCalibrationPhase: vi.fn() }, 2, 'quiet');
    probe.onEvent({ type: 'calibrationAck', epoch: 2, phase: 'quiet' });
    await pending;
  });
});

// Contract model for scheduling, not a substitute for the real Electron worklet probe.
function calibrationSequenceFixture() {
  type Event = {
    type: string;
    epoch: number;
    phase?: string;
    frames?: number;
    valid?: boolean;
    peak?: number;
  };
  let emit: (event: Event) => void = () => {
    throw new Error('host not created');
  };
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const partial = deferred<void>();
  const speech = deferred<void>();
  const output = { getChannelData: () => new Float32Array(4) };
  const rendering = deferred<typeof output>();
  const gain = { gain: { value: 1 }, connect: vi.fn() };
  const node = { connect: vi.fn(() => gain) };
  const source = { buffer: null, connect: vi.fn(() => node), start: vi.fn() };
  const handle = { node, setCalibrationPhase: vi.fn(), close: vi.fn() };
  const emitWindows = (epoch: number, phase: string, count: number, peak: number) => {
    for (let i = 0; i < count; i++)
      emit({ type: 'calibrationWindow', epoch, phase, frames: 960, valid: true, peak });
    emit({ type: 'calibrationComplete', epoch, phase, frames: count * 960 });
  };
  const context = {
    destination: {},
    createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(31 * 48000) })),
    createBufferSource: () => source,
    createGain: () => gain,
    suspend: vi.fn((time: number) => (time === 0.03 ? partial.promise : speech.promise)),
    startRendering: vi.fn(() => {
      partial.resolve();
      return rendering.promise;
    }),
    resume: vi.fn(async () => {
      if (context.resume.mock.calls.length === 1) {
        emitWindows(2, 'quiet', 500, Math.fround(0.001));
        speech.resolve();
      } else {
        emitWindows(3, 'speech', 1000, Math.fround(0.01));
        rendering.resolve(output);
      }
    }),
  };
  const createProcessor = vi.fn(async (_context, _options, _window, _error, _status, onEvent) => {
    emit = onEvent;
    return handle;
  });
  return { context, createProcessor, handle, source, emit: (event: Event) => emit(event) };
}

async function flushSequence() {
  await vi.advanceTimersByTimeAsync(0);
}

it('the actual calibration sequence gates initial start and both resumes on matching acknowledgements', async () => {
  vi.useFakeTimers();
  const { probeCalibration } = require('./calibration-phase-probe.js');
  // Execute precisely the serialized function used by main, without a module closure.
  const run = runInNewContext(`(${probeCalibration.toString()})`, { performance, setTimeout });
  const fixture = calibrationSequenceFixture();
  const pending = run(
    fixture.context,
    fixture.createProcessor,
    createCalibrationPhaseProbe,
    vi.fn()
  );
  // Observe errors immediately, even if an earlier scheduling assertion fails in a mutation run.
  const outcome = pending.then(
    (value: unknown) => ({ value }),
    (error: Error) => ({ error })
  );
  await flushSequence();
  expect(fixture.handle.setCalibrationPhase).toHaveBeenLastCalledWith(1, 'quiet');
  expect(fixture.source.start).not.toHaveBeenCalled();
  expect(fixture.context.startRendering).not.toHaveBeenCalled();
  fixture.emit({ type: 'calibrationAck', epoch: 0, phase: 'quiet' });
  await flushSequence();
  expect(fixture.context.startRendering).not.toHaveBeenCalled();
  fixture.emit({ type: 'calibrationAck', epoch: 1, phase: 'quiet' });
  await flushSequence();
  expect(fixture.source.start).toHaveBeenCalledTimes(1);
  expect(fixture.context.startRendering).toHaveBeenCalledTimes(1);
  expect(fixture.handle.setCalibrationPhase).toHaveBeenLastCalledWith(2, 'quiet');
  expect(fixture.context.resume).not.toHaveBeenCalled();
  fixture.emit({ type: 'calibrationAck', epoch: 2, phase: 'speech' });
  await flushSequence();
  expect(fixture.context.resume).not.toHaveBeenCalled();
  fixture.emit({ type: 'calibrationAck', epoch: 2, phase: 'quiet' });
  await flushSequence();
  expect(fixture.context.resume).toHaveBeenCalledTimes(1);
  expect(fixture.handle.setCalibrationPhase).toHaveBeenLastCalledWith(3, 'speech');
  fixture.emit({ type: 'calibrationAck', epoch: 2, phase: 'quiet' });
  await flushSequence();
  expect(fixture.context.resume).toHaveBeenCalledTimes(1);
  fixture.emit({ type: 'calibrationAck', epoch: 3, phase: 'speech' });
  expect(await outcome).toEqual({
    value: {
      quietWindows: 500,
      speechWindows: 1000,
      quietFrames: 480000,
      speechFrames: 960000,
      quietComplete: true,
      speechComplete: true,
      silentOutput: true,
      allWindowsComplete: true,
      speechPeak: Math.fround(0.01),
    },
  });
  expect(fixture.context.resume).toHaveBeenCalledTimes(2);
  expect(fixture.handle.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
