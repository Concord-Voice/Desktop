# Production-code quality findings sweep (2026-11-18) — design

Ad-hoc hygiene work, no issue. Scope: the open SonarCloud issues (all rules except
`typescript:S5906`) and the CodeQL Code Quality findings in `desktop/src/**`,
`desktop/spikes/**`, `scripts/authority-vectors/**` and
`desktop/tests/e2e/bundled-fallback-login.spec.ts`. Workflows, dependencies and the
unit-test assertion sweep are handled in separate PRs.

Every finding was checked against `main` at `53d34119`. All of them were still present.

## Approach

- **Fix** when the finding is a real defect, or the fix is small and does not change
  behavior.
- **False positive** when the analyzer cannot see why the code is correct. The reason
  is recorded below and on the finding.
- **Accept** when the rule is a style preference and following it would make the code
  less clear or less safe.

## Dispositions

| Finding | Location | Decision | Reason / change |
|---|---|---|---|
| S8786 regex backtracking | `utils/crypto/base64url.ts:25` | Fixed | `/=+$/` → `/={1,2}$/`. Base64 padding is at most two characters. |
| S8786 | `Auth/Login.tsx:1336` | Fixed | Removed the inline copy of the encoder. The code now calls the shared `bufferToBase64url`. |
| S8786 | `ui/ForceUpdateOverlay.tsx:22` | Fixed | `.replace(/[-+].*$/, '')` → `.split(/[-+]/, 1)[0]`. |
| S8786 | `utils/messaging/inviteUrl.ts:43` | Fixed | The URL scan now splits on single delimiter characters and finds the scheme with `/https?:\/\//i` on the original string. The red-team pass found that a first draft took indexes from `toLowerCase()`, which changes length for U+0130 and let a look-alike link pass the host check; a test pins that case. The pathname's trailing-slash strip (`/\/+$/`, quadratic, existed before) is now a loop too. |
| S8786 | `utils/messaging/inviteUrl.ts:46` | Fixed | Trailing punctuation is trimmed with a loop, not `/[…]+$/`. |
| S5145 log injection | `services/system/notificationPrefsService.ts:169` | Fixed | `errorMessage()` replaces Unicode control characters (`\p{Cc}`), U+2028/U+2029 and the bidi overrides/isolates with a space, so no logged message can add or reorder a line. The change applies to every call site; no caller parses the output. |
| S6847 / S6819 | `Layout/DockShell.tsx:204` | False positive | A focusable `role="separator"` with `aria-valuenow`/`min`/`max` is the WAI-ARIA window-splitter widget. That widget is interactive, so it must have handlers. An `<hr>` cannot be a splitter. Keyboard resize already works through `onKeyDown`. |
| S6747 `closedby` | `ui/ConnectionLostOverlay.tsx:264`, `ui/ForceUpdateOverlay.tsx:234` | False positive | `closedby` is a standard HTML `<dialog>` attribute. `@types/react` 19.3 declares it (`closedby?: "any" \| "closerequest" \| "none"`), and `useTopLayerDialog` reads it. |
| S3776 complexity | `Auth/SSOEagerUnlock.tsx:126` | Fixed | The non-2xx keys-response handling moved into `describeKeysFetchFailure`. Behavior is unchanged. |
| S6564 alias | `main/ipcContract.ts:450` | Accepted | `CredentialOwner` is the documented opaque IPC type. Its JSDoc defines the contract, and three processes import it. Replacing it with `number` would remove that contract. |
| S9423 `!important` | `common/PremiumGate.css:61-62`, `styles/index.css:254-256` | Accepted | Reduced-motion and reduce-animations overrides. They must beat component rules, so `!important` is needed. |
| S9423 | `styles/pride-flourishes.css:86` | Accepted | The pride scrollbar must beat per-component scrollbar styles. The comment says so. |
| S7747 spread | `main/connectionRegistry.ts:399,408`, `main/tokenManager.ts:492` | False positive | The spread copies the listener set on purpose. A listener can subscribe or unsubscribe while it runs, and a live `Set` iterator would then visit a late subscriber or skip one. |
| S7764 `globalThis` | `voice/screenAudioBridge.ts:205` | False positive | The comment explains it: `globalThis` does not typecheck against `MessageEventSource` (TS2367). |
| S7764 | `Settings/NotificationSection.tsx:154`, `Settings/AccessibilitySection.tsx:299` | False positive | `globalThis.setTimeout` resolves to the Node overload here, which returns `Timeout`. The refs hold the DOM `number` handle. Tried: `tsc` fails with TS2322. |
| S7764 | `workers/e2eeWorker.ts:92,105,180` | Accepted | `self` is the WorkerGlobalScope's own name, and the worker's unit harness injects a fake scope with `vi.stubGlobal('self', …)`. Tried: switching to `globalThis` failed 10 of the 12 worker tests. |
| S7755 `.at()` | `policy/decideDropIndex.ts:48` | Fixed | `rects.at(-1) ?? first`. The empty case returns earlier. |
| S6582 optional chain | `e2ee/e2eeService.ts:505` | Accepted | `receipt === null \|\| this.sessionKeys !== receipt.sessionKeys` is an explicit null guard on an E2EE path. `receipt?.sessionKeys` would compare against `undefined`, and the next clause would still need its own guard. |
| S1607 skipped tests | `tests/e2e/bundled-fallback-login.spec.ts:47,99,134` | Fixed | `if (…) test.skip(true, …)` → `test.skip(condition, …)`. The skips are runtime preconditions (no built bundle, a non-packaged launch) and the reasons stay in place. |
| CodeQL #9 missing-await | `Settings/MFASetup.tsx:170` | False positive | `slot.current === next` compares promise identity for de-duplication. Adding `await` would break it. |
| CodeQL #10 | `hooks/messaging/useWebSocket.ts:207` | False positive | Same pattern: the in-flight map entry is deleted only if it still holds this promise. |
| CodeQL #11, #12 | `e2ee/e2eeService.ts:834,1503` | False positive | Same pattern in the key-fetch de-duplication maps. Each promise is awaited in the `try` above. |
| CodeQL #19, #20 index-out-of-bounds | `voice/voiceService.ts:11231,11587` | Fixed | The loop runs `attempt <= retryDelays.length` on purpose. The last attempt has no retry delay. `retryDelays[attempt]` → `retryDelays.at(attempt)`, which returns `undefined` there and does not read past the array. The third loop of the same shape (encrypt rebase, line 11152) is changed the same way. |
| CodeQL #17 trivial-conditional | `Chat/MessageList.tsx:257` | Fixed (real) | The only caller of `resolveLandingTarget` passed `anchor: undefined`, so its anchor branch could never run. The parameter and the branch are removed. `resolveMountedLandingTarget` already handles the anchor. |
| CodeQL #18 | `Permissions/OverridePanel.tsx:564` | Fixed | `disabled \|\| isSavingOverride` inside a `!disabled &&` block → `isSavingOverride`. |
| CodeQL #14 incompatible types | `DirectMessages/ConversationList.tsx:1204` | Fixed | `isOpen={purgeTarget !== null}` inside `purgeTarget &&` → `isOpen`. |
| CodeQL #13 implicit conversion | `main/authority/primitives.ts:36` | False positive | All operands are `bigint`, including `P384_B`, a hex BigInt literal. JS does not convert implicitly in BigInt arithmetic, and mixed types throw `TypeError`. |
| CodeQL #21 superfluous args | `spikes/capture-gate/main.mjs:156` | Fixed | The initial `requestAnswer` now declares the `(permission, details)` parameters that the reassigned versions take. |
| CodeQL #51 useless assignment | `scripts/authority-vectors/gen.mjs:1167` | Won't fix | The initial value is dead, but harmless. `vectors.json` pins the SHA-384 of `gen.mjs`, so any edit means regenerating the shared cross-language vectors, and regeneration redraws random keys and rewrites all 1046 vectors. A no-op cleanup does not justify that churn in a contract file. Tried: the edit failed `vectors.coverage.test.ts`. |

## Verification

- `tests/unit/utils/regexLinearRewrites.test.ts` compares the old regex
  implementations with the new code on normal inputs, and times them on long hostile
  input.
- The existing suites for base64url, inviteUrl, ForceUpdateOverlay, SSOEagerUnlock and
  MessageList still pass.
- No CSS or rendered output changes, so no visual capture is needed.
