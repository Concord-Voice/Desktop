# Lockfile registry guard — design

Issue: #216

## Intent

npm installs from whatever host a lockfile `resolved` URL names. A changed URL
can point an install at a registry we do not control, and nothing in CI checks
it today. Fail such a PR.

## Goals

- Fail when any `resolved` URL in a tracked `package-lock.json` is not
  `https://` on an approved host. Name the file, the package and the host.
- Fail on any `replace` directive in a tracked `go.mod` or `go.work`.
- Keep the approved hosts in one small file: `.github/approved-registries.txt`.
- Fail a tracked `.npmrc` that uses any setting outside a short allowlist
  (`install-links`, `min-release-age` today). `registry`, `userconfig`,
  `globalconfig` and others can move npm's fetches, and npm's ini reader
  decodes quoted names and expands `${VAR}` in them, so an allowlist is the
  only rule that does not have to copy that reader (found in review).
- Check `npm-shrinkwrap.json` like `package-lock.json`. Fail a tracked
  `yarn.lock` or `pnpm-lock.yaml` as unsupported.

## Non-goals

- No check of integrity hashes. `npm ci` already verifies them against the
  lockfile.
- No allowlist for Go `replace`: no tracked `go.mod` uses one today. Add one
  when a real need appears.

## Approaches

1. **Bash + jq script, standalone workflow (chosen).** Same shape as #215 and
   the other `.github/scripts` guards. No install step.
2. A step inside `dependency-compat.yml`. That workflow installs the desktop
   tree and does not watch the other lockfiles.
3. `lockfile-lint` from npm. A new dependency for a twenty-line jq filter.

## Design

- `.github/scripts/check-lockfile-registries.sh [file...]` — with no arguments,
  every tracked lockfile, `.npmrc`, `go.mod` and `go.work` except the
  script-test fixtures; an empty list fails closed. It reads lockfile entries
  only (v2/v3 `packages` and the v1 nested `dependencies` tree). Each rule
  accepts a short known-good shape and fails everything else:
  - `resolved` is `https://<approved host>/<seg>/…` with no port, credentials,
    empty segment (npm rebuilds `//host/…` paths into a new host), backslash,
    query or whitespace; or a relative local `file:` / `link: true` path.
  - `version` is plain semver, an `npm:` alias, or a relative `file:` path, so
    v1 git, URL and GitHub `user/repo#sha` specs fail.
  - an installed entry with no `resolved` fails.
- `.github/scripts/tests/check-lockfile-registries.test.sh` — the off-registry
  fixture must fail; plus a case for each rule above, the fail-closed errors,
  and the no-argument mode CI runs (in a scratch git repository).
- `.github/workflows/lockfile-registries.yml` — runs on every PR that changes a
  lockfile, `.npmrc`, `go.mod`, `go.work`, the config or the guard.
  `contents: read`.
