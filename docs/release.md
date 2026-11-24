# Cutting a Desktop release

Desktop builds release artifacts but never signs or publishes them. Release-Ops does both
(runbook step D2).

1. Merge a PR that promotes `[Prerelease]` in `CHANGELOG.md` and bumps
   `desktop/package.json`:
   `./.github/scripts/promote-unreleased-changelog.sh <next> && cd desktop && npm version <next> --no-git-tag-version`.
2. Main CI checks for an untagged version nightly at 07:00 UTC. A `risk: hotfix`
   merge can start the same gates immediately. After the checks and SHA-bound
   build pass, Release-Ops creates the protected tag `v<next>` at that SHA.
3. `.github/workflows/release.yml` checks that the tag matches the version and that the
   commit is on `main`. It builds the six unsigned legs on GitHub-hosted runners, uploads
   them, and attests each uploaded file's build provenance. It holds no secret and writes
   no release.
4. When that run succeeds, the Release Trigger App starts Release-Ops' verify. Verify
   checks every file's attestation against `release.yml` at the tag and SHA, then creates
   the draft release here.
5. The Release Trigger App starts signing in Release-Ops after verification passes.
   Publish-back uploads the signed assets and update manifests and publishes the release.

`verify-unsigned-desktop.py` (run by `lint-pr-release-trust.sh`) keeps `release.yml` to
attestation permissions only. It fails when the release packaging steps drift from
`build-desktop.yml`'s, or when an uploaded path is not attested.
