import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTransformFailure, observeVerifiedTransform, recordTransformFailure, requireNoRuntimeFailure, verifiedConsumerId } from './witness-contract.mjs';

test('classifies transform errors without retaining console text', () => {
  for (const [text, expected] of [
    ['E2EE: receive transform BYPASSED — encrypted frames are reaching the decoder; re-attaching', 'bypass-reattach'],
    ['E2EE: receive transform still bypassed after re-attach — closing consumer fail-closed', 'bypass-close'],
    ['E2EE Worker error: sensitive text', 'worker-error'],
    ['E2EE: closing consumer because decrypt transform failed', 'decrypt-close'],
    ['E2EE: closing consumer because encrypt transform failed', 'encrypt-failed'],
  ]) {
    const failures = [];
    recordTransformFailure(failures, classifyTransformFailure(text), 1, 'camera-reproduce');
    assert.deepEqual(failures, [{ reason: expected, peer: 1, stage: 'camera-reproduce' }]);
  }
  assert.equal(classifyTransformFailure('healthy'), null);
  // Playwright can concatenate a console argument containing a newline; the
  // previous substring check still detected an error after that newline.
  assert.equal(classifyTransformFailure('context\nencrypt transform failed: detail'), 'encrypt-failed');
  assert.equal(classifyTransformFailure('xencrypt transform failedMore'), 'encrypt-failed');
});

test('failure records are bounded and keep the pass gate closed', () => {
  const failures = [];
  for (let i = 0; i < 40; i++) recordTransformFailure(failures, 'worker-error', 0, 'continuous-call');
  assert.equal(failures.length, 32);
  assert.throws(() => requireNoRuntimeFailure({ transformFailures: failures, priorityUpdateFailure: false, pageErrors: 0 }), /Runtime media error/);
});

test('verified payload accepts entered frames without packets, and failures keep peer and observed stage', async () => {
  assert.equal(verifiedConsumerId({ consumerId: 'c', entered: 1, packetsReceived: 0 }), 'c');
  assert.equal(verifiedConsumerId({ consumerId: 'c', entered: 0, packetsReceived: 10 }), null);
  const failures = [];
  const ids = new Set();
  assert.equal(await observeVerifiedTransform(async () => ({ consumerId: 'c', entered: 1, packetsReceived: 0 }), ids, failures, 0, 'camera-reproduce'), true);
  assert.deepEqual([...ids], ['c']);
  assert.equal(await observeVerifiedTransform(async () => ({ consumerId: 'secret', entered: 0 }), ids, failures, 1, 'camera-reproduce'), false);
  assert.equal(await observeVerifiedTransform(async () => { throw Error('secret'); }, ids, failures, 0, 'publish-consume'), false);
  assert.deepEqual(failures, [
    { reason: 'verified-payload-rejected', peer: 1, stage: 'camera-reproduce' },
    { reason: 'verified-jsonvalue-threw', peer: 0, stage: 'publish-consume' },
  ]);
  assert.throws(() => requireNoRuntimeFailure({ transformFailures: failures, priorityUpdateFailure: false, pageErrors: 0 }), /Runtime media error/);
});
