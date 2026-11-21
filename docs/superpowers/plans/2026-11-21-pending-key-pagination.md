# Pending key-request pagination — Plan

Spec: `docs/superpowers/specs/2026-11-21-pending-key-pagination-design.md`.
Branch: `fix/security-179-pending-keys-pagination`. Approach: dynamic. Mode:
automated.

1. Reproduce the one-page loss with cursor-page unit fixtures, including an
   empty intermediate page.
2. Extend the E2EE pending-key fetch loop to drain encoded cursor pages with a
   20-page bound, deduplication, and a persisted continuation cursor.
3. Advance the continuation only after processing succeeds; preserve session
   generation fences, retry scheduling, stop semantics, legacy one-page
   replies, and recovery from an expired cursor.
4. Clear saved pagination state when pending operations are fenced.
5. Verify focused E2EE tests, lint, type-check, diff hygiene, and required PR
   review gates before marking the PR ready. Do not merge in this run.
