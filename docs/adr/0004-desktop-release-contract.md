# 0004 — Desktop Release Contract: Cascade-Skip Discipline and Privileged-Surface Gating

**Status:** Accepted
**Date:** 2026-05-20
**Issue:** PR #1077
**Predecessors:** PR #889 (the regression that motivated this contract)

## Context

> **Superseded in part by #2274 — see the ADR-0032 note below.** The `workflow_call`
> mechanism this amendment describes was removed; `build-desktop.yml` is now
> dispatch-only and every release run is `event_name == 'workflow_dispatch'`, not
> `push`. The scan-gating order it establishes is unchanged. Full account:
> ADR-0032 § "Addendum (2026-07-16):
> dispatch-only release topology" — referenced by section rather than line number, which
> is the drift this correction exists to stop.
>
> **Amended by ADR-0018 (#1477, 2026-06-11):** `build-desktop.yml`'s `push:main` trigger moved to the `main-ci.yml` orchestrator — the release path now fires via `workflow_call` AFTER all push:main scan verdicts, gated by main-ci's `changes` filter replicating the former path list (`client/desktop/package.json` + the workflow itself). `github.event_name` remains `push` under workflow_call, so every event-gated invariant below (`detect-release`, `pr-paths-filter`, the release job's `always()` + per-need guards) is unchanged. Invariant 3's verify-next-push discipline now applies to `main-ci.yml`'s build-desktop node as well.

> **Amended by ADR-0032 (#2274, 2026-07-14):** pull-request packaging and trusted release builds now use separate `pr-smoke-build` and `release-build` jobs. The historical `needs.build` example below is retained as the founding topology; the current release dependency is `release-build`. This ADR's durable contract remains `always()` plus explicit `result == 'success'` checks. ADR-0032 owns the newer signing-secret, OIDC, exact-main, artifact-custody, and release-validation boundary; branch/tag signed smoke dispatches are no longer permitted.

> **Amended by PR #2812 (2026-08-19):** main-ci's `changes` filter no longer replicates the former path list in full. `client/desktop/package.json` was removed from it, leaving only `.github/workflows/build-desktop.yml`; detection of a pending version bump is now solely the `changes` job's pending-release probe, which compares that file's version against the `desktop-v<version>` tag. The path entry could not distinguish a version bump from a dependency bump, so every dependabot bump to a desktop dependency armed a dispatch with nothing to release, and those no-op dispatches failed closed on `detect-release`'s `expected_sha` binding whenever main advanced inside main-ci's ~14-minute gate window — three consecutive red `main` runs on 2026-08-19 during a dependabot merge train. The liveness guarantee is unchanged, and is the one ADR-0032 § "Addendum (2026-07-16): dispatch-only release topology" already attributes to the probe alone: while `desktop-v<version>` is untagged, every push that triggers CI arms the release path, so the stranded-release class this ADR exists to close stays closed.

> **Superseded in part by ADR-0018 § "Amendment
> — 2026-08-26: a third orchestrator, and main-ci becomes hotfix-conditional".** The
> liveness mechanism above — *"while `desktop-v<version>` is untagged, every push that
> triggers CI arms the release path"* — **no longer holds on the main-ci side.**
> `main-ci.yml` now runs its gate set and dispatcher only when the merged PR carried
> `risk: hotfix`; an ordinary push arms nothing. The stranded-release class stays
> closed, but by `nightly-ci.yml`'s 07:00 UTC run, at up to 24 hours' latency instead
> of next-merge. What makes the substitution sound is the property this ADR already
> identified: the probe is **version-based, not push-based**, so it stays armed until
> the tag exists regardless of what happens in between — and the nightly carries the
> same probe in its `window` job. Everything else here is unchanged: the
> `expected_sha` binding, the lint-pinned checkout, and the rule that a dispatch can
> never release a commit whose gates did not pass in the dispatching run.

PR #889 (merged 2026-05-08) introduced a `pr-paths-filter` job to `.github/workflows/build-desktop.yml` to support PR smoke-testing on a path-filtered subset of changes. That job carries `if: github.event_name == 'pull_request'` and is `skipped` on every `push:main` event by design.

The downstream `release:` job inherited the standard GitHub Actions implicit `success()` semantics for its `needs` chain. GHA treats `skipped` as a non-`success` state in that implicit chain, so the moment any upstream job was `skipped`, every transitively-downstream job — including `release` — was also `skipped`, even when all six platform builds had succeeded.

**Observed consequence (2026-05-08 to 2026-05-20):**

- v0.1.35 was published manually by the operator on 2026-05-09 because the workflow refused to fire.
- v0.1.36 (E2EE-everywhere completion children), v0.1.37 (more #201 children), and v0.1.38 (WebSocket reconnect fix #1046) were each bumped in `client/desktop/package.json` on the path expected to publish them — but the `release` step silently skipped, never created the GitHub Release, never invoked the code-signing flow, and never published artifacts to `/opt/concord/releases/`.
- `gh release list` confirms no tags exist for v0.1.36, v0.1.37, or v0.1.38.
- All three versions are bundled into v0.1.39 (the version that ships this fix).

Three structural gaps surfaced by the regression:

1. **Implicit `success()` semantics are inadequate for fan-out filter patterns.** When a workflow legitimately filter-skips on event type (PR vs push), the implicit chain propagates that skip across the entire dependency tree even though the skip is semantically a no-op for the push event, not a failure.
2. **No regression test for workflow semantics.** Per project memory "Workflow PRs need real-dispatch test," static CI catches schema, not runtime — and the existing pre-commit `workflow lint` hooks did not flag the cascade-skip pattern. The de facto regression test was a release-bearing `push:main`, which materialized 11 days after the regression was introduced.
3. **Operator instinct ("re-publish manually") masks the structural cost.** The operator successfully published v0.1.35 manually on 2026-05-09, which extracted the immediate user-visible release but did not surface the recurrence pattern that would strand v0.1.36 / v0.1.37 / v0.1.38 over the next eleven days.

## Decision

The desktop release workflow contract is **three enforced invariants**:

1. **`always()` + explicit `result == 'success'` is required on the release job.** The `release:` job in `build-desktop.yml` MUST be guarded by `always() && needs.<critical>.result == 'success' && ... && should_release == 'true'`. The `always()` opts out of GHA's transitive-skip semantics; the explicit `result == 'success'` checks replicate the privilege gate that the implicit chain provided.

   Pattern (verbatim from `.github/workflows/build-desktop.yml` post-#1077):

   ```yaml
   release:
     needs: [pr-paths-filter, detect-release, build]
     if: >-
       always() &&
       needs.detect-release.result == 'success' &&
       needs.build.result == 'success' &&
       needs.detect-release.outputs.should_release == 'true'
   ```

   - `detect-release` carries `if: github.event_name != 'pull_request'`, so on PR events its `result` is `skipped`, not `success`. The explicit `== 'success'` comparison correctly excludes PR-event firing of the privileged release surface (Azure Authenticode signing key, Apple Dev ID, `contents: write` permission for tag creation).
   - The `should_release` comparison is `== 'true'` (string literal), NOT bare truthiness — `should_release` is emitted as a shell-assigned string and both `"true"` and `"false"` are truthy strings under JS-style coercion. Same class of foot-gun as `workflow_dispatch` boolean inputs (#911 → #912 boolean-coercion fix).

2. **`always()` justification comment is required.** Every `always()` in `.github/workflows/**` MUST carry an inline justification comment naming the upstream-skipping job and the transitive-skip mechanism it triggers. This is enforced at pre-commit time by `workflow lint — always() requires justification comment (#920 §5.3)`. Drift-defense rationale: without the comment, future maintainers cannot distinguish "intentional always() for cascade-skip recovery" from "accidental always() that masks failures."

3. **No signed release-job test from untrusted refs; validate on the next real new-version exact-main release.** Static policy tests and the fixed unsigned PR smoke cover the pre-merge structure. Any PR touching `build-desktop.yml`'s `release`, `release-build`, or `detect-release` jobs MUST then capture full signing and publication evidence from the next organic new-version release on exact `main`. `force_release=true` is reserved for an operator-approved incomplete release whose tag and GitHub Release state will not conflict (`gh workflow run build-desktop.yml --ref main -f force_release=true`); it cannot overwrite an already-published release and is not an unchanged-version smoke mechanism. See manual-release-dispatch.md for the full procedure.

## Consequences

**Positive:**

- The next filter-job addition (e.g., a new `if: github.event_name == 'workflow_dispatch'` job or a `dependabot-only-paths` filter) cannot recur the cascade-skip stranding. Invariant 1 makes the release job's needs chain explicit per-need rather than implicit.
- The release job's privileged surface (signing keys, `contents: write`) remains gated by `result == 'success'` on `detect-release` and `build`, NOT by `!= 'skipped'` — the `!= 'skipped'` shortcut would have accepted any non-skip state including `failure` and `cancelled`, exposing signing credentials to broken-build artifacts.
- The justification-comment requirement (Invariant 2) provides drift defense without burdening every workflow with custom test infrastructure. Maintainers six months from now will find both the rule (`.claude/rules/electron.md` "Release-job `always()` discipline") and the rationale (this ADR) through normal architectural discovery paths.

**Negative:**

- Every release-workflow change remains operationally pending until a real new-version exact-main release supplies the trusted-path evidence. This can delay validation relative to a branch smoke, but preserves the signing boundary and avoids rewriting an existing release.
- The `always()` pattern is structurally identical to a fail-open guard if a maintainer drops one of the `result == 'success'` checks. Mitigated by Invariant 2's justification-comment requirement, which forces the maintainer to articulate the security model when editing the clause.

**Out of scope (deferred):**

- **In-tree workflow-semantics test framework.** Tools like [`act`](https://github.com/nektos/act) can simulate workflow runs locally but do not faithfully replicate GHA's `result`-propagation semantics, particularly across `needs` chains with conditional jobs. The trade-off — operational fragility of a local simulator vs. discipline-based testing in real GHA — favors discipline for now. Revisit if a second cascade-skip-class incident materializes.
- **Per-version release smoke-tests as a separate workflow.** Could add `release-smoke.yml` that runs on every `push:main` and asserts the `release` job fired with `result == 'success'` for any version-bumped commit. Rejected as over-engineered; the real-release evidence required by Invariant 3 provides the same trusted-path coverage without another privileged entry point.

## References

- PR #1077 — the fix that ships this contract
- PR #889 — the regression source (closed)
- `.claude/rules/electron.md` "Release-job `always()` discipline (#1077)" — the path-scoped rule that enforces this contract at edit time
- [`.github/workflows/build-desktop.yml`](../../.github/workflows/build-desktop.yml) — the workflow under contract
- Project memory entries: "Workflow PRs need real-dispatch test"; "workflow_dispatch needs default branch"
