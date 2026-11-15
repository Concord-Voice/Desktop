# #217 — Weekly npm lockfile refresh for desktop/

Issue: #217

## Intent

Dependabot moves direct dependencies only. A weekly job moves the transitive
packages in `desktop/package-lock.json` to the newest version their ranges allow,
so they do not drift for months.

## Design

This copies the shape of the npm flush already used in the Self-Hosted repository,
reduced to one root.

- Thursday 06:30 UTC and `workflow_dispatch`.
- `guard` (`pull-requests: write`, no npm) defers the run while a same-repository
  Dependabot PR on `dependabot/npm_and_yarn/desktop/*` is open. That covers the
  `desktop/tools/*` compat packages, which resolve into the same lockfile. It
  comments once per 6 days on each such PR.
- `refresh` (`contents: read`, no secret) works in four steps.
  1. It probes that npm knows `min-release-age`.
  2. It runs `npm update --package-lock-only --ignore-scripts --min-release-age=7`
     in `desktop/`.
  3. It checks the result and fails on any of these:
     - a downgrade, per install path and per package name and major;
     - any changed file other than the lockfile.
  4. It uploads the lockfile and the PR body as an artifact.
- `open-pr` (App token, no npm) copies the lockfile in. Then it opens or updates
  `chore/npm-lockfile-flush`, with pinned bot identities and
  `add-paths: desktop/package-lock.json` only.
- `.github/scripts/tests/npm-lockfile-flush.test.sh` runs the real `run:` blocks
  against a stub npm and gh, and locks the job split. It is wired into `pr-ci.yml`.

## Approaches

1. **Chosen: copy the Self-Hosted three-job flush.** It is already reviewed, and
   its job split is the credential boundary.
2. Let Dependabot do it through `versioning-strategy: lockfile-only`. Rejected:
   Dependabot still updates only the dependencies it tracks, not every
   transitive one.
3. One job with a write token. Rejected: npm would resolve third-party code in a
   job that holds write credentials.

## Calls made here

- Node 24.20.0, the same as `release.yml`.
- Labels: `type: chore`, `area: deps`, `area: desktop`.
