# Desktop voice runtime probe flake repair: plan

See [the design](../specs/2026-11-09-weekly-ci-flakes-design.md).

1. Keep the behavior-preserving extraction of the old copied ramp and fixed 95-second decision in `witness-contract.mjs` as the regression baseline.
2. In `witness-contract.test.mjs`, run the real A/V detector against opposing ambient skew and assert the old fork fails to trip. Cover strict bidirectional SR-linked `remoteId`/`localId` admission, an ignorable probationary report, rejection of ambiguous legitimate publishers, late-step recovery, missing/repeated-reset rejection, final-cycle completion, and no mutation.
3. Repair `createFaultControlFork` and `continuousCallDecision`, then wire redacted detector state through `page.mjs` and the monotonic-clock, clamped-final-poll `run.mjs` loop. New cycles stop at 180 seconds; a final 175..179.999-second cycle may complete by 185 seconds only with proof. Do not touch `avSyncDriftDetector.ts`.
4. Update the probe README and validate:

```bash
cd desktop
node --test --test-concurrency=2 scripts/voice-runtime-probe/local-sfu.test.mjs scripts/voice-runtime-probe/witness-contract.test.mjs scripts/voice-runtime-probe/audio-witness.test.mjs
npm run lint
npm run typecheck
node scripts/voice-runtime-probe/run.mjs
git diff --check
```

The real runtime command is the proof of Electron/libwebrtc behavior. It must run sandboxed; `--no-sandbox`, skipped control evidence, and a workflow rerun are not valid substitutes. Phase-8 review requires security, code, scope, test-analysis, and documentation coverage.
