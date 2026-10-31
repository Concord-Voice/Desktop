# SonarQube False Positive Register

> **Split from the Concord-Voice-Alpha register at the repo split (Alpha @771eb3c).** The Legacy section keeps the 21 entries that concern code now in this repo, as decided in Alpha. New decisions for this repo go under Post-migration.

| Field          | Value      |
|----------------|------------|
| Effective Date | 2026-04-11 |
| Version        | 1.0        |

## Purpose

This file is the canonical record of SonarQube false-positive decisions for the Concord Voice project. When a SonarQube finding is marked `FALSE_POSITIVE` via the SonarQube API or UI, a corresponding entry MUST be appended here to preserve the reasoning for future reviewers.

The register exists because the `mcp__sonarqube__change_sonar_issue_status` tool used by Claude Code cannot attach justification comments to the marked issue in SonarQube — the tool only flips the status. Without this register, FP decisions would live silently in SonarQube's state with no discoverable reasoning.

> **Security-signal re-homing (2026-06-11, #1426 / ADR-0017):** SAST security
> detection is re-homing from SonarQube's security sensors to per-tool GitHub
> Code Scanning (CodeQL #1424, Semgrep #1426 — categories `semgrep-custom` /
> `semgrep-community`). This is an architecture change recorded per
> ADR-0017 (kept in Concord-Voice-Alpha) §Consequences — NOT a rule
> suppression on AI-authored code. SonarQube retains coverage + new-code
> quality + AI-Code-Assurance (#1430 narrows its scope).
>
> **Enactment (#1430):** the sensor retirement is enacted by deactivating the
> `injection`-tagged VULNERABILITY (taint) rules in project-assigned custom
> quality profiles — the Sonar-staff-documented mechanism for skipping the
> security sensors (no scanner property exists). The profiles are
> org-level, so they are managed from Concord-Voice-Alpha
> (`scripts/sonar/narrow-security-profiles.sh`), not from this repo. This is the recorded ADR-0017 architecture change, NOT
> rule suppression on AI code: hotspot rules, DBD sensors, and all
> maintainability/reliability rules stay active. Quality Gate thresholds are
> byte-identical. CodeQL `security-extended` (#1424) + Semgrep (#1426) own the
> taint classes. The AI-Code-Assurance *security* signal
> originates from GitHub Code Scanning as of #1430.

### Relationship to SonarQube AI-Code Assurance

Concord has **SonarQube AI-Code Assurance enabled**, which prohibits rule-level suppression or tuning of findings on AI-authored code. As a result, **every false positive must be handled at the instance level** via per-issue `FALSE_POSITIVE` markings. Rule-level `sonar-project.properties` edits that disable or tune rules are not allowed. This register is the audit trail that makes the instance-level approach sustainable.

### ACCEPTED vs FALSE_POSITIVE

SonarQube has two distinct "we're not fixing this" states:

- **`ACCEPTED`** — "the rule is correct, but we've decided not to fix it right now" (tech debt).
- **`FALSE_POSITIVE`** — "the rule is wrong about this specific instance" (tool error).

This register is only for `FALSE_POSITIVE` decisions. `ACCEPTED` findings — when SonarQube reports something the team acknowledges as real but chooses not to fix right now — are tracked via ordinary GitHub issues (typically labeled `domain: developer-experience` and prioritized as tech debt). They are not recorded here.

## Known Gap — closed 2026-05-04

This register begins on **2026-04-11** and does not cover the approximately 616
SonarQube false-positive markings made before that date. **No retroactive audit of
them was ever run, and none is planned.**
#615, which
tracked that audit, closed **completed** on 2026-05-04; its closing comment records
that the pre-register markings were rectified incrementally through microchanges
across a few hundred PRs rather than audited as a batch. Treat the pre-2026-04-11
markings as resolved by that incremental work — this register simply does not carry
their reasoning.

## Legacy (Concord-Voice-Alpha, before the repo split)

### Section 1 — Rule-Calibration Notes

<!-- audit-exempt: false-positive substring matches ("alphabetical", "alphabetically") -->
High-level stances on SonarQube rules whose mismatch with this project's idiomatic Go code is **structural** (i.e., any future occurrence of the rule on a similar code pattern would merit the same FP disposition). Entries sorted alphabetically by rule key.

#### `css:S9423` — `!important` in reduced-motion overrides and theme-wide cascade winners

| Field | Value |
|---|---|
| First recorded | 2026-10-29 (Sonar/code-scanning reconciliation sweep) |
| Rationale | The rule asks for every `!important` to be replaced by a specificity fix. That works for ordinary component conflicts, and the 2026-10-29 sweep removed 15 such uses. It cannot work for an override whose job is to beat *every* component rule: the reduced-motion blocks (`*, *::before, *::after` under `@media (prefers-reduced-motion: reduce)` or `[data-reduce-animations='true']`) and a theme override such as the Pride scheme's `::-webkit-scrollbar-thumb`. Any specificity a component adds would outrank a universal selector, so `!important` is the only cascade-correct way to say "this wins everywhere". |
| Instance count in Section 2 | 10 (#261–#270) |
| Disposition | Per-instance `FALSE_POSITIVE` only for an accessibility motion override or a scheme-wide override that must beat all component rules. An `!important` that resolves an ordinary conflict between two known selectors is fixed, not registered. |

#### `css:S9440` — Animation covered by the global reduce-animations override

| Field | Value |
|---|---|
| First recorded | 2026-10-29 (Sonar/code-scanning reconciliation sweep) |
| Rationale | The rule checks each stylesheet alone for a `prefers-reduced-motion` guard. The desktop renderer guards motion once, globally: `[data-reduce-animations='true'] *` in `client/desktop/src/renderer/styles/index.css` zeroes every animation and transition duration, and `settingsStore.applyReduceAnimations` sets that attribute when the user enables Reduce Animations **or** the OS reports `prefers-reduced-motion: reduce` (the OS half added 2026-10-29, with a live `change` listener). A per-file guard would duplicate the global one in every stylesheet. |
| Instance count in Section 2 | 38 (#226–#260, #271–#273) |
| Disposition | Per-instance `FALSE_POSITIVE` for animations in `client/desktop/src/renderer/**`, after confirming the global rule and the OS-preference wiring still exist. Does not apply to `client/admin` (it carries its own `@media` guard) or to motion set from JavaScript, which must check the preference itself. |

#### `tssecurity:S5145` — Logging `(err as Error).message` in Electron renderer console

| Field | Value |
|---|---|
| First recorded | 2026-05-20 (issue #708) |
| Rationale | The rule fires on logging of any value SonarQube infers as user-controllable, including `(err as Error).message` inside a `catch` block. The project's `.claude/rules/observability.md` explicitly mandates this pattern (instead of passing the raw `err`, which would propagate ES2022 `Error.cause` chains that may carry secrets) — see the documented `console.error('Token decryption failed:', (err as Error).message);` example in that rules file. The rule's threat model (log-injection via CRLF or structured-log-line forgery) does not apply to Electron renderer `console.warn` / `console.error` calls in Concord Voice: (a) the logs go to the renderer process's DevTools console (not a log aggregator that parses lines as structured records), (b) Sentry / structured logging was removed from all three services in 2026-04-22 (project memory: "Sentry — being removed"), so there is no production log pipeline that could be tricked by injected newlines, (c) the catch'd error is generated client-side from `fetch` / IPC handlers, not propagated user input. The project's `no-restricted-syntax` ESLint rule (added in PR #714) and SonarQube's S5145 thus conflict on the same canonical pattern; the ESLint rule reflects the project's actual threat model and takes precedence. |
| Instance count in Section 2 | 1 |
| Disposition | Per-instance `FALSE_POSITIVE` for each occurrence of `console.warn` / `console.error` logging `(err as Error).message` (or `err instanceof Error ? err.message : 'literal'`) inside a `catch` block in renderer code. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. If the renderer ever forwards logs to a structured aggregator in the future, this Section 1 entry must be revisited. |

#### `typescript:S1082` — Mouse-event-only element flagged for missing keyboard listener (successor to `S6852`)

| Field | Value |
|---|---|
| First recorded | 2026-06-14 (PR #1516) |
| Rationale | `typescript:S1082` ("Visible, non-interactive elements with click handlers must have at least one keyboard listener") is the current rule key SonarCloud emits for the same family previously keyed `typescript:S6852`. It co-fires with `typescript:S6848` (successor to `S6843`) on the `<div onClick={...}>` / `<div onMouseDown={...}>` shape. The disposition is identical to the existing Section 1 entries for `typescript:S6843` / `typescript:S6852`: the a11y rule family is **internally contradictory for non-native elements** — `S6848` demands `role` + keyboard listeners, while its siblings `S6819` ("use a native element, not the ARIA role") and `S6847` ("non-interactive elements should not have listeners") forbid exactly that. Only converting to a native element satisfies all three, which is not viable for overlay backdrops, native-HTML drag-and-drop wrappers, or container tiles that hold block-level children (`<video>`, `<div>`) that `<button>` cannot legally contain. The naive `role="button"` fix was attempted in #1516 and produced 16 NEW `S6819`/`S6847` smells — empirically confirming the contradiction. See the `typescript:S6848` entry below for the full sub-pattern taxonomy. |
| Instance count in Section 2 | 5 |
| Disposition | Per-instance `FALSE_POSITIVE` when the co-located `typescript:S6848` finding on the same line is also marked FP (the two rules are linked — if `S6848` is a real a11y gap, so is `S1082`). Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S1313` — RFC special-purpose address blocks that ARE the SSRF egress denylist

| Field | Value |
|---|---|
| First recorded | 2026-08-21 (SonarCloud/Code-Scanning backlog sweep) |
| Rationale | The TypeScript sibling of the `go:S1313` calibration above, with a stronger form of the same argument. The rule flags hardcoded IP literals on the theory that an address in source is environment-specific configuration that leaks topology or pins a deployment. In `client/desktop/src/main/egressPolicy.ts` the literals are neither: they are the **RFC-defined special-purpose address registries** — RFC 1918 private space, RFC 3927 / RFC 4291 link-local, RFC 6598 CGNAT, RFC 4193 ULA, RFC 5771 multicast, RFC 6052 / RFC 3056 NAT64 and 6to4, RFC 1112 reserved — enumerated to build the `net.BlockList` denylist that `classifyAddress()` uses to refuse SSRF dials to internal networks. The addresses are the security control itself, not a configuration value it consumes. The rule's own remediation (externalise to configuration) is the precise opposite of what this file must do: making the denylist runtime-configurable would create the bypass the module exists to prevent, since anything that can edit that configuration can delete a tier-1 entry and re-open metadata-service and link-local egress. The values are also fixed by IANA registry, not by environment — they are identical in dev, CI and production, so there is nothing for a deployment to override. Note the module is deliberately structured so these constants are unreachable from any caller: `TIER1`/`TIER2` are module-private, and `isDialPermitted` returns `false` for tier 1 with no branch on the approval flag. |
| Instance count in Section 2 | 18 |
| Disposition | Per-instance `FALSE_POSITIVE` for each IP literal inside `egressPolicy.ts`'s `TIER1`/`TIER2` denylist tables, after confirming the literal is a registry-defined special-purpose block and that the surrounding structure is a deny/classify table rather than a dial target or allowlist. An IP literal that is a **destination** (an API host, a STUN/TURN server, a bootstrap peer) is NOT covered by this note and remains a true positive. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S1607` — Playwright runtime-conditional skip carries its reason in the API argument

| Field | Value |
|---|---|
| First recorded | 2026-07-15 (scanning-alert/SonarCloud triage session) |
| Rationale | `typescript:S1607` ("Remove this unit test or explain why it is ignored") expects a skip to be statically annotated. Playwright's documented mechanism for a **runtime-conditional** skip is `test.skip(condition, reason)` — the explanation *is* the second argument, surfaced in the Playwright report whenever the skip fires. The rule does not parse the reason argument (nor the surrounding comment blocks), so it flags exactly the sites that already do what it asks. The flagged specs skip only when a runtime precondition fails (no built Electron bundle; `app.isPackaged === false` under Playwright's node_modules-launched Electron) and run fully otherwise — they are not disabled tests. |
| Instance count in Section 2 | 3 |
| Disposition | Per-instance `FALSE_POSITIVE` for `test.skip(condition, reason)` sites whose reason argument genuinely explains the skip. A bare `test.skip()` / `.skip` annotation without a reason remains a true positive. |

#### `typescript:S3735` — `void` operator marks a deliberately fire-and-forget promise

| Field | Value |
|---|---|
| First recorded | 2026-07-22 (PR #2374) |
| Rationale | The rule ("Remove this use of the `void` operator") is a general-JS style rule. It is mis-applied to `void <promise>()` used as the **canonical fire-and-forget marker** required by the project's own `@typescript-eslint/no-floating-promises` ESLint rule (`client/desktop/eslint.config.mjs`). Removing the `void` (S3735's remediation) produces a floating promise, which `no-floating-promises` then rejects — the two rules directly conflict. Both flagged sites (`tokenManager` staged-key + legacy-migration adopts) are deliberately unawaited: the owner-scoped writer handles its own failure (warn-and-never-clear, #1288) and must not block the synchronous return of the already-resolved keys. |
| Instance count in Section 2 | 2 (#105, #106) |
| Disposition | Per-instance `FALSE_POSITIVE` for `void <promise>` sites that exist to satisfy `no-floating-promises` on an intentionally-unawaited call. Does NOT apply to a `void` discarding a non-promise expression. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S4084` — Media caption track on WebRTC audio/video elements

| Field | Value |
|---|---|
| First recorded | 2026-04-12 (issue #432) |
| Rationale | The rule requires `<audio>` and `<video>` elements to have a `<track>` child for captions. In Concord Voice, these elements are bound to dynamic WebRTC `MediaStream` objects via `srcObject` — not static media files. WebRTC streams cannot carry `<track>` caption data; captions would need to be delivered via a separate data channel or signaling path, which is outside the scope of the media element itself. The rule's compliance model assumes file-based media, not real-time streams. |
| Instance count in Section 2 | 1 |
| Disposition | Per-instance `FALSE_POSITIVE` for each occurrence on WebRTC-bound media elements. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S4325` — Type assertions that `tsc` confirms are load-bearing

| Field | Value |
|---|---|
| First recorded | 2026-05-11 (issue #818) |
| Rationale | The rule flags `value as Type` assertions where SonarQube's TypeScript analyzer believes the receiver accepts the original-typed value. In practice, SonarQube's analyzer does not fully replicate TypeScript's compiler flow analysis, and over-flags several idiomatic narrowing patterns where running `tsc --noEmit` actively errors when the cast is removed. Sub-patterns confirmed FP in this codebase (each verified by removing the cast and observing the specific TS error): **A.** Forced cast `X as unknown as Record<string, unknown>` for a Zustand store's `getState()` flowing into a `callSetter`/`pushDraftsToStore` helper — TS2352, because the store's discriminated state type lacks an index signature and isn't structurally assignable to `Record<string, unknown>` without going through `unknown`. The `as unknown` step is load-bearing. **B.** `string as LiteralUnion` after an `Array.includes(value)` check — `.includes()` returns `boolean` but does not narrow the value's type to the array's literal-union; TS2345 on the downstream call without the cast. **C.** `errback(err as Error)` inside a catch block — TS5+ types catch variables as `unknown` by default; downstream consumers (e.g., mediasoup's `errback`) require `Error`. TS2345 without the cast. **D.** `IIFE-result as 'literal' \| 'literal2'` — TypeScript widens the inferred IIFE return type to `string` when the body has multiple narrowed returns plus a non-literal fallback; TS2322 without the cast. **E.** `IPC-bridge-string as TypedUnion` — Electron IPC bridges incoming `data.type` / `data.status` payloads as the wire type (`string`); internal stores require the narrower union. TS2345 without the cast. **F.** `Uint8Array.buffer as ArrayBuffer` — `.buffer` is typed `ArrayBufferLike` (union of `ArrayBuffer \| SharedArrayBuffer`); React setState expecting `ArrayBuffer` rejects the union. TS2345 without the cast. **G.** `({}) as TypedShape` for a default-empty fallback — `{}` is not structurally assignable to types whose downstream consumers access required-shaped properties. TS2339 on the property access without the cast. |
| Instance count in Section 2 | 11 (+2 — rows #155–#156 added 2026-09-12, re-fingerprinted after `voiceService.ts` moved to `services/voice/`) |
| Disposition | Per-instance `FALSE_POSITIVE` when `tsc --noEmit` confirms removal of the cast produces a TS2322 / TS2345 / TS2339 / TS2352 error. The TS compiler's diagnostic is the authoritative arbiter — it is more accurate than SonarQube's reduced TS analyzer on these flow-narrowing patterns. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S6582` — optional chain suggested on an explicit `=== null ||` / `!x ||` membership guard

| Field | Value |
|---|---|
| First recorded | 2026-07-22 (PR #2374) |
| Rationale | The rule ("Prefer using an optional chain expression") is a general conciseness rule. It is mis-applied to explicit `receipt === null || … receipt.field …` / `!completion || completion.field …` membership guards where the leading null-check is **load-bearing for correctness**, not redundant. Applying the remediation changes semantics: in `e2eeService.clearKeysIfInitializationCurrent`, rewriting `receipt === null || this.sessionKeys !== receipt.sessionKeys` to `this.sessionKeys !== receipt?.sessionKeys` evaluates to `false` when `receipt` is `null` AND the singleton fields are `undefined`, letting the guard fall through so `clearKeys()` runs on a null receipt — a CWE-212 key-custody regression. In the `ipc/sso.ts` completion guards, the explicit `!completion ||` prefix is reorder-safe (later `completion.field` accesses depend on it), whereas the optional-chain rewrite's safety hinges on evaluation order and breaks silently if conditions are reordered. |
| Instance count in Section 2 | 3 (#107, #108, #109) |
| Disposition | Per-instance `FALSE_POSITIVE` for `S6582` flagged on an explicit `=== null ||` / `!x ||` membership guard where the optional-chain rewrite changes short-circuit semantics or correctness. Does NOT apply to a simple `a && a.b` genuinely equivalent to `a?.b`. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S6747` — `closedby` on a `<dialog>` flagged as an unknown JSX property

| Field | Value |
|---|---|
| First recorded | 2026-09-24 (PR #3424) |
| Rationale | The rule ("JSX elements should not use unknown properties") checks JSX attributes against a fixed list of known DOM properties, and that list lags the HTML standard. `closedby` is a standard `<dialog>` attribute (HTML Living Standard; `"any" \| "closerequest" \| "none"`), and React's own types declare it on dialog elements: `@types/react` 19.3 `DialogHTMLAttributes` has `closedby?: "any" \| "closerequest" \| "none"`, so `tsc` accepts it and React renders it to the DOM unchanged. `tests/unit/components/globalOverlaysBehindModal.test.tsx` § `mandatory overlays render closedby="none"` pins that it reaches the DOM (mutation-checked: deleting the attribute turns the case red), and `client/desktop/scripts/dialog-top-layer-probe/` measures on Electron 44.4.3 / Chromium 152 that `closedby="none"` makes Escape fire neither `cancel` nor `close`. The attribute is load-bearing: `.claude/rules/frontend.md` rule 4 requires it on a mandatory global overlay. |
| Instance count in Section 2 | 2 (#175, #176) |
| Disposition | Per-instance `FALSE_POSITIVE` for `S6747` on a `closedby` attribute of a `<dialog>`. Does NOT apply to an attribute absent from both the HTML standard and React's DOM types, which is a real typo or misuse. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S6819` — Custom ARIA combobox and adjustable-separator patterns

| Field | Value |
|---|---|
| First recorded | 2026-04-20 (issue #651) |
| Rationale | Two reviewed patterns require an explicit ARIA role because no native element provides the same semantics and behavior.<br><br>**A — Rich combobox:** The rule suggests replacing custom `role="listbox"` markup with semantic HTML (`<select size=...>`, `<select multiple=...>`, `<datalist>`). None of those alternatives can carry avatar thumbnails, role-color badges, custom icons, or integrate with a controlled textarea's cursor for `@`-trigger filtering. `MentionAutocomplete` and `EmojiAutocomplete` implement the custom ARIA combobox contract with `role="listbox"`, `aria-activedescendant`, per-option `role="option"`/`aria-selected`, and complete keyboard navigation.<br><br>**B — Adjustable separator:** `DockShell` uses the WAI-ARIA adjustable-separator pattern for a sidebar splitter: explicit `role="separator"`, `tabIndex={0}`, accessible name/orientation/current/minimum/maximum values, pointer resizing, and ArrowLeft/ArrowRight keyboard handlers with Shift acceleration. A native `<hr>` is a static horizontal rule and cannot provide the focusable, keyboard-adjustable splitter contract. Removing the explicit role would erase the widget semantics while leaving an interactive generic element. |
| Instance count in Section 2 | 3 (row #67 `MentionAutocomplete`; row #91 `EmojiAutocomplete`; row #116 `DockShell` adjustable separator) |
| Disposition | Per-instance `FALSE_POSITIVE` for either (A) a custom ARIA-compliant combobox that requires rich per-option content or (B) a WAI-ARIA adjustable separator that exposes the explicit role, focusability, value properties, and keyboard resize handlers. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S6843` — Non-native interactive element with a compensating control

| Field | Value |
|---|---|
| First recorded | 2026-05-27 (PR #747, #115) |
| Rationale | The rule flags `<div>` (or other non-native) elements that carry interactive event handlers (`onClick`, `onMouseDown`, `onContextMenu`) without declaring an interactive role + tabIndex + keyboard listener. The naive "fix" (adding `role="button"` + `tabIndex` + an `onKeyDown` handler) triggers SIBLING rules in the same family: `typescript:S6817` ("use `<button>` instead of `role='button'`") and `typescript:S6822` ("`tabIndex` should only be declared on interactive elements"). Net effect of the naive fix is MORE findings, not fewer. This entry covers two sub-patterns where the rule is over-firing in Concord Voice:<br><br>**Sub-pattern A — Propagation-blocking wrapper inside a popover/menu.** The handlers exist ONLY to call `e.stopPropagation()`. The element is NOT user-interactive; it's a layout wrapper that prevents an outer popover's outside-click handler from firing when the user interacts with descendants (typically dragging a slider whose pointer may exit the descendant's bounding box mid-drag). Adding role/tabIndex/keyboard handlers would falsely advertise the wrapper to assistive tech. All real interaction happens on focusable child elements (slider, button) that already carry their own keyboard support.<br><br>**Sub-pattern B — Non-native element with a native sibling that provides the keyboard equivalent.** The non-native element (e.g., a participant tile `<div>`) carries a mouse-convenience handler (typically `onContextMenu`) that opens a menu at the cursor. A native `<button>` sibling (e.g., a kebab/three-dots trigger rendered at the tile's corner) provides the keyboard equivalent: the button is focusable by default, gets Enter/Space for free, has an accessible name via `aria-label`, and opens the same menu. The keyboard-access concern that motivates the rule is fully satisfied by the sibling button — the rule's threat model (no keyboard path to the function) does not apply. Wrapping the outer element in `<button>` is not viable because the tile contains block-level children (`<video>`, `<div>`) which `<button>` cannot semantically contain. |
| Instance count in Section 2 | 3 |
| Disposition | Per-instance `FALSE_POSITIVE` when the underlying pattern matches sub-pattern A or B above. Confirm by reading the handler body and the surrounding JSX:<br>• **Sub-pattern A:** the handler is demonstrably pure-`stopPropagation`/`preventDefault` (no other side effects), AND the wrapper sits inside an outer popover/menu that owns the real user interaction.<br>• **Sub-pattern B:** there is a native interactive element (`<button>`, `<a href>`, native input) rendered alongside the non-native element that opens the same menu / triggers the same action, providing the keyboard-access path the rule was designed to ensure.<br><br>If neither sub-pattern applies, this disposition does NOT apply and the finding is a real a11y gap. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S6845` — `tabIndex` on a WAI-ARIA adjustable separator

| Field | Value |
|---|---|
| First recorded | 2026-07-29 (issue #1750 / PR #2510) |
| Rationale | The rule advises placing `tabIndex` only on native interactive elements, but an adjustable separator is an explicitly focusable ARIA widget. `DockShell` implements that contract with `role="separator"`, `tabIndex={0}`, `aria-label`, `aria-orientation="vertical"`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, pointer resizing, and ArrowLeft/ArrowRight keyboard handlers with Shift acceleration. Removing `tabIndex` would make the splitter unreachable by keyboard. Replacing it with `<hr>` would supply only static horizontal-rule semantics; an `<hr>` cannot implement a focusable, keyboard-adjustable splitter. |
| Instance count in Section 2 | 1 (row #118) |
| Disposition | Per-instance `FALSE_POSITIVE` only when `tabIndex` makes an explicit `role="separator"` adjustable, the element exposes its orientation and current/minimum/maximum values, and keyboard handlers perform the same bounded resize operation as pointer input. |

#### `typescript:S6848` — Non-native interactive element (successor to `S6843`), a mutually contradictory rule family

| Field | Value |
|---|---|
| First recorded | 2026-06-14 (PR #1516) |
| Rationale | `typescript:S6848` ("Avoid non-native interactive elements...") is the current rule key SonarCloud emits for the family previously keyed `typescript:S6843`. The disposition and rationale are inherited from the `typescript:S6843` entry above. The defining property: **the a11y rule family cannot be simultaneously satisfied on a non-native element.** `S6848` says "add `role` + `tabIndex` + keyboard listeners"; `S6819` says "don't use the ARIA `role`, use the native element"; `S6847` says "non-interactive elements should not carry mouse/keyboard listeners." The only mutual solution is converting the element to native HTML — impossible for the cases below. PR #1516 empirically demonstrated this: applying the `role="button"` + `onKeyDown` fix to these elements produced **16 new `S6819`/`S6847` smells** (net-negative), so the fix was reverted and the findings marked FP per this entry. Sub-patterns observed in Concord Voice (each verified by reading the JSX):<br><br>**A — Propagation-blocking wrapper** (see `S6843` sub-pattern A): handlers are pure `stopPropagation`/`preventDefault`; real interaction lives on focusable children.<br>**B — Native-sibling keyboard equivalent** (see `S6843` sub-pattern B): a sibling `<button>` provides the keyboard path (e.g. participant-tile kebab trigger).<br>**C — Overlay/modal backdrop dismiss**: a full-screen backdrop `<div onClick={onClose}>` whose only action is click-outside-to-dismiss. The keyboard path already exists — a global `Escape` handler (`Modal` document keydown, `ScreenSharePicker` Escape) plus a visible, focusable close `<button>`. Making the backdrop itself focusable/role=button would falsely advertise the dismiss-surface to assistive tech and duplicate the close button.<br>**D — Hover-reveal informational element**: `onMouseEnter`/`onMouseLeave` that reveal a tooltip or slide-in panel (e.g. `MainView` E2EE indicator, `ChannelPanel` peek). There is no click action to make keyboard-operable; the core state is already conveyed by an always-visible icon (Lock/LockOpen) and the hover content is progressive enhancement. `S6848`/`S6847` firing on a non-interactive hover affordance is over-firing.<br>**E — Native HTML5 drag-and-drop wrapper**: `onDragStart`/`onDragOver`/`onDrop` on `ServerBar` reorder wrappers. Keyboard-accessible drag-and-drop is a separately-scoped design-system concern, not satisfiable by `role`+`onKeyDown` on the drag wrapper; the rule's role/tabIndex remedy does not provide a keyboard reorder path.<br>**F — WAI-ARIA adjustable separator:** `DockShell`'s resize handle is intentionally a non-native element with `role="separator"`, `tabIndex={0}`, accessible orientation/current/minimum/maximum values, pointer resizing, and ArrowLeft/ArrowRight keyboard handlers with Shift acceleration. A native `<hr>` has static horizontal-rule semantics and cannot implement the keyboard-adjustable splitter contract. |
| Instance count in Section 2 | 13 |
| Disposition | Per-instance `FALSE_POSITIVE` when the element matches sub-pattern A–F above and cannot be converted to a native interactive element without tripping `S6819`/`S6847` or losing required ARIA widget semantics. The keyboard-access concern the rule was designed to enforce is satisfied by a documented alternative or by the explicit adjustable-separator contract, OR is inapplicable (no action / native-DnD). If none applies, this disposition does NOT apply and the finding is a real a11y gap. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S6852` — Co-fires with S6843 on the propagation-blocking wrapper pattern

| Field | Value |
|---|---|
| First recorded | 2026-05-27 (PR #747, #115) |
| Rationale | Same pattern as the Section 1 entry for `typescript:S6843`. `S6843` ("non-native interactive elements need role + tabIndex") and `S6852` ("non-interactive elements with click handlers need keyboard listeners") frequently co-fire on the same line — both target the `<div onClick={...}>` shape. When the click handler is a pure `e.stopPropagation()`, `S6852`'s "click handlers need keyboard listeners" is mis-calibrated: there's no user action to support with a keyboard equivalent because the click handler does nothing user-visible. |
| Instance count in Section 2 | 2 |
| Disposition | Per-instance `FALSE_POSITIVE` when (a) the underlying element matches the propagation-blocking wrapper described in the `typescript:S6843` Section 1 entry, AND (b) `S6843` is also marked FP on the same line via this register. The two rules are linked — if `S6843` is real (the element IS interactive), then `S6852` is also real. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S7755` — `.at(-1)` swap is not type-preserving on a proven-in-range index

| Field | Value |
|---|---|
| First recorded | 2026-09-12 (scanner sweep) |
| Rationale | The rule ("Prefer `Array.prototype.at()` method for index access") assumes the swap is a free, equivalent, clearer substitution. It is not when the receiver is `readonly T[]` and the target index was already proven in-range: `rects[rects.length - 1]` in `client/desktop/src/renderer/utils/policy/decideDropIndex.ts:48` types as `DOMRect`, while `rects.at(-1)` types as `DOMRect \| undefined`. VERIFIED BY EXECUTION, not argued: applying `const last = rects.at(-1);` and running `npm run typecheck` in `client/desktop` produced `decideDropIndex.ts(49,59): error TS18048: 'last' is possibly 'undefined'` (the probe was reverted; the file is unchanged). It compiles only with a non-null assertion — which CLAUDE.md bans in this style — or a provably dead `??` branch, on an index the code already proved in-range via the `rects.length === 0` early return at lines 41-43. |
| Instance count in Section 2 | 1 |
| Disposition | `.at(-1)` is preferred ONLY where the receiver tolerates `\| undefined`. Under `strictNullChecks` with `noUncheckedIndexedAccess` OFF, swapping a proven-in-range index expression for `.at()` trades a statically-safe expression for an assertion and is a net loss, not a simplification. Any future FP on this rule must cite an actual `tsc` error produced by removing the index expression, not an assertion that one would occur. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `typescript:S7764` — `self` is the canonical WorkerGlobalScope idiom, and `globalThis` re-flags a CodeQL FP

| Field | Value |
|---|---|
| First recorded | 2026-06-14 (PR #1516) |
| Rationale | The rule ("Prefer `globalThis` over `self`") is a general-JS modernization. It is mis-applied inside a **dedicated Web Worker** (`client/desktop/src/renderer/workers/e2eeWorker.ts`), where `self` is the spec-canonical reference to the `WorkerGlobalScope` and is the established idiom. Critically, applying the rule's remediation has a concrete harm: changing `self.onmessage = ...` to `globalThis.onmessage = ...` **edits the worker's message-handler line**, which causes CodeQL to re-attribute the pre-existing `js/missing-origin-check` alert (alert #405) to the PR diff and **block the Alpha Code Scanning merge gate**. That CodeQL alert is itself a false positive — a dedicated worker receives messages only from the parent context that spawned it (same-origin by spec; `MessageEvent.origin` is the empty string for parent↔worker messages), so there is no cross-origin `postMessage` sender to validate. The `js/missing-origin-check` rule targets `window.addEventListener('message', ...)` cross-window scenarios, not dedicated-worker `onmessage`. So `globalThis` yields no benefit on a worker's global while triggering a spurious security-gate block; `self` is retained. **Second sub-case — renderer `window.setTimeout`/`setInterval` whose return is stored in a `number`-typed ref.** In the Electron renderer, `@types/node` shares the global scope with `lib.dom`, so `globalThis.setTimeout(...)` resolves to the **Node** overload returning `NodeJS.Timeout`, which is not assignable to a `number`-typed timer ref (`useRef<number \| null>`); `window.setTimeout` is DOM-typed (returns `number`). Applying the `globalThis` remediation breaks `tsc --noEmit` (TS2322 'Timeout' is not assignable to 'number'), so `window` is the correct idiom for browser timer IDs and the rule is a FP for these call sites. **Third sub-case — ACCEPTED, not FALSE_POSITIVE, recorded here because the distinction is exactly what this register exists to preserve.** `client/desktop/src/renderer/services/voice/screenAudioBridge.ts:342` compares `event.source` against bare `globalThis`; the rule is right that `globalThis` and `window` are the same object at runtime, but the spelling is unavailable because the compiler rejects it: `event.source` is typed `MessageEventSource \| null` (`Window \| MessagePort \| ServiceWorker`), and TypeScript never merges that union with `typeof globalThis` — only the `window` declaration in lib.dom carries `Window & typeof globalThis`. Verified: the change fails typecheck with `screenAudioBridge.ts(342,9): error TS2367: This comparison appears to be unintentional because the types 'MessageEventSource \| null' and 'typeof globalThis' have no overlap.` The only route to compliance is a double cast, and this is the check that refuses a same-document attacker forging a message event, so blinding the compiler there is the wrong trade. Per this register's own ACCEPTED-vs-FALSE_POSITIVE distinction, a compiler limitation is not the rule being wrong about the instance — so `AaCUeaEHto_c3DKA1XL5` was set `ACCEPTED` (2026-09-12), not `FALSE_POSITIVE`, and carries no Section 2 row. The sibling `S7764` on the same file's line 341 WAS fixed (`globalThis.location.origin`). |
| Instance count in Section 2 | 5 (worker `self`: #71, #87, #88; renderer `window.setTimeout` return-type: #89, #90) |
| Disposition | Per-instance `FALSE_POSITIVE` for (a) `self` references in dedicated-Web-Worker scope (`src/renderer/workers/**`), where `self` is the canonical idiom and the `globalThis` remediation would touch a message-handler line and re-flag the CodeQL `js/missing-origin-check` FP; and (b) `window.setTimeout`/`setInterval` whose return is stored in a `number`-typed ref, where `globalThis` pulls in the Node `Timeout` overload and breaks `tsc`. Does NOT apply to non-worker modules with no timer-return-typing conflict, where `globalThis` is preferred. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `tssecurity:S5145` — `console.warn(msg, errorMessage(err))` taint flow from HTTP response

| Field | Value |
|---|---|
| First recorded | 2026-05-20 (PR #1092) |
| Rationale | The rule fires on `console.warn`/`console.error` calls whose argument data-flow traces back to an HTTP response body (treated as "user-controlled" by Sonar's taint analysis). In Concord renderer code, the blessed log discipline for catch blocks IS `console.warn(msg, errorMessage(err))` — `errorMessage()` is the helper in `client/desktop/src/renderer/utils/runtime/redactError.ts` that returns `err.message` for `Error` instances or `'unknown_error'` as a stable identifier fallback. The helper exists explicitly to satisfy `.claude/rules/observability.md` "Console error logging" — sanitize untrusted error payloads before logging. Sonar's data-flow analysis cannot see that `errorMessage()` shadows the taint, so it fires on every catch site whose `err` originates from `apiFetch`. The threat model (user input injected into format-string sinks → log forgery) does not apply: (a) the "user-controlled" data is the AUTHENTICATED user's OWN server response, (b) the destination is `console.warn`, a development/debug sink not a control flow gate, and (c) `errorMessage()` extracts only `err.message`, dropping any `Error.cause` chain that could carry secrets (the rule the ESLint `no-restricted-syntax` policy in `eslint.config.mjs` enforces). |
| Instance count in Section 2 | 1 |
| Disposition | Per-instance `FALSE_POSITIVE` for each `console.warn(msg, errorMessage(err))` site in a catch block whose `err` originates from `apiFetch`. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `tssecurity:S5147` — URL path concatenation in internal API-helper module

| Field | Value |
|---|---|
| First recorded | 2026-06-01 (PR #1264) |
| Rationale | The rule (and its companion `securityhotspot:S5852` "Ensure that tainted data is validated before being used to construct a client-side request URL") fires whenever a function parameter flows into a `fetch()` URL via template concatenation. In `client/desktop/src/renderer/services/apiClient.ts`, the `apiFetch(path, init)` public surface accepts a relative API route string and concatenates it with the build-time-constant `API_BASE` (read from `src/renderer/config.ts`). Sonar's taint analyzer flags `path` as "user-controllable" because it is an external function parameter, but in this codebase: (a) `apiFetch` is an internal renderer-only helper — no path argument ever crosses a UI input boundary unsanitized, (b) every call site uses a hardcoded route template (`/api/v1/...`) with optional embedded entity IDs from store state (UUIDs, snowflake IDs sourced from the same trusted backend), (c) `API_BASE` is a build-time constant pinning the destination to the official `concordvoice.chat` API host — even an attacker-influenced `path` cannot escape the origin via this code path because the URL grammar parses `${API_BASE}${path}` left-to-right with no scheme/host substitution available downstream of the constant prefix. The rule's threat model (SSRF to attacker-controlled origin or arbitrary URL fetch) cannot apply when the URL prefix is a build-time constant. Note: the exact Sonar rule key is the editor's best inference from the rule descriptors quoted in PR #1264; will be reconciled with the issue key when the SonarQube MCP env-var substitution is fixed and the FP markings are re-recorded. |
| Instance count in Section 2 | 1 |
| Disposition | Per-instance `FALSE_POSITIVE` for each `fetch(\`${API_BASE}${path}\`, ...)` invocation in `apiClient.ts` where `path` is the public parameter of `apiFetch` (or a callee that received it unmodified). After PR #1264, the URL construction is centralized in the single `apiFetchRaw()` helper, so this disposition applies to one site rather than three. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |

#### `tssecurity:S8475` — App-controlled version string written to browser storage flagged as tainted

| Field | Value |
|---|---|
| First recorded | 2026-06-14 (PR #1516) |
| Rationale | The rule ("Ensure that tainted data is sanitized before being written to browser storage") fires on `localStorage`/`sessionStorage` writes whose value Sonar's taint analysis traces to an external source. In `client/desktop/src/renderer/components/ui/UpdateBanner.tsx`, the stored value is the app-update version string surfaced by the `electron-updater` flow (the dismissed-version marker, so a dismissed update banner stays dismissed across reloads). That string is NOT user input: it originates from the signed update manifest served by the project's own update endpoint and validated by `electron-updater`'s TLS-pinned, signature-checked pipeline (see `.claude/rules/electron.md` "Auto-Updater"). It is a semver-shaped identifier, not free-form text, and it is read back only for an equality comparison against the current update's version — never `eval`'d, rendered as HTML, or used to construct a URL. Sonar's taint analyzer cannot see that the value crosses the signed-manifest trust boundary, so it conservatively flags the storage write. The rule's threat model (attacker-controlled data persisted then later trusted) does not apply to a signature-validated version string used only for equality. |
| Instance count in Section 2 | 1 |
| Disposition | Per-instance `FALSE_POSITIVE` for the dismissed-version `localStorage` write in `UpdateBanner.tsx` where the value is the signed-manifest update version used only for equality comparison. Rule-level disable is prohibited by project SonarQube AI-Code Assurance policy. |


## Post-migration (Desktop)

### Rule-Calibration Notes

_None yet._

### Instance-Specific Entries

_None yet._

## Recreation-recovery / drift-guard (ADR-0017 narrowed profile)

The **2026-06-14 SonarCloud project recreation** (see the Section 2 banner) did
more than invalidate issue keys: a freshly-recreated project reverts to the
stock **`Sonar way`** quality profiles, silently undoing the ADR-0017 narrowing
(the deactivation of the `injection`-tagged VULNERABILITY taint rules in the
custom `Concord way (<lang>) — ADR-0017 narrowed` profiles). With the narrowing
reverted, SonarCloud's JS/TS/Go security sensors run again — re-introducing both
the #1381 timeout and a duplicate SAST signal that ADR-0017 deliberately re-homed
to CodeQL + Semgrep.

The drift-guard (`scripts/sonar/check-narrowed-profile.sh`) and the restore
op (`scripts/sonar/narrow-security-profiles.sh --apply`) live in
Concord-Voice-Alpha, which manages the shared org profiles. This repo's CI has
no drift-guard job.

## Schema Rules

1. **Section 1 entries** use the 4-field table format and are sorted alphabetically by rule key. Add a new Section 1 entry when a rule's mismatch is structural, regardless of current instance count.
2. **Section 2 entries** are append-only. Rows are numbered sequentially and never renumbered.
3. **Never delete a Section 2 row.** If an FP is later reopened, apply GitHub-flavored markdown strikethrough (`~~text~~`) to every non-pipe cell in the row and append a `**Reopened YYYY-MM-DD (reason)**` annotation to the Justification column *outside* the strikethrough so the reason remains readable. Example: `| ~~5~~ | ~~2026-04-11~~ | ~~AZ0bzFOrh5l158zVMp5B~~ | ~~go:S6418~~ | ~~...~~ | ~~Claude (#431)~~ | ~~original justification~~ **Reopened 2026-05-10 (security-reviewer flagged as real finding)** |`. This preserves the original decision as crossed-out history while making the reopen reason scannable.
4. **Marker column format:** `<identity> (#<issue-or-pr-number>)`. For Claude Code sessions, use `Claude (#NNN)`. For pre-existing FPs discovered during pre-flight verification, use `pre-existing FP (YYYY-MM-DD)`.
5. **Date column:** ISO 8601 `YYYY-MM-DD` of the day the FP was marked.
6. **Cross-reference Section 1 from Section 2** when the justification is rule-level.

## Related Issues

- #431 — Register genesis, initial 7 entries
- #432 — Final ACCEPTED-bucket cleanup, 1 new entry (S4084 WebRTC audio)
- #615 — Retroactive audit of ~616 pre-register FPs; closed **completed** 2026-05-04 without running the audit (resolved incrementally instead)

## Maintenance

- **On new FP marking:** Append a row to Section 2. If the rule has no Section 1 entry and the justification is rule-level, add a Section 1 entry first (alphabetical insert), then append to Section 2.
- **Obtaining the Issue Key:** Run `mcp__sonarqube__search_sonar_issues_in_projects` (or the equivalent SonarCloud UI page) filtered by project, file, and rule to locate the specific finding. The returned `key` field (format `AZxxxxxxxxxxxxxxxxxx`) is the value to paste into the Issue Key column. The `mcp__sonarqube__change_sonar_issue_status` call that flips the finding to `FALSE_POSITIVE` takes the same key as its `key` parameter.
- **On rule reopening:** Never delete. Strikethrough the row (see Schema Rule 3 for syntax) and add a `**Reopened YYYY-MM-DD (reason)**` annotation. If the reopened finding's rule was the *only* instance keeping a Section 1 entry alive, update that entry's `Instance count in Section 2` field but do not remove the Section 1 entry — the rule-level reasoning remains valid for future instances.
- **Flipping an FP via the SonarQube MCP requires two calls, not one.** SonarCloud's state machine does not allow direct transitions between terminal states, so an issue currently in `ACCEPTED` must first be reopened and then re-resolved as false-positive. The pattern is: (1) `mcp__sonarqube__change_sonar_issue_status({ key, status: ["reopen"] })`, immediately followed by (2) `mcp__sonarqube__change_sonar_issue_status({ key, status: ["falsepositive"] })`. Never abort between these two calls for the same issue — a successful reopen without a follow-up falsepositive leaves the finding in an `OPEN` state that can fail the Quality Gate. See `docs/policies/mcp-server-policy.md` §8 for the full gotcha writeup.
- **When Section 2 grows past ~50 rows:** Consider splitting Section 2 into sub-sections grouped by rule key (`#### godre:S8193`, `#### go:S6418`, etc.), preserving the global sequential numbering. This is a forward-compatibility hint, not a hard rule — smaller registers don't need grouping. The split should happen as its own PR, not mixed in with a routine FP marking.
- **Agent discovery:** `.claude/agents/docs-reviewer.md` watches this file. `.claude/agents/docs-writer.md` has a Mode 1 special-case for appending entries.
