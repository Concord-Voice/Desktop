# #217 plan — desktop npm lockfile flush

1. Port the Self-Hosted workflow to `.github/workflows/npm-lockfile-flush.yml`, for
   `desktop/` only.
2. Port its test to `.github/scripts/tests/npm-lockfile-flush.test.sh`. Change the
   fixtures to the single desktop root and the Desktop Dependabot branch names.
3. Wire the test into `pr-ci.yml`.
4. Run actionlint, the repo's workflow lints, the suite-wiring lint and the test.
