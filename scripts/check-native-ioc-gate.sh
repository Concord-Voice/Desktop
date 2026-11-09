#!/usr/bin/env bash
# Pin the ADR-0018 IOC gate on the native-audiocap workflow.
#
# native-audiocap.yml's addon-build leg runs `npm ci` on four runners. pr-ci.yml
# states the invariant this protects: "Every scanner that installs or executes repo
# code carries `needs: ioc`." The workflow originally shipped with a standalone
# `pull_request` trigger, which ran that install in PARALLEL with the supply-chain
# verdict rather than after it — caught in review on PR #3155, not by any gate.
#
# WHY A STATIC GUARD RATHER THAN A PATH FILTER. The obvious alternative is adding
# pr-ci.yml and main-ci.yml to the `native` change filter so an edit to the wiring
# re-runs the native jobs. That costs four native builds plus three sanitizer legs on
# every orchestrator edit, and pr-ci.yml is edited often. This runs in milliseconds
# and catches the same regression: the node disappearing, losing its `ioc` edge, or
# the workflow regrowing a self-trigger.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF_DIR="${1:-${ROOT}/.github/workflows}"

python3 - "$WF_DIR" <<'PY'
import sys, os

# Fail CLOSED on a missing parser rather than dying in a traceback that names
# neither the file nor the cause -- matching check-deploy-ref-gate.sh's pattern.
try:
    import yaml
except ImportError:
    print("check-native-ioc-gate: PyYAML is not installed, so this guard cannot",
          file=sys.stderr)
    print("  read the workflows. Refusing to report a pass it did not verify.",
          file=sys.stderr)
    print("  Install it:  python3 -m pip install pyyaml", file=sys.stderr)
    sys.exit(1)

wf = sys.argv[1]
problems = []

def load(name):
    p = os.path.join(wf, name)
    if not os.path.exists(p):
        problems.append(f"{name} is missing")
        return None
    with open(p) as f:
        doc = yaml.safe_load(f)
    # A LIVE FAIL-OPEN until PR #3155: yaml.safe_load returns None for an empty or
    # comments-only file, callers guarded with `if doc is not None`, and every rule
    # keyed on that file was then skipped -- the guard printed "reusable, ioc-gated"
    # and exited 0. Verified on both shapes. (Deleting the file outright was already
    # caught by the exists() check above; only the empty forms got through.)
    if doc is None:
        problems.append(f"{name} parsed as empty — refusing to report a gate this "
                        f"script did not actually verify")
        return None
    if not isinstance(doc, dict):
        problems.append(f"{name} is not a YAML mapping")
        return None
    return doc

# 1. The reusable workflow must NOT carry its own pull_request/push trigger. A
#    self-trigger is exactly how the install escaped the IOC gate the first time.
nat = load("native-audiocap.yml")
if nat is not None:
    # PyYAML parses a bare `on:` key as the boolean True.
    triggers = nat.get("on", nat.get(True, {})) or {}
    # Three legal spellings: a mapping, a LIST (`on: [workflow_call]`), or a bare
    # scalar. The list form is valid YAML and used to raise an unhandled
    # "cannot use 'list' as a set element" TypeError -- it failed closed, but with
    # an error naming neither the file nor the cause.
    if isinstance(triggers, dict):
        keys = set(triggers)
    elif isinstance(triggers, list):
        keys = set(triggers)
    else:
        keys = {triggers}
    if "workflow_call" not in keys:
        problems.append("native-audiocap.yml must be reusable (`on: workflow_call:`)")
    # An ALLOWLIST, not a denylist of three names. `workflow_run` and
    # `workflow_dispatch` both passed the old denylist while running the very same
    # `npm ci` outside the IOC gate -- the exact regression this guard exists for.
    # Same fail-closed reasoning as the JSF AV 206 rewrite. Found by
    # @code-reviewer on PR #3155.
    for forbidden in sorted(keys - {"workflow_call"}, key=str):
            problems.append(
                f"native-audiocap.yml has its own `{forbidden}` trigger — that runs "
                f"`npm ci` outside the IOC gate (ADR-0018)")

# 2. PR CI and the nightly must invoke it, gated on ioc.
#
# main-ci.yml is deliberately excluded, and that is a correction: an
# earlier version of this guard required the node there too, which was wrong twice
# over. main-ci is the push:main RELEASE orchestrator -- every one of its jobs is
# gated on `hotfix == true && desktop-release == true`, so ordinary merges run
# nothing in it by design, the scanners having already run at PR time. Worse, its
# `ioc` job carries that same hotfix condition, so a `needs: ioc` node there was
# unreachable on exactly the pushes it was meant to cover: GitHub propagates a
# skipped dependency. Found by Codex on PR #3155.
for name, ioc_job in (("pr-ci.yml", "ioc"), ("nightly-native-audiocap.yml", "ioc")):
    doc = load(name)
    if doc is None:
        continue
    jobs = doc.get("jobs", {})
    node = jobs.get("native-audiocap")
    if node is None:
        problems.append(f"{name} has no `native-audiocap` job — the native build "
                        f"would never run from the gated pipeline")
        continue
    # EXACT, not endswith. A suffix match also accepts
    # `./.github/workflows/alternate-native-audiocap.yml` -- a different, valid
    # top-level workflow -- so a PR could keep the `needs: ioc` edge this guard
    # checks for while replacing the sanitizer, fuzz and addon-build jobs it
    # exists to protect. Found by CodeRabbit on PR #3155.
    if str(node.get("uses", "")) != "./.github/workflows/native-audiocap.yml":
        problems.append(f"{name}: native-audiocap does not call native-audiocap.yml")
    needs = node.get("needs", [])
    needs = [needs] if isinstance(needs, str) else list(needs)
    if ioc_job not in needs:
        problems.append(
            f"{name}: native-audiocap is missing `needs: {ioc_job}`. Its addon-build "
            f"leg runs `npm ci`; ADR-0018 requires that edge.")

# 3. The nightly must preserve the daily cadence and the full-window IOC handoff.
nightly_name = "nightly-native-audiocap.yml"
nightly = load(nightly_name)
if nightly is not None:
    def require(condition, message):
        if not condition:
            problems.append(f"{nightly_name}: {message}")

    triggers = nightly.get("on", nightly.get(True, {}))
    require(triggers == {"schedule": [{"cron": "0 7 * * *"}], "workflow_dispatch": None},
            "must run daily at 07:00 UTC with input-free manual dispatch")
    require(nightly.get("concurrency") == {"group": "nightly-native-audiocap", "cancel-in-progress": False},
            "must serialize nightly runs without cancelling in-flight coverage")
    require(nightly.get("permissions") == {"contents": "read"}, "must default to read-only permissions")
    jobs = nightly.get("jobs", {})
    require(set(jobs) == {"window", "ioc", "native-audiocap"},
            "must contain only the scan window, IOC and native verification jobs")
    window = jobs.get("window", {})
    ioc = jobs.get("ioc", {})
    native = jobs.get("native-audiocap", {})
    require(window.get("if") == "github.repository == 'Concord-Voice/Desktop' && github.ref == 'refs/heads/main'",
            "scan window must be restricted to Desktop main")
    require(window.get("outputs", {}).get("diff-base") == "${{ steps.window.outputs.diff-base }}",
            "window must expose the resolved diff-base")
    require(ioc.get("uses") == "./.github/workflows/ioc-scanning.yml",
            "ioc must call ioc-scanning.yml")
    require(ioc.get("needs") in (["window"], "window"), "ioc must wait for the scan window")
    require(ioc.get("with") == {"diff-base": "${{ needs.window.outputs.diff-base }}"},
            "ioc must receive the full-window diff-base")
    require(native.get("needs") in (["ioc"], "ioc"), "native-audiocap must wait only for ioc")
    for name, job in (("ioc", ioc), ("native-audiocap", native)):
        require("if" not in job and "continue-on-error" not in job,
                f"{name} must retain default success-only ordering without path/release conditions")
    expected_permissions = {
        "window": {"contents": "read", "actions": "read"},
        "ioc": {"contents": "read", "pull-requests": "read"},
        "native-audiocap": {"contents": "read"},
    }
    for name, job in jobs.items():
        require(job.get("permissions") == expected_permissions.get(name), f"{name} permissions drifted")
        require("secrets" not in job and "environment" not in job, f"{name} must not receive release credentials")

# 4. main-ci must NOT invoke it. Re-adding it there would look like more coverage
#    and deliver none -- the node cannot run behind a hotfix-gated ioc.
main_ci = load("main-ci.yml")
if main_ci is not None and "native-audiocap" in main_ci.get("jobs", {}):
    problems.append(
        "main-ci.yml has a `native-audiocap` job. It CANNOT RUN there: main-ci is "
        "the release orchestrator and its `ioc` job is gated on "
        "hotfix && desktop-release, so a `needs: ioc` node is skipped on every "
        "ordinary merge. Remove it; PR and nightly CI own native verification.")

if problems:
    print("native-audiocap IOC gate is broken:")
    for p in problems:
        print(f"  - {p}")
    print()
    print("See ADR-0043 and the invariant stated in pr-ci.yml's scanner block.")
    sys.exit(1)

print("check-native-ioc-gate: native-audiocap is reusable, ioc-gated in PR and nightly CI, and absent from main-ci.")
PY
