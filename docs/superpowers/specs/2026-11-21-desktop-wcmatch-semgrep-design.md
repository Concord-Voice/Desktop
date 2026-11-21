# Desktop Semgrep wcmatch remediation — design (ad-hoc, 2026-11-21)

Desktop's `.github/requirements-semgrep.txt` pins `wcmatch==8.5.2`, which matches
[GHSA-53pm-wgxf-c6qf](https://github.com/advisories/GHSA-53pm-wgxf-c6qf)
(CVSS v3.1 5.9). The first patched version is 11.2. Semgrep 1.186.0 still
declares `wcmatch~=8.3`, so the fix is an explicit, tested override. The
Self-Hosted compatibility PR [#370](https://github.com/Concord-Voice/Self-Hosted/pull/370)
is a precedent, not an import: Desktop owns its own lock and workflow.

## Decision

Pin `wcmatch==11.2` with PyPI hashes and document the Semgrep constraint
exception. Preserve Semgrep 1.186.0. Test the actual Desktop Semgrep target
selection, exclusions, and a bounded hostile multi-star pattern; installation
alone cannot prove compatibility across the wcmatch 8→11 behavior change.

The current ordinary Semgrep job installs the PR checkout's lock while holding
PR-comment and SARIF-write permissions. Move its install to the immutable PR
base lock. Use that same trusted ref for custom rules and `.semgrepignore`:
PR-controlled glob patterns can cause excessive matching time under the base
lock's vulnerable wcmatch. Semgrep reads nested ignore files, so select the
trusted root ignore through a random runtime-only filename. Keep the protected
verdict's verified workflow-commit ref for all three inputs. Install and
exercise the candidate lock, rules, and ignore file in a separate
`contents: read` CI job after the supply-chain IOC
gate, without SARIF/comment permissions or persisted checkout credentials. Do
not restore a PR-writable pip cache in the write-scoped scanner.

This change affects only the Semgrep lock, `.github/workflows/{semgrep,pr-ci}.yml`,
their focused Python contract/compatibility tests, and this spec and plan. It
does not change scanner rules, policy thresholds, application runtime, release
assets, or production deployment.

## Acceptance

- The candidate lock resolves to Semgrep 1.186.0 and wcmatch 11.2, with hashes
  matching [PyPI's 11.2 artifacts](https://pypi.org/pypi/wcmatch/11.2/json).
- A read-only candidate-lock job passes Desktop custom-rule target and exclusion
  checks, plus a three-second bounded multi-star rejection check, on the exact
  PR head. The normal write-scoped scanner reads its lock, custom rules, and
  `.semgrepignore` only from the same trusted ref.
- Focused Python contract tests and `actionlint` pass. Custom, community and
  canary Semgrep jobs complete without scanner errors. Required CI, SonarCloud,
  Gitar, and specialist reviews pass on the exact head.
- Alert 30 is rechecked after merge. Merge requires separate Phase-9 approval;
  a green source PR does not establish a merged change or deployed state.

## Rollback and limit

Revert the lock and workflow change through a reviewed PR if target selection
regresses. This returns to the vulnerable 8.5.2 pin, so the rollback needs an
immediate replacement decision. The override remains outside Semgrep's declared
range until upstream widens it; focused tests cannot prove every Semgrep path.
