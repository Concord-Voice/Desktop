# Fix CI scorecard hygiene — plan

Spec: `docs/superpowers/specs/2026-11-18-fix-ci-scorecard-hygiene-design.md`. All tasks run inline (each one is small, and its files are already in context).

1. **Dangerous-Workflow (#26, #27).** Change both `pull_request_target` checkouts to `ref: ${{ github.sha }}`. Change the classify-data checkout predicate in `lint-pr-release-trust.sh` to `github.sha`, and update its fixtures plus the `workflow-validate-report.test.sh` assertion. Verify: linter `--unsigned .`, both suites.
2. **Pinned-Dependencies (#28–#30).** Switch the PyYAML installs in `ioc-scanning.yml` to the hash lock. Add `.github/requirements-semgrep.txt`, install it with `--require-hashes --only-binary=:all:`, check it against `SEMGREP_VERSION`, and add the lock hash to the pip cache key. In `.github/dependabot.yml`, ignore `semgrep` and update the pip comment. Verify: a hash-checked install in a Python 3.12 venv, a Linux wheel download, `audit-dependabot-coverage.sh`, `actionlint`.
3. **Code Quality (#1, #2, #4–#8).** Comment the intentional `pass` blocks and remove the unused imports. Verify: `test_ci_scan_verdict.py`, the sonar tests, `pyflakes`.
4. **Dismissals (CodeQL #2–#7, Scorecard #25, #31–#33).** Use `gh api -X PATCH …/code-scanning/alerts/<n>` with the reasons in the spec, and list them in the PR body.
5. Draft PR → CI green → ready → review → merge gate.
