# #218 plan — release SBOMs

1. Add `.github/scripts/generate-desktop-sbom.sh` and its stub-based test
   `.github/scripts/tests/generate-desktop-sbom.test.sh`. Wire the test into
   `pr-ci.yml`.
2. Run the script against the real v0.3.1 installers: Windows x64 in an
   `ubuntu:24.04` container, plus macOS arm64 and Linux x64.
3. Add the `sbom` and `attach-sbom` jobs to `release.yml`.
4. Extend `verify-unsigned-desktop.py` and its test with the two jobs' rules.
5. Run actionlint, the release-trust lint, the suite-wiring lint and both tests.
