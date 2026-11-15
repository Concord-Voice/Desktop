# Vitest pair guard — design

Issue: #215

## Intent

`@vitest/coverage-istanbul` pins `vitest` as an exact peer. If the two resolve to
different versions, `npm ci` fails. `desktop/` groups the pair in Dependabot;
`tools/concord-bridge` does not. Grouping also cannot stop a one-sided security
advisory from moving only one half. Such a PR must fail with a message that says
why and how to fix it.

## Goals

- Group the pair for version and security updates in the `tools/concord-bridge`
  Dependabot entry, the same as `desktop/`.
- A PR check that compares the resolved `vitest` and `@vitest/coverage-istanbul`
  versions in each npm root that uses them, and fails on a split.

## Non-goals and anti-goals

- CI never pushes to a Dependabot branch (maintainer decision). The check only
  reports.
- No general peer-dependency checker. Only this pair has an exact peer pin that
  makes a split unmergeable.

## Approaches

1. **Bash + jq script, standalone workflow (chosen).** Same shape as the other
   `.github/scripts/*.sh` guards and their `tests/*.test.sh` suites. No install
   step, so it runs in seconds and needs no IOC gate.
2. Node script in an existing workflow (`dependency-compat.yml`). That workflow
   installs the whole desktop tree and does not watch `tools/concord-bridge`.
   More cost, wider blast radius.
3. Run `npm ci` in each root and let it fail. It already fails, but the error is
   an ERESOLVE trace that does not name the fix.

## Design

- `.github/scripts/check-vitest-pair.sh <root>...` reads
  `<root>/package-lock.json`. A root without the coverage plugin passes. A
  plugin without `vitest`, or two different versions, fails with a `::error`
  annotation that names the root, both versions, the half that is behind, and
  the fix command.
- `.github/scripts/tests/check-vitest-pair.test.sh` runs the script against a
  split fixture (must fail, message checked) and a matched fixture (must pass).
- `.github/workflows/vitest-pair.yml` runs the suite, then the check on
  `desktop` and `tools/concord-bridge`, on PRs that change either root's
  manifest or lockfile, or the guard itself. `contents: read` only.
