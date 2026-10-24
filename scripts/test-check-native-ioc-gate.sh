#!/usr/bin/env bash
# Self-test for check-native-ioc-gate.sh.
#
# The guard exists because the ADR-0018 edge regressed silently once already. A
# guard whose own detection is never exercised is the same silence one level up, so
# every way the gate can break gets a fixture that must FAIL, and the correct wiring
# gets one that must PASS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="${ROOT}/scripts/check-native-ioc-gate.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

# Writes a workflow set into $1. $2 = native-audiocap trigger block,
# $3 = pr-ci native node, $4 = main-ci native node.
scaffold() {
  local d="$1"; rm -rf "$d"; mkdir -p "$d"
  printf '%s\n' "name: Native Audiocap" "$2" "jobs:" "  addon-build:" "    runs-on: ubuntu-latest" > "${d}/native-audiocap.yml"
  printf '%s\n' "name: PR CI" "on:" "  pull_request:" "jobs:" "  ioc:" "    uses: ./.github/workflows/ioc-scanning.yml" "$3" > "${d}/pr-ci.yml"
  printf '%s\n' "name: Main CI" "on:" "  push:" "jobs:" "  ioc:" "    uses: ./.github/workflows/ioc-scanning.yml" "$4" > "${d}/main-ci.yml"
}

GOOD_TRIGGER=$'on:\n  workflow_call:'
GOOD_NODE=$'  native-audiocap:\n    needs: [ioc, detect-changes]\n    uses: ./.github/workflows/native-audiocap.yml'

check() { # $1 name, $2 expect(pass|fail)
  local d="${TMP}/wf"
  # `|| rc=$?` because a failing command substitution aborts under `set -e` in an
  # ASSIGNMENT (it does not in an argument). The output is checked as well as the
  # exit code: a guard that merely CRASHES exits non-zero and would otherwise score
  # as a correct rejection on every red case, so an inert script reads as a working
  # one. Found by @pr-review-toolkit:pr-test-analyzer on PR #3155.
  local out rc=0
  out="$("$GUARD" "$d" 2>&1)" || rc=$?
  local got=fail
  [ "$rc" -eq 0 ] && got=pass
  if [ "$got" != "$2" ]; then
    printf '  %-56s WRONG — expected %s, got %s\n' "$1" "$2" "$got"; fail=$((fail+1)); return
  fi
  # A rejection must name its reason; an acceptance must state the invariant it
  # verified. Neither is something a crashed or stubbed-out script can produce.
  local want='native-audiocap|needs: ioc|missing|reusable|parsed as empty|main-ci'
  if grep -qE "$want" <<<"$out"; then
    printf '  %-56s ok (%s)\n' "$1" "$got"; pass=$((pass+1))
  else
    printf '  %-56s %s BUT NO DIAGNOSIS — a crash, not a verdict\n' "$1" "$got"
    fail=$((fail+1))
  fi
}

echo "=== correct wiring must PASS ==="
scaffold "${TMP}/wf" "$GOOD_TRIGGER" "$GOOD_NODE" ""
check "reusable, ioc-gated in pr-ci, absent from main-ci" pass

echo
echo "=== every way the gate can break must FAIL ==="
scaffold "${TMP}/wf" $'on:\n  workflow_call:\n  pull_request:' "$GOOD_NODE" ""
check "native-audiocap regrows its own pull_request trigger" fail

scaffold "${TMP}/wf" $'on:\n  workflow_call:\n  push:\n    branches: [main]' "$GOOD_NODE" ""
check "native-audiocap regrows its own push trigger" fail

scaffold "${TMP}/wf" $'on:\n  pull_request:' "$GOOD_NODE" ""
check "native-audiocap is not reusable at all" fail

# The denylist of three names let these two through, and both run the same npm ci
# outside the IOC gate. Found by @code-reviewer on PR #3155.
scaffold "${TMP}/wf" $'on:\n  workflow_call:\n  workflow_run:\n    workflows: [pr-ci]' "$GOOD_NODE" ""
check "native-audiocap regrows a workflow_run trigger" fail

scaffold "${TMP}/wf" $'on:\n  workflow_call:\n  workflow_dispatch:' "$GOOD_NODE" ""
check "native-audiocap regrows a workflow_dispatch trigger" fail

# The one trigger that would run npm ci with write-scoped secrets on a fork PR, and
# it had no red case at all.
scaffold "${TMP}/wf" $'on:\n  workflow_call:\n  pull_request_target:' "$GOOD_NODE" ""
check "native-audiocap regrows a pull_request_target trigger" fail

# An empty or comments-only workflow parsed as None, and every rule keyed on it was
# then SKIPPED while the guard printed "gate intact" and exited 0. A live fail-open.
scaffold "${TMP}/wf" "" "$GOOD_NODE" ""
printf '' > "${TMP}/wf/native-audiocap.yml"
check "empty native-audiocap.yml is not a pass" fail

scaffold "${TMP}/wf" "" "$GOOD_NODE" ""
printf '# only a comment\n' > "${TMP}/wf/native-audiocap.yml"
check "comments-only native-audiocap.yml is not a pass" fail

scaffold "${TMP}/wf" "$GOOD_TRIGGER" $'  native-audiocap:\n    needs: [detect-changes]\n    uses: ./.github/workflows/native-audiocap.yml' ""
check "pr-ci node loses its needs: ioc edge" fail

scaffold "${TMP}/wf" "$GOOD_TRIGGER" "" ""
check "pr-ci node deleted entirely" fail

scaffold "${TMP}/wf" "$GOOD_TRIGGER" $'  native-audiocap:\n    needs: [ioc]\n    uses: ./.github/workflows/some-other.yml' ""
check "pr-ci node points at the wrong workflow" fail

# A SUFFIX match accepted this: a different, valid top-level workflow whose name
# merely ends the same way, keeping `needs: ioc` while swapping out every job the
# guard exists to protect.
scaffold "${TMP}/wf" "$GOOD_TRIGGER" $'  native-audiocap:\n    needs: [ioc]\n    uses: ./.github/workflows/alternate-native-audiocap.yml' ""
check "a look-alike workflow path is rejected" fail

# main-ci is the RELEASE orchestrator and its ioc job is hotfix-gated, so a node
# there is skipped on every ordinary merge -- coverage that looks real and is not.
# Re-adding it must FAIL, which is the inverse of what this suite asserted before
# Codex found the defect on PR #3155.
scaffold "${TMP}/wf" "$GOOD_TRIGGER" "$GOOD_NODE" "$GOOD_NODE"
check "main-ci regrows the node (unreachable behind hotfix-gated ioc)" fail

# `on: [workflow_call]` is legal YAML and used to raise an unhandled TypeError.
scaffold "${TMP}/wf" 'on: [workflow_call]' "$GOOD_NODE" ""
check "list-form on: [workflow_call] is accepted" pass

# A scalar `needs: ioc` is legal YAML and must be accepted, not treated as absent.
scaffold "${TMP}/wf" "$GOOD_TRIGGER" $'  native-audiocap:\n    needs: ioc\n    uses: ./.github/workflows/native-audiocap.yml' ""
check "scalar (non-list) needs: ioc is accepted" pass

echo
# An assertion FLOOR: a suite whose helpers stop running would otherwise print
# "passed 0, failed 0" and exit 0.
MIN_CASES=15
if [ "$((pass + fail))" -lt "$MIN_CASES" ]; then
  echo "ONLY $((pass + fail)) cases ran; expected at least ${MIN_CASES}." >&2
  exit 1
fi
echo "passed ${pass}, failed ${fail}"
[ "$fail" -eq 0 ]
