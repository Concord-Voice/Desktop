---
description: JSF++ (Joint Strike Fighter AV) coding profile for the native per-process audio capture addon
paths:
  - "desktop/native/**/*.cc"
  - "desktop/native/**/*.cpp"
  - "desktop/native/**/*.h"
  - "desktop/native/**/*.hpp"
  - "desktop/native/**/*.mm"
  - "desktop/native/**/binding.gyp"
---

> **Imported from Concord-Voice-Alpha (@771eb3c) at the repo split.** `client/desktop/` there is `desktop/` here. References to `services/control-plane/**`, `services/media-plane/**`, `docs/superpowers/**`, `docs/runbooks/**`, `docs/ci/quality-gate-definition.md`, the public-mirror overlay and its workflows, Alpha's org rulesets, and ADRs not under `docs/adr/` in this repo point at Alpha or the private ops repos. Use them for context; they are not files or CI in this repo.

# Native Audio Addon Rules — JSF++ Profile

The DECISION and its rationale live in
[ADR-0043](../../../docs/adr/0043-per-process-screen-share-audio-capture.md) § D3. This file is the
ENFORCEABLE list only. Where the two disagree, the ADR is the authoring site for *why* and this
file for *what* — but they must not disagree; fix both in the same PR.

Standard: **JSF AV C++ Coding Standards, Doc. No. 2RDU00001 Rev C, December 2005**
(<https://www.stroustrup.com/JSF-AV-rules.pdf>). It grades its own rules (§4): *shall* =
mandatory and verifiable, *will* = mandatory, *should* = advisory. Adopted **loosely**, per the
project lead — advisory rules are advisory here too.

## The boundary — read this before anything else

```
desktop/native/concord-audiocap/
  rt/      real-time capture core   — JSF++ BINDS
  napi/    Node-API binding layer   — JSF++ DOES NOT BIND
```

`rt/` runs on an OS audio callback thread. `napi/` talks to V8, which allocates and (by default)
throws. Do not move code across that line to dodge a rule; move the rule's justification instead,
which means editing the ADR.

The profile binds every subdirectory of `rt/`, not just its top level — `rt/platform/`, added in
PR 2 for the macOS Core Audio backend, is in scope on the same terms as `rt/capture_backend.h` and
every other file already here.

## Binding in `rt/`

| Rule | Requirement |
|---|---|
| AV 206 | No free-store allocation or deallocation after initialization |
| AV 208 | No C++ exceptions — no `throw`, `catch` or `try` |
| AV 119 | No recursion, direct or indirect |
| AV 215 | No pointer arithmetic — index a bounds-checked array |
| AV 115 | If a function returns error information, that error information is tested |
| AV 142 | All variables initialized before use |
| AV 207 | No unencapsulated global data |
| AV 209 | No bare `int`/`short`/`long`/`float`/`double` — use fixed-width typedefs |
| AV 189 | No `goto` |
| AV 197 | No floating-point loop counters |
| AV 201 | A `for` loop's counter is not modified in the loop body |
| AV 20 | No `setjmp` / `longjmp` |
| AV 22 | No `<stdio.h>` |
| AV 24 | No `abort`, `exit`, `getenv`, `system` |
| AV 25 | No `<time.h>` functions |
| AV 1 | No function exceeds 200 logical source lines |

**Corollary to AV 206, stated because it is the rule most often broken by reflex:** no STL
container that allocates may appear in `rt/`. No `std::vector`, `std::string`, `std::function`,
`std::map`. Fixed-capacity arrays sized at construction, and raw spans over them.

**Corollary to AV 208:** the seam uses the C `node-api`, or `node-addon-api` compiled with
`NAPI_DISABLE_CPP_EXCEPTIONS`. Errors cross the boundary as an explicit result enum, never as an
exception.

## Named deviations — approved, do not re-litigate in review

| Deviation | Scope | Why |
|---|---|---|
| C++11-and-later constructs: `constexpr`, `enum class`, `std::atomic`, `= delete` | `rt/` | JSF++ Rev C predates C++11 entirely. Each of these STRENGTHENS what its rules protect. `std::atomic` in particular is how a lock-free ring buffer is written correctly; the 2005 standard had no vocabulary for it |
| AV 206 and AV 208 | `napi/` only | N-API must allocate to create JS values |
| AV 206, AV 207, AV 208 and AV 215 | `rt/platform/macos/tap_backend.mm` **only** — not the header, not any other file under `rt/platform/` | The one file that names Core Audio, and every one of these is forced by the SDK rather than chosen. **AV 206:** `CATapDescription`, `NSUUID`, `NSMutableArray` and the aggregate-device `NSDictionary` are the only way to construct a tap; there is no allocation-free C entry point. Confined to the START path — never the audio callback, which is the property AV 206 exists to protect and which `ioProcThunk` still honours. **AV 208:** an Objective-C message send can raise `NSException`, and these functions are `noexcept`. The containment is that this file has **no `@try`/`@catch` anywhere**, so an uncaught `NSException` reaches the Objective-C runtime and terminates the process — a bounded abort, never an unwind through a `noexcept` frame. `GCC_ENABLE_CPP_EXCEPTIONS: 'NO'` is NOT what provides that: it governs **C++** exceptions, and `NSException` is a separate mechanism whose syntax is controlled by `GCC_ENABLE_OBJC_EXCEPTIONS` (which this build does not set). An earlier revision of this row cited the C++ setting as the reason and was wrong about the mechanism while right about the outcome. **AV 207:** the two IOProc slots (`g_ioProcFn`, `g_ioProcCtx`), because `AudioDeviceCreateIOProcID` takes a C function pointer with no usable client-data channel through this wrapper shape; both are `std::atomic` and are the reason that sub-deviation is safe. **AV 215:** walking `AudioBufferList::mBuffers`, a C flexible-array member. Approved 2026-09-11 on PR #3265 review; #3196's Windows backend must raise its own rather than inherit this one |
| Every rule, as applied to platform SDK headers | both | Rules bind code we author, not `audioclientactivationparams.h` or `CoreAudio.h` |

Anything not on this list is a deviation that has not been approved. Raise it, get it added here
and in the ADR, then write the code — in that order.

**The macOS row above was added AFTER its code, which is the order this rule forbids.** It is
recorded rather than quietly regularised because the gap is the interesting part: the deviations
are individually defensible — allocation in a once-per-capture setup path is not allocation in the
callback — and "obviously fine" is exactly what the register exists to capture, since the next
author reads the table and not the reviewer's judgement. Two independent reviewers found it on the
same PR and neither found it from the code; both found it from this file.

## Process-tree targets (`rt/process_tree.h`, #3394 PR 2)

`CaptureTarget.allowDescendants` expands one owner PID into the Core Audio process-object list
that actually renders an app's audio — the window owner's own process is frequently silent
(a comms app's helper renderer, Chrome's audio service), so the process that emits sound is a
descendant of it. `buildTarget` (`rt/capture_backend.h`) admits `allowDescendants` only paired
with exactly one PID; more than one is refused (`BadOptions`), because a tree expansion takes a
single root — macOS's own walk below, and `INCLUDE_TARGET_PROCESS_TREE` for the Windows backend
(#3196), which is not built yet.

**The walk.** `inTree(pid, root, excludeRoot, parentOf, ctx)` climbs `pid`'s parent chain, testing
`excludeRoot` before `root` on every hop — so a share of a window belonging to the host itself
(Concord's own main process) captures nothing of it — for up to `kMaxAncestorDepth` (32) hops,
the same bound that terminates a parent-pointer cycle. It is a plain iterative `for` loop over a
fixed bound: no allocation, no recursion, no pointer arithmetic (JSF++ AV 119/206/215 all hold).

**Where the candidate list comes from.** `TapBackend::resolveTree`
(`rt/platform/macos/tap_backend.h`) enumerates the HAL's full process-object list ONCE, via
`hal_.processObjectList`, into a `kMaxProcessObjects` (512)-entry stack buffer; reads each
object's PID; and classifies it with `inTree` against the owner (`root`) and
`hal_.hostRootPid()` (`excludeRoot` — `getppid()` of the utility process, which is the Electron
main process). Matches land in a `kMaxTreeObjects` (16)-entry buffer — a separate, larger bound
than `kMaxTargetPids` (8), which still limits only the caller-supplied PID list, never the
expanded one. **The enumeration is a one-time snapshot taken at start** — there is no property
listener and no live re-evaluation of the tap description, so a helper process that first
connects to Core Audio *after* the share starts is never in the captured set (see limitations
below).

**Fail-closed table.** Every arm refuses rather than substitutes a smaller or wider set.
Under-capture (a silent share) is the only failure direction this walk can take — never a widened
one:

| Condition | Outcome | Code |
|---|---|---|
| `allowDescendants` requested with `pidCount != 1` | Refused (`BadOptions`) at admission, before any OS call; defended a second time inside the backend | `rt/capture_backend.h:190`; `rt/platform/macos/tap_backend.h` `resolveTree:300` |
| Root PID ≤ 1 (launchd's tree is the whole system) | Refused before any HAL enumeration call | `rt/platform/macos/tap_backend.h` `resolveTree:306` (guarded again inside `inTree` itself at `rt/process_tree.h:68`) |
| Chain reaches `excludeRoot` — checked **before** `root` on the same hop | Excluded | `rt/process_tree.h:73` |
| Chain reaches the owner (`root`), and the owner's OWN ancestry reaches launchd without meeting `excludeRoot` (`rootOutsideHost`) | Included | `rt/process_tree.h:74-76`, `:46-58` |
| Chain reaches the owner, but the owner itself descends from the host (a window owner Concord spawned) | Excluded — the per-hop check stops at `root` and never sees the host above it, so this second climb is what keeps the host's subtree out. Found by the Phase-4 red-team pass | `rt/process_tree.h:51` |
| The owner's own ancestry cannot be read, or exceeds the depth bound | Excluded — "outside the host" is unprovable | `rt/process_tree.h:54,57` |
| Chain reaches a PID ≤ 1 without resolving | Excluded | `rt/process_tree.h:72` |
| `parentPid` lookup fails (process exited, EPERM) | Excluded — that one candidate drops, not the whole share | `rt/process_tree.h:79` |
| Depth exceeds `kMaxAncestorDepth` (32) | Excluded (the same bound also terminates a parent-pointer cycle) | `rt/process_tree.h:71,82` |
| `processObjectList` enumeration returns non-`kNoErr` | `kDeviceError` at `StartStage::kListProcesses`, no tap created | `rt/platform/macos/tap_backend.h` `resolveTree:309-310` |
| Enumerated list is at or over `kMaxProcessObjects` (512) | Refused (`kDeviceError` / `kStatusListOverflow`) — a full buffer is indistinguishable from a truncated one, so both refuse rather than risk a silent subset | `rt/platform/macos/tap_backend.h` `resolveTree:316-318` |
| Matched set would exceed `kMaxTreeObjects` (16) | Refused (`kNoTarget`) — never a subset | `rt/platform/macos/tap_backend.h` `resolveTree:327` |
| Matched set is empty | Refused (`kNoTarget`), no tap created | `rt/platform/macos/tap_backend.h` `resolveTree:331` |

**Known limitations, named rather than silently absorbed:**

- **Safari and other launchd-parented XPC helpers.** WebKit's GPU process is launched by
  `launchd`, not by Safari, so a parent-chain walk structurally cannot reach it — there is no
  private SPI here to bridge that gap. MEASURED (#3394 PR 2 M3, macOS 26.6.2): Safari holds no
  process object, the tree is empty, and the start is refused with "target-unresolved", which the
  renderer shows as "We couldn't capture that app's sound." An app whose window owner DOES hold a
  process object while its audio plays through a launchd-parented XPC service would instead go
  live with silent app audio and no message; none has been observed.
- **Late helpers.** A helper that starts producing audio only after the share's start-time
  snapshot is never in the captured set, because there is no live re-scan. MEASURED (M2): Chrome
  149 starts its audio service at browser launch, not on first playback, so the ordinary Chrome
  flow is covered; the residual needs that service to start or restart mid-share. The user-facing
  remedy is toggling Share Sound off and back on, which starts a new capture child and a new
  snapshot.

**Platform confinement.** `pid_t` → `std::int32_t` narrowing and
`proc_pidinfo(PROC_PIDTBSDINFO)` are confined to `tap_backend.mm`, reached only through the
`HalApi` seam's four new entries (`hal_api.h`: `processObjectList`, `processObjectPid`,
`parentPid`, `hostRootPid`). `rt/process_tree.h` and `tap_backend.h`'s orchestration name no
macOS type, which is what keeps the whole walk running on the Linux ASAN/UBSAN/TSAN legs through
the fake HAL in `test/macos_tap_test.cc`.

## The `napi/` seam: `capability` / `start` / `drain` / `stop` / `status` / `resolveWindowOwner` (#3195, #3197, #3198)

The addon's whole JS-facing surface is six functions, documented in full at
`native/concord-audiocap/index.d.ts`:

- **`capability() -> AudioCapCapability`.** The platform/OS-version probe that feeds ADR-0043 D6's
  capability ladder.
- **`start(options, onQuantumAvailable) -> { ok: true } | { ok: false, reason }`.** `options` is
  checked for **exact equality**, every field, against the constants compiled into
  `rt/quantum_header.h` — not negotiated. A mismatch is `BadOptions`, a fault to report, never a
  geometry to adopt.
- **`drain(into: ArrayBuffer) -> { ok: boolean }`.** Fills `into` in place via
  `napi_get_arraybuffer_info` and allocates nothing on the payload path. `into` must be exactly
  `QUANTUM_BYTES` (3872); it fails closed — `{ ok: false }`, nothing written — on a wrong size, a
  detached buffer, an empty ring, or a call after `stop()`.
- **`stop()`.** Synchronous and idempotent. It no longer joins a producer thread — teardown is a
  POST-CONDITION, not a mechanism (`rt/capture_backend.h`): `stop()` calls the backend's own
  `stop()`, then closes `rt/sink_gate.h`'s gate and waits, bounded, for every in-flight sink call to
  quiesce. **The release-or-abandon decision is read from the `poisoned` latch, not from what that
  wait saw** — the handle is released only when the wait quiesced AND the process is not already
  poisoned. `stop()` is idempotent and reachable more than once per process (the explicit call, the
  env cleanup hook, and the unwind of a `start()` that armed and then failed), so a second run that
  finds a quiet gate would otherwise release a handle the first run deliberately abandoned. If the
  wait times out, `stop()` instead ABANDONS the threadsafe-function handle — deliberately leaking it rather
  than releasing it under a call that may still be in flight — and latches a process-lifetime
  `poisoned` flag (`rt/teardown.h`). A poisoned process answers every later `start()` with
  `Poisoned`; it can only be killed, never made to capture again.
- **`resolveWindowOwner(handle) -> number | null`.** One OS call — `GetWindowThreadProcessId` on
  Windows, `CGWindowListCopyWindowInfo` on macOS — turning a picked window handle into its owning
  PID. Called ONCE PER SHARE **in the capture child**, never in main (ADR-0043 D5), and the PID it
  returns never crosses back out of that process. Every refusal is `null`, never 0: a numeric
  refusal invites `if (pid)`, and a falsy-check is how a refusal becomes a widened capture (#2161).
  It lives in `napi/window_owner.cc` rather than `rt/` because it runs outside the real-time path.
- **`status() -> AudioCapStatus`.** A pure, allocation-free read of the producer's counters plus the
  `poisoned` latch — the only way a JS caller can observe that a teardown could not prove
  quiescence. It now has a LIVE reader in addition to the post-mortem one: since #3394 PR 2 the
  capture child's fault watch (`audiocapChild.ts`) polls this once a second for the life of a
  running capture, reading only `faulted`/`faultReason` off the snapshot and posting
  `fault{stage:'run'}` on a positive read — nothing else the call returns reaches that message.
  The post-mortem read in `handleStop` is unchanged and reads the full snapshot. `Status_JS`
  (`napi/addon.cc`) reads `g_capture.backend`'s counters live on every call, including a
  concurrent one from that poll, which is why `TapBackend`'s `quiesceProved_`/`destroyFailures_`/
  `failStage_`/`failStatus_` are documented safe to read from the JS thread while the audio
  callback thread writes elsewhere — not because the storage is atomic, but because both live
  writers (`start()`, `teardown()`) run on that same JS thread and the callback thread never
  touches those four fields. `status()` still touches neither the gate nor the threadsafe function,
  whether the call is the live poll or the post-`stop()` read — that safety claim is unchanged.

**`onQuantumAvailable` carries no data and MUST be a `napi_threadsafe_function` with
`max_queue_size = 1`, called `napi_tsfn_nonblocking`.** It is a bare availability *edge*, not a
queue: a signal arriving while the JS side is credit-blocked is coalesced away rather than
buffered. Audio itself flows through the ring, never through this TSFN — that split is what keeps
the credit/backpressure decision on the producer side of the N-API boundary without an unbounded
queue standing behind the signal. Treat a signal as "there may be something to drain," never as
"there is exactly one thing" — drain in a loop until `drain()` returns `{ ok: false }` or the
caller's own credit bound is reached. Do not widen `max_queue_size` above 1 and do not make the
call blocking; either reintroduces a second, uncounted drop/backpressure site alongside the ring's
own.

## The compile-gated synthetic source (`CONCORD_AUDIOCAP_SYNTHETIC`)

`rt/synthetic_source.h` provides a deterministic PCM waveform for testing the whole transport
before a real platform backend exists, and it is **opt-in at `binding.gyp` CONFIGURE time**, not a
runtime flag: `npx node-gyp rebuild -- -Daudiocap_synthetic=1` builds a *second*, separately-named
target (`concord_audiocap_synthetic.node`). The default target — what `npm run build:native` ships
— never defines the macro and has no producer at all; its `start()` unconditionally returns
`{ ok: false, reason: 'NoBackend' }`, which the host resolves to video-only with a reason, never to
a system mix (C9, ADR-0043 D6). `index.js` can only ever `require`-resolve `concord_audiocap.node`,
so the synthetic binary is unreachable through the shipped loader even in a dev tree where both
`.node` files happen to sit side by side. **If touching this ever requires editing
`EXPECTED_NATIVE` in `scripts/verify-asar-payload.sh` or the `native/` lookahead in
`forge.config.ts`, the gyp gate is wrong — not the allowlist**; the release `native/` payload stays
at exactly ONE FILE, the loader (`electron.md` § app.asar payload boundary). `EXPECTED_NATIVE`
lists TWO lines for that one file because an asar listing carries the `concord-audiocap`
DIRECTORY entry alongside it, and both are required — the two numbers describe different units,
not a disagreement. This feature must never be the reason either moves.

## Non-negotiable, independent of JSF++

- **The ring buffer is fuzzed.** It is the one component reachable across a trust boundary.
- **ASAN and UBSAN builds of `rt/` run in CI.** The result is VISIBLE, not
  merge-blocking: the org baseline ruleset's (`17153062`) `required_status_checks`
  names exactly `Gitar` and `SonarCloud Code Analysis`, the Alpha-only `24957423`
  adds `Required PR build result` (see
  `docs/ci/quality-gate-definition.md`
  § Ruleset-enforced gates), and `native-audiocap` is not among them. This line
  said "merge blocker" until PR #3155; it was never true. Making it one is a
  ruleset decision with a real obstacle — the caller node is path-gated, so on a
  PR touching no native path the workflow's jobs never report at all, and a
  required context that never reports leaves the PR pending. See ADR-0043
  § Verification.
- **The addon runs in a `utilityProcess`**, never in main and never in the renderer. A
  memory-safety bug must not own the process holding SSO tokens and the update path
  (ADR-0043 D5). `nodeIntegration` stays off — see [`electron.md`](electron.md).
- **No allocation in the audio callback.** This restates AV 206 because it is the single
  property whose violation is audible rather than merely incorrect.
