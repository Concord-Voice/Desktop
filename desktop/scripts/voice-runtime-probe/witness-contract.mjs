export const MIN_DURATION_MS = 95_000;
export const MAX_DURATION_MS = 180_000;
export const POLL_INTERVAL_MS = 5_000;
export const FINAL_OBSERVATION_DEADLINE_MS = 185_000;
export const VIDEO_STALL_MS = 10_000;

const DETECTOR_REASONS = new Set([
  'first-sample', 'missing-stats', 'stale-stats', 'future-stats', 'stream-changed', 'counter-reset',
  'out-of-order', 'field-absent', 'sr-not-advanced', 'unpaired', 'kind-incomplete',
  'ambiguous-streams', 'clock-regression', 'insufficient-samples', 'offset-step',
]);
const NORMALIZATION_REASONS = new Set(['normalized', 'pair-count', 'unpaired', 'field-absent', 'invalid-elapsed', 'sr-not-advanced']);

/**
 * Creates the existing separate fault-control fork without touching the real
 * reports observed by the production sampler or independent witness.
 */
export function createFaultControlFork({ slopeMsPerSec = 2 } = {}) {
  let baseline;
  let previousRaw;
  return (entries, elapsedMs) => {
    const copied = [...entries].map((entry) => entry && typeof entry === 'object' ? { ...entry } : entry);
    const inboundForKind = (kind) => copied.filter((entry) => entry && typeof entry === 'object' &&
      entry.type === 'inbound-rtp' && entry.kind === kind && typeof entry.remoteId === 'string');
    const [audioIn] = inboundForKind('audio');
    const [videoIn] = inboundForKind('video');
    const linkedOutbound = (inbound) => copied.filter((entry) => entry && typeof entry === 'object' &&
      entry.type === 'remote-outbound-rtp' && entry.id === inbound?.remoteId);
    const audioOut = linkedOutbound(audioIn);
    const videoOut = linkedOutbound(videoIn);
    const paired = (inbound, outbound) => inbound && outbound && typeof inbound.id === 'string' &&
      typeof inbound.remoteId === 'string' && typeof outbound.id === 'string' && typeof outbound.localId === 'string' &&
      inbound.remoteId === outbound.id && outbound.localId === inbound.id;
    const valid = (entry) => Number.isFinite(entry.timestamp) && Number.isFinite(entry.remoteTimestamp);
    if (inboundForKind('audio').length !== 1 || inboundForKind('video').length !== 1 ||
        audioOut.length !== 1 || videoOut.length !== 1) {
      return { entries: copied, normalized: false, normalizationReason: 'pair-count' };
    }
    const [audioRemote] = audioOut;
    const [videoRemote] = videoOut;
    if (!paired(audioIn, audioRemote) || !paired(videoIn, videoRemote)) {
      return { entries: copied, normalized: false, normalizationReason: 'unpaired' };
    }
    if (!valid(audioRemote) || !valid(videoRemote)) {
      return { entries: copied, normalized: false, normalizationReason: 'field-absent' };
    }
    if (!Number.isFinite(elapsedMs)) {
      return { entries: copied, normalized: false, normalizationReason: 'invalid-elapsed' };
    }
    const identity = `${audioIn.id}|${audioRemote.id}|${videoIn.id}|${videoRemote.id}`;
    if (previousRaw?.identity === identity &&
        (previousRaw.audioRemoteTimestamp === audioRemote.remoteTimestamp || previousRaw.videoRemoteTimestamp === videoRemote.remoteTimestamp)) {
      previousRaw = { identity, audioRemoteTimestamp: audioRemote.remoteTimestamp, videoRemoteTimestamp: videoRemote.remoteTimestamp };
      return { entries: copied, normalized: false, normalizationReason: 'sr-not-advanced' };
    }
    if (baseline?.identity !== identity) baseline = {
      identity,
      audioOffset: audioRemote.timestamp - audioRemote.remoteTimestamp,
      videoOffset: videoRemote.timestamp - videoRemote.remoteTimestamp,
      elapsedMs,
    };
    previousRaw = { identity, audioRemoteTimestamp: audioRemote.remoteTimestamp, videoRemoteTimestamp: videoRemote.remoteTimestamp };
    const elapsedSeconds = (elapsedMs - baseline.elapsedMs) / 1_000;
    audioRemote.remoteTimestamp = audioRemote.timestamp - (baseline.audioOffset - slopeMsPerSec * elapsedSeconds);
    videoRemote.remoteTimestamp = videoRemote.timestamp - baseline.videoOffset;
    return { entries: copied, normalized: true, normalizationReason: 'normalized' };
  };
}

/** Observes the isolated fault-control fork without touching raw RTC reports. */
export function observeFaultControl(detector, fork, observedAt) {
  if (!fork.normalized) return { usable: false, reason: fork.normalizationReason };
  return detector.observe(fork.entries, observedAt);
}

export function continuousCallDecision({ elapsedMs, pollAdmittedElapsedMs, requiredDurationMs, witnesses }) {
  if (!Number.isSafeInteger(elapsedMs) || !Number.isSafeInteger(requiredDurationMs) ||
      !Number.isSafeInteger(pollAdmittedElapsedMs) || requiredDurationMs < MIN_DURATION_MS ||
      requiredDurationMs > MAX_DURATION_MS || elapsedMs < 0 || pollAdmittedElapsedMs < 0 ||
      pollAdmittedElapsedMs >= MAX_DURATION_MS || pollAdmittedElapsedMs > elapsedMs ||
      elapsedMs > FINAL_OBSERVATION_DEADLINE_MS) return 'fail';
  if (!Array.isArray(witnesses) || witnesses.length !== 2) return 'fail';
  if (witnesses.some((entry) => entry?.independentDrift || entry?.productionDrift)) return 'fail';
  if (elapsedMs < requiredDurationMs) return 'continue';
  if (witnesses.some((entry) => !entry?.injectedDetectorTripped)) return 'fail';
  const complete = witnesses.every((entry) => entry?.independentCurrentWindowUsable && entry.independentUsableCount > 0);
  if (complete && elapsedMs <= MAX_DURATION_MS) return 'verify';
  if (complete && pollAdmittedElapsedMs >= MAX_DURATION_MS - POLL_INTERVAL_MS) return 'verify';
  if (elapsedMs >= MAX_DURATION_MS) return 'fail';
  const recovering = witnesses.filter((entry) => !entry?.independentCurrentWindowUsable);
  const lateThresholdMs = Math.max(0, requiredDurationMs - 60_000);
  return recovering.length === 1 && recovering[0].independentOffsetStepCount === 1 &&
    recovering[0].independentOtherDiscontinuityCount === 0 &&
    recovering[0].independentLastOffsetStepElapsedMs >= lateThresholdMs
    ? 'continue-recovery' : 'fail';
}

/** Plans the last admissible observation without sleeping past the hard boundary. */
export function planContinuousCallPoll(elapsedMs) {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs >= MAX_DURATION_MS) return null;
  return {
    pollAdmittedElapsedMs: elapsedMs,
    delayMs: Math.min(POLL_INTERVAL_MS, MAX_DURATION_MS - elapsedMs),
  };
}

export function launchProbeElectron(electron, options) {
  // Playwright otherwise prepends --no-sandbox on Linux, which this fixture refuses.
  return electron.launch({ ...options, chromiumSandbox: true });
}

/** Fail before key setup if the test-only integration seam has changed. */
export function requireVoiceProbeContract(service) {
  for (const name of ['createE2EEWorker', 'produceEncrypted', 'creationAttachConsumeOption',
    'applyDecryptTransform', 'recordSelectedCandidatePair', 'liveUpdateVideoPriority',
    'startAvSyncSampling', 'terminateE2EEWorker']) {
    if (typeof service?.[name] !== 'function') throw new Error(`Voice runtime fixture contract missing: ${name}`);
  }
  if (!(service.consumers instanceof Map) || service.avSyncSamplingTimer !== null ||
      !Number.isSafeInteger(service.avSyncObservationCount) || service.avSyncObservationCount < 0 ||
      typeof service.avSyncDriftEmitted !== 'boolean') {
    throw new Error('Voice runtime fixture contract missing: consumer/sampler state');
  }
}

/** Partial failure evidence must never retain raw stats, identities, keys or SDP. */
export function summarizeRuntimeWitnesses(witnesses) {
  const counter = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const boolean = (value) => typeof value === 'boolean' ? value : null;
  const state = (value, allowed) => allowed.includes(value) ? value : 'unknown';
  const transportStates = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'];
  const iceStates = ['new', 'gathering', 'complete'];
  const reasons = (value) => Array.isArray(value)
    ? [...new Set(value.filter((reason) => typeof reason === 'string' && DETECTOR_REASONS.has(reason)))].slice(0, 4)
    : [];
  const states = (value, allowed) => Object.fromEntries(['send', 'audioReceive', 'videoReceive']
    .map((name) => [name, state(value?.[name], allowed)]));
  if (!Array.isArray(witnesses)) return [];
  return witnesses.slice(0, 2).map((entry) => {
    const value = entry ?? {};
    return {
      transportStates: states(value.transportStates, transportStates),
      iceGatheringStates: states(value.iceGatheringStates, iceStates),
      audioContextState: state(value.audioContextState, ['running', 'suspended', 'closed', 'interrupted']),
      audioSignalPresent: boolean(value.audioSignalPresent), decodedVideoPresent: boolean(value.decodedVideoPresent),
      audioPacketsReceived: counter(value.audioPacketsReceived), videoPacketsReceived: counter(value.videoPacketsReceived),
      videoBytesReceived: counter(value.videoBytesReceived), framesDecoded: counter(value.framesDecoded),
      presentedFrames: counter(value.presentedFrames), outboundPacketsSent: counter(value.outboundPacketsSent),
      outboundVideoFramesEncoded: counter(value.outboundVideoFramesEncoded),
      e2eeEntered: Array.isArray(value.e2eeEntered) ? value.e2eeEntered.slice(0, 2).map(counter) : null,
      sourceTracksLive: boolean(value.sourceTracksLive),
      productionDrift: boolean(value.productionDrift), independentDrift: boolean(value.independentDrift),
      injectedDetectorTripped: boolean(value.injectedDetectorTripped),
      independentUsableCount: counter(value.independentUsableCount),
      independentOffsetStepCount: counter(value.independentOffsetStepCount),
      faultControlUsableCount: counter(value.faultControlUsableCount),
      independentRefusals: reasons(value.independentRefusals), faultControlRefusals: reasons(value.faultControlRefusals),
      faultControlNormalizationReasons: Array.isArray(value.faultControlNormalizationReasons)
        ? [...new Set(value.faultControlNormalizationReasons.filter((reason) => typeof reason === 'string' && NORMALIZATION_REASONS.has(reason)))].slice(0, 4)
        : [],
    };
  });
}

export function requireDuration(duration) {
  if (!Number.isSafeInteger(duration) || duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
    throw new Error('MEDIA_PROBE_DURATION_MS must be 95000..180000');
  }
  return duration;
}

/** Compare actual decode/presentation counters between bounded runtime polls. */
export function createVideoProgressGate() {
  let previous;
  return (witness) => {
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (typeof witness.videoConsumerId !== 'string' || !witness.videoConsumerId ||
        ![witness.framesDecoded, witness.presentedFrames, witness.decodedProgressAgeMs,
          witness.presentedProgressAgeMs].every(finite)) return false;
    const advancing = previous?.videoConsumerId === witness.videoConsumerId &&
      witness.framesDecoded > previous.framesDecoded && witness.presentedFrames > previous.presentedFrames &&
      witness.decodedProgressAgeMs <= VIDEO_STALL_MS && witness.presentedProgressAgeMs <= VIDEO_STALL_MS;
    previous = {
      videoConsumerId: witness.videoConsumerId,
      framesDecoded: witness.framesDecoded, presentedFrames: witness.presentedFrames,
    };
    return Boolean(advancing);
  };
}

export function verifiedConsumerId(payload) {
  return payload && typeof payload.consumerId === 'string' && payload.consumerId &&
    Number.isFinite(payload.entered) && payload.entered > 0 &&
    Number.isFinite(payload.packetsReceived) && payload.packetsReceived > 0
    ? payload.consumerId : null;
}

export function initialConsumersVerified(witness, verifiedIds) {
  const evidence = witness.consumerEvidence;
  return Array.isArray(evidence) && evidence.length === 2 &&
    evidence.some((entry) => entry.kind === 'audio') && evidence.some((entry) => entry.kind === 'video') &&
    evidence.every((entry) => typeof entry.id === 'string' && verifiedIds.has(entry.id) && entry.entered > 0);
}

export function replacementVerified(witness, previousId, verifiedIds, originalAudioId) {
  return typeof witness.videoConsumerId === 'string' && witness.videoConsumerId !== previousId &&
    verifiedIds.has(witness.videoConsumerId) && witness.e2eeVideoEntered > 0 && witness.audioSignalPresent &&
    witness.consumerEvidence.some((entry) => entry.kind === 'audio' && entry.id === originalAudioId && entry.entered > 0);
}

export function requireNoRuntimeFailure(markers) {
  if (markers.transformFailure || markers.priorityUpdateFailure || markers.pageErrors !== 0) {
    throw new Error('Runtime media error');
  }
}

/** Manifest text, root lock declaration, resolved lock, package and executable must agree. */
export function requireElectronAlignment({ manifest, lockManifest, locked, installed, runtime }, satisfies) {
  if (typeof manifest !== 'string' || manifest !== lockManifest ||
      typeof locked !== 'string' || !satisfies(locked, manifest) || installed !== locked ||
      (runtime !== undefined && runtime !== locked)) {
    throw new Error('Electron manifest/lock/installed/runtime mismatch');
  }
}
