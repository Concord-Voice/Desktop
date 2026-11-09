import assert from 'node:assert/strict';
import test from 'node:test';
import semver from 'semver';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import * as contract from './witness-contract.mjs';
import { createAvSyncDriftDetector } from '../../src/renderer/services/voice/avSyncDriftDetector.ts';
import {
  continuousCallDecision, createFaultControlFork, createVideoProgressGate, FINAL_OBSERVATION_DEADLINE_MS, initialConsumersVerified, observeFaultControl, planContinuousCallPoll, replacementVerified, requireDuration,
  requireElectronAlignment, requireNoRuntimeFailure, verifiedConsumerId, launchProbeElectron,
} from './witness-contract.mjs';

test('the real Playwright launch boundary never adds no-sandbox on Linux',
  { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-sandbox-argv-'));
  try {
    const capture = path.join(root, 'argv.json');
    const executable = path.join(root, 'record-argv');
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));process.exit(1);\n`);
    await chmod(executable, 0o755);
    const child = path.join(root, 'launch.mjs');
    const contractUrl = new URL('./witness-contract.mjs', import.meta.url).href;
    await writeFile(child, `import { createRequire } from 'node:module';\nimport { launchProbeElectron } from ${JSON.stringify(contractUrl)};\nconst require = createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});\nconst { _electron } = require('@playwright/test');\nvoid launchProbeElectron(_electron, ${JSON.stringify({ executablePath: executable, args: ['fixture.cjs'], timeout: 5000 })}).catch(() => {});\n`);
    // The recorder deliberately exits instead of starting an engine. Isolate the
    // dependency's expected launch rejection; assert the actual native argv.
    const result = spawnSync(process.execPath, [child], {
      timeout: 7000, maxBuffer: 1024 * 1024, shell: false, encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    const args = JSON.parse(await readFile(capture, 'utf8'));
    assert(args.includes('fixture.cjs') && args.includes('--remote-debugging-port=0'));
    assert.equal(args.includes('--no-sandbox'), false, 'Playwright disabled the renderer sandbox');
    assert.equal(args.includes('--disable-setuid-sandbox'), false);
  } finally { await rm(root, { recursive: true }); }
});

const sample = (framesDecoded, presentedFrames, extra = {}) => ({
  videoConsumerId: 'original', framesDecoded, presentedFrames,
  decodedProgressAgeMs: 100, presentedProgressAgeMs: 100, ...extra,
});

function avSyncEntries(timestamp, audioOffset, videoOffset) {
  return [
    { id: 'a:in-audio', type: 'inbound-rtp', kind: 'audio', remoteId: 'a:ro-audio',
      ssrc: 1, trackIdentifier: 'audio', timestamp, jitterBufferDelay: 0.05, jitterBufferEmittedCount: 1_000 },
    { id: 'a:ro-audio', type: 'remote-outbound-rtp', kind: 'audio', localId: 'a:in-audio',
      timestamp, remoteTimestamp: timestamp - audioOffset },
    { id: 'v:in-video', type: 'inbound-rtp', kind: 'video', remoteId: 'v:ro-video',
      ssrc: 2, trackIdentifier: 'video', timestamp, jitterBufferDelay: 0.05, jitterBufferEmittedCount: 1_000 },
    { id: 'v:ro-video', type: 'remote-outbound-rtp', kind: 'video', localId: 'v:in-video',
      timestamp, remoteTimestamp: timestamp - videoOffset },
  ];
}

function detectorWitness(overrides = {}) {
  return {
    independentCurrentWindowUsable: true,
    independentUsableCount: 1,
    independentDrift: false,
    productionDrift: false,
    injectedDetectorTripped: true,
    independentOffsetStepCount: 0,
    independentOtherDiscontinuityCount: 0,
    independentLastOffsetStepElapsedMs: null,
    ...overrides,
  };
}

function driveContinuousCall({ elapsedMs, requiredDurationMs, readLatencyMs, witnesses }) {
  const admissions = [];
  for (let polls = 0; polls < 4; polls++) {
    const plan = planContinuousCallPoll(elapsedMs);
    if (!plan) {
      return { admissions, elapsedMs, decision: continuousCallDecision({ elapsedMs, requiredDurationMs,
        pollAdmittedElapsedMs: elapsedMs, witnesses }) };
    }
    admissions.push(plan.pollAdmittedElapsedMs);
    elapsedMs += plan.delayMs + readLatencyMs;
    const decision = continuousCallDecision({ elapsedMs, requiredDurationMs,
      pollAdmittedElapsedMs: plan.pollAdmittedElapsedMs, witnesses });
    if (decision !== 'continue' && decision !== 'continue-recovery') return { admissions, elapsedMs, decision };
  }
  throw new Error('virtual poll controller exceeded its bounded test loop');
}

test('fault control normalizes opposing live skew before imposing its exact drift ramp', () => {
  const fork = createFaultControlFork();
  const detector = createAvSyncDriftDetector();
  const startedAt = 1_000_000;
  let verdict;
  for (let elapsed = 0; elapsed <= 65_000; elapsed += 5_000) {
    // The live audio offset increases by 2 ms/s. The historical copied-report
    // fork adds that same amount to remoteTimestamp, cancelling its own control.
    const raw = avSyncEntries(startedAt + elapsed, 100 + elapsed * 0.002, 100);
    const control = fork(raw, elapsed);
    assert.deepEqual(raw, avSyncEntries(startedAt + elapsed, 100 + elapsed * 0.002, 100),
      'the control fork must not mutate live RTC reports');
    verdict = detector.observe(control.entries, startedAt + elapsed);
  }
  assert.equal(verdict?.usable, true, 'the control must accumulate a usable one-minute window');
  assert.equal(verdict?.verdict, 'drift', 'ambient skew cannot cancel the positive control');
});

test('one late offset-step receives a bounded recovery window after the required 95 seconds', () => {
  const healthy = detectorWitness();
  const recovering = detectorWitness({ independentCurrentWindowUsable: false, independentOffsetStepCount: 1,
    independentLastOffsetStepElapsedMs: 90_000 });
  assert.equal(continuousCallDecision({
    elapsedMs: 95_000,
    pollAdmittedElapsedMs: 95_000,
    requiredDurationMs: 95_000,
    witnesses: [recovering, healthy],
  }), 'continue-recovery');
});

test('continuous-call recovery rejects missing control evidence and repeated discontinuities', () => {
  const healthy = detectorWitness();
  const recovering = detectorWitness({ independentCurrentWindowUsable: false, independentOffsetStepCount: 1,
    independentLastOffsetStepElapsedMs: 90_000 });
  assert.equal(continuousCallDecision({ elapsedMs: 95_000, pollAdmittedElapsedMs: 95_000, requiredDurationMs: 95_000,
    witnesses: [{ ...recovering, injectedDetectorTripped: false }, healthy] }), 'fail');
  assert.equal(continuousCallDecision({ elapsedMs: 95_000, pollAdmittedElapsedMs: 95_000, requiredDurationMs: 95_000,
    witnesses: [{ ...recovering, independentOffsetStepCount: 2 }, healthy] }), 'fail');
  assert.equal(continuousCallDecision({ elapsedMs: 95_000, pollAdmittedElapsedMs: 95_000, requiredDurationMs: 95_000,
    witnesses: [{ ...recovering, independentLastOffsetStepElapsedMs: 34_999 }, healthy] }), 'fail');
  assert.equal(continuousCallDecision({ elapsedMs: 180_000, pollAdmittedElapsedMs: 179_999, requiredDurationMs: 180_000,
    witnesses: [healthy, healthy] }), 'verify');
  assert.equal(continuousCallDecision({ elapsedMs: 180_001, requiredDurationMs: 180_000,
    pollAdmittedElapsedMs: 179_999, witnesses: [healthy, healthy] }), 'verify');
});

test('poll planner admits the final pre-cutoff observation and clamps its delay', () => {
  assert.deepEqual(planContinuousCallPoll(174_999), { pollAdmittedElapsedMs: 174_999, delayMs: 5_000 });
  assert.deepEqual(planContinuousCallPoll(179_999), { pollAdmittedElapsedMs: 179_999, delayMs: 1 });
  assert.equal(planContinuousCallPoll(180_000), null);
  assert.equal(planContinuousCallPoll(-1), null);
  assert.equal(planContinuousCallPoll(1.5), null);
});

test('a valid final observation admitted before 180 seconds survives one millisecond of read latency', () => {
  const result = driveContinuousCall({ elapsedMs: 175_000, requiredDurationMs: 180_000,
    readLatencyMs: 1, witnesses: [detectorWitness(), detectorWitness()] });
  assert.deepEqual(result, { admissions: [175_000], elapsedMs: 180_001, decision: 'verify' });
});

test('continuous-call admission never grants the final grace to early, invalid, incomplete, drifting, or overdue evidence', () => {
  const healthy = [detectorWitness(), detectorWitness()];
  const early = driveContinuousCall({ elapsedMs: 174_999, requiredDurationMs: 180_000,
    readLatencyMs: 2, witnesses: healthy });
  assert.deepEqual(early, { admissions: [174_999], elapsedMs: 180_001, decision: 'fail' });
  assert.equal(continuousCallDecision({ elapsedMs: 180_000, requiredDurationMs: 180_000,
    pollAdmittedElapsedMs: 180_000, witnesses: healthy }), 'fail');
  assert.equal(continuousCallDecision({ elapsedMs: 180_001, requiredDurationMs: 180_000,
    pollAdmittedElapsedMs: 179_999,
    witnesses: [detectorWitness({ independentCurrentWindowUsable: false }), detectorWitness()] }), 'fail');
  assert.equal(continuousCallDecision({ elapsedMs: FINAL_OBSERVATION_DEADLINE_MS + 1,
    requiredDurationMs: 180_000, pollAdmittedElapsedMs: 179_999, witnesses: healthy }), 'fail');
  assert.equal(continuousCallDecision({ elapsedMs: 180_001, requiredDurationMs: 180_000,
    pollAdmittedElapsedMs: 179_999,
    witnesses: [detectorWitness({ productionDrift: true }), detectorWitness()] }), 'fail');
});

test('one late offset-step rebuilds a real detector window before bounded verification', () => {
  const detector = createAvSyncDriftDetector();
  const startedAt = 1_000_000;
  for (let elapsed = 0; elapsed <= 90_000; elapsed += 5_000) {
    detector.observe(avSyncEntries(startedAt + elapsed, 100, 100), startedAt + elapsed);
  }
  const stepped = detector.observe(avSyncEntries(startedAt + 95_000, 200, 100), startedAt + 95_000);
  assert.deepEqual(stepped, { usable: false, reason: 'offset-step' });
  let recovered;
  for (let elapsed = 100_000; elapsed <= 160_000; elapsed += 5_000) {
    recovered = detector.observe(avSyncEntries(startedAt + elapsed, 200, 100), startedAt + elapsed);
  }
  assert.deepEqual(recovered, { usable: true, verdict: 'steady' });
});

test('continuous-call evidence fails immediately on raw independent or production drift', () => {
  const witnesses = [detectorWitness(), detectorWitness()];
  assert.equal(continuousCallDecision({ elapsedMs: 5_000, pollAdmittedElapsedMs: 5_000, requiredDurationMs: 95_000,
    witnesses: [{ ...witnesses[0], independentDrift: true }, witnesses[1]] }), 'fail');
  assert.equal(continuousCallDecision({ elapsedMs: 5_000, pollAdmittedElapsedMs: 5_000, requiredDurationMs: 95_000,
    witnesses: [witnesses[0], { ...witnesses[1], productionDrift: true }] }), 'fail');
});

test('missing or malformed reports never normalize the control or satisfy recovery evidence', () => {
  const fork = createFaultControlFork();
  const raw = [{ id: 'a:ro-audio', type: 'remote-outbound-rtp', kind: 'audio', timestamp: 1_000 }];
  const control = fork(raw, 0);
  assert.equal(control.normalized, false);
  assert.notEqual(control.entries[0], raw[0], 'fork still copies malformed report objects');
  assert.deepEqual(raw, [{ id: 'a:ro-audio', type: 'remote-outbound-rtp', kind: 'audio', timestamp: 1_000 }]);
  assert.deepEqual(createAvSyncDriftDetector().observe(control.entries, 1_000), { usable: false, reason: 'missing-stats' });
  assert.equal(continuousCallDecision({ elapsedMs: 95_000, pollAdmittedElapsedMs: 95_000, requiredDurationMs: 95_000,
    witnesses: [detectorWitness({ injectedDetectorTripped: false }), detectorWitness()] }), 'fail');
});

test('control normalization requires a stable paired stats identity and advancing Sender Reports', () => {
  const startedAt = 1_000_000;
  const fork = createFaultControlFork();
  assert.equal(fork(avSyncEntries(startedAt, 100, 100), 0).normalized, true);

  const frozen = avSyncEntries(startedAt + 5_000, 100, 100);
  for (const entry of frozen) {
    if (entry.type === 'remote-outbound-rtp') entry.remoteTimestamp = startedAt - 100;
  }
  assert.equal(fork(frozen, 5_000).normalized, false, 'a frozen SR cannot form a control ramp');

  const mismatched = avSyncEntries(startedAt, 100, 100);
  mismatched.find((entry) => entry.id === 'a:ro-audio').localId = 'a:wrong-inbound';
  assert.equal(createFaultControlFork()(mismatched, 0).normalized, false,
    'an unpaired remote-outbound report cannot establish the control baseline');
});

test('an unlinked mediasoup video probator does not block the paired fault-control ramp', () => {
  const fork = createFaultControlFork();
  const detector = createAvSyncDriftDetector();
  const startedAt = 1_000_000;
  let verdict;
  for (let elapsed = 0; elapsed <= 65_000; elapsed += 5_000) {
    const raw = avSyncEntries(startedAt + elapsed, 100, 100);
    raw.push({ id: 'v:probator', type: 'inbound-rtp', kind: 'video', ssrc: 1234,
      timestamp: startedAt + elapsed, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 });
    const original = structuredClone(raw);
    const control = fork(raw, elapsed);
    assert.equal(control.normalized, true);
    assert.deepEqual(raw, original, 'the control fork must not mutate the unlinked live probator');
    verdict = detector.observe(control.entries, startedAt + elapsed);
  }
  assert.equal(verdict?.verdict, 'drift');
});

test('a one-sided frozen audio Sender Report does not contaminate the normalized control clock basis', () => {
  const rawDetector = createAvSyncDriftDetector();
  const controlDetector = createAvSyncDriftDetector();
  const fork = createFaultControlFork();
  const startedAt = 1_000_000;
  let rawAtFreeze;
  let rawFinal;
  let rawUsableCount = 0;
  let controlTripped = false;
  for (let elapsed = 0; elapsed <= 95_000; elapsed += 5_000) {
    const raw = avSyncEntries(startedAt + elapsed, 100, 100);
    if (elapsed === 40_000) {
      const audioSr = raw.find((entry) => entry.id === 'a:ro-audio');
      audioSr.timestamp = startedAt + 35_000;
      audioSr.remoteTimestamp = startedAt + 35_000 - 100;
    }
    const original = structuredClone(raw);
    const rawObservation = rawDetector.observe(raw, startedAt + elapsed);
    if (elapsed === 40_000) rawAtFreeze = rawObservation;
    rawFinal = rawObservation;
    if (rawObservation.usable) rawUsableCount++;
    const controlObservation = observeFaultControl(controlDetector, fork(raw, elapsed), startedAt + elapsed);
    controlTripped ||= controlObservation.usable && controlObservation.verdict === 'drift';
    assert.deepEqual(raw, original, 'neither raw detector nor control fork mutates the live report');
  }
  assert.deepEqual(rawAtFreeze, { usable: false, reason: 'sr-not-advanced' });
  assert.deepEqual(rawFinal, { usable: true, verdict: 'steady' });
  assert.equal(rawUsableCount, 7);
  assert.equal(controlTripped, true, 'control must resume only from normalized Sender Report snapshots');
});

test('a frozen Sender Report remains refused after the control normalization repair', () => {
  const detector = createAvSyncDriftDetector();
  const startedAt = 1_000_000;
  detector.observe(avSyncEntries(startedAt, 100, 100), startedAt);
  const frozen = avSyncEntries(startedAt + 5_000, 100, 100);
  for (const entry of frozen) {
    if (entry.type === 'remote-outbound-rtp') entry.remoteTimestamp = startedAt - 100;
  }
  assert.deepEqual(detector.observe(frozen, startedAt + 5_000), { usable: false, reason: 'sr-not-advanced' });
});

test('runtime-witness recovery rejects repeated offset steps and the hard cap', () => {
  const healthy = detectorWitness();
  const repeated = detectorWitness({ independentCurrentWindowUsable: false, independentOffsetStepCount: 2,
    independentLastOffsetStepElapsedMs: 90_000 });
  assert.equal(continuousCallDecision({ elapsedMs: 95_000, pollAdmittedElapsedMs: 95_000, requiredDurationMs: 95_000,
    witnesses: [repeated, healthy] }), 'fail');
  assert.equal(continuousCallDecision({ elapsedMs: 180_000, pollAdmittedElapsedMs: 179_999, requiredDurationMs: 95_000,
    witnesses: [{ ...healthy, injectedDetectorTripped: false }, healthy] }), 'fail');
});

test('partial diagnostics retain only typed transport and media counters', () => {
  const input = { transportStates: { send: 'connected', audioReceive: 'checking', videoReceive: 'failed' },
    iceGatheringStates: { send: 'complete', audioReceive: 'gathering', videoReceive: 'new' },
    audioContextState: 'running', audioSignalPresent: false, decodedVideoPresent: true,
    audioPacketsReceived: 12, videoPacketsReceived: 18, videoBytesReceived: 4096,
    framesDecoded: 9, presentedFrames: 8, outboundPacketsSent: 40, outboundVideoFramesEncoded: 10,
    e2eeEntered: [11, 22, 33], sourceTracksLive: true,
    productionDrift: true, independentDrift: false, injectedDetectorTripped: true,
    independentUsableCount: 2, independentOffsetStepCount: 1, faultControlUsableCount: 3,
    independentRefusals: ['offset-step', 'secret', 'offset-step', 'sr-not-advanced', 'field-absent', 'future-stats'],
    faultControlRefusals: ['first-sample', 'invalid', 'first-sample'],
    sdp: 'never retain this', testKey: [1, 2, 3], consumerId: 'private identity' };
  const expected = { transportStates: { send: 'connected', audioReceive: 'unknown', videoReceive: 'failed' },
    iceGatheringStates: { send: 'complete', audioReceive: 'gathering', videoReceive: 'new' },
    audioContextState: 'running', audioSignalPresent: false, decodedVideoPresent: true,
    audioPacketsReceived: 12, videoPacketsReceived: 18, videoBytesReceived: 4096,
    framesDecoded: 9, presentedFrames: 8, outboundPacketsSent: 40, outboundVideoFramesEncoded: 10,
    e2eeEntered: [11, 22], sourceTracksLive: true,
    productionDrift: true, independentDrift: false, injectedDetectorTripped: true,
    independentUsableCount: 2, independentOffsetStepCount: 1, faultControlUsableCount: 3,
    independentRefusals: ['offset-step', 'sr-not-advanced', 'field-absent', 'future-stats'],
    faultControlRefusals: ['first-sample'], faultControlNormalizationReasons: [] };
  assert.deepEqual(contract.summarizeRuntimeWitnesses?.([input, input, input]), [expected, expected]);
  const bad = { ...input, audioContextState: 'contains private text', framesDecoded: Infinity,
    audioPacketsReceived: -1, e2eeEntered: ['secret'], audioSignalPresent: 'yes' };
  const summary = contract.summarizeRuntimeWitnesses?.([bad])?.[0];
  assert.equal(summary?.framesDecoded, null);
  assert.equal(summary?.audioPacketsReceived, null);
  assert.deepEqual(summary?.e2eeEntered, [null]);
  assert.equal(summary?.audioSignalPresent, null);
  assert.equal(summary?.audioContextState, 'unknown');
});

test('the fixture fails closed before setup if its production service contract changes', () => {
  const methods = ['createE2EEWorker', 'produceEncrypted', 'creationAttachConsumeOption',
    'applyDecryptTransform', 'recordSelectedCandidatePair', 'liveUpdateVideoPriority',
    'startAvSyncSampling', 'terminateE2EEWorker'];
  const service = { ...Object.fromEntries(methods.map((name) => [name, () => {}])),
    consumers: new Map(), avSyncSamplingTimer: null, avSyncObservationCount: 0, avSyncDriftEmitted: false };
  assert.equal(typeof contract.requireVoiceProbeContract, 'function', 'Missing fail-closed contract preflight');
  assert.doesNotThrow(() => contract.requireVoiceProbeContract(service));
  for (const name of methods) {
    assert.throws(() => contract.requireVoiceProbeContract({ ...service, [name]: undefined }), /fixture contract missing/);
  }
  for (const bad of [{ consumers: {} }, { avSyncObservationCount: NaN },
    { avSyncSamplingTimer: 1 }, { avSyncDriftEmitted: undefined }]) {
    assert.throws(() => contract.requireVoiceProbeContract({ ...service, ...bad }), /fixture contract missing/);
  }
});

test('advancing real-counter snapshots pass; frozen startup image and one-sided progress fail', () => {
  const progress = createVideoProgressGate();
  assert.equal(progress(sample(100, 100)), false);
  assert.equal(progress(sample(150, 150)), true);
  assert.equal(progress(sample(150, 150)), false); // colored retained frame cannot prove delivery
  assert.equal(progress(sample(200, 150)), false); // decode without presentation
  assert.equal(progress(sample(200, 200)), false); // presentation without decode
  assert.equal(progress(sample(250, 250)), true);
  assert.equal(progress(sample(300, 300, { presentedProgressAgeMs: 10_001 })), false);
  assert.equal(progress(sample(350, 350, { decodedProgressAgeMs: 10_001 })), false);
});

test('a replacement consumer needs its own baseline and subsequent advancing poll', () => {
  const progress = createVideoProgressGate();
  progress(sample(100, 100));
  assert.equal(progress(sample(150, 150)), true);
  assert.equal(progress(sample(10, 10, { videoConsumerId: 'replacement' })), false);
  assert.equal(progress(sample(20, 20, { videoConsumerId: 'replacement' })), true);
  assert.equal(progress(sample(20, 20, { videoConsumerId: 'replacement' })), false);
});

test('original markers and entered frames cannot verify a replacement consumer', () => {
  const verified = new Set(['original-video', 'original-audio']);
  const replacement = { videoConsumerId: 'replacement', e2eeVideoEntered: 15, audioSignalPresent: true,
    consumerEvidence: [{ id: 'original-audio', kind: 'audio', entered: 20 }] };
  assert.equal(replacementVerified(replacement, 'original-video', verified, 'original-audio'), false);
  assert.equal(verifiedConsumerId({ consumerId: 'replacement', entered: 0, packetsReceived: 10 }), null);
  assert.equal(verifiedConsumerId({ consumerId: 'replacement', entered: 10, packetsReceived: 0 }), null);
  verified.add(verifiedConsumerId({ consumerId: 'replacement', entered: 10, packetsReceived: 10 }));
  assert.equal(replacementVerified(replacement, 'original-video', verified, 'original-audio'), true);
  assert.equal(replacementVerified({ ...replacement, videoConsumerId: 'original-video' }, 'original-video', verified, 'original-audio'), false);
  assert.equal(replacementVerified({ ...replacement, audioSignalPresent: false }, 'original-video', verified, 'original-audio'), false);
  assert.equal(replacementVerified({ ...replacement, consumerEvidence: [{ id: 'original-audio', kind: 'audio', entered: 0 }] }, 'original-video', verified, 'original-audio'), false);
  assert.equal(replacementVerified(replacement, 'original-video', verified, 'different-audio'), false);
});

test('an original audio consumer requires its own production verdict before measurement', () => {
  const witness = { consumerEvidence: [
    { id: 'audio', kind: 'audio', entered: 100 }, { id: 'video', kind: 'video', entered: 100 },
  ] };
  const verified = new Set(['video', 'unrelated-1', 'unrelated-2', 'unrelated-3']);
  assert.equal(initialConsumersVerified(witness, verified), false);
  verified.add('audio');
  assert.equal(initialConsumersVerified(witness, verified), true);
  assert.equal(initialConsumersVerified({ consumerEvidence: witness.consumerEvidence.map((entry) =>
    entry.kind === 'audio' ? { ...entry, entered: 0 } : entry) }, verified), false);
});

test('a recreation-phase error blocks the final pass gate', () => {
  const clean = { transformFailure: false, priorityUpdateFailure: false, pageErrors: 0 };
  assert.doesNotThrow(() => requireNoRuntimeFailure(clean));
  for (const bad of [{ transformFailure: true }, { priorityUpdateFailure: true }, { pageErrors: 1 }]) {
    assert.throws(() => requireNoRuntimeFailure({ ...clean, ...bad }), /Runtime media error/);
  }
});

test('candidate Electron binding refuses stale installed package, runtime and lock declarations', () => {
  const versions = { manifest: '^44.9.0', lockManifest: '^44.9.0', locked: '44.9.1', installed: '44.9.1', runtime: '44.9.1' };
  assert.doesNotThrow(() => requireElectronAlignment(versions, semver.satisfies));
  for (const bad of [{ installed: '44.9.0' }, { runtime: '44.9.0' }, { lockManifest: '^45.0.0' }, { locked: '45.0.0', installed: '45.0.0', runtime: '45.0.0' }]) {
    assert.throws(() => requireElectronAlignment({ ...versions, ...bad }, semver.satisfies), /Electron manifest\/lock\/installed\/runtime mismatch/);
  }
});

test('a ninety-second override cannot reduce the requested ninety-five-second gate', () => {
  assert.equal(requireDuration(95_000), 95_000);
  assert.equal(requireDuration(180_000), 180_000);
  for (const bad of [90_000, 94_999, 95_000.5, NaN, 180_001]) {
    assert.throws(() => requireDuration(bad), /95000\.\.180000/);
  }
});
