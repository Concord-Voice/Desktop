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
- Fail a tracked `.npmrc` that sets any registry. npm rewrites lockfile npmjs
  URLs to the configured registry, so a `.npmrc` alone can move every fetch
  (found in review). The rule is fail-closed: a setting name that mentions
  `registry` or holds a quote, backslash or `$` fails. That avoids copying
  npm's ini reader, which decodes quoted names and expands `${VAR}` in them.
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
  every tracked lockfile, `go.mod` and `go.work` except the script-test
  fixtures. It walks every object with a string `resolved` at any depth, so
  lockfile v1 nested `dependencies` are covered. Allowed: an exact approved
  host (a port, credentials or a lookalike suffix fail), and relative local
  `file:` or `link: true` paths (the in-repo compat packages). `file://` and
  absolute or backslash paths fail: they can reach a network share. A `version`
  holding a URL or git spec fails, and so does a v2/v3 entry with no
  `resolved`. An empty file list fails closed.
- `.github/scripts/tests/check-lockfile-registries.test.sh` — the off-registry
  fixture must fail; plus http, credentials, port, git+ssh, lookalike host, v1
  nesting, and `replace` line and block cases.
- `.github/workflows/lockfile-registries.yml` — runs on every PR that changes a
  lockfile, `go.mod`, `go.work`, the config or the guard. `contents: read`.
