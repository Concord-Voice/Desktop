# Test hygiene sweep (2026-11-18) — Plan

Spec: `docs/superpowers/specs/2026-11-18-test-hygiene-sweep-design.md`.
Branch: `test/test-hygiene-sweep-2026-11-18`. Approach: dynamic. Mode: automated.

## Tasks

1. **Mechanical S5906 rewrite (inline, scripted).** For each S5906 row whose line has the
   single-line shape `expect(X.length).toBe(N)`, rewrite only that line to
   `expect(X).toHaveLength(N)`. Skip the two `AesKeyAlgorithm` rows (spec decision 2). A script
   changes only the flagged line numbers, so unflagged code does not change.
2. **Judgment fixes (Workflow fan-out by directory, D6).** One agent per directory batch takes:
   the S5906 rows that are not the simple shape (multi-line expects, `before + 1` counts,
   `activity-history.spec.ts:241`, `App.test.tsx:252`), and the CodeQL findings in its batch.
   Agents edit test files only, do not commit, and report each finding as fixed or not-a-defect.
3. **Adversarial cross-check (same Workflow).** Independent agents review the full diff per batch
   and try to find a weakened assertion, a wrong `toHaveLength` subject, a changed test meaning,
   or a production-file edit. Any confirmed problem is fixed before commit.
4. **Sonar false positives.** Mark the rows from decision 2 (and any added by task 2) false
   positive in SonarCloud with the reason.
5. **Verify.** `npm run test:unit`, `npm run lint`, `npm run typecheck` in `desktop/`. Check that
   `git diff --name-only origin/main` holds only test files and the two docs.
6. **Ship.** Commit (`test:`), draft PR, CI, ready, review, Phase 9 merge gate.
