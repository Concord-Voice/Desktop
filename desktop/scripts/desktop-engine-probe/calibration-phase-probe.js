'use strict';

// Self-contained because main serializes this into the real renderer probe.
// Offline rendering must remain suspended until the worklet has applied the
// phase command; posting a MessagePort command is not an acknowledgement.
function createCalibrationPhaseProbe(recordEvent, timeoutMs = 2000) {
  let pending = null;
  return {
    onEvent(event) {
      recordEvent(event);
      if (
        pending &&
        event.type === 'calibrationAck' &&
        event.epoch === pending.epoch &&
        event.phase === pending.phase
      ) {
        pending.finish();
      }
    },
    setPhase(handle, epoch, phase) {
      if (pending) return Promise.reject(new Error('Calibration phase command already pending'));
      return new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          pending = null;
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(
          () =>
            finish(
              new Error(`Calibration acknowledgement deadline: epoch=${epoch} phase=${phase}`)
            ),
          timeoutMs
        );
        // Install the observer before sending, including for synchronous test hosts.
        pending = { epoch, phase, finish };
        try {
          handle.setCalibrationPhase(epoch, phase);
        } catch (error) {
          finish(error);
        }
      });
    },
  };
}

// The actual sequence used by main, kept self-contained for renderer serialization.
async function probeCalibration(context, createProcessor, createPhaseProbe, onError) {
  const events = [];
  const phases = createPhaseProbe((event) => events.push(event));
  const calibration = await createProcessor(
    context,
    { protectAgcPeaks: true, gate: { kind: 'fixed', thresholdDbfs: -40 } },
    () => {},
    onError,
    undefined,
    phases.onEvent
  );
  try {
    const buffer = context.createBuffer(1, 31 * 48000, 48000);
    buffer.getChannelData(0).fill(0.001);
    buffer.getChannelData(0).fill(0.01, Math.round(10.08 * 48000));
    const source = context.createBufferSource();
    source.buffer = buffer;
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(calibration.node).connect(silent).connect(context.destination);
    await phases.setPhase(calibration, 1, 'quiet');
    const partial = context.suspend(0.03);
    const speech = context.suspend(10.08);
    source.start();
    const rendering = context.startRendering();
    await partial;
    // Supersede a partially captured window through the production host API.
    await phases.setPhase(calibration, 2, 'quiet');
    await context.resume();
    await speech;
    await phases.setPhase(calibration, 3, 'speech');
    await context.resume();
    const calibrated = await rendering;
    const deadline = performance.now() + 2000;
    while (
      !events.some((event) => event.type === 'calibrationComplete' && event.epoch === 3) &&
      performance.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const quiet = events.filter((event) => event.type === 'calibrationWindow' && event.epoch === 2);
    const spoken = events.filter(
      (event) => event.type === 'calibrationWindow' && event.epoch === 3
    );
    const complete = events.filter((event) => event.type === 'calibrationComplete');
    return {
      quietWindows: quiet.length,
      speechWindows: spoken.length,
      quietFrames: quiet.reduce((sum, event) => sum + event.frames, 0),
      speechFrames: spoken.reduce((sum, event) => sum + event.frames, 0),
      quietComplete: complete.some((event) => event.epoch === 2 && event.frames === 480000),
      speechComplete: complete.some((event) => event.epoch === 3 && event.frames === 960000),
      silentOutput: calibrated.getChannelData(0).every((value) => value === 0),
      allWindowsComplete: [...quiet, ...spoken].every(
        (event) => event.valid && event.frames === 960
      ),
      speechPeak: spoken.length ? spoken[spoken.length - 1].peak : null,
    };
  } finally {
    calibration.close();
  }
}

module.exports = { createCalibrationPhaseProbe, probeCalibration };
