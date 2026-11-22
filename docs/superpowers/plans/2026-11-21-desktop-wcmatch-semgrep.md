# Desktop Semgrep wcmatch remediation — plan (ad-hoc, 2026-11-21)

Spec: `docs/superpowers/specs/2026-11-21-desktop-wcmatch-semgrep-design.md`.
Approach: dynamic. Mode: automated; the Phase-9 merge checkpoint remains.

1. Regenerate `.github/requirements-semgrep.txt` with the existing `uv pip
   compile --universal --generate-hashes --python-version 3.12 --override`
   recipe, adding only `wcmatch==11.2` to the override. Confirm the PyPI hashes
   and `bracex>=3.2` resolution. Keep Semgrep 1.186.0.
2. Add a focused Desktop compatibility test for real Semgrep rule-path and CLI
   exclusions, hidden paths, representative Electron/TypeScript targets,
   `TargetManager._globmatch`, and bounded multi-star rejection. Run it in a
   fresh Python 3.12 hash-locked venv.
3. In `.github/workflows/semgrep.yml`, load the ordinary scanner lock, custom
   rules, and `.semgrepignore` from the immutable PR base SHA; retain the
   protected workflow-SHA path for all three. Remove the pip wheel-cache restore
   from this write-scoped job. Extend `test_hash_locked_installs.py` to assert
   both trust paths and reject a PR-controlled custom config or ignore file.
4. In `.github/workflows/pr-ci.yml`, add a `contents: read` candidate-lock
   compatibility job after IOC, with checkout credentials disabled and no
   SARIF/comment writes. Gate its install on the candidate Semgrep version and
   run the compatibility test and candidate rule/ignore validation. Add a
   structural test for its permissions and dependency edge.
5. Run the focused Python tests, compatibility script, `actionlint`, workflow
   contract checks, and a clean diff/status review. Open a draft Desktop PR
   referencing advisory and alert 30; complete exact-head CI, Gitar, SonarCloud,
   security/deployment-config review and one enhanced review before Ready.
   Ask separately at the Phase-9 merge checkpoint. Recheck alert 30 on main.
