# ADR-0043: Per-process screen-share audio via a first-party native addon, with a JSF++-constrained real-time core

> **Historical record, imported from Concord-Voice-Alpha (@771eb3c) at the repo split.** `client/desktop/` there is `desktop/` here. Issue numbers, `docs/superpowers/**`, `docs/runbooks/**`, `docs/ci/**`, `.claude/rules/*.md` (now `.claude/rules/domains/`), control-plane paths and ADRs not in this folder refer to Alpha or the private ops repos.

**Status:** Accepted (2026-09-07 — D1, D2, D4; see § Sign-off)
**Date:** 2026-09-07
**Deciders:** Mark (project lead) — see § Sign-off.
**Issue:** none (ad-hoc intake, 2026-09-07)
**Spec:** `docs/superpowers/specs/2026-09-07-screen-share-audio-and-switching-design.md`
**Related:** #2161 (window-share system-audio leak — the constraint this supersedes), #2162
(viewer-side screen-audio controls), #2163 (screen-share entitlement clamps), ADR-0038
(attachment placement — precedent for a per-object capability ladder)

## Sign-off

**Ruled by Mark (project lead) on 2026-09-07, in the `/dev-lifecycle` session that produced
this ADR: "I approve D1, D2, and D4 — update the ADR sign-off."** That covers D1 (build a
first-party native addon rather than vendoring or declining), D2 (the two-layer `rt/` + `napi/`
split with JSF++ binding only to `rt/`), and D4 as revised by the S1 spike — candidate 1,
`MediaStreamTrackGenerator` + `AudioData`, over the transferable-`ArrayBuffer` `MessagePort`
transport specified in D4c after `SharedArrayBuffer` was measured unavailable.

**The provenance is a session directive, not the linked comment URL this section originally
demanded, and that difference is recorded rather than papered over.** The prior text read:
*"Flips to Accepted only when it can cite a Mark-authored comment URL … Text asserting approval
without a linked artifact does not count."* That clause exists to stop an **agent** asserting an
approval nobody gave — a real hazard here, because `gh` authenticates as the repository owner, so
a comment written by an agent is indistinguishable from a Mark-authored one at the API. The
decision above was given directly by the decision-maker, so the clause's purpose is met while its
stated mechanism is not. Anyone auditing this should read it as: the approval is genuine and its
scope is quoted verbatim, and the citable artifact is this file plus the commit that sets it.

If a linked artifact is wanted after the fact, a one-line comment from Mark on
PR #3145 is enough, and its URL
belongs in this section.

**What this sign-off does NOT cover.** Spike **S2** (the Windows Application Loopback probe) is
still outstanding — § Verification lists it as a gate on the implementing PRs, not on this
decision, and approving D1/D2/D4 does not retire it. A negative S2 result does not reopen D1; it
would change what the Windows capture layer inside `rt/` is built on, and that belongs in a
follow-up ADR rather than here.

## Context

Screen-share audio today takes the legacy Chromium path: `getUserMedia` with
`chromeMediaSource: 'desktop'` (`voiceService.ts:3786`). That call captures the **whole system
render mix** and ignores `chromeMediaSourceId` for audio, so a window share cannot be scoped to
its window. #2161 closed the resulting leak by hard-coding `audio: false` for every `window:`
target (`voiceService.ts:3800`) — correct at the time, and the reason app shares are silent.

Three facts reopen the decision.

1. **Both platforms now ship per-process capture APIs.** Windows exposes
   `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` and
   `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` (Win10 build 20348+). macOS exposes
   CoreAudio process taps — `AudioHardwareCreateProcessTap` + `CATapDescription` (14.2, matured
   14.4+). Neither is reachable from Electron's JavaScript surface: `Streams.audio` accepts only
   `'loopback' | 'loopbackWithMute' | WebFrameMain` (`electron.d.ts:23747`), where the loopback
   values are whole-system and Windows-only, and `WebFrameMain` captures **our own** frames.

2. **Chromium is already migrating to this API family.** The `MacCatapLoopbackAudioForScreenShare`
   feature flag named in Electron's own `desktopCapturer` docs is Chromium adopting CoreAudio
   Taps. The platform is converging here; Electron simply does not expose per-process *selection*.

3. **Whole-desktop loopback is the mechanism behind a live user-reported defect.** A sharer on
   Windows reported audio feeding back into their own headset, growing until the box crashed,
   while the receiving participant heard nothing. Whole-desktop loopback captures the render
   endpoint — which includes Concord's own output — so the client re-captures what it plays.
   Per-process capture **cannot** exhibit this: a tap on the target process never observes
   Concord's render stream.

Point 3 is what moves this from a feature request to an architecture decision. Per-process
capture is not merely nicer for app shares; it removes a whole defect class by construction.

## Decision

### D1 — Build a first-party native addon; do not vendor, do not decline

Per-app audio requires native code. The industry split is instructive: one major comms platform built per-process
hooking and made it its primary mechanism (its support documentation states the capture
"hooks into individual application processes" and cannot take a whole-desktop mix); OBS ships
Application Audio Capture on the Windows API and has kept it labelled BETA for years; other major comms
platforms largely decline the problem and ship system-wide "share computer sound"; browsers do
per-*tab* only, because a tab is a process they own.

Existing npm wrappers exist (`application-loopback`, `mac-audio-capture`, `electron-audio-loopback`).
**Rejected.** A third-party native binary inside an E2EE client is a supply-chain decision with an
RCE-shaped blast radius, the candidates are small and thinly maintained, and CLAUDE.md requires
new dependencies be flagged for review. We own this code.

**Consequence:** this repository acquires its first native build toolchain. That is new CI
surface for `win32-x64`, `darwin-arm64` and `darwin-x64`, new code-signing obligations (the
`.node` binary must be signed and notarized inside the hardened runtime), and a packaging change
in `forge.config.ts` so a packed `.node` can be loaded at all.

> **Superseded in part by § D4 — RESULT of PR 5 (#3194).** This paragraph originally named
> `asar.unpackDir` as the change to make. That option is permanently non-functional here, so the
> shipped route ships the binary via `extraResource` instead and `unpackDir` stays `undefined`
> deliberately, not pending. The signing obligation stands, with the Windows half satisfied
> transitively — see that section.

### D2 — Two layers, one documented boundary

```
concord-audiocap/
  rt/      real-time capture core   — JSF++ binds here (D3)
  napi/    Node-API binding layer   — JSF++ explicitly does NOT bind here
```

`rt/` owns the platform capture callback and a single-producer/single-consumer lock-free ring
buffer. It allocates nothing, throws nothing, and never calls into JavaScript. `napi/` owns every
interaction with V8 — which allocates and (in `node-addon-api`'s default configuration) throws.

The boundary is not bureaucratic. A real-time audio callback that allocates or throws produces
audible dropouts; the same discipline that JSF++ imposes for flight software is what real-time
audio requires anyway. The two-layer split is what lets us hold the half that matters to the
strict standard without pretending the V8 half can meet it.

### D3 — JSF++ adoption profile

Adopted per the project lead's direction, **held loosely** and scoped to `rt/`. JSF++ grades its
own rules (§4, p.393-398): *shall* = mandatory and verifiable, *will* = mandatory, *should* =
advisory. We bind the *shall*/*will* rules listed below inside `rt/`, treat *should* rules as
advisory, and record every deviation in-tree rather than silently.

**Binding in `rt/` — these are load-bearing, not ceremonial:**

| Rule | Requirement | Why it earns its place here |
|---|---|---|
| AV 206 | No free-store allocation/deallocation after initialization | The audio callback must never allocate. This is real-time doctrine independent of JSF++ |
| AV 208 | No C++ exceptions (`throw`/`catch`/`try`) | Unwinding in an audio callback is unbounded-latency. Satisfied by using the C `node-api` at the seam and `NAPI_DISABLE_CPP_EXCEPTIONS` |
| AV 119 | No recursion, direct or indirect | Bounds stack depth in a callback with a fixed OS-supplied stack |
| AV 215 | No pointer arithmetic | The ring buffer indexes an array with bounds-checked integers. This is the one component where a memory-safety bug is reachable, and this rule is most of the mitigation |
| AV 115 | Every returned error is tested | The platform APIs are `HRESULT`/`OSStatus`-shaped; ignoring one is how a dead stream becomes silent-but-live |
| AV 142 | All variables initialized before use | — |
| AV 207 | No unencapsulated global data | Capture state is owned by one class, not file statics |
| AV 209 | Fixed-width typedefs, not bare `int`/`float`/`double` | Wire-format and sample-format correctness across two platforms |
| AV 189 / 197 / 201 | No `goto`; no float loop counters; loop counters unmodified in body | — |
| AV 20 / 22 / 24 / 25 | No `setjmp`/`longjmp`, `<stdio.h>`, `abort`/`exit`/`getenv`/`system`, `<time.h>` | An audio callback must not do I/O or terminate the process |
| AV 1 | ≤200 logical SLOC per function | — |

**Named deviations, decided now rather than discovered later:**

| Deviation | Scope | Rationale |
|---|---|---|
| JSF++ predates C++11 entirely (Rev C, December 2005) | `rt/` | We use `constexpr`, `enum class`, `std::atomic` and `= delete`. Every one of these *strengthens* the properties JSF++ is protecting. `std::atomic` in particular is how a lock-free ring buffer is written correctly in this century; JSF++ had no vocabulary for it |
| AV 206 (allocation), AV 208 (exceptions) | `napi/` only | N-API allocates to create JS values. Non-negotiable, hence the D2 boundary |
| Platform SDK headers violate many rules | both | Rules bind code we author, not `audioclientactivationparams.h` or `CoreAudio.h` |
| No STL container that allocates, in `rt/` | `rt/` | Follows from AV 206; stated explicitly because it is the rule most likely to be violated by reflex |
| AV 206, AV 207, AV 208, AV 215 | `rt/platform/macos/tap_backend.mm` **only** | The single file that names Core Audio, added by #3197 PR 2. Each is forced by the SDK, not chosen: a tap cannot be constructed without `CATapDescription` / `NSUUID` / `NSMutableArray` / an `NSDictionary` (AV 206), an Objective-C message send can raise `NSException` (AV 208) — contained because the file has no `@try`/`@catch`, so an uncaught raise terminates the process rather than unwinding through a `noexcept` frame; note this is NOT provided by `GCC_ENABLE_CPP_EXCEPTIONS: 'NO'`, which governs C++ exceptions only, `AudioDeviceCreateIOProcID` takes a bare C function pointer so the IOProc slots are file-scope (AV 207, both `std::atomic`), and `AudioBufferList::mBuffers` is a C flexible-array member (AV 215). **The allocation is confined to the start path and never the audio callback** — which is the property AV 206 is defending, and `ioProcThunk` still honours it in full. Approved 2026-09-11 during PR #3265 review. **Scoped deliberately to this one file:** #3196's Windows backend raises its own rather than inheriting these, because WASAPI's constraints are not Core Audio's |

The profile lives in `.claude/rules/native-audio.md` so it routes by path glob to anyone editing
`rt/`, and so the deviation list has one authoring site rather than being restated per review.

### D4 — PCM transport: decided by spike S1, candidates fixed here

Capture is the easy half. The captured PCM lands in a native process and mediasoup needs a
`MediaStreamTrack` in the renderer. Candidates, in preference order:

1. **`MediaStreamTrackGenerator`** (Insertable Streams) — write `AudioData` frames, receive a real
   track. Cleanest available path, and the team already works with encoded transforms via
   `produceEncrypted`. Risk: the generator API has been in flux in Chromium.
2. **`AudioWorklet` + `MediaStreamAudioDestinationNode`** — the conservative fallback. Well-trodden,
   more moving parts.

Transport under either: a **`SharedArrayBuffer` ring buffer** allocated once at start, written by
`rt/` and read by the renderer. Zero-copy and zero-allocation in steady state, which is what makes
AV 206 hold end-to-end rather than only inside `rt/`. 48 kHz stereo float32 is ~384 KB/s; copying
that through structured-clone IPC every quantum is the thing to avoid.

**Rejected: a virtual audio device** (a historical approach of major meeting apps). Driver-class install,
kernel-adjacent signing, and a user-visible device left behind in the OS. Disproportionate.

### D4 — RESULT of spike S1 (measured 2026-09-07, Electron 43.5.1 / Chromium 150.0.7871.250)

Measured in the real Electron runtime we ship, not a browser. Three findings, one of
which invalidates this ADR's original transport proposal.

**1. `MediaStreamTrackGenerator` for audio exists and works. Candidate 1 is viable.**
`new MediaStreamTrackGenerator({kind:'audio'})` constructs, exposes `.writable`, and
round-trips `AudioData` through a real `MediaStreamTrack`. Note `VideoTrackGenerator` is
**absent** while the audio generator is present — so the API churn this ADR worried about
resolved in our favour: the audio generator is the surviving form, not a deprecated one.

**2. Paced, the path is effectively free.** 48 kHz stereo, 10 ms quanta, 2 s of audio:

| | |
|---|---|
| Frames read back | **200 / 200 (100%)** |
| Wall clock vs audio | 1992 ms for 2000 ms — real time held |
| Added latency | **p50 0.1 ms · p95 0.1 ms · p99 0.2 ms · max 0.2 ms** |

Sub-millisecond at p99. The transport is not where a latency budget goes.

**3. UNPACED, IT SILENTLY DROPS. This is the operational constraint.** The first run wrote
3 s of audio as fast as the writer accepted it — 2.6 ms wall, ~1150× real time, zero
backpressure waits — and **only 10 of 300 frames were ever read back**. `MediaStreamTrackGenerator`
neither paces nor applies backpressure: it accepts everything and quietly discards what it
cannot place. A bridge that bursts loses audio *and reports success*, which is the same
silent-failure shape as the macOS dead-stream bug in D7. The native side must deliver at
capture rate and the bridge must never catch up by bursting.

That first run also produced a number worth naming so nobody re-derives it as good news:
its "p50 0.2 ms latency" was measured over the 10 surviving frames and meant nothing. A
latency figure from an unpaced writer is not a latency figure.

**Recommendation (D4 remains the project lead's to rule):** candidate 1,
`MediaStreamTrackGenerator` + `AudioData`. Candidate 2 (`AudioWorklet` +
`MediaStreamAudioDestinationNode`) is present and stays the fallback, but has more moving
parts for no measured benefit.

### D4c — `SharedArrayBuffer` is NOT available; the ring-buffer transport is revised

The original D4 specified a `SharedArrayBuffer` ring buffer, "zero-copy and zero-allocation
in steady state". **Measured: `SharedArrayBuffer` is `undefined` and `crossOriginIsolated`
is `false` in the app's renderer.** SAB requires cross-origin isolation (COOP/COEP), which
this app does not set and cannot adopt casually — it loads a remote SPA, and isolation would
require every cross-origin resource to carry CORP headers or stop loading.

So the sanctioned transport is **transferable `ArrayBuffer`s** over the utilityProcess
`MessagePort`: each capture quantum is posted with a transfer list, so ownership moves
without copying the samples. It is not allocation-free the way a shared ring buffer would
have been, which makes finding 3 above sharper — the pacing discipline is now the only thing
standing between a burst and dropped audio, rather than one of two.

**Enabling cross-origin isolation to recover the SAB design is explicitly out of scope**
and should not be reopened without its own ADR. The measured latency makes it unnecessary:
0.2 ms at p99 leaves nothing worth buying.

**Flow control is part of this decision, not an implementation detail.** A `MessagePort`
queue is unbounded by construction, and S1 measured what happens when the reader falls
behind: an unpaced writer delivered **10 of 300 frames** and `MediaStreamTrackGenerator`
reported nothing — no exception, no `drop` event, no counter. Silent loss is the native
failure mode here, so the policy has to be stated up front rather than discovered in
production.

The sanctioned policy:

- **The producer is the clock.** The native side posts one quantum per capture callback and
  never batches to catch up. There is no timer on the renderer side asking for more; the
  device's own cadence is the pacing signal, which is what made the paced S1 run deliver
  200/200 at p99 0.2 ms.
- **Credit-gated posting, bound 8 quanta (~80 ms at a 10 ms quantum).** The addon holds an
  outstanding counter: incremented at `postMessage`, decremented on the renderer's
  acknowledgement. **At the bound it does not post at all** — the new quantum is dropped at
  the sender and the counter is untouched.
- **The drop is the NEWEST, and that is forced, not chosen.** An earlier revision of this
  section said "drops the oldest", which is not implementable: once a buffer is posted its
  ownership has transferred and a `MessagePort` exposes no sender-side operation to withdraw
  or reorder it. A sender-side counter can therefore only decide *whether to post*, never
  *what to unpost* — so a policy that must discard has exactly one candidate, the quantum in
  hand. Anything phrased as bounding the queue after the fact is describing a mechanism the
  transport does not have.
- **Never block the audio callback.** Both the credit check and the drop are non-blocking. A
  wait inside a real-time capture thread is unbounded-latency by construction, which is what
  JSF++ AV 208 forbids at this seam — so back-pressure can only ever be expressed as a drop
  here, not as a stall.
- **Credit is one acknowledgement per consumed quantum**, posted back over the same port.
  It is a counter, not a request: the renderer never asks for a specific number of frames,
  it only reports what it has drained.
- **Overrun is observable or it is not a policy.** Every drop increments a counter carried
  on the next quantum's header, and the renderer surfaces a non-zero value the way
  `voiceTransformBypass` surfaces a bypass — as a visible fault, not a log line. The whole
  point is that this failure was invisible in S1; a bound that fails as quietly as no bound
  buys nothing.
- **Test obligation for the implementing PR:** a renderer-stall test that holds the reader
  for longer than the bound and asserts three things — **outstanding posted-but-unacknowledged
  buffers never exceed 8** (measured on the port, not read off the addon's own counter, since
  the counter is the thing under test), the drop counter is non-zero, and it reaches the
  renderer. A test that only asserts audio resumes afterwards passes against the unbounded
  version, and one that only reads the addon's counter passes against a counter that lies.

### D4 — RESULT of PR 4 (build toolchain, landed 2026-09-07)

The toolchain exists: `client/desktop/native/concord-audiocap/` with the `rt/` +
`napi/` split, the JSF++ profile enforced mechanically, `QuantumRing` under test and
fuzzed, and CI across three platforms and four architectures. **PR 4 ships NO
packaging change** — an earlier draft of this line claimed `asar.unpack` landed, which
finding 5 below then contradicted in the same section. It does not land, it cannot
currently land, and PR 5 must pick a route before a packaged build can load the
addon. Four results change what
later PRs should assume.

**1. There are no new npm dependencies, and there need not be.** The seam uses the
plain C `node_api.h` rather than `node-addon-api`. That is D1's own supply-chain
argument applied to our own build — rejecting a third-party native binary in an E2EE
client and then adding one to compile it would be the same reasoning pointed the
wrong way — and it satisfies AV 208 at the seam *by construction*, since the C API
has no exceptions to disable. `node-gyp` moves from a transitive dependency of
electron-forge to a declared `devDependency`; that is a new declaration of a package
already in the tree, not a new package.

**2. One build serves both runtimes. This corrects the usual assumption.** The
Electron-targeted artifact loaded cleanly under Node 26, whose `NODE_MODULE_VERSION`
differs from Electron 43's. That is N-API doing what it exists for (`NAPI_VERSION=8`):
a NAN or raw-V8 addon would have been rejected. `--runtime=electron` selects headers
and, on Windows, the `node.lib` to link against; it does **not** make the artifact
runtime-specific. Consequences worth acting on: CI needs no Electron install to
exercise the addon, and no PR should add a per-runtime rebuild step on the assumption
that one is required.

**3. Sanitizers cannot be a local gate, so they are a CI gate.** ASAN and TSAN map
large fixed shadow regions, which a sandboxed shell can refuse — the runtime then
hangs or segfaults with no diagnostic, which reads exactly like a test failure and is
not one. The sanitizer legs therefore live in `native-audiocap.yml` on Linux runners,
across `address+undefined`, `thread`, and a 120 s libFuzzer smoke run. `-fno-sanitize-recover=all` is set on the
UBSAN leg deliberately: UBSAN's default is to print and continue, which exits 0 and
reports a green job while having found the defect.

**4. Falsifying the ring's tests found a gap the ADR had not named, and one
non-defect.** Seven mutations were injected and each had to turn the suite red.

- **A single-threaded test structurally cannot catch a weakened memory ordering.**
  Relaxing `push()`'s release store left every sequential test green. A concurrent
  producer/consumer test with self-verifying payloads catches it on **arm64**, whose
  weak ordering makes the reordering observable — but CI runs on x86-64, where TSO
  makes a relaxed store behave almost identically and that same test would very
  likely stay green. **That is why TSAN is in the matrix**, not thoroughness: it
  detects the missing happens-before edge directly instead of hoping the hardware
  reorders during a particular run.
- **`(int32_t)w - (int32_t)r` is not a defect.** It has the same bit pattern as the
  unsigned subtraction in two's complement, so for the small differences this ring
  deals in it returns an identical answer — UB under the standard, but nothing a
  compiler miscompiles here. The wrap-safety property is genuinely broken by
  comparing *absolute* values (`|| w < r`), which is what the rollover test now pins.
  Recorded so the next reviewer does not "fix" a correct line.

**5. BLOCKER FOUND — `asar.unpack` is non-functional in this repo, so D1's stated
packaging change cannot be made as written.** This corrects a claim made in the first
draft of this section: `asar.unpack: '**/*.node'` was described as landing "inert".
It is not inert. Setting either `unpack` or `unpackDir` switches `@electron/asar`
onto a code path that **crashes packaging**:

```
TypeError: (0 , minimatch_1.default) is not a function
    at shouldUnpackPath (@electron/asar/lib/asar.js:147)   // via `unpack`
    at isUnpackedDir     (@electron/asar/lib/asar.js:54)   // via `unpackDir`
```

**Two frames, corrected by #3194.** This block recorded only `:147`, which is the `unpack`
path. Setting `unpackDir` *alone* leaves `unpack` undefined, so `:147` is guarded by
`if (unpack)` and never runs — that throw comes from `isUnpackedDir` at `:54`, and only when its
`startsWith` short-circuit fails. Both levers crash, so the decision below is unaffected; but a
reader who tested the claim as written would not have reproduced it and could reasonably have
concluded the record was wrong.

`@electron/asar@3.4.1` declares `minimatch ^3.0.4` and calls its DEFAULT export;
`client/desktop` overrides minimatch globally to `^10.2.6`, and minimatch dropped the
default export at 9. The path is only reached when one of those options is set, which
is why this went unnoticed — both have been `undefined` for the life of the override.

**The minimatch override is not the thing to change.** It is security-validated (it
clears four advisory floors), its governing principle is that every skew is UPWARD,
and `client/admin` recorded "Do not re-add a minimatch pin below 10" in PR #2715.
Capping asar back to minimatch 3 to make an unpack glob work would invert all of that.

So D1's consequence — "a change to `forge.config.ts` `asar.unpackDir`" — is not a
one-line edit. **Three routes, and the choice is a dependency/architecture decision
rather than an implementation detail.** Ruled by PR 5 — see § D4 — RESULT of PR 5,
below. The list that follows is the choice as it stood, kept for its reasoning:

1. Override `@electron/asar` to `^4.3.0`, which declares `minimatch ^10.0.1`. Fixes
   it at the source and the skew is upward, consistent with the override policy — but
   `@electron/packager@18.4.4` declares `^3.2.13`, so it forces a MAJOR onto the
   release packaging path and needs its own validation.
2. Ship the addon via **`extraResource`**, which this config already uses, instead of
   unpacking it from the archive. Touches no dependency at all; the loader resolves
   through `process.resourcesPath` rather than a relative `require`.
3. Wait for `@electron/packager` to move to asar 4.

PR 4 therefore ships **no packaging change**, and the loader fails loudly in a
packaged build rather than falling back silently. Route selection belongs to PR 5.

### D4 — RESULT of PR 5 (#3194)

**Route 2 chosen: the `.node` ships via `extraResource`.** It touches no dependency, which is its
whole advantage over route 1, and `extraResource` was already a five-entry `existsSync`-guarded
pattern in `forge.config.ts` with a CI-hard-fail precedent. Route 1 forces an `@electron/asar`
3→4 major onto the release packaging path under `@electron/packager@18.4.4`'s declared `^3.2.13`,
to buy what `extraResource` already provides. Route 3 has no owner and would block the epic
indefinitely. A fourth candidate surfaced during PR 5 and is **closed, not pending**: Forge's
`plugin-auto-unpack-natives` writes the same `asar.unpack` key and hits the identical crash, and
is not installed, so it would also be a new dependency against D1's own supply-chain reasoning.

**`asar.unpackDir` stays `undefined` permanently.** The blocker is not awaiting a fix — the
minimatch-10 override is security work that is not capped back, so route 2 routes *around* the
blocker rather than clearing it. Electron's own asar documentation names `--unpack *.node` as the
canonical way to ship a native module; this repository deliberately diverges, recorded here so a
future reader does not find those docs and rediscover the crash.

**The loader JS ships INSIDE `app.asar`; only the opaque binary leaves.** Executable code
entering a Node-privileged process stays under `EnableEmbeddedAsarIntegrityValidation`. This costs
a narrowed `ignore` lookahead admitting both `/native` and `/native/concord-audiocap` — the copy
filter is consulted on a directory *before* descending, so excluding either level suppresses the
subtree while every per-file assertion stays green — plus a new required top-level `/native` entry
in the archive, with a matching depth assertion in `verify-asar-payload.sh`.

**Main resolves the path; the loader does not.** Route 2's sketch above said the loader "resolves
through `process.resourcesPath`". The shipped design refines that: a `utilityProcess` child has no
`app` module and therefore cannot ask `app.isPackaged`, so main resolves and passes
`CONCORD_AUDIOCAP_PATH` on the fork env. `resolveNativeAddonPath` is pure and unit-tested.

**CI now builds the binary, and this was the gap PR 5 nearly shipped without.** `build/` is
gitignored and `build-desktop.yml` had zero references to `build:native`, so `existsSync` was
false at `electron-forge make` on every leg — a guard-only `extraResource` push would have shipped
nothing, on every platform, with every leg green. The step is added to `pr-smoke-build` and all
six `release-build` legs, uses the **Electron-ABI** `build:native` (not the Node-ABI
`build:native:node` that `native-audiocap.yml` loads), and is guarded on `runner.os != 'Linux'`
because the addon is win32+darwin only and a Linux leg's absence is correct.

**R4 — the Windows `.node` is signed transitively, and that is a decision.** The trusted-signing
step filters `exe` under `out/make`, so it does not reach a `.node` in the payload; the binary
ships inside an already-signed NSIS installer. The filter is deliberately **not** widened. D1
above states the obligation as "signed and notarized inside the hardened runtime" — on Windows
that is satisfied by the enclosing installer or not at all, and this records which.

**R6 — Route 2 places the binary outside `EnableEmbeddedAsarIntegrityValidation`, and for the
BINARY that is not a regression relative to route 1.** `app.asar.unpacked` is equally outside
integrity validation, so the blocked route offered no protection here either. On macOS the code
signature covers the file — `@electron/osx-sign` signs `.node` anywhere in the bundle and
`Contents/Resources` is under the `CodeResources` seal; on Windows there is no equivalent, which
is R4 restated.

> **CORRECTION (#3194 red-team, F1).** An earlier revision of this section generalised the
> sentence above into "local replacement is a restatement of pre-existing local-write risk."
> **That is true of swapping the Mach-O and false of the environment channel**, and the
> difference is the sink: the loader's sink is `require()`, not `dlopen()`. A `require()` target
> need not be a Mach-O, so a `.js` payload bypasses macOS library validation, Windows
> Authenticode and asar integrity *simultaneously* — none of them is consulted, because no signed
> binary is loaded and nothing is written into the bundle. `codesign --verify` stays green and
> macOS App Management never prompts. The channel therefore needs **less** privilege than the
> disk-write route and defeats a control that route does not, with `capability()` becoming
> attacker-authored and free to forge `perProcessAudio: true` — #2161's defect.
>
> Closed by making `CONCORD_AUDIOCAP_PATH` a value that must **agree** with the single path the
> loader derives from `process.resourcesPath`, rather than one that **specifies** what to load.
> An allowlist of one; no traversal scrubbing, no extension check, no second expressible target.
> Main sets the variable only when packaged and strips an inherited one otherwise, so a hostile
> value cannot even reach the child as a dev-mode denial of service.
>
> **The lesson generalises past this file:** "the artifact is signed" is not a mitigation when
> the loader will accept an artifact that does not need to be signed at all. Ask what the sink
> accepts, not what the intended payload is.

> **SECOND CORRECTION (#3194 red-team, VULN-1) — R6 is false for the disk-write route too, on
> different grounds.** The correction above rescued the Mach-O half of R6: swapping the binary
> was said to be "a restatement of pre-existing local-write risk", and that was accepted as
> true. It is not. The utility process is hosted by the plain `Helper.app`, which
> `@electron/osx-sign` signs against `default.darwin.plist` — that profile does **not** carry
> `com.apple.security.cs.disable-library-validation` (only `default.darwin.plugin.plist` does,
> and it is applied to `(Plugin).app`, which is not the utility host). So macOS library
> validation genuinely *does* block a swapped Mach-O, and local write into `<Resources>/` was
> **not** by itself equivalent to code execution.
>
> What made it equivalent was the sink again, one level deeper than F1 reached. The F1 fix pins
> the PATH; it did not pin the OBJECT at that path, and `require()` resolves a **module**, not a
> file. A **directory** named `concord_audiocap.node` resolves `index.js` inside it as a
> CommonJS package; a **symlink** resolves to its realpath, so the `.js` handler runs instead of
> the `.node` one. Either executes attacker JS in the privileged process through the *accepted*
> branch of the allowlist — again with no Mach-O loaded, so library validation, Authenticode and
> asar integrity are all bypassed exactly as in F1. Reproduced with a working proof-of-concept.
>
> Initially addressed with an object-type gate between the allowlist and the sink: `lstatSync`
> refused anything that was not a regular file. That blocked standing directory and symlink
> payloads but did not bind the object later consumed by `require(target)`; see the correction
> below. The CI assertion remains useful independently: `[ -s ]` is TRUE for a directory, so the
> packaged payload check still requires a regular, non-symlink, non-empty file.
>
> **The lesson, sharpened:** F1's lesson was "ask what the sink accepts". VULN-1 is what that
> question looks like when you answer it only halfway — the allowlist reasoned about *strings*
> ("no traversal to scrub, no extension to check, no second expressible target") while the sink
> consumes *filesystem objects*. Pinning the name of a thing is not pinning the thing.

> **THIRD CORRECTION (2026-09-13, native-loader TOCTOU).** `lstatSync` did not bind the
> object later consumed by `require(target)`, so replacement between those operations could
> still reach CommonJS resolution. The loader now calls `process.dlopen` directly with the
> canonical filename; a directory or JavaScript symlink can fail native loading but cannot
> become `index.js`. This closes the JavaScript-resolution route, not arbitrary replacement of
> native code by an actor already able to modify the trusted Resources payload.

**R5 — macOS notarization of a `Resources`-resident Mach-O is UNVERIFIED at time of writing.**
Whether `@electron/osx-sign`'s defaults walk `Contents/Resources/` and sign a `.node` there, and
whether notarization then accepts it under the hardened runtime, cannot be settled from source. A
local signed `npm run package` on darwin settles the signing half; notarization settles at the
first `release-build` after merge. Do **not** reach for `optionsForFile` — it caused a silent
codesign hang (#403).

**The Windows floor constant is PROVISIONAL and remains S2's to settle.**
`kWindowsProcessLoopbackFloorBuild = 20348` is written alone and named in
`napi/addon.cc` precisely so that a hardware result is a one-line edit rather than a
hunt. The standalone probe that produces that result is in
`client/desktop/spikes/s2-windows-loopback/` and needs no live client.

### D4a — Resolving a picked source to a target process (gap closed 2026-09-07)

Both platform APIs are addressed by **process**, and the picker yields an Electron source
id. Nothing in `DesktopCapturerSource` carries a PID, so an earlier revision of this ADR
left the link unspecified — a hole big enough to sink the design, since without it there is
nothing to tap.

Electron's window ids are `window:XX:YY`, where **XX is the `HWND` on Windows and the
`CGWindowID` on macOS** (YY distinguishes web contents within one top-level window). Both
map to a PID with one native call:

| Platform | Handle in the id | Call |
|---|---|---|
| Windows | `HWND` | `GetWindowThreadProcessId(hwnd, &pid)` |
| macOS | `CGWindowID` | `CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, id)` → `kCGWindowOwnerPID` |

The resolution happens in `napi/`, not `rt/` — it runs once per share, not per audio
callback, and it touches OS handle APIs that no JSF++ profile should be asked to cover.

**The id is parsed, never trusted.** A renderer supplies it, so `napi/` validates the shape,
rejects anything that does not resolve to a live window, and the capture fails closed rather
than falling back to a system-wide tap. A malformed or stale id must never silently widen the
capture — that is #2161's failure mode wearing native clothes.

**The sixth `napi/` export is called in the capture CHILD, never in main (#3198, decided ahead
of PR 2's implementation).** An earlier design pass assumed the resolver could run in main, on
the theory that "unresolvable" should be learned before capture starts. That is invalidated by
what the tree already does: `audiocapChild.ts` is the only `require` of
`native/concord-audiocap` anywhere under `client/desktop/src/` — `audiocapHost.ts` forks the
child and speaks to it over `parentPort`, but never loads the addon itself. Calling the resolver
from main would mean `dlopen`-ing memory-unsafe native code into the process holding SSO tokens
and the update path, which collapses D5 below. The resolver therefore runs in the child,
immediately before `start()`: main parses the picker's `window:XX:YY` id into a `u32` window
handle (`parseWindowSourceId`, `client/desktop/src/shared/`) and sends only that handle across
the existing `parentPort` control set — a widened `AudiocapStart.windowHandle: number`, not a
fifth message kind. The child resolves the handle to a PID and, on failure, reports a new
`'target'` fault stage (`AudiocapFaultStage`) that main maps to a new `'target-unresolved'`
`ScreenAudioDegradeReason`, distinct from `'no-backend'` — a mechanism string naming the wrong
mechanism would tell the user "this machine cannot do per-process audio" when the truth is "we
could not find the process behind that window". No OS tap is created before this point, so
"before capture" is satisfied in the sense that matters even though the resolver's call site is
technically inside the same process that will host the tap.

### D4b — Risk register

Ranked by what would actually stop this shipping. Each row names what retires it, because a
risk with no retirement plan is a wish.

| # | Risk | Why it is the risk it is | Retired by |
|---|---|---|---|
| **1** | **The PCM→`MediaStreamTrack` bridge** | Capture is the easy half. The bytes land in a native process and mediasoup wants a track in the renderer; there is no direct seam, and the wrong choice here costs latency on every share | **S1.** Build both candidates against a synthetic source and measure. Non-negotiably first |
| **2** | **The window's PID is not the process rendering the audio** | Modern apps render audio from a helper. Chrome's audio service is a child of the browser process, so `INCLUDE_TARGET_PROCESS_TREE` from the window's PID should cover it — *should*, unverified. This is the single most likely cause of "shares video, no audio", and it is why OBS still ships theirs as BETA and why one major comms platform's is a perennial support topic | **S2**, against a fixed app matrix (Chrome, Electron app, Spotify, VLC, a game, a Java app), plus D6's fail-closed ladder so a miss degrades to an explained silence rather than a lie |
| **3** | **The Windows floor may be Windows 11, not Windows 10** | Microsoft's sample states build **20348**, which is Server 2022 — *above* Win10 22H2 (19045). If that is a runtime floor rather than an SDK floor, consumer Windows 10 gets nothing, which changes who this feature is for. Sources disagree; some place the API at 20H1 (19041) | **S2** must probe at RUNTIME on a real Win10 22H2 box. Do not settle this from documentation |
| 4 | Memory-safety bug becomes RCE in an E2EE client | New attack surface that did not exist in the desktop client | D5 isolation, D3's rule profile, fuzzing the ring buffer, ASAN/UBSAN gating merges |
| 5 | Signing, notarization, packaging route, per-arch CI | First native toolchain in this repo; a packed `.node` cannot load, so the binary must reach disk some other way | **SETTLED by PR 5 / #3194** — route 2 (`extraResource`), CI native-build step on both packaging jobs, macOS signing verified locally. `asar.unpackDir` stays `undefined` permanently. Notarization (R5) remains unverified until the first release build; Windows signing is transitive via the NSIS installer (R4). See § D4 — RESULT of PR 5 |
| 6 | Long maintenance tail | Every prior implementation of this has one | Accepted deliberately; the fallback ladder means a regression degrades rather than breaks |

**Sequencing follows the register, not the feature list.** S1 and S2 come before any addon
code, because risks 1-3 can each invalidate the design and all three are cheap to test and
expensive to discover in PR 5.

**Risk 2 is NOT retired on macOS, and #3197 PR 2 cannot retire it (measured 2026-09-11).**

Two additions to that row:

1. **Its macOS mechanism is now known and is worse than "the PID might be wrong".**
   `kAudioHardwarePropertyTranslatePIDToProcessObject` returns **`noErr` while yielding
   `kAudioObjectUnknown`** for a PID with no audio object. A backend that tested only the
   `OSStatus` would hand `kAudioObjectUnknown` to `CATapDescription` as though it were a resolved
   target — fail-open, on the exact path this risk is about. PR 2 tests both, and a fake-HAL case
   pins it.
2. **The app matrix that retires this risk has an unstated precondition and is currently
   UNRUNNABLE.** Without the *System Audio Recording Only* grant (see the D7 correction), every
   tap is silent regardless of target — so every row of the matrix would record "silent" and mean
   nothing. A matrix run without that grant produces a confidently wrong result. The precondition
   must be held and recorded before the matrix is run.

   **Correction (#3394 PR 2, 2026-09-23):** the precondition above is misattributed. E4 measured a
   tap carrying signal with the *System Audio Recording Only* grant denied, so that grant is not
   what makes an owner-only matrix run UNRUNNABLE. E1 measured the actual cause: an owner-only
   target records silence for every helper-rendered app regardless of grant state. The
   precondition is tree targeting (§3 of the #3394 PR 2 design) plus a recorded responsible-process
   grant state — not the audio-only grant alone.

### D5 — The addon runs in a `utilityProcess`, not in main

Electron's `utilityProcess` can load native modules and connect to the renderer over a
`MessagePort`. Putting the addon there means a memory-safety bug in `rt/` does not own the main
process — which holds the SSO tokens, the update path, and every privileged IPC handler.
`nodeIntegration` in the renderer stays off, per CLAUDE.md, so the renderer is not a candidate host.

### D6 — Capability ladder, fail closed, and the #2161 invariant survives

Per-process capture is not universally available. The ladder, resolved per share:

| Condition | Behaviour |
|---|---|
| Windows ≥ build 20348, target process resolved | Per-process capture. Audio is that app's, and only that app's |
| macOS ≥ 14.4, target process resolved, **and the responsible process holds Screen Capture (and, per E4, Microphone)** | CoreAudio process tap, same guarantee. **Restated (#3394 PR 2, citing the D7 corrections above):** the gating grant is the responsible process's Screen Capture/Microphone state, not the audio-only grant — E4 measured a tap carrying signal with the audio-only grant denied and those two held; which of the two carried it is undetermined |
| macOS ≥ 14.4, target resolved, **and the responsible process holds neither** | The capture RUNS and delivers silence. See the D7 correction below: every Core Audio call returns `noErr`, the IOProc fires on schedule, and every sample is zero. Nothing at the capture seam distinguishes this from a quiet app. **Measured on macOS 26.6.2 only** — 16 runs, nine candidate causes eliminated. Whether 14.4 through 15.x behave identically is UNTESTED, and the D7 correction gives a positive reason to doubt it: the two-service TCC split it describes is a macOS 26 change, so the consent gate this row depends on may not have the same shape on earlier releases. The handling is the same either way — the silence detector keys on content, not on a version — so this is a gap in the evidence, not in the code |
| Full-screen/monitor target | Whole-system mix (R3 wants exactly this), via the existing loopback path |
| Below the OS floor, or process unresolvable | **Video-only, and the UI says so.** Never silently fall back to whole-system audio on a window target |

The last row is #2161's invariant, restated. It moves from renderer code into the capability
resolver and gets a regression test that asserts a window target can never obtain a system-mix
track — including when the renderer asks for one.

**Two facts feed this ladder, on two different lifetimes, and #3198 PR 1 is careful not to
merge them.** The *machine* claim ("does this hardware/OS combination carry a per-process
backend at all") is pushed to the renderer exactly once per its own lifetime, over
`audiocap:capability` (IPC contract 28 — see `electron.md` §
"IPC contract v28"), written only from a validated `hello` and held in
`voiceStore.machineScreenAudioCapable: boolean | null`. The *share* claim ("did this
specific window's PID resolve") is per-share, never reaches the renderer, and is resolved
entirely on the main-process/child side (D4a above). `canCarryScreenAudio`'s third parameter is
always the machine-level boolean — never a per-share result — which is why `'per-process'`
stays unreachable until PR 2 threads `start({ targetPids })` through the second fact. A `null`
or `undefined` machine snapshot (not yet arrived, or a shell below contract 28) resolves to the
pre-addon rungs exactly like `false`: absence is the fail-closed state, never "audio is fine".

**The monitor / full-screen row stays on the Electron loopback permanently — the addon is never
consulted for it.** `CaptureScope::kSystemMix` remains declared-and-unreachable in `rt/`:
`rt::buildTarget` never emits it, and a grep-shaped regression test
(`client/desktop/tests/unit/renderer/services/voice/screenAudioD6.test.ts`, added in #3198 PR 1)
asserts no production code outside `rt/capture_backend.h` ever assigns it — deliberately not
"the identifier appears nowhere", since the native test suites hand-assign it to prove
`buildTarget` refuses to produce it. **This is now in conflict with a comment left in the native
code**, and the conflict is recorded here rather than silently fixed, because PR 1 is
TypeScript-only and does not touch native code: `native/concord-audiocap/napi/addon.cc:1197`
reads "When #3198 resolves a monitor target it adds an explicit option here and sets
kSystemMix." That prediction is superseded by the ruling above — #3198 resolves a per-**window**
target only; the monitor row was never in scope for the addon and does not gain one. **PR 2 item:
correct or remove that comment** when native code is next touched for this feature.

**Where the macOS floor is ENFORCED (#3197 PR 2).** In `rt::platformBackend()`, which returns
`nullptr` below 14.4 — not in `capability()`. `capability()` is a probe and nothing obliges a
caller to consult it before `start()`, so a floor enforced only there is a floor a caller walks
around. The `@available(macOS 14.2)` guard protecting the weak tap symbols sits strictly *inside*
that 14.4 check; below the floor no backend object exists, so there is no `start()` that must
remember to test a version before touching a weak symbol.

### D7 — macOS `NSAudioCaptureUsageDescription` ships immediately, ahead of all of this

**Shipped.** `forge.config.ts` `extendInfo` (`client/desktop/forge.config.ts:370`) now carries
`NSAudioCaptureUsageDescription` alongside `NSMicrophoneUsageDescription` and
`NSCameraUsageDescription`. Electron 43's docs were explicit about the risk this closed: without
it, macOS 14.2+ capture "will create a dead audio stream without warnings or errors," and the
existing `try/catch → video-only` fallback cannot observe a live-but-silent track — it would have
published silence to the SFU. This was a confirmed defect affecting every macOS user, it was one
line, and it did not wait for the addon. The epic #3192 issue body's citation of
`forge.config.ts:308` is stale; the key now lives at `:370`.

**CORRECTION (#3197 PR 2, measured 2026-09-11 on macOS 26.6.2): the plist key is NECESSARY AND
NOT SUFFICIENT, and D7's own failure mode is still reachable with it present.**

The R9 spike embedded `NSAudioCaptureUsageDescription` into a standalone Mach-O via
`-sectcreate __TEXT __info_plist`, verified present with `otool -P` against a negative-control
build that genuinely lacked it — and capture was still silent. Sixteen runs; nine candidate causes
eliminated by measurement, including a global tap and a tap rate-matched to the device at 192 kHz.

The reason is that **macOS 26 exposes two separate TCC services**, visible as distinct panels in
System Settings → Privacy & Security:

| Service | Grants |
|---|---|
| **Screen & System Audio Recording** | screen capture |
| **System Audio Recording Only** | audio capture without screen |

**They are separate grants and the first does not imply the second.** A Core Audio process tap is
audio-only capture and is gated by the second. So a user who has granted Concord Voice screen
recording — which is what sharing a window asks for — and not system-audio recording gets a share
that looks entirely healthy and is silent: every API returns `noErr`, the IOProc fires at ~94
callbacks per second with correctly-shaped 48 kHz binary32 stereo buffers, and every sample is
zero. That is exactly the dead-stream failure D7 was written to close, arriving through a gate D7
does not name, and the existing `try/catch → video-only` fallback still cannot observe it.

**Dev-environment consequence.** `scripts/patch-electron-plist.sh` re-signs after every Electron
download and a re-sign resets the grant — now **two** grants, one of which a developer does not
know exists.

**CORRECTION (#3394 PR 2, 2026-09-23): the "gated by the second grant" claim above does not hold
for the state actually measured.** **MEASURED (E4, dev client, macOS 26.6.2):** with
`kTCCServiceAudioCapture` denied, and Screen Capture and Microphone allowed to the responsible
process, a new Core Audio process tap carried signal on 1541 of 1541 callbacks — so the user
described above, holding the screen (and here, microphone) grant but not the audio-only grant,
does **not** get a silent share in this state. **UNDETERMINED:** which of the two allowed grants
carried it. **UNMEASURED:** screen (and microphone) denied inside Electron; a packaged build;
macOS before 26.6.2. R9's zero-fill stands for R9's own conditions only — a standalone binary
whose grant state was not recorded — not for this measured dev-client state.

**Correction to the dev-environment consequence (MEASURED, E2):** a dev client launched from a
terminal is attributed to the **launching app** (Claude.app, Terminal), not to
`com.github.Electron`. Grants and resets on Electron's own bundle ID have no effect in that flow,
so the re-sign above does not reset a grant a dev client launched this way ever reads.

## Consequences

**Accepted costs.** First native toolchain in the repo. Two new platform floors to communicate in
the UI. Signing and notarization of a native binary. A new `utilityProcess` in the runtime
topology. A memory-safety attack surface that did not previously exist in the desktop client —
mitigated by D5's isolation, D3's rule profile, and the fuzz/sanitizer requirements in § Verification.

**Rejected alternative — decline R2 and ship system-wide audio like other major comms platforms.** Legitimate,
cheaper, and explicitly considered. Rejected because it leaves the feedback-loop defect class
alive: system-wide loopback re-captures our own output no matter how the UI is worded.

**Linux.** PipeWire per-node capture is the equivalent primitive. Out of scope for this ADR; the
capability ladder's bottom rung covers it as video-only.

## Verification

**S1 — PCM transport spike. Blocks D4, and blocks writing any addon code.**
Feed a synthetic 48 kHz stereo PCM source into a real mediasoup producer by BOTH candidate
routes, and measure rather than reason:

- end-to-end added latency, capture callback → producer, at p50 and p99;
- steady-state allocations per second in the renderer (target: zero in the hot path);
- whether `MediaStreamTrackGenerator` for **audio** is present and stable in this exact
  Electron's Chromium, since that API has been in flux and its video sibling was already
  renamed;
- behaviour under a deliberately slow consumer, which is where a ring buffer either
  drops cleanly or corrupts.

Deliverable: a recommendation with numbers, and a throwaway branch. No addon code starts
until this lands, because the answer changes the addon's output contract.

**S2 — Capture spike. Blocks D1's cost estimate and settles risks 2 and 3.**
Per-process capture on Windows first (it has the older, better-documented API), then macOS.
Two questions matter more than "does it work":

1. **The app matrix.** Capture from Chrome, an Electron app, Spotify, VLC, a game, and a
   Java app. Record for each whether the window's owning PID plus
   `INCLUDE_TARGET_PROCESS_TREE` actually yields that app's audio. A partial result is a
   fine outcome and directly sizes the fallback ladder; a result of "Chrome works" tells us
   almost nothing.
2. **The real Windows floor**, probed at RUNTIME on Windows 10 22H2 (build 19045). If the
   API is genuinely 20348+, consumer Win10 is excluded and that is a product decision, not
   an engineering detail. Settle it on hardware, not from docs.

**Neither spike is a prototype of the feature.** They are two measurements that decide
whether the design in this ADR survives contact. Treat a disconfirming result as the spike
succeeding.

**Standing requirements once code exists:**

- ASAN and UBSAN builds of `rt/` in CI. **A sanitizer failure is VISIBLE, not
  merge-blocking** — the org ruleset's `required_status_checks` names exactly two
  contexts, `Gitar` and `SonarCloud Code Analysis`
  (`docs/ci/quality-gate-definition.md`
  § Ruleset-enforced gates), and `native-audiocap` is not among them. An earlier
  revision of this line asserted it was a merge blocker; it never was. Corrected in
  PR #3155 after Codex flagged the contradiction.

  Adding the contexts is not the obvious follow-up it looks like. `native-audiocap`
  is a **path-gated call to a reusable workflow**, so on a PR that touches no native
  path the caller job is skipped and the called workflow's jobs never materialise as
  check runs at all — a required context that never reports leaves the PR pending
  rather than passing. Making these gates therefore means first giving them a
  reporting shape that survives the skip.

  **The gate is the nightly, and it is now armed.** `nightly-ci.yml` carries an
  UNCONDITIONAL `native-audiocap` node — added because the PR leg is path-gated
  and main-ci's every job is hotfix-gated, so nothing re-ran these legs against
  `main` at all. Being unconditional it reports on every nightly and has no skip
  to survive, which is what makes it a viable gate where a
  `required_status_checks` context is not. The developer took that release-gating
  decision on PR #3155: `native-audiocap` is in the `release` and `bump` jobs'
  `if:` expressions AND in both `blocking` arrays, so a red ASAN, UBSAN, or fuzz
  leg withholds the nightly release.

  Both places, always. A name in the `blocking` array but not the `if:` prints
  "blocking" in the summary table while the release cuts anyway — a gate that
  reports itself and does nothing, which is the failure mode this whole section
  was written about.

  So the split is: **advisory at PR time, blocking post-merge.** A sanitizer
  failure cannot block the merge — the ruleset names two contexts and this is not
  one of them — but it does stop the release that would carry the defect to a
  user.
- The ring buffer is fuzzed. It is the one component reachable across a trust boundary.
- A regression test proves the D6 last row: a window target cannot obtain a system-mix track.
- A regression test proves D7's plist key is present, so it cannot be dropped by a config refactor.
- The Windows feedback loop is reproduced with instrumentation **before** any fix is claimed —
  per-process capture is a hypothesis about that defect until measured, not a proven fix.

## As-built addendum — #3195 (utilityProcess host + PCM transport)

**This section records what implementation discovered. It does not reopen D1–D7; where it
appears to modify a prior decision, it is narrating how that decision was realized, not
re-deciding it.** #3195 ships the mechanism **dark**: `canCarryScreenAudio` returns only
`'none' | 'system-loopback'` in this PR, the synthetic `rt/` source is compiled out of release
builds, and no end user reaches a per-process track from it. The `'per-process'` rung, PID
resolution, and the real Windows/macOS backends are #3196/#3197/#3198.

### T0 — the two blocking spikes, re-measured on the shipped runtime

S1 (above) measured Electron 43.5.1 / Chromium 150.0.7871.250 on 2026-09-07. #3212
bumped the tree to **Electron 44.1.1 / Chromium 152.0.7977.65** before implementation started, so
Task 0 re-measured rather than inherited S1's numbers:

| Spike | Result | Consequence |
|---|---|---|
| **T0a** — cross-world `ArrayBuffer` detachment, preload → main world | **PASS** — source `byteLength` 0 after post; the page received all 3872 bytes | Option B′ (below) transfers rather than copies on this hop, so its security property costs no allocation |
| **T0b** — `AudioDataInit.transfer` | **PASS** — probe detached | The renderer bridge uses the primary zero-copy path only; the spec's capped-free-list fallback was never built, and with it the pool-inflation attack surface that free list existed to close never exists either |
| **T0c** — `SharedArrayBuffer` availability *(added; not in the original S1 spike set)* | **STILL UNAVAILABLE** — `typeof SharedArrayBuffer === 'undefined'`, `crossOriginIsolated === false` | **D4c's premise holds on the runtime this repo now ships. The credit-gated transferable transport stands; nothing here reopens D4c.** |

T0c is the valuable negative: it is the re-check of the exact measurement D4c's abandonment of
the shared-memory ring rested on, taken on a runtime this repo no longer shipped by the time
implementation started. Record it so the next Electron bump does not have to re-derive it —
re-run T0c whenever Electron moves again, since a future engine could in principle flip it.

### The realized D4c transport

D4c specified the *policy* (producer-is-the-clock, credit-gated, drop-the-newest, one bound). The
implementation fixes the wire shape that policy runs over:

- **A 32-byte little-endian header, one QUANTUM_BYTES = 3872 buffer.** `magic` (u16 `0xCA57`) ·
  `version` (u8, `1`) · `flags` (u8, reserved, must be `0`) · `seq` (u32, wraps) · `sampleRate` (u32,
  pinned `48000`) · `channels` (u16, pinned `2`) · `frameCount` (u16, pinned `480`) ·
  `captureTimestampNs` (u64) · `overrunTotal` (u32, saturating) · `reserved` (u32, must be `0`).
  Every fixed field is checked for exact equality before the three variable fields (`seq`,
  `captureTimestampNs`, `overrunTotal`) are read; no field selects a code path other than
  accept-or-close-the-port. `src/shared/audiocapProtocol.ts` is the sole encoder and decoder.
- **One drop site, by construction — `ringSlots == creditBound == 8` (~80 ms at a 10 ms quantum).**
  The child drains only while `outstanding < CREDIT_BOUND`; when it stops draining, `rt/`'s ring
  fills and drops the newest quantum, incrementing a saturating `overrun` counter. Credit exhaustion
  *is* ring overflow — there is nothing to reconcile between "the consumer stopped acking" and "the
  ring is full" because they are the same event, counted once.
- **The availability signal carries no data.** `start()` registers a `napi_threadsafe_function`
  with `max_queue_size = 1`, called `napi_tsfn_nonblocking`. A signal arriving while credit-blocked
  is coalesced away rather than queued; PCM flows through the ring, never through the TSFN. This is
  what keeps the credit decision on the producer side of the native boundary without an unbounded
  queue standing behind the signal.

### `overrunTotal` is stamped at capture time; `seq` is the immediate witness — both are required

`overrunTotal` is written into a quantum's header when that quantum is *captured*, so it lags a
live drop by up to `RING_SLOTS` (8) quanta — the quanta already queued when the drop happened
still carry the older count. Measured during Task 2: after a stall, the eight already-queued
survivors all read `overrunTotal: 0`; the first freshly-captured quantum after the stall read
`17`, matching the `seq` gap (`25 − 7 − 1 = 17`) exactly. A `seq` gap, by contrast, is visible on
the very first quantum after a stall — it is a drop witness derived from the stream itself, so it
still moves even if `overrunTotal` were hardcoded or lying. §4f's requirement that both observers
be asserted, never either alone, is therefore load-bearing rather than belt-and-braces: a test
draining only the stale eight and asserting `overrunTotal > 0` fails against *correct* code.

### The two hops crossing the child→renderer path are different APIs, and only one transfers

D4c's transport section described a quantum as "posted with a transfer list" without saying which
hop. There are two, and they are not the same mechanism:

- **child → preload** rides Electron's `MessagePortMain` (`port.postMessage(message, transfer?:
  MessagePortMain[])`, `electron.d.ts:9820`). An `ArrayBuffer` does not type-check in that list and
  Electron's docs give no evidence one is accepted at runtime, so `audiocapChild.ts` posts a fresh
  3872-byte `ArrayBuffer` by value on this hop — one allocation per 10 ms quantum, in the child,
  which is a Node process off the real-time thread. AV 206 constrains `rt/`; it does not constrain
  this glue.
- **preload → main world** rides a DOM `MessagePort` and **does** transfer. This is the hop T0a
  measured, and it is the one A1 (zero renderer allocation) depends on, because A1 constrains
  *renderer* steady-state allocation specifically.

Whether `MessagePortMain` accepts an `ArrayBuffer` at runtime despite the typing was left open by
the design and is not settled by this PR; the CI probe added in Task 8 is where that question
would be answered if it mattered to a future PR.

### Option B′, realized: the port terminates in preload

Main forks the child and hands it `port1` of a `MessageChannelMain`; `port2` goes to **preload**
(`audiocap:port`, `webContents.postMessage`), never to the main world. Preload validates every
inbound quantum against the wire format, then forwards the payload to the main world over a
**second, preload-created `MessageChannel`**, whose main-world end is delivered exactly once — via
`window.postMessage` tagged with a value the `contextBridge` exposes as
`audiocap.getPortMessageTag()`, because a raw `MessagePort` cannot cross `contextBridge` (C2).

The property this buys is not "the main world cannot see the samples" — the main world has to
decode them and build the `AudioData` and the track, so it plainly can. It is that **the main
world is structurally unable to send anything to the process that loads native code.** Under the
rejected Option A (the child's own port relayed into the main world), a compromised main world —
remote-SPA code included — would hold a live port into a Node context that has already loaded
`rt/`, and could post one arbitrary structured-cloneable value before the validator closed it.
Under Option B′ the only thing the preload relay ever posts to the child is a freshly minted
`{ c: 1 }` of its own construction, never the object the main world sent — that one line is the
entire delta between the two options, and it is a proxy that buffers nothing, not a queue.

### The compile-gated synthetic backend, and its three independent barriers

`rt/synthetic_source.h` is a deterministic PCM source behind `#if CONCORD_AUDIOCAP_SYNTHETIC`,
needed so the whole transport is measurable end-to-end before either real platform backend lands.
It is compiled **out of** the release binary, not merely unreachable in it — a reachable test tone
inside a signed binary can publish a wrong-source track, the same class of harm as the system-mix
fallback C9 forbids. Three independent things keep it out of the shipped payload, so no single
mistake ships it: (1) the gyp target that defines `CONCORD_AUDIOCAP_SYNTHETIC` is gated on
`-Daudiocap_synthetic=1` and does not build by default; (2) it emits a separately-named
`concord_audiocap_synthetic.node`; (3) `index.js` can only ever resolve `concord_audiocap.node`, so
a synthetic binary sitting beside the release one in a dev tree is unreachable through the shipped
loader. `EXPECTED_NATIVE` (`verify-asar-payload.sh`) and `forge.config.ts` are untouched — the
release `native/` payload boundary (§ D4 RESULT of PR 5) does not move.

### The watchdog rail (§6c rail 3) was DELETED, not shipped inert

The design's teardown section specified a third reap rail: the host self-terminates the child
after N seconds with no credit ack and no live share. That rail's precondition is a **capturing**
child, and #3195 forks no such thing — it forks only the short-lived app-start capability probe
(below), which main kills on the same turn its handshake settles. Its transport doesn't exist
either: at that stage, IPC contract 27 carried exactly one audiocap channel, main → preload, and
`noteAudiocapCreditAck` / `setAudiocapShareLive` have no caller to wire them from — the credit ack
lives in the renderer bridge, which cannot reach main without a new IPC channel carried 100×/second
for the life of every share, and share-liveness is minted by the spawn path #3198 owns.
The live contract and its later control channels are recorded in the #3198 PR 3 addendum below;
`client/desktop/src/main/ipcContract.ts` is the authoritative current version.

Shipping the rail armed-but-unwired was considered and rejected: an unwired watchdog is
indistinguishable from a working one on inspection and reads as defence when it guards nothing —
precisely the "shipped code with no caller" condition #3194's review exists to prevent, wearing a
different costume. `armWatchdog`, `noteAudiocapCreditAck`, and `setAudiocapShareLive` were deleted
rather than left inert. **This is recorded here so the rail is not thought lost:** #3198
reintroduces all three alongside the capturing child that gives them meaning.

### Accepted residual: `reapChild`'s spawn listener on a fork that never spawns

`killAudiocapHost` and `retire` both reap through `reapChild`, which handles the
measured Electron behaviour that `UtilityProcess.kill()` before the OS spawn
returns `false` and neither reaps nor cancels — it re-kills on `spawn`.

If a fork **never spawns at all** (the OS refuses it), that `once('spawn')`
listener is never removed, so the listener and its retained `child` closure live
for the rest of the app's run. Raised by Gitar on PR #3245 and **accepted for
this PR with the developer's explicit approval**, on three grounds:

- It is **unreachable here.** `startAudiocapHost`'s only caller is
  `probeAudiocapCapability`, memoized to run once per launch, so at most one such
  listener can ever exist and only if the OS refused that single fork.
- The cost is a listener plus one closure, not a process. The *child* leak the
  same function exists to prevent is the material one, and that is fixed.
- The path arms with #3198's share flow, where repeated share attempts could
  accumulate listeners. That is where a bounded timeout belongs, and Gitar's own
  recommendation says the same.

**#3198 owes a bounded timeout on that listener.** Recorded here rather than left
in a review thread so it travels with the code instead of with the pull request.

### The app-start capability probe is the production caller #3194 lacked

`probeAudiocapCapability()` (`audiocapHost.ts`) forks the child once at `whenReady`, takes its
handshake, records whether it claims `perProcessAudio`, and kills it — unconditionally, in a
`finally`, on every outcome. It is deliberately not awaited (nothing on the critical path may cost
a native-code fork or `HANDSHAKE_TIMEOUT_MS`) and deliberately memoized to run once. This is the
caller that distinguishes #3195 from #3194, where `runAudiocapSmoke` shipped inside `app.asar` with
no path by which it could ever execute; here the D5 guard, the loader, and the handshake are all
exercised on every real launch rather than only by a test or a developer's local build. The
answer stays in main — #3198 adds the renderer-facing rung and the channel to carry it, and adding
one now for a value nothing reads yet would be the same no-caller defect pointing the other way.

## As-built addendum — #3197 PR 1 (producer-backend contract, teardown gate, repacketizer)

**Ships dark, like #3195.** No platform backend exists yet; `platformBackend()` returns `nullptr`
on every OS, so a release build still returns `NoBackend`. What this PR adds is the seam #3196
(Windows) and PR 2 (macOS) both implement against, plus the teardown fix that seam exists to make
possible.

**Teardown is now a POST-CONDITION, not a mechanism.** The shipped-#3195 contract was "stop, join
the producer thread, release the threadsafe function" — unsatisfiable by a callback-driven backend,
since a Core Audio `IOProc` or a WASAPI callback belongs to the OS and hands back no joinable
handle. `rt/capture_backend.h` instead specifies only the outcome: when `stop()` returns, no
further sink call occurs from any thread and every OS artefact is destroyed. A thread-driven
backend satisfies it by joining; a callback-driven one by stopping and destroying the tap/IOProc
directly. `rt/sink_gate.h` enforces the post-condition independently of whether a backend tells the
truth — it closes a gate and waits, bounded, for in-flight sink calls to quiesce, abandoning
(never releasing) the threadsafe-function handle and latching a process-lifetime `poisoned` flag on
timeout.

**The repacketizer (`rt/quantum_pump.h`, `rt/frame_pack.h`) is pure C++ with no floating-point
arithmetic on a sample** — every operation is `memcpy`/subscript, never addition. That is what
keeps it inside the JSF++ profile with no new named deviation (acceptance A9) and inside the
existing Linux ASAN/UBSAN/TSAN/fuzz legs alongside the ring.

**Two fix rounds landed on top of the above before this addendum's PR (#3262) merged.**

**The teardown witness is `QuantumPump::activityTotal()`, not `callbackTotal`.**
`rt/capture_backend.h` says a backend "MAY" call `noteCallback()`, so a conforming backend that
only calls `submit()` left `callbackTotal` motionless while its tap ran — a PoC proved a teardown
watching it takes the quiesced arm over a live producer. `activityTotal` is bumped by the pump
itself, by both `noteCallback()` and `submit()`, the latter *before* its own validation so a
refused submission still counts; there is no conforming way to touch the sink without moving it.
`callbackTotal` keeps its own separate meaning as the starvation signal — the two are not
redundant. The settle window (50 ms) and the quiesce budget (250 ms) are now measured in **wall
time**, via a `TeardownOps::nowNs` hook, rather than loop iterations: iteration counting assumed
`uv_sleep(1)` sleeps ~1 ms, which Windows' ~15.6 ms default timer resolution breaks by ~15x. The
witness saturation ceiling is not the "497 days" an honest 10 ms cadence implies — measured at 9.6 s
in a one-thread submit loop, a cadence the contract permits and places no limit on.

**`CaptureTarget` gained `scope: CaptureScope` (`kProcessList` default, `kSystemMix` only by
affirmative caller choice),** resolving D6's ambiguity where `pidCount == 0` meant both "no target"
and "capture everything": a default-constructed struct, a forgotten field, and a failed PID lookup
now all land on `kProcessList`, and `buildTarget` never emits `kSystemMix`.

**`capture_backend.h`'s `stop()` post-condition now states, not merely implies, that a backend must
not return until its own callbacks are quiesced** — the gate seam observes that promise, it does
not substitute for the backend's proof of it. PR 2's macOS backend owes this explicitly: Apple
documents no quiescence guarantee after `AudioDeviceStop` returns.

## As-built addendum — #3197 PR 2 (macOS Core Audio process-tap backend)

**R9 is closed: STATE B.** When TCC audio-capture consent is absent, a Core Audio process tap
delivers on-schedule, correctly-shaped, **zero-filled** callbacks, and every API returns `noErr`.

Measured 2026-09-11 on macOS 26.6.2, Apple clang 17, arm64; default output device a Schiit Unison
Modi Multi 2 at 192 kHz. Sixteen runs, four discarded by their own controls. Nine candidate causes
were eliminated **by measurement**, not by argument: a silent source, a dead source, a
per-process targeting fault (a *global* tap read zeros too), `tapautostart` misuse, buffer shape,
the aggregate's input configuration, TCC cache staleness across two host-app restarts, a nil
`deviceUID`, and — last to fall — a device/tap sample-rate mismatch, where
`initWithProcesses:andDeviceUID:withStream:` negotiated **192000 Hz exactly matching the device**,
delivered 376 callbacks/s × 512 frames, and still produced nothing. Only TCC denial survives.

**Scope correction (#3394 PR 2, 2026-09-23):** "when TCC audio-capture consent is absent" above
describes R9's own binary and conditions — a standalone Mach-O whose Screen Capture and
Microphone grant state was not recorded. E4 measured a different state (those two grants held,
only the audio-only grant denied) inside Electron, and there the tap was not silent. "Only TCC
denial survives" stands for R9's binary; it does not establish that audio-only denial alone
silences a tap in every grant configuration.

**What this forces on the detector, and it is the harder of the two readings.** A `callbackTotal`
deadline is *structurally blind* — it sees ~94 perfectly healthy callbacks a second. But content
inspection alone is *ambiguous*: a granted tap on a paused app produces byte-identical all-zero
output, observed when the test source auto-paused mid-run. **Neither candidate detector works
alone, and no third one at this seam can separate them, because they are the same bytes.** What
ships is `signalTotal` (callbacks that admitted ≥1 non-zero sample) plus a one-shot
`silentSinceStart` latch on a 10 s budget, evaluated natively, **advisory only** — it never faults,
never tears down, and is cleared permanently by the first non-zero sample. Its named false positive
is a healthy consented share that is genuinely silent for its first 10 s.

**`BackendStart::kPermissionDenied` is unreachable from the macOS tap path.** `start()` does not
fail under denial; every call returns `noErr`. The member stays in the closed union — the
exhaustive-mapping test asserts a mapping exists, not that a member is producible — and
`ScreenAudioDegradeReason` therefore gains **`capture-starved` only**. A `consent-denied` member
would be a mechanism string the mechanism cannot detect.

**The initializer choice is load-bearing for format admission.**
`initStereoMixdownOfProcesses:` yields 48 kHz binary32 stereo — exactly what `rt::acceptsSourceFormat`
admits. `initWithProcesses:andDeviceUID:withStream:` yields the *device's* native rate, 192 kHz on
the measuring machine, which `rt/` refuses. PR 2 uses the mixdown form and `rt/`'s admission is
unchanged: the device-bound form would make capability a function of whichever DAC the user owns,
and widening to 192 kHz is not a widening but a resampler plus a wire-format change. The format is
still read and checked before `AudioDeviceStart` — one machine measuring 48 kHz is not an invariant.

**The `stop()` barrier.** Apple documents no quiescence after `AudioDeviceStop` returns and
`HostServices::spawn`/`join` are `nullptr` in a shipped binary, so the backend builds its own:
close its gate first, stop the device, wait bounded (50 ms, failing closed on a null clock or sleep
hook), then **destroy the tap, aggregate and IOProcID unconditionally — quiesced or not.** The
privacy invariant is the tap's *existence*, which nothing above the backend can end; destroying
under a possibly-live callback can dangle Apple's state, never ours.

**HAL property listeners may not touch the pump** — not `submit()`, not `noteCallback()`, not
`fault()`. A listener on a dispatch queue is a second concurrent writer to the pump's non-atomic
members and a second mover of the teardown witness. Recorded on `rt/capture_backend.h`'s `start()`
post-condition rather than in the macOS file, because #3196's `IAudioSessionEvents` has the
identical shape.

**Coverage is fake-HAL, by necessity.** `client/desktop/native/**` is outside `sonar.sources`, so
no C++ or ObjC++ line here can count toward the ≥80% new-code gate. The state machine is therefore
header-only and Apple-header-free over a POD of function pointers, and runs in full on the Linux
ASAN/UBSAN/TSAN legs. What that cannot see is named in the spec: whether
`AudioDeviceDestroyIOProcID` actually drains an in-flight IOProc, and what revocation mid-share
looks like (owned by #3198).

## As-built addendum — #3198 PR 2 (target-PID resolution, split scope, and honest copy)

**Describes what shipped, not the design.** Most of what D4a and D6 describe is deliberately
absent here — a resolver with no reachable caller, a protocol that can carry a target, and copy
that stopped lying about a capability the code cannot yet offer. Where a sentence would be true
only after PR 3, it says so explicitly rather than reading as present tense.

**The sixth `napi/` export exists and no live share reaches it.** `resolveWindowOwner(handle):
number | null` (`napi/window_owner.cc`) turns a picked `window:XX:YY` handle into its owning PID
with one OS call — `GetWindowThreadProcessId` on Windows, `CGWindowListCopyWindowInfo` on macOS —
and returns `null` for every refusal, never `0`. `binding.gyp` gained the CoreGraphics framework
link on macOS and a `link_settings` block declaring `user32.lib` on Windows; the Windows addition
is almost certainly redundant rather than load-bearing — node-gyp's own `addon.gypi` already
injects `user32.lib` into every Windows target's default library list — but it is kept explicit
because the resolver names the exact Win32 call it needs, and an explicit declaration
survives a future node-gyp default change that an implicit one would not. (It named TWO
until the #3198 PR 2 review removed the `IsWindow` pre-check: that call refused nothing
`GetWindowThreadProcessId` does not already refuse, and the interval between the two was a
live HWND-recycling window in which a destroyed handle could be reassigned to another
process's window and resolve to ITS pid — a capture aimed at an app the user never picked,
which is the widening D4a forbids. The comment there asserted the opposite; a safety
comment naming a mechanism that does not exist is what stops the next reviewer looking.) Nothing in `src/`
outside the capture child calls it. `audiocapChild.ts`'s `resolveTargetPid` is the one caller, and
it in turn has no reachable caller in production — see the split below.

**The resolver runs in the CHILD, never in main, and no PID ever crosses back out of it (D5,
invariant I-PID).** This PR is the as-built confirmation of D4a's design, not a new decision:
`audiocapChild.ts` is the sole `require` of `native/concord-audiocap` under `client/desktop/src/`,
main forks the child and speaks to it over `parentPort`/`MessageChannelMain` but never loads the
addon itself, and `resolveTargetPid` resolves the handle main sent immediately before
`addon.start()` — no tap exists before that point. The resolved PID is folded into
`targetPids: [pid]` and never returned to main or the renderer. `allowDescendants` stays
deliberately ABSENT from that call (not `false`): it is platform-asymmetric — macOS documents its
target list as already descendant-expanded by the caller, Windows honours
`INCLUDE_TARGET_PROCESS_TREE` — and choosing a descendant-expansion policy is its own decision,
out of scope here.

**Forward note (#3394 PR 2, 2026-09-23):** decided by #3394 PR 2 § 3 — `allowDescendants` becomes
the required literal `true` on that call once that PR lands.

**MEASURED (2026-09-12, macOS 26.6.2, arm64): `kCGWindowListOptionIncludingWindow` used alone is
an implicit ON-SCREEN filter, not merely "the requested window or nothing" as its name suggests.**
Across 534 live windows, 67/67 on-screen windows returned exactly one matching element and 0/467
off-screen ones did. **So a MINIMISED app's share refuses and degrades to video-only.** That is the
fail-closed direction — `kCGWindowListOptionAll` is literal `0`, so no flag widens the query — and
it is D6's last row operating correctly, but it is real, previously-undocumented product behavior:
a user who shares an app and then minimises it loses that app's audio for the rest of the share,
with `'target-unresolved'` as the reported reason and no recovery short of restarting the share.
Task 13's copy was written with this in mind and does not promise app audio for a minimised
target.

**Two distinct kinds of evidence exist for the resolver, and only one of them is a CI job — say so
explicitly rather than let a green run imply the wrong scope.**

- **`.github/workflows/native-audiocap.yml`'s resolver step proves three REFUSALS only** (handle
  0, an absent handle `0xfffffffe`, an out-of-range handle), on real Windows and macOS runners.
  That is real and cheap, and it catches a missing export, a broken build, or a refusal leaking as
  numeric `0` — but a stub `return null;` for every input satisfies all three assertions, and the
  probe script's own header says as much. "The CI probe is green" must never be read as "the
  resolver resolves".
- **The permanent positive control is `client/desktop/scripts/audiocap-target-probe/`** (modelled
  on `scripts/audiocap-host-probe/`), a committed, re-runnable Electron probe — not a Vitest test,
  because it needs a real `BrowserWindow`, a real `utilityProcess` and the loaded `.node`, none of
  which the mocked-`electron`/jsdom unit suite can supply. It forks the real, built
  `dist/main/audiocapChild.js` twice — one child per start, since the sink gate arms once per
  process — resolves a LIVE handle from `BrowserWindow.getMediaSourceId()`, and separately sends a
  known-bad one, reading the `fault` each posts. **MEASURED 2026-09-12, macOS 26.6.2 / Electron
  44.1.1 / darwin-arm64: PASS.** `sourceId window:38339:0` — live handle → `faults: ["start"]` (the
  resolve succeeded; the OS refused the tap one stage later, as expected under D7's TCC finding);
  bad handle `0xfffffffe` → `faults: ["target"]`. This retires the epic's largest remaining
  unknown: a `utilityProcess` child IS inside the Quartz GUI session that
  `CGWindowListCopyWindowInfo` needs, and D5 stands as written.
- **No CI job can hold the positive control, and nothing automated would catch a regression in
  it.** `build.yml`'s `electron-host-probe` runs on a headless Ubuntu runner with no window server,
  and `resolveNativeAddonPath` supports darwin/win32 only, so the addon never loads there; adding a
  macOS CI runner for this was ruled out at spec time (§8). What would catch a regression —
  an Electron sandbox change, a macOS TCC change, a `napi/window_owner.cc` edit — is running this
  probe by hand. Treat it as a pre-release manual check on any Electron major bump or a change to
  that file. The first user-visible symptom of a silent regression here would be every macOS
  per-process share degrading to video-only with `'target-unresolved'`, with every automated check
  green.

**Protocol widened (Task 11):** `AudiocapStart` gains `windowHandle: number`; `AudiocapFaultStage`
gains `'target'` (5 → 6 members); `ScreenAudioDegradeReason` gains `'target-unresolved'` (9 → 10),
collapsing every main-side and child-side resolution failure — a malformed id, a `screen:` id, a
window that closed between pick and start, and an OS call that refused — into one member, per A7 /
`observability.md` principle 7.

**Honest copy landed at all eight sites a content re-grep found** (§6's own five-site list was
short), plus an accessibility fix: the per-app toggle moved from native `disabled` to
`aria-disabled` with a JS activation guard, and its explanatory hint moved from a `title=` tooltip
to a persistent, `aria-describedby`-wired `<p>`. A native `disabled` control sits outside the tab
order, so the privacy explanation this feature depends on was keyboard/AT-unreachable before this
PR. `ScreenAudioDegradeReason`'s message map (`screenAudioDegradeCopy.ts`, Task 13b) is wired at
`voiceService.ts`'s existing `produce-rejected` degrade site — closing the fourth shipped-but-unread
artifact this epic has produced (after #3194's smoke harness, `capture-starved`, and
`screenAudioBridge.ts`).

**`'per-process'` STAYS UNREACHABLE in this PR — a scope-split decision made 2026-09-16, not an
oversight.** While wiring Task 11, it was found that nothing in this repository ever constructs a
`MessageChannelMain` for a capture share or posts a `{kind:'start'}` control message to the capture
child — `audiocapChild.ts`'s `handleStart` (the function that calls `resolveTargetPid` and
`addon.start`) has no reachable caller in production, verified by grep:
`kind: 'start'` appears only as the type declaration, no `MessageChannelMain` is constructed in
`src/main/`, and `audiocapHost.ts` itself carries a comment reading, verbatim, "`postMessage` that
is not there." So Tasks 10 (the `audiocap:start` IPC invoke), 12 (the capture-seam `'per-process'`
arm) and 12a (the main-side `start` + port handoff that leg needs, itself previously unplanned) all
move to **#3198 PR 3**. Both `canCarryScreenAudio` call sites — `ScreenSharePicker.tsx` and
`voiceService.ts` — still pass exactly two arguments; the `'per-process'` arms of
`audioToggleHint`, `screenAudioTitle` and `screenAudioRefusalMessage` are written, exhaustive, and
unreachable. This PR proves the resolver works, widens the protocol to carry a target, and makes
the copy honest about a capability the code still cannot offer.

## As-built addendum — #3198 PR 3 (the capture seam: the start leg, the port handoff, and reachability)

**Describes what shipped.** PR 3 builds the one leg the epic never had and then throws the
switch, so for the first time D4a and D6 describe live behaviour rather than a declared shape.

**The leg that never existed.** #3195 built the host, the handshake and the PCM relay; #3197 the
backends; PR 1 the ladder; PR 2 the resolver and the widened protocol. Nothing anywhere
constructed a `MessageChannelMain` for a capture share or posted a `{kind:'start'}` control
message, so `AudiocapStart` had no producer and the child's `handleStart` was unreachable in
production. `HostState` had carried a `'capturing'` member since #3195 with a comment saying the
port handoff enters it; nothing ever did. It now runs in `handleHello` — `handleChildMessage`'s
hello arm, which grew past the S3776 cognitive-complexity ceiling once the leg landed in it and
is now its own function — the only point that knows both that the child survived the handshake
and what it claims to support. Starting from `startAudiocapHost` would race the handshake it
exists to wait for.

**The app-start capability probe takes none of it.** `windowHandle === null` means "no window",
so the probe settles exactly as before: no channel, no `start`, no `'capturing'`. That is what
keeps P3 (the probe's child is short-lived) and P4 (it runs once) untouched, and it is asserted
rather than assumed — deleting the null-handle guard reddens the probe case plus six pre-existing
ones.

**`startAudiocapHost` regains `windowHandle`, REQUIRED rather than optional.** PR 2's review
deleted the parameter for being unwired, on #3195's precedent of deleting an unwired watchdog
rather than shipping it inert; PR 3 restores it together with the consumer that gives it meaning.
It is required-with-explicit-`null` rather than defaulted, because a defaulted parameter is
precisely how the sibling defect happened: `screenAudioRefusalMessage` gained
`platform: string | null = null`, the sole production call site kept passing one argument, and
the Linux branch was dead in production while its unit tests passed. Required means the compiler
names every caller that has to decide, and the probe's `null` is a statement rather than an
omission.

**Two invokes, additive within contract 28.** `audiocap:start` (`{sourceId}` →
`AudiocapStartResult`) and the zero-argument `audiocap:stop`. `IPC_CONTRACT_VERSION` does not
move and `SPA_MIN_CONTRACT` stays 19; the renderer feature-detects both, so a shell without them
loses per-process audio and keeps its video — never a fall back to the system mix (C9).
Capability, not demand.

`audiocap:start` is **the one audiocap handler the sender-frame criterion binds** — the
`audiocap:capability` push has no sender to validate, and reading the absence of a check there as
an oversight is the mistake the handler's existence is meant to prevent. Four fences in a fixed
order, and the order is the design: sender frame on the first statement; payload shape, where an
extra field is dropped rather than rejected so a hostile renderer learns nothing about which
fields exist; the `window:` prefix re-parsed HERE rather than trusted from the renderer (D4a);
and liveness against a thumbnail-free `desktopCapturer` enumeration, because a well-formed id for
a window that has since closed is stale and a stale id must never silently widen a capture. **No
PID appears in that file** (I-PID): main resolves a HANDLE and sends that, and the capture child
remains the only process that ever learns a PID.

The awaited enumeration has a separate cancellation fence: each valid start snapshots a
monotonic operation epoch, and every trusted stop or newer valid start advances it. The start
must compare that epoch immediately after enumeration and refuse stale work before
`startAudiocapHost`; there is no await between the comparison and host registration. An
untrusted stop must neither stop the host nor advance the epoch.

A malformed or `screen:` id yields `target-unresolved`, **deliberately diverging from spec §4.2's
table**, which gives `no-backend` for an id failing the `window:` regex. A7 is a Global
Constraint and outranks that row, and §4.3 independently argues `no-backend` would be a mechanism
string naming the wrong mechanism.

**`stopAudiocapHost` is SEPARATE from `killAudiocapHost`, not a replacement**, because the two
have incompatible contracts. Kill must stay synchronous: it is called from `startAudiocapHost`'s
supersede (I3, nothing awaited in between) and from the quit hooks, where an await re-enters the
#1383 quit-deadlock veto window. A graceful stop necessarily lets the child outlive the call, so
folding one into the other would either break the supersede or make the quit path await.

What posting `stop` buys, given process exit already destroys the tap, is that the child's
`handleStop` is the **only** caller of the addon's `status()` — the R9 silence detector's
`signalTotal` and `silentSinceStart`, plus `quiesceProved` and `destroyFailures`. Kill-only
computes all of them on every callback and shows them to nobody, which is the shipped-but-unread
failure this epic has produced repeatedly, reproduced one layer up. `killAudiocapHost` drains a
still-quiescing child first, so a supersede cannot leave two taps overlapping on the privacy
surface this ADR exists to narrow.

**`audiocap:stop` exists because nothing else reaps a child when a share ENDS.** Every
`killAudiocapHost` caller is a quit, crash or update hook, and `audiocapChild.ts`'s `handleStop`
"deliberately does NOT exit" so that a self-exit cannot be misread by main as `child-crash`, i.e.
as a packaging defect. Without the channel a share the user ended kept the capture child holding
its OS tap until the app quit or the next share superseded it. It is zero-argument by
construction, matching `spa:reloadLatest`: the renderer triggers, main resolves which child to
reap from its own session, so the renderer names nothing and chooses nothing — and it is
sender-fenced on the first statement, because it reaches a process kill and a frame that is not
ours must not be able to end another window's share.

**A RACE THIS PR INTRODUCED AND THEN CLOSED.** Main posts the port to preload inside the same
turn that settles `audiocap:start`, and the renderer can only construct a bridge after that
promise crosses IPC and resolves — while `audiocapRelay` hands the main world its end with one
`postMessage` and never repeats it. A handoff with no listener is therefore not delayed, it is
destroyed, and the symptom is an intermittent silent audio-free share with nothing in any log on
either side. This is the `windowLoaded` trap the #3195 addendum records for preload, one layer
up, reached by choosing when main posts the port.

`screenAudioBridge.ts` now installs **one** handoff listener at module scope and buffers
unclaimed ports by generation; `createScreenAudioBridge` registers its claim first and drains
second, because registering after the drain would reopen the race in miniature. A second property
falls out for free and retires a real bug: the handoff is a `window` message, so a per-bridge
listener made it a broadcast every live bridge saw — which is what let a not-yet-stopped bridge
close its successor's port (PR #3245 red-team, VULN-2). Dispatch by generation means a bridge is
only ever offered its own port, so that collision is unrepresentable rather than guarded against.

**A10 is decided: `screenAudioBridge.ts` is WIRED, not deleted.** It had zero importers until
this PR only because nothing had ever started a capture. It is precisely the main-world consumer
of the port the host now hands over, and deleting it would have meant writing it again.

**The reachability switch is the third ladder argument at FOUR call sites** — the picker, the
capture seam, `setScreenAudioEnabled` and `canShareScreenAudio` — threaded in one change because
`machineCapability` is optional and the compiler names no site that forgets it. A site that omits
it silently answers with the pre-addon rungs; `grep canCarryScreenAudio(` is the check, not a
count in prose. The picker SUBSCRIBES rather than reading `getState()`: the snapshot is pushed
when the capability handshake settles and again on every `did-finish-load`, so it can land after
first render, and a one-shot read would freeze the picker on the fail-closed `null` with no
re-render to correct it.

**A mirror is deleted rather than re-pinned.** `voiceService.canShareScreenAudio` carried its own
switch returning hand-written booleans for the two capable verdicts — a second encoding of a
question `verdictOffersAudio` already answers for the picker. The two disagreed for real while
this PR was being written: flipping one left the toolbar and the picker giving opposite answers,
and the whole suite stayed green because the agreement test never calls `canShareScreenAudio`. It
now delegates for every verdict but `'none'`, whose divergence is load-bearing —
`getDisplayMedia` records no source id, so a live audio track is proof of capability the id
cannot express, and collapsing it would lock the toolbar on every non-Electron share (spec R8).

**The #2161 widening stays structurally impossible on this rung.** The `'per-process'` arm takes
the same `videoOnly()` capture every other arm takes and attaches a track built from the
`MessagePort`; no `chromeMediaSource: 'desktop'` request appears anywhere in it. The whole-desktop
loopback lives in the `'system-loopback'` arm and nowhere else, so a window target cannot reach
one however the policy answers.

**What this PR does NOT change.** `ScreenAudioDegradeReason`'s `'capture-starved'` member still
has **no producer**, for the reason the PR 2 addendum records: every fault routes to `retire()`,
which reaps the capturing child, so a mid-share silence latch would kill a live, correct share —
R9 having measured a granted tap on a paused app as byte-identical to a denied one. A mid-share
producer needs a non-terminal `notice` message kind, which #3195, #3197 and both earlier #3198 PRs
each declined, and it remains deferred to its own issue. PR 3 does move the needle in one respect:
`status()` now has a second reader, because `audiocap:stop` causes `handleStop` to run on an
ordinary share teardown rather than only at quit — but that is still a POST-share read.

**The trust-fence mutations ran on 2026-09-18.** All four `audiocap:start` fences
plus `audiocap:stop`'s sender fence were flipped to fail-open one at a time against a green
control, and each killed exactly the cases that name it: 3 for the start sender frame
(including the ordering case that asserts a hostile sender costs no OS work), 3 for the payload
shape, 1 for the `window:` prefix, 1 for liveness, and 2 for the stop fence — ten kills, none
outside the owning `describe`, with `audiocap.ts` restored between every run and verified clean
at the end. They executed in the DEVELOPER's own shell rather than the session's, which is the
documented resolution for a path on `protect-sensitive.sh`'s protected list whose bypass marker
is inert: the hook resolves its project root outside this worktree, so the marker the developer
wrote never applied and the session could not mutate the file itself.

The operation-epoch cancellation added on 2026-09-19 was mutation-checked separately: removing
only the post-enumeration epoch comparison allowed a trusted stop to be followed by a native host
start, while restoring it returned the focused IPC suite to green.

**The harness needed three corrections before its output meant anything, and every one of them
reported on its own READER rather than on the code.** Twice a count regex failed to see through
vitest's ANSI-coloured summary — the real bytes are `Tests\x1b[22m  \x1b[1m\x1b[31m3 failed`,
and neither `\s` nor `strip()` touches `\x1b` — so the first run printed `0 failed` on five
mutations that had each exited 1, and rendered a verdict from that contradiction anyway. The
third correction was a targeting check that matched a `describe` title against vitest's `×`
lines, which carry the leaf test name only; it flagged all five rows off-target and none were.
The lesson generalises past this script: **a control proving the suite is green is not a control
proving the reader works**, and the second is the one that gets skipped. A diagnostic can also
change the conditions it is diagnosing — piping vitest through `tail` to inspect its output
disabled the very colour that was breaking the parse.

**The visual verification is DONE, and it found two defects the suite could not.** A live
per-process share of a browser window was captured in both themes — picker and live toolbar — so
`'per-process'` is reachable in production for the first time. Two things only running the app
could show:

**1. The live toolbar could not name the rung.** `VoiceControls` recovered a verdict from a boolean
with `isScreenAudioCapable ? 'system-loopback' : 'none'`. PR 2 left that mapping deliberately and
named its owner in the code — *"PR 3 only has to change this one mapping"* — and PR 3 made
`'per-process'` reachable without changing it. So a per-process sharer was told *"Share every sound
on this computer, not only this screen"*, the exact claim this issue exists to delete, while
`screenAudioTitle`'s `'per-process'` arm was reachable only from its own unit test. A boolean cannot
carry a three-rung ladder: `voiceStore` now publishes `screenAudioVerdict: ScreenAudioVerdict`,
`voiceService.currentScreenAudioVerdict()` is its single producer, and `canShareScreenAudio`
delegates entirely to it — the third mirror this PR removes rather than re-pins. The R8 divergence
survives intact: `'none'` **plus a live audio track** resolves to `'system-loopback'`, which is both
what the browser path actually sends and the string that case already rendered.

**2. A silent app blamed the machine.** MEASURED 2026-09-18: sharing a **Finder** window makes the
macOS tap answer `NoTarget`, because a process that has never produced audio has no audio object to
attach to. The child reported that on stage `'start'`, which `reasonForFaultStage` maps to
`'no-backend'` → *"App sound isn't available on this computer."* That was false — the same build
captured a browser window seconds later. `NoTarget` now reports stage `'target'` →
`'target-unresolved'` → *"We couldn't capture that app's sound."*, which is true of every cause that
member collapses, and the collapse stays A7's. The unwind is untouched; only the reported stage
moved, which is why the fix threads a stage through `unwindFailedStart` rather than returning early
and leaving a possibly-armed addon behind. **Correction (see § As-built addendum — #3394 PR 1):**
the stage was posted correctly, but it could not reach the user — `handleHello` had already settled
the start promise `ok:true` before this fault ever arrived, so the corrected copy was computed and
dropped on every run until PR 1 shipped.

**Both are the same shape, and it is this epic's signature:** a branch written, exhaustively typed,
unit-tested and unreachable. Neither was visible to 15,837 passing tests. Exhaustiveness proves you
handled every case you were GIVEN; it never proves the caller can give you every case. The cheap
probe also beat the deep dive — `NoTarget` was one step from a Core Audio read, and varying the
INPUT (a window that actually makes noise) answered it in two minutes.

### Two more, found by following a review finding rather than accepting it (#3349)

Gitar returned `CHANGES_REQUESTED` on the Sonar-remediation head with a finding on
`capturePerProcessScreenAudio`. Its **coordinates were right and its analysis was wrong in both
directions**: it claimed a failed re-capture leaves "the main-process capture child holding the OS
audio tap running", which `startAudiocapHost`'s kill-first `killAudiocapHost()` (I3, synchronous,
nothing awaited before it) already prevents for any invoke that reaches main; and it missed that
`switchScreenSourceQueued` already calls `stopScreenAudioHost()`, which reaps the stale bridge it
was worried about. Its suggested patch would have fixed a non-defect.

Reading the method's failure paths because of it surfaced two real ones, on a single line, in
opposite directions.

**3. Per-process audio never survived a source switch.** `switchScreenSourceQueued` acquires the
new capture FIRST (a cancelled picker must leave the existing share running), then later tears down
the previous share's audio. By then the per-process arm has installed its bridge and written
`mode: 'per-process'`, so `this.screenAudioBridge` is the NEW bridge -- and the teardown stopped it
and posted `audiocap:stop`, reaping the child `audiocap:start` had just started.
`produceScreenAudioFromStream` then read a stream whose audio track had already ended. System
loopback was unaffected, because its track comes from `getUserMedia` and the teardown only stops
the bridge; that asymmetry is what made the defect visible at all.

**4. A refusal's degrade reason was destroyed by the same line.** The arm writes
`mode: 'degraded'` with the reason main produced; `stopScreenAudioHost()` then wrote
`mode: 'off'`. Its early return only fires on `mode === 'off' && overrun === 0`, so a degrade never
took it. The user was told nothing rather than *"We couldn't capture that app's sound."* -- a
mechanism string computed and then discarded, one layer up from defect 2.

**The fix threads ownership, not a bridge reference.** `captureScreen` and `captureScreenElectron`
return `ScreenCaptureResult`, carrying `ownsScreenAudioOutcome`; the switch runs its teardown only
when that is false. The field is **ownership of the OUTCOME, not "installed a host"** -- a refusal
installs nothing yet has still superseded the inherited host and written the state that must stand,
so a host-shaped field is false exactly where defect 4 lives. The arm acquires candidate video
first, then the switch-only currentness predicate gates teardown and is rechecked after start
success or rejection. A stale outcome returns without global teardown or state writes; a current
post-start bridge or `addTrack` failure performs full teardown and records degraded state. The
returned outcome remains owned by the arm so the caller cannot clobber a successor.

Three alternatives were tried and rejected: moving the teardown before `acquireScreenCapture`
silences a share that survives a failed capture; comparing the bridge reference across the capture
cannot see a refusal that had no prior bridge, both sides being `null`; and a boolean named
`installedScreenAudioHost` routes straight back into defect 4.

**The regression suite needed two controls, and the first one's failure is the lesson.** The
appended `describe` is a SIBLING of the existing one, so the outer `beforeEach` never ran: the
switch returned at its "no active screen share" guard, the capture never executed, and all three
cases failed exactly as they would have if the fix were absent. The control passed throughout,
because it drives `captureScreenElectron` directly and needs none of that share state. **A control
proves the thing it exercises** -- that one exercised the capture, not the switch. The second
control asserts the switch reaches the capture at all. Mutation: reverting the guard kills the
success and reason cases; dropping the arm's up-front supersede kills the child-reaping case; both
controls survive each.

#### And a fifth, where the suggested patch was measured to be inert

Gitar's second finding on the same review: `ScreenAudioBridge.stop()` deletes its claim from
`awaitingPort` but does not drop this generation's entry from `unclaimedPorts`, so a port arriving
after teardown is buffered until a later bridge's supersession sweep or until
`UNCLAIMED_PORT_LIMIT` evicts it. The finding is accurate and its own severity -- bounded and
self-correcting -- is right.

**Its suggested patch, `dropUnclaimed(generation)` inside `stop()`, does not fix it.** `stop()`
runs BEFORE the late port arrives, so the buffer is empty at that moment and there is nothing to
drop. Measured rather than argued: a probe with that exact patch applied printed
`late-port closed = false`, and a mutant reproducing it leaves the regression case failing while
the other nineteen cases stay green. Applying it would have shipped a dead line under a comment
claiming a fix.

Normal adoption deletes the claim immediately, whether the port was buffered or arrived in flight.
A no-claim generation at or below the current generation closes as a duplicate or retired handoff;
future generations buffer. Only a stop-before-handoff installs a self-removing tombstone that
closes the late port, while the `dropUnclaimed(generation)` call covers a port already buffered
when `stop()` runs.

The general shape, since it has now cost two near-misses in one review: **a reviewer's coordinates
and its remedy are separately wrong.** Finding 1 named the right method for a refuted reason;
finding 2 named a real residue with a remedy that cannot reach it. Both were worth following and
neither was worth applying.

## As-built addendum — #3394 PR 1 (start waits for the tap; renderer loss ends the capture)

**Two defects in shipped code, unrelated to each other, cut as one PR because each is small and
each is worth shipping alone.** No `notice` kind, no `'run'` fault stage, no detector, no
`audiocap:notice` channel, no UI — all of that is PR 2. `IPC_CONTRACT_VERSION` stays 28 and
`SPA_MIN_CONTRACT` stays 19; nothing here adds or changes a channel.

**1. C1 — settle-at-`started`, not settle-at-`hello`.** Before this PR, `handleHello` resolved
`startAudiocapHost`'s promise `ok:true` in the same turn it posted `{kind:'start'}` and handed
over the port — before the child had resolved a target or attempted `addon.start`. `settleOnce`
is first-outcome-wins (I4), so every later `fault{stage:'target'|'start'}` arrived at an already-
settled promise and was silently dropped. This is precisely why the PR 3 addendum's `NoTarget` →
`'target-unresolved'` copy — a real fix, correctly coded — never reached a user; see the
correction inline in that addendum above. `HostState` gains `'starting'`, entered from
`handleHello` immediately after posting `start` and handing over the port, instead of `'capturing'`
entered there directly. The child now posts a bare `{kind:'started'}` ack
(`AudiocapStarted`/`isAudiocapStarted`, `audiocapProtocol.ts`) as the LAST statement of
`handleStart` once `addon.start` has returned successfully — after every refusal branch has
already returned, so a refusal can never be followed by a `started` telling the renderer the share
has sound. `handleStarted` accepts it only in `'starting'` (a duplicate, an early arrival before
`hello`, or one from the probe all retire the session `protocol-fault` through §4a's closed set,
with no "ignore it" branch); on acceptance it clears the ack timer, enters `'capturing'`, and
`settleOnce`s `ok:true`. A `fault{target|start}` arriving in `'starting'` now reaches the promise
that is actually still open, exactly as the PR 3 fix intended.

**2. `START_ACK_TIMEOUT_MS`, separate from `HANDSHAKE_TIMEOUT_MS`.** It bounds `start` → `started`,
not spawn → `hello`, because it bounds a different thing: OS tap creation, which the design expected
could sit behind a first-run macOS TCC prompt. T0 measured that it does not, on the dev binary (see
the record below); a Developer-ID-packaged build is unmeasured. Initial value 10000ms,
same shape as the handshake timer (`armStartAck`, `unref`'d — a pending ack must never hold the
event loop open at quit). A timeout retires the session `handshake-timeout` — the same reason and
the same user-facing copy as a missed `hello`, because from the renderer's side both mean "the
child didn't start in time."

<!-- T0-MEASURED -->
**T0 measured it (2026-09-23), and the premise was wrong in the helpful direction: tap creation
does not wait on a prompt.** Setup: macOS 26.6.2 (25G83), the dev Electron binary
(`com.github.Electron`, ad-hoc re-signed with `NSAudioCaptureUsageDescription`), the
`AudioCapture` grant reset with `tccutil`, one window of a browser playing audio, synthetic
camera/mic flags on (they cannot reach a Core Audio tap). Result: `start` to a live share in
**1-2 s by stopwatch, and no TCC prompt at any point.** The child's liveness line proves the tap
ran and was ungranted rather than attributed to some pre-granted parent app: `callbackTotal`
1508 over ~16 s, `signalTotal` 0, `silentSinceStart` true, `quiesceProved` true,
`destroyFailures` 0, and `addon.stop()` returned in 56 ms. So nothing a human does can hold
`start → started` open, and **`START_ACK_TIMEOUT_MS` stays at 10000ms**, now about 5x a measured
value instead of a guess. The spec §6 decision table's "blocks on the prompt for longer than 10s"
row is unreachable on this path. **Not measured: a Developer-ID-signed packaged build**, whose TCC
path may differ; that is the remaining gap, not an assumption that it matches.

**CORRECTION (#3394 PR 2, 2026-09-23, from TCC's retained log — E2):** the T0 record above
over-claims what it measured. T0's six audio-capture checks were credited to the **launching
app**, never to Electron. Three (17:25–17:37) went to Claude.app and were allowed; three
(17:39–17:44) went to `com.anthropic.claude-code` and were **denied** with reason 8, which the
widely cited TCC reason table lists as a missing usage string. So T0 held granted and denied taps
alike, and every one was silent. **INFERRED:** the silence is over-determined, since every T0
share targeted one window-owner PID (E1 was measured on a third-party comms app; T0's browser was not
re-measured). "No prompt" is explained by the credited app lacking a usage description, not by
tap creation never waiting on a prompt. **UNMEASURED:** a denied first share with the target
fixed, and whether tap creation waits on a prompt when the credited app *does* carry the usage
description (a packaged Concord). **STANDS:** 1–2 s `start → started`, as a **granted-state**
figure only.

The consequence is PR 2's, not this constant's: **a first-run user with no grant gets a share that
goes live, carries a silent audio track, and says nothing.** That is R9's state B arriving at
first use, not only on revocation, which is exactly what the mid-share detector and notice
channel exist to surface. The decision stays settle-at-`started` regardless — reverting to
settle-at-`hello` re-opens C1.

**Measuring it found two defects, both fixed with this record.** Neither had ever let the
liveness line reach a developer. (a) `reportLiveness` wrote with `console.debug`, which Node
sends to stdout; the host drains the child's stdout unread and echoes only stderr, so the line
went nowhere. It now uses `console.warn`. (b) One Stop-sharing click sends `audiocap:stop`
twice, and `stopAudiocapHost` drained any quiescing child before checking for a live session,
so the redundant stop killed the child the first stop had just asked to quiesce — measured at
16 ms, inside `addon.stop()`. It now returns first when nothing is live, the rule its own
probe guard already stated. Each has a test that fails with the fix reverted.

**3. Accepted cost: video publication now waits on the same promise.** `startAudiocapHost`'s start
promise is what `capturePerProcessScreenAudio` (`voiceService.ts`) awaits before it adopts the port,
attaches the audio track, and returns its `ScreenCaptureResult` — and that return is what feeds the
video track into `produceScreen`'s publish. So the per-process arm's video, not only its audio, now
waits behind OS tap creation on every share: 1–2 s as T0 measured it, bounded by
`START_ACK_TIMEOUT_MS`. This was not true when the promise settled at `hello`: a share used to go live as soon as
the child existed, with app audio arriving or failing silently afterward. The trade is deliberate —
C1 is a correctness defect (a real fault reaching nobody), and this is its cost.

**4. C15 — a reload or renderer crash now ends the capture.** Before this PR neither had any
effect on a live capture child: `render-process-gone` only logged, and nothing watched navigation
at all, so a reload or crash left the child holding its OS tap until the next share or app quit —
reachable by an ordinary Cmd+R, against the exact privacy invariant #3197's teardown gate exists
for. `killAudiocapCapture()` (`audiocapHost.ts`) retires the live session unless it carries no
`windowHandle`, which is what spares the app-start capability probe: the probe has no window and
deliberately overlaps the first page load, so killing it there would reap it before its `hello` on
every cold start: `probeInFlight` would memoize `{ok:false, reason:'child-crash'}` for the life of
the process, and the machine-capability snapshot would stay `null` (the pre-addon rungs) until the
first share's own `hello`. A kill during `'starting'` settles the pending start `child-crash`, like
any other kill; the renderer that would read it is the one that just went away. `wireAudiocapRendererLoss(contents)` wires
both signals on the main window's `webContents` (called from `main.ts` alongside the existing
`render-process-gone` handler) and calls `killAudiocapCapture()` on `render-process-gone` and on
`did-navigate`. **`did-navigate`, not `did-start-navigation` — this choice moved once during PR 1
execution and the reason is worth keeping.** The first cut used `did-start-navigation` gated on
`isMainFrame && !isSameDocument`, on the reasoning that ending the capture as early as possible
minimizes how long a stale tap survives a reload. Electron's documented navigation order is
`did-start-navigation` → `will-frame-navigate` → `will-navigate` → … → `did-navigate` (Context7
`web-contents.md` § navigation events), and `main.ts`'s own `will-navigate` handler can still veto
the navigation after `did-start-navigation` has already fired. Keying on the earlier event meant a
link click the app then cancelled would already have killed a live share's app audio for nothing.
`did-navigate` fires for the main frame only, and only once a cross-document navigation COMMITS;
an in-page navigation (`pushState`, a hash change) fires `did-navigate-in-page` instead and is
correctly ignored. The accepted cost is symmetrical to the C1 trade above: on a genuine reload the
tap now outlives the old document until the new one commits, longer than the earlier cut would have
allowed (not measured). Window close needs no wire of its own — `mainWindow.on('close')` always
calls `preventDefault()` unless the app is quitting, and the quit hooks already call
`killAudiocapHost`.

**4a. Three gaps the Phase-4 red-team pass found in item 4, and closed in this PR.** Each was
proved with an executable PoC against the code above and is now pinned by a test that a mutant
of its fence fails.
(i) **A loss during `audiocap:start`'s window enumeration orphaned a capture.** The handler awaits
`desktopCapturer.getSources` after its sender fence; a reload or crash landing in that await found
no session for `killAudiocapCapture` to kill, so the start went on to fork, post `start`, hand the
port to the NEW document and settle `ok:true` to nobody, leaving a tap only quit would reap. The
host now counts renderer losses (`audiocapRendererLossEpoch()`, bumped by every handler
`wireAudiocapRendererLoss` registers); `handleAudiocapStart` snapshots it beside its existing
`shareOperationEpoch` and refuses on a change with the same `target-unresolved` a superseded start
already gets. It then re-runs FENCE 1 after the await, returning `protocol-fault`: measured on
Electron 44, `senderFrame` is `null` once its document has navigated, and a frame this host does
not watch moves no epoch.
(ii) **A main-frame navigation that fails commits an error page and fires no `did-navigate`**
(measured: `did-fail-provisional-load` then `did-fail-load` with code -6, and the owning document
gone). `wireAudiocapRendererLoss` therefore also listens for `did-fail-load` and ends the capture
when `isMainFrame && errorCode !== -3`; ERR_ABORTED is excluded exactly as the self-heal filter
excludes it, because a cancelled navigation leaves the document in place. Measured as NOT firing
either kill: a vetoed navigation, a subframe navigation, and an in-page navigation.
(iii) **The capability probe's cleanup killed whatever session was live** (I2, older than this PR
and latent — the renderer offers per-process audio only after a `hello` has set the snapshot). A
share that superseded the probe mid-handshake was ended `child-crash` by the probe's own `finally`.
`runCapabilityProbe` now reads its own session synchronously after `startAudiocapHost` returns (the
Promise executor assigns it) and reaps only that one; a probe that created no session reaps
nothing.

**4b. Three more, found at Phase 8, and one correction to 4a.**
(iv) **The wire was attached after the initial load.** `main.ts` called `wireAudiocapRendererLoss`
at the end of `createWindow`, behind `await loadPackagedRenderer` / `loadDevRendererWithFallback`,
and `loadURL` does not resolve until `did-finish-load` — while the renderer is already live. A
red-team PoC showed a reload or crash inside that window reaching no listener. The wire now runs
immediately after the main window is constructed; the initial load's own `did-navigate` is
harmless, because no capture exists yet and the probe is spared.
(v) **A renderer `audiocap:stop` reaped the app-start probe.** `killAudiocapCapture` spared it;
`stopAudiocapHost` did not. A stop landing inside the probe's handshake memoized `child-crash` and
left the capability snapshot `null`, so the renderer never offered the per-process rung — the only
path that could re-set it. The PoC proved the consequence, not that renderer teardown reaches that
window in practice. `stopAudiocapHost` now returns early when the live session is the windowless
probe, mirroring the kill.
(vi) **Admission was wider than the loss watch.** Both invokes checked origin only, so a PiP
window — same SPA, same preload — could start or stop a capture while only the main window's main
frame is watched for loss. Admission now also requires `event.sender` to be the main window's
webContents and the sender frame to be its main frame (by `frameTreeNodeId`), at the first fence and
in the post-await re-check.
**Correction to 4a:** its claim that every fence "is now pinned by a test that a mutant of its fence
fails" was not true when written. A 28-mutant run found that routing `render-process-gone` or
`did-navigate` around the epoch, and deleting the `main.ts` wire outright, left every test green —
the test named for those events fired only `did-fail-load`. Both are pinned now.

**5. What is still open, by decision rather than by gap.** A renderer that stays alive but stops
acking credits — the case the watchdog rail (spec §6c rail 3) would cover — is not addressed by
either fix here. The child keeps dropping quanta at its ring and keeps the OS tap until stop,
supersede, or quit; see `audiocapHost.ts`'s "NO WATCHDOG RAIL HERE" comment, updated by this PR to
record that #3198 PR 3 made the rail's precondition (a capturing child) true and that PR 1's two
renderer-loss signals still do not reintroduce it. Reintroducing the rail for that case is a
decision this PR does not take. Also deferred, to PR 2: a `fault` arriving just AFTER an accepted
`started` retires the child — privacy holds — but reaches no user, because the start promise has
already settled `ok:true`. That is C1's shape moved past `started`, and telling the renderer about
it mid-share is exactly PR 2's non-terminal channel.

## As-built addendum — #3394 PR 2 (process-tree targeting, the interrupted channel, and the record corrections)

**Scope, restated from the top of the PR.** The silence advisory design (`notice{level}`, the 1 s
sampler, the darwin hint, the 60 s cooldown) is dropped entirely, not shipped and later removed —
E3 and E4 below show that its two triggers (revocation, an ungranted first share) do not occur as
designed. What ships instead is native process-tree targeting (§3.2/§3.3 of the PR 2 spec) and one
terminal push, `audiocap:interrupted`, for a live per-process share that loses its audio without
the user asking.

### The tree rule, and where it runs

The window-owner PID alone frequently taps a process that renders no sound — `rt/process_tree.h`
exists because E1 measured a third-party comms app's owner process holding a Core Audio object with
`IsRunningOutput = 0` while its `Helper (Renderer)`, a child process, was the one producing
signal. `AddonStartOptions.allowDescendants` is now the **required** literal `true` in the capture
child (`audiocapChild.ts`), so a forgotten flag is a compile error rather than a silent owner-only
tap; `buildTarget` (`rt/capture_backend.h`) admits `allowDescendants` only paired with **exactly
one** PID, refusing `BadOptions` otherwise, because a tree expansion takes a single root.

The walk itself (`inTree`, `rt/process_tree.h`) is a pure, allocation-free, bounded loop: it climbs
a candidate PID's parent chain, testing the **host's own subtree first** on every hop and the
**owner** second. That per-hop check covers an owner ABOVE the host — the Claude.app or Terminal
window that launched a dev client, whose descendants include Concord itself. It cannot see an owner
BELOW the host, because the climb stops at the owner: the Phase-4 red-team pass showed a tap created
over two objects inside Concord's own subtree when the window's owner was a process Concord had
spawned. `rootOutsideHost` closes it by also climbing the owner's own ancestry, requiring it to
reach launchd without meeting the host and failing closed on any unreadable or over-deep hop, so a
share of a window belonging to Concord's own process tree captures none of it. `hostRootPid()` is `getppid()` read from inside the capture `utilityProcess`, which
resolves to the Electron **main** process, not to some ancestor further up the OS tree. All of it
runs **natively, inside the capture child** (`rt/platform/macos/tap_backend.h` orchestrates;
`hal_api.h` + `tap_backend.mm` make the four OS calls) — never in main, per D5/I2: no PID crosses a
process boundary, and Windows' own `INCLUDE_TARGET_PROCESS_TREE` expands natively on the same
platform-confinement principle, so `targetPids: [owner], allowDescendants: true` means the same
thing on both platforms once #3196 exists.

### The caps, and the fail-closed shape

Three bounds, each independent and each refusing rather than truncating:

- **`kMaxTreeObjects = 16`** — the expanded set's own ceiling, four times the only measurement on
  record (a third-party comms app: owner + 3 object-holding descendants). Above it the whole share refuses
  (`kNoTarget` → `'target-unresolved'`); it is **never** truncated to a subset, because a subset
  could drop exactly the one helper process that renders audio — the silent-share defect this PR
  exists to close, reproduced by policy instead of by omission. `kMaxTargetPids` (8) is unrelated
  and continues to bound only the caller-supplied PID list.
- **`kMaxAncestorDepth = 32`** — the walk's hop ceiling, which doubles as cycle termination for a
  corrupted or adversarial parent-pointer chain.
- **`kMaxProcessObjects = 512`** — the system-wide enumeration buffer. A longer list refuses rather
  than silently drops entries past the cap, because a full buffer is indistinguishable from a
  truncated one and either could hide the one object that matters.

Every other arm (root PID ≤ 1, a failed `parentPid` lookup, a PID reaching ≤ 1 without resolving)
excludes just that one candidate rather than the whole share — under-capture, the only failure
direction the walk can take. The full fail-closed table, arm by arm with its code citation, is
recorded in `native-audio.md` § "Process-tree targets" and
is not restated here; this addendum states the invariant, that file is the enforceable list.

### The snapshot residual

The enumeration is taken **once, at start** — there is no HAL property listener and no live
`kAudioTapPropertyDescription` rewrite. A helper process that first connects to Core Audio only
*after* the share begins is never in the captured set, and the share goes silent with no signal to
distinguish it from a genuinely quiet app. The case the spec named, a browser's audio service on
first playback, does not arise for Chrome in ordinary use: M2 measured Chrome 149 starting its
`audio.mojom.AudioService` at browser launch (4 s after the main process, before any playback), so
a share started before playback still captured sound. The residual needs that service to start or
restart mid-share, for example after a crash. The remedy is the same toggle the interrupted
UI offers for an unrelated failure: turning Share Sound off and back on starts a fresh capture
child and a fresh snapshot. A live re-scan was considered and rejected — it is a second mutation
path on the privacy surface, and it would need its own teardown barrier, since removing a listener
does not drain one already in flight any more than `AudioDeviceStop` drains an IOProc.

### The Safari / launchd-parented XPC limitation

WebKit's GPU process — and Safari's audio rendering with it — is launched by `launchd`, not by
Safari itself, so a parent-chain walk structurally cannot reach it: there is no private SPI used to
bridge the gap (`responsibility_get_pid_responsible_for_pid` is private, and bundle IDs differ
between an app and its helpers, so they do not substitute). A Safari share could either go live
with silent app audio and no message, or refuse with `'target-unresolved'`, depending on whether
Safari's own process holds a Core Audio process object. **M3 measured the refusal:** Safari and its
`WebKit.WebContent` process are both launchd-parented, the owner holds no process object, the tree
is empty, and the start settles `'target-unresolved'`. The user sees video, no app sound, and "We
couldn't capture that app's sound. Share a whole screen to include sound." That message is itself
an M3 finding (see below): before this PR's fix the reason was stored and never shown. Any app whose
audio renders through a launchd-parented XPC service shares this limitation; one whose window owner
does hold a process object would take the silent shape instead, and none has been observed.

### Windows parity — #3196 is not built

The rule is stated to mean the same thing on both platforms — "the app's process tree" — but only
the macOS half exists in this PR. #3196 owes `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` on
the single owner PID, expanded natively by the OS exactly as macOS's tree is expanded natively
here, plus an equivalent of the host-subtree exclusion before it can ship — without it, a Windows
share of Concord's own window would tap Concord's own audio output the same way an unguarded macOS
walk would. Two differences are recorded rather than left implicit: Windows' tree mode is **live**,
where macOS's is a start-time **snapshot**, and the host-subtree exclusion is a macOS-backend rule
that #3196 must add rather than inherit.

### `audiocap:interrupted` (contract 30), and why the trigger is a watch

`IPC_CONTRACT_VERSION` moves 29 → 30; `SPA_MIN_CONTRACT` stays 19 (capability, not demand — a
shell below 30 simply says nothing when a share's audio dies, which is the pre-30 behaviour). One
main → renderer push, `{generation, reason}`, where `reason` is the closed three-member
`ScreenAudioInterruptReason` union (`'capture-interrupted' | 'child-crash' | 'protocol-fault'`) —
never the addon's own fault text, which stays inside the capture child by construction (I2). Full
wire-contract detail — the sender-frame posture, the preload field-copy, the registration-order
proof — lives in `electron.md` § "IPC contract v30" and is not
duplicated here.

**The trigger is a 1 s poll of `status().faulted` in the capture child
(`FAULT_WATCH_INTERVAL_MS`), armed immediately after `postStarted()` and cleared as `handleStop`'s
first statement — not an event.** `QuantumPump::fault()` latches without signalling: once a fault
is set, every later callback takes the fault arm and stops emitting quanta, so the drain callback
that would otherwise carry a wake-up never runs again. An event-driven alternative — the fault
raising the existing TSFN signal — changes `rt/`'s real-time semantics, and a wake-up consumed
while the child is credit-blocked is lost with no replay. Polling one boolean field once a second
costs nothing the real-time path cares about and cannot miss a latch the way a signal-based design
could. `kFormatChanged` (`rt/platform/macos/tap_backend.h`) is the only native producer reachable
today — the stereo-mixdown tap makes a channel-count change unlikely on real hardware, so this path
is proven by a fake HAL and a child-level test rather than measured live; `DeviceLost`,
`PermissionLost` and `NoCallbacks` carry phrase-map arms for #3196's Windows backend and have no
macOS producer yet.

### The silence advisory dropped, and why

E3 measured that revoking the audio-capture grant mid-share has no effect on a running tap — the
grant is checked once, at tap creation, never again. E4 measured that a tap **with the audio-only
grant denied** still carried signal on 1541 of 1541 callbacks, provided the responsible process
held Screen Capture (and, in that run, Microphone). Both of the advisory's two design triggers —
revocation, and an ungranted first share — therefore do not occur the way the Phase-2 design
assumed, and dropping the advisory removes the detector, the sampler, the advisory state, its copy,
its cooldown, and the T0 silence constants along with it. Nothing about R9's own measured zero-fill
result is retracted — it stands for R9's own conditions, a standalone binary whose grant state was
never recorded — but it no longer generalises to the case the advisory was built to cover.

### `'capture-starved'` removed from `ScreenAudioDegradeReason`

The union goes from 10 members to 9. It existed to name the silence-advisory's own failure mode,
which no longer exists once the advisory itself is gone; every remaining
`ScreenAudioInterruptReason` member has a live production producer (the fault watch, a child
`exit`/`error`, or a stage-illegal message), which `'capture-starved'` never did for this rung.

### The hung-child gap — still undetected, by decision

A capture child that hangs without crashing — stops acking flow-control credits but never exits and
never posts a fault — is not covered by any mechanism in this PR. The watchdog rail (spec §6c rail
3, referenced again in the #3394 PR 1 addendum above) would be the mechanism, and it stays out of
scope here for the same reason it stayed out of scope in PR 1: reintroducing it is a decision this
work does not take, not a gap nobody noticed.

### The retry video glitch (E5)

The interrupted UI's remedy is the existing Share Sound toggle — turn it off, then on. That
restarts the whole per-process capture, video included, so a viewer sees a brief glitch on retry
even though only the audio half was ever lost. An audio-only restart that avoids it would need new
host infrastructure and is not built; it is recorded as accepted cost, not fixed.

### M1–M6 pre-merge hardware checks

The developer ran all six on 2026-09-24 on macOS 26.6.2, with dev clients of this branch launched
from the Claude desktop app. Liveness figures are the child's `reportLiveness` line at stop.

| # | Check | Procedure | Pass condition | Result |
|---|---|---|---|---|
| M1 | Positive control | Share a playing third-party comms app window on this branch's dev build; read `reportLiveness` at stop | `signalTotal > 0` (control: E1's owner-only record, `signalTotal` 0; if that app's layout has changed, re-run `main` as the control) | **PASS.** `signalTotal` 856 of `callbackTotal` 2315, no fault, `quiesceProved` true, `destroyFailures` 0 |
| M2 | Late-helper residual (merge gate) | Share a Chrome window; start the share **before** first playback, then play | Record the result; if the audio service was not tapped, decide on re-evaluation before merge (spec §13 decision 3) | **PASS.** Chrome 149.0.7827.201 freshly launched; `signalTotal` 1163 of 1671. Its `AudioService` started 4 s after the browser, before the share, so the late-helper residual did not arise. No re-evaluation needed |
| M3 | Safari / XPC limitation shape | Share a Safari window with media playing | Record which of the two named outcomes occurs (silent-with-video, or refused `'target-unresolved'`) | **Refused `'target-unresolved'`** (`fault{target}`, `callbackTotal` 0). Found the degraded state unrendered; re-run after the fix shows the message |
| M4 | Host-subtree exclusion | Share the Claude.app or Terminal window that launched the dev client, while in a call | Peers do not hear the call echoed | **PASS** on the re-run: sharing client kept as a live descendant of Claude.app, call audio audible, `signalTotal` 0 of 2984. The first run was invalid (see below) |
| M5 | Interrupted UI, live | `pkill` the capture utility process mid-share, in both themes | The interrupted badge, toast and announcement appear; video continues; captures attached to the PR | **PASS** in both themes after the rail-2 fix; failed before it (see below) |
| M6 | Start-path latency | Record `start → started` latency in the M1 run | Stays well under `START_ACK_TIMEOUT_MS` (10000ms) | **PASS.** About 1-2 s by stopwatch, matching the granted-state T0 figure |

**What the checks found, all fixed in this PR.** Each of these passed its unit tests before the
hardware run found it.

- **M3: the degraded state had no display.** A refused per-process start wrote
  `{ mode: 'degraded', reason }` and nothing rendered it, so the Safari share went live silent with
  no message, although #3405's changelog promised one. `voiceService.degradeScreenAudio` now writes
  the state and the slot-error toast at every degrade site.
- **M3: the slot-error toast was see-through.** Its background was a 15% tint over `transparent`, so
  the stage label showed through the message. It is now opaque `--bg-secondary`: 5.50:1 minimum
  across all 34 theme blocks, where a 15% tint over the same colour measured 4.48:1 in high-contrast
  light.
- **M5: the interrupted state was overwritten 7 ms after it was written.** Measured with probes over
  CDP: the interrupt handler's `retireScreenAudioProducer` emits `close-producer`, the SFU echoes
  `producer-closed`, and the handler's screen-audio "teardown rail 2" called `stopScreenAudioHost`
  for any local-user echo, writing `off`. Rail 2 now runs only for a producer this client still
  holds, which is the ownership check the mic and camera branch of the same handler already used.
  Phase-8 review then found that the server-close branch itself stopped only the capture host: the
  SFU closes exactly one producer, so on the desktop-loopback rung the closed producer kept sending
  RTP and Share sound could not be turned back on. That branch now covers screen and screen audio
  alongside mic and camera, and screen audio takes the Share-sound OFF path
  (`setScreenAudioEnabled(false)`), which keeps the captured track for reuse.
  The same echo would have stopped a live capture after a re-produce or a source switch, both of
  which retire the old producer id; that shape was not reproduced live.

**A harness trap, recorded so the next M4 is valid.** Clients launched with `nohup … &`, which is
how `concord-dev.sh` starts them, are reparented to `launchd` once the launching shell exits. They
then sit outside the process tree of the app window being shared, so an M4 share reads
`signalTotal` 0 with or without the exclusion. Launch the sharing client in the foreground of a
shell that stays alive, and check its ancestry with `ps -o ppid=` before trusting the result.

### Record corrections carried by this PR

§5 rows 1–7 above are Corrected in place, all citing the E1–E4 evidence: the "screen grant does not
imply the audio grant" claim in D7 is narrowed to R9's own conditions rather than stated as general;
the T0 record (both in this file's #3394 PR 1 addendum and in `electron.md`'s IPC contract v28
section) is corrected from "an ungranted tap starts at once and delivers silence" to "T0's checks
were credited to the launching app, never to Electron, and held both an allowed and a denied
outcome — every one of which was silent, for a reason (missing usage string, reason 8) that is
INFERRED rather than MEASURED to be the whole explanation." Every corrected claim keeps MEASURED,
INFERRED and UNMEASURED distinct rather than collapsing evidence of different strength into one
sentence — see the evidence note,
`docs/superpowers/reports/2026-09-23-3394-audiocap-capture-measurements.md`,
for the raw TCC log entries and callback counts behind each one.
