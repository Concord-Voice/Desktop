# Fix CI scorecard hygiene — design

Ad-hoc, issueless. Weekly hygiene sweep (2026-11-18), CI/workflow slice: `.github/workflows/**`,
`.github/scripts/**`, `scripts/sonar/**`. Each finding was checked against `main` at `53d34119`.

## Decisions

| Alert | Finding | Decision |
|---|---|---|
| Scorecard #26, #27 Dangerous-Workflow | `pull_request_target` checkout with `ref: github.event.pull_request.base.sha` (`classify-release-comment.yml`, `workflow-validate.yml`) | **Fix.** Check out `github.sha` instead. On `pull_request_target`, that is the base-branch tip, which is also protected code. The base SHA stays as data (`BASE_SHA` env). `lint-pr-release-trust.sh` and both test suites now require `github.sha`. The classifier already anchors on the current base tip, and `fetch-depth: 0` keeps the event base SHA reachable. |
| Scorecard #28, #29 Pinned-Dependencies | `pip install --user pyyaml` (`ioc-scanning.yml`) | **Fix.** Install from the existing hash-locked `.github/requirements-pyyaml.txt` with `--require-hashes --only-binary=:all:`. Trusted scans read the lock from the protected `scanner/` checkout, never from the target. |
| Scorecard #30 Pinned-Dependencies | `pip install "semgrep==${SEMGREP_VERSION}"` (`semgrep.yml`) | **Fix.** Add the hash-locked `.github/requirements-semgrep.txt` (68 pins, generated with `uv pip compile --universal --generate-hashes --override`), installed with `--require-hashes --only-binary=:all: --no-deps`. Engine bump: Semgrep 1.130.0 → 1.186.0 (clears protobuf PYSEC-2026-1805; protobuf is now 7.36.2). Forced versions: every Semgrep release pins a vulnerable `opentelemetry-api` (GHSA-mf5v-w3w3-f6cg, GHSA-xcq7-p3pf-p88h), so the lock overrides the OpenTelemetry set to 1.45.2 / 0.66b2. 1.186.0 also pins `mcp==1.29.0` (four GHSAs), so the lock overrides it to 1.30.0. `pip check` reports those overrides, by design. OSV reports no vulnerabilities in any pin, and no OSV exception was added. The install step fails if the lock and `SEMGREP_VERSION` disagree. Dependabot ignores `semgrep` itself, which is still bumped by hand. |
| CodeQL #2–#7 `actions/untrusted-checkout/medium` | PR-ref checkouts in `pull_request` reusable workflows | **Dismiss (false positive).** Every caller is `pull_request`, `push`, `schedule` or `workflow_dispatch`, never `pull_request_target` or `workflow_run`. No repository secret reaches these jobs. Fork PRs get a read-only `GITHUB_TOKEN`, and `workflow_sha` is the code the run already executes. |
| Scorecard #25 Branch-Protection | enforce-admins off, 1 required approval | **Won't fix (structural).** The repo has one maintainer. The admin path is the documented emergency override, and two approvals cannot be met. |
| Scorecard #31 Maintained | repo younger than 90 days | **Won't fix (structural).** Clears itself with age. |
| Scorecard #32 Code-Review | 2/14 changesets approved | **Won't fix (structural).** Solo-maintainer model: review comes from bots and agents, not a second human approval. |
| Scorecard #33 CII-Best-Practices | no OpenSSF badge | **Won't fix in repo.** It needs owner enrollment at bestpractices.dev, not a file change. Reported to the owner. |
| Code Quality #4–#8 `py/empty-except` | silent `pass` | **Fix.** Add a comment that says why the swallow is intentional. |
| Code Quality #1, #2 `py/unused-import` | `shutil`, `Message` | **Fix.** Remove them. No test reads them as module attributes. |

## Acceptance

- `lint-pr-release-trust.sh --unsigned .` passes; its suite (353) and `workflow-validate-report.test.sh` (37) pass.
- `audit-dependabot-coverage.sh` is clean. `actionlint` is clean on the touched workflows.
- PR CI is green. Each alert is closed by the next `main` scan or dismissed with the reason above.
