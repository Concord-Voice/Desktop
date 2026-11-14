# Lockfile registry guard — plan

Issue: #216 · Spec: `docs/superpowers/specs/2026-11-14-216-lockfile-registry-guard-design.md`

1. Write `.github/approved-registries.txt` and the fixtures.
2. Write `check-lockfile-registries.test.sh` and see it fail (no script yet).
3. Write `check-lockfile-registries.sh`; the suite passes; the tracked files pass.
4. Add `lockfile-registries.yml` and the `.gitignore` exception for fixture
   lockfiles; run actionlint and `lint-test-suite-wiring.sh`.
