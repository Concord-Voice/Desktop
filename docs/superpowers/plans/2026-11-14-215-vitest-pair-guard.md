# Vitest pair guard — plan

Issue: #215 · Spec: `docs/superpowers/specs/2026-11-14-215-vitest-pair-guard-design.md`

1. Add `vitest-pair` and `vitest-pair-security` groups to the
   `tools/concord-bridge` entry in `.github/dependabot.yml`.
2. Write the split and matched fixture lockfiles.
3. Write `check-vitest-pair.test.sh` and see it fail (no script yet).
4. Write `check-vitest-pair.sh`; the suite passes; the real roots pass.
5. Add `vitest-pair.yml`; run actionlint and `lint-test-suite-wiring.sh`.
