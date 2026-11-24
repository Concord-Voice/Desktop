# Real voice runtime probe

This opt-in probe drives two isolated, sandboxed Electron renderers through an actual
local mediasoup worker. It runs production `VoiceService` sender/receiver transform
hooks, `e2eeWorker`, `MediaEncryption`, camera encoding ladders, ICE diagnostics and the
production A/V sampling timer. It also runs an independent detector on unmodified
real stats. Continuous synthetic audio and video must decrypt and play for at least
95 seconds. Every normal five-second poll must advance both actual decoded and presented
frame counters within the progress deadline. The one terminal, clamped short poll may retain
the immediately preceding both-advancing proof only for the same consumer, nondecreasing
counters, and both ages within `VIDEO_STALL_MS`; retained proof cannot chain, admit startup,
or admit a new, stale, or regressed consumer. Camera reproduction retains the capture track,
requires strict new per-consumer counter advancement, and receives its own production
transform-verification verdict.

The fixture replaces account setup, key-service provisioning and signaling only.
It installs a fresh random test CSK and real transports into the production singleton.
It does **not** test login, join authorization, Socket.IO, RoomManager, key rotation,
screen capture or the app's complete receive-audio graph. No RTC object or `getStats`
method is mocked. Only production code increments `avSyncObservationCount`.

The detector positive control copies the real reports into a **separate** detector. It
baselines one finite namespaced audio/video remote-outbound pair, holds the copied video
offset steady, and applies a declared 2 ms/s slope to the copied audio offset. That makes
the control independent of ambient clock skew. It never mutates a `getStats()` entry, the
independent witness, or the production sampler. The healthy-call witnesses always use
untouched real reports; a tripped control proves only that the separate detector can trip.
Snapshots refused by normalization do not advance the control detector; the raw independent
witness still observes them. This prevents a paused Sender Report from mixing clock bases.

For each kind, the control admits a pair only when the inbound report's `remoteId` and the
remote-outbound report's `localId` link each other, their SR-derived timestamps advance, and
the link is unambiguous. An unlinked mediasoup probationary report is ignored; multiple
legitimate linked publishers are rejected rather than selected arbitrarily.

The normal continuous-call gate is at least 95 seconds. New observation cycles stop at
180 seconds. A final cycle admitted from 175 through 179.999 seconds may finish by 185
seconds only if it produces complete proof; an incomplete result at or after 180 seconds
fails and is never retried. A single peer may receive this recovery only when one late raw
`offset-step` has left its current measurement window without a usable verdict. Media
progress, E2EE, production/independent drift, and runtime errors still fail immediately.
Missing control evidence fails. During active incomplete-window recovery, another reset or
a different discontinuity fails; no peer is skipped. The 185-second bound is internal
completion handling, not a duration setting.
Failure summaries retain only bounded detector-reason labels and counters, never raw RTC
reports or IDs.

`independentCurrentWindowUsable` means the retained detector window has usable proof; it
does not mean the latest tick was usable. A non-discontinuity refusal such as
`sr-not-advanced` retains that history under the production detector contract. Reset counts
govern incomplete-window recovery, not lifetime failure: several early resets followed by a
clean 60-second window by the base deadline can pass. A second or different reset during an
active, incomplete extension fails at the next poll.

Run from a normal ephemeral Linux or macOS runner, as a non-root user, with supported
Chromium sandboxing and a display (Xvfb is suitable on Linux). The media worker lives in
the Self-Hosted repo, so check it out next to this one (`../Self-Hosted`). Install the
exact locked dependencies normally in both. No signing, secrets, database or .env is needed:

```bash
npm --prefix ../Self-Hosted/services/media-plane ci
npm --prefix desktop ci
cd desktop
MEDIA_PROBE_OUTPUT="$RUNNER_TEMP/voice-runtime.json" \
  node scripts/voice-runtime-probe/run.mjs
```

On a Linux runner with Xvfb already provisioned, prefix the command with `xvfb-run -a`.
The launcher explicitly requests Chromium sandboxing from Playwright; its Linux
default otherwise adds a flag that the fixture deliberately refuses.
Do not add `--no-sandbox`, disable isolation, or grant container capabilities to make it
pass. A host that cannot launch sandboxed Electron reports `NOT RUN`, exits nonzero and
cannot satisfy the media gate. The probe itself does not install host packages.

`MEDIA_PROBE_SERVER_DIR` may select another installed media-plane worktree (for example,
the server update under review). Its installed version must match its own lockfile.
`MEDIA_PROBE_DURATION_MS` defaults to 95000 and accepts only 95000..180000.
The run prints each stage change and wait to stderr. Every renderer wait and cleanup call
has its own deadline, and a watchdog (the duration plus 145 s) writes a `FAIL` result that
names the stuck stage and exits nonzero, so a hung run still leaves an artifact.
The two peer windows open side by side, and the fixture shell disables Chromium's
backgrounding of occluded windows: on macOS a fully covered window is backgrounded even
with `backgroundThrottling: false`, which starved the covered peer's video. If a consume
call still fails, the result's `consumeDiagnostics` records each window's visibility and
two samples of its video RTP counters (frames and keyframes encoded, PLI/FIR counts,
packets and frames received). Its last element is not a per-peer entry: it is `{ sfu: [...] }`
with the SFU's own view per peer (transport ICE/DTLS state and bitrate; producer and
consumer layers, scores and PLI/NACK counts; no ids), or `{ sfuError }` if that read failed.
A single entity whose stats read fails appears in place as `{ statsError }`.
For video startup, the fixture waits for the SFU receive transport's DTLS-connected
state before asking for a keyframe. It also replaces the live sender track once
as video consumption starts, with at most two more replacements while playback waits;
the real RTP sender, E2EE transform, decoder, and playback witnesses remain in use.
The existing supported `MEDIASOUP_WORKER_BIN` override can select an exact candidate
worker; record that separately from proving its ordinary installation/build path.
The artifact distinguishes the JavaScript package version from the resolved native
worker path and SHA-256. `MEDIA_PROBE_WORKER_SHA256`, when supplied from separately
verified candidate-artifact metadata, must match that native binary. Without it the
artifact explicitly reports native candidate digest binding as `NOT VERIFIED`; a
healthy runtime verdict does not establish upstream native-artifact provenance.
`MEDIA_PROBE_ELECTRON` may select an already installed executable; its actual version
must equal the resolved lockfile version, as must the installed package. Manifest and
root-lock declarations must agree and admit that resolved version. Missing `electron/path.txt`
without this override is an installation failure, never a reason for a lazy download.

The fixture's real-worker setup/ownership check can run without a display:

```bash
node --test scripts/voice-runtime-probe/local-sfu.test.mjs
node --test scripts/voice-runtime-probe/witness-contract.test.mjs
node --test scripts/voice-runtime-probe/audio-witness.test.mjs
```

Capture stdout or `MEDIA_PROBE_OUTPUT` as the CI artifact. `PASS` requires exact runtime
Electron/Chromium/Node/mediasoup versions, sandbox/isolation, real E2EE entered frames,
decoded synthetic content, selected ICE pair markers, a production sampler count above
zero, an independent usable/steady verdict, the separate detector fault control,
advancing decoded/presented frames, separately verified replacement consumers and
confirmed native-worker exit. Original verbose console logs,
keys, SDP and raw media stats are deliberately excluded from the artifact.

`markers.transformFailures` retains at most 32 fixed reason records with the peer index
and the stage at which the event was observed. Reasons are `bypass-reattach`,
`bypass-close`, `worker-error`, `encrypt-failed`, `decrypt-close`, `verified-payload-rejected`, and
`verified-jsonvalue-threw`. These records contain no console arguments or consumer IDs,
and any record still fails the runtime gate. An accepted verification requires a consumer
ID and a positive entered-frame count, matching the production verdict even when the
sample reports zero received packets. This does not prove the cause of older failures
that recorded only a boolean. During camera reproduction the artifact also records
elapsed milliseconds and peer index for close, reproduce, and replacement-consume calls.

Runtime evidence: on 2026-11-09, the repaired probe passed on macOS with sandboxed Electron
45.0.0 (Chromium 156.0.8078.48, bundled Node 24.22.0), mediasoup-client 3.25.3, and native
SFU 3.31.0. It ran 95.151 seconds: both peers produced steady usable raw windows (five and
six samples), normalized controls tripped, camera reproduction passed, and the native worker
closed. This run did not exercise late-reset extension and does not establish Linux behavior;
the deterministic detector test covers the 60-second rebase policy.

With the same runtime versions, the final observation-boundary repair passed a
maximum-duration macOS run at 180.009 seconds:
both peers had current usable windows (22 and 23 samples), normalized controls tripped, no
raw or production drift appeared, camera reproduction passed, and the native worker closed.
This confirms bounded completion at the configured maximum, not live late-reset recovery.

A startup preflight checks the production service members this test-only integration
uses and fails before key setup when that contract changes. No production test API is
added. Failures retain only allowlisted transport/ICE/audio states, media counters,
and worker/window/error classifications. They retain no raw console arguments,
identity, key bytes, SDP or RTC reports. Partial diagnostics cannot satisfy a PASS gate.
The Linux launch regression uses an argument recorder to inspect the real Playwright
process boundary; that unit test does not execute Electron or prove renderer behavior.

The synthetic remote-audio witness follows the app's modern receive graph: a muted
audio element pulls the same remote stream that feeds the waveform analyser. It
resumes the server consumer before awaiting playback, which has a ten-second bound.
The element remains muted and the graph's output gain remains zero; the waveform
must still exceed the existing RMS threshold. Cleanup pauses and releases the owned
element and nodes without stopping the consumer's track or closing the shared context.
The lifecycle tests do not prove actual decrypted audio; the real engine run must do so.
