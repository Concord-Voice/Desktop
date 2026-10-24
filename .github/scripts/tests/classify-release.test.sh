#!/usr/bin/env bash
#
# classify-release.test.sh — Self-test for classify-release.sh.
#
# Creates minimal git fixture repos in /tmp for each test case so that
# git show + git diff commands work deterministically without depending on
# the live worktree's commit history.
#
# Mirrors the assert-helper pattern from parse-dispatched-workflow.test.sh.
# Spec: internal-reference §4 (#976)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/classify-release.sh"

pass=0
fail=0

# Temp dir registry for cleanup
FIXTURE_REGISTRY=$(mktemp)

cleanup_fixtures() {
  local d
  while IFS= read -r d; do
    [ -d "$d" ] && chmod -R u+w "$d" && rm -rf "$d"
  done < "$FIXTURE_REGISTRY"
  rm -f "$FIXTURE_REGISTRY"
}
trap cleanup_fixtures EXIT

# ── Assert helpers ────────────────────────────────────────────────────────────

assert_exit() {
  local expected="$1"
  local label="$2"
  shift 2
  local actual
  set +e
  "$@" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $label (exit=$actual)"
    pass=$((pass + 1))
  else
    echo "  ✗ $label (expected exit=$expected, got exit=$actual)" >&2
    fail=$((fail + 1))
  fi
}

assert_output_contains() {
  local needle="$1"
  local label="$2"
  local fixture_dir="$3"
  local base_sha="$4"
  # classify-release.sh's emit() writes to $GITHUB_OUTPUT when that var is set
  # (else stdout). In CI the runner sets GITHUB_OUTPUT for THIS test's own step,
  # so the script would write into that file and leave stdout empty — making
  # every output assertion silently fail (the local-vs-CI leak that broke #1388).
  # Point GITHUB_OUTPUT at a per-call tmpfile and read it back: robust in both
  # environments AND exercises the real CI file-output path.
  local out gho
  gho=$(mktemp)
  set +e
  ( cd "$fixture_dir" && BASE_SHA="$base_sha" GITHUB_OUTPUT="$gho" bash "$SCRIPT" >/dev/null 2>&1 )
  set -e
  out=$(cat "$gho")
  rm -f "$gho"
  if grep -qF -- "$needle" <<<"$out"; then
    echo "  ✓ $label (found: $needle)"
    pass=$((pass + 1))
  else
    echo "  ✗ $label (missing: $needle)" >&2
    echo "    output: $out" >&2
    fail=$((fail + 1))
  fi
}

assert_target_sha_without_checkout() {
  local fixture_dir="$1"
  local base_sha="$2"
  local target_sha="$3"
  local out gho actual_head
  gho=$(mktemp)
  set +e
  ( cd "$fixture_dir" && BASE_SHA="$base_sha" TARGET_SHA="$target_sha" GITHUB_OUTPUT="$gho" bash "$SCRIPT" >/dev/null 2>&1 )
  local actual=$?
  set -e
  out=$(cat "$gho")
  rm -f "$gho"
  actual_head=$(git -C "$fixture_dir" rev-parse HEAD)
  if [[ "$actual" == "0" && "$actual_head" == "$base_sha" && "$out" == *$'shell_changed=true'* && "$out" == *$'version_action=notes-needed'* ]]; then
    echo "  ✓ TARGET_SHA classifies fetched target without checking it out"
    pass=$((pass + 1))
  else
    echo "  ✗ TARGET_SHA must classify target while protected-base HEAD stays checked out (exit=$actual, HEAD=$actual_head)" >&2
    echo "    output: $out" >&2
    fail=$((fail + 1))
  fi
}

assert_target_sha_rejected() {
  local fixture_dir="$1"
  local base_sha="$2"
  local target_sha="$3"
  local diagnostic="$4"
  local output actual
  set +e
  output=$(cd "$fixture_dir" && BASE_SHA="$base_sha" TARGET_SHA="$target_sha" bash "$SCRIPT" 2>&1)
  actual=$?
  set -e
  if [[ "$actual" != "0" && "$output" == *"$diagnostic"* ]]; then
    echo "  ✓ invalid TARGET_SHA rejected: $diagnostic"
    pass=$((pass + 1))
  else
    echo "  ✗ invalid TARGET_SHA must fail with '$diagnostic' (exit=$actual)" >&2
    echo "    output: $output" >&2
    fail=$((fail + 1))
  fi
}

assert_classifier_output_bounded() {
  local fixture_dir="$1"
  local base_sha="$2"
  local target_sha="$3"
  local gho bytes lines out actual
  gho=$(mktemp)
  set +e
  ( cd "$fixture_dir" && BASE_SHA="$base_sha" TARGET_SHA="$target_sha" GITHUB_OUTPUT="$gho" bash "$SCRIPT" >/dev/null 2>&1 )
  actual=$?
  set -e
  bytes=$(wc -c < "$gho" | tr -d '[:space:]')
  lines=$(wc -l < "$gho" | tr -d '[:space:]')
  out=$(cat "$gho")
  rm -f "$gho"
  if [[ "$actual" == "0" && "$bytes" -le 8192 && "$lines" == "12" \
    && "$out" == *"old_contract=999999999"* && "$out" == *"new_contract=999999999"* \
    && "$out" == *"old_spa_min=999999999"* && "$out" == *"new_spa_min=999999999"* ]]; then
    echo "  ✓ maximal valid classifier fields emit at most 8 KiB ($bytes bytes)"
    pass=$((pass + 1))
  else
    echo "  ✗ maximal valid classifier fields must succeed within the 8 KiB output cap (exit=$actual, bytes=$bytes)" >&2
    fail=$((fail + 1))
  fi
}

# ── Git fixture helper ────────────────────────────────────────────────────────
# Creates a minimal git repo fixture. Writes the fixture dir path to a tmpfile
# and the base SHA to stdout, so both can be captured without subshell issues.
#
# Args: base_contract base_version head_contract head_version [shell]
# Side effects: creates fixture dir (registered for cleanup), outputs:
#   line 1: fixture_dir path
#   line 2: base_sha
make_fixture() {
  local base_contract="$1"
  local base_version="$2"
  local head_contract="$3"
  local head_version="$4"
  local shell_change="${5:-}"
  local ipc_extra="${6:-}"
  # SPA_MIN_CONTRACT is the DEMAND and moves independently of the capability.
  # It defaults to UNCHANGED (both sides = base_contract) rather than tracking
  # the contract: a fixture that moved them together could never express the
  # #2967 shape, where the capability rose and the demand did not.
  # The literal "absent" omits the declaration, reproducing a tree from before
  # the constant existed. Needed for the migration case: "$7 unset" cannot
  # express it, because an unset arg falls through to a default that writes one.
  local base_spa_min="${7:-$base_contract}"
  local head_spa_min="${8:-$base_spa_min}"

  local tmpdir
  tmpdir=$(mktemp -d)
  echo "$tmpdir" >> "$FIXTURE_REGISTRY"

  (
    cd "$tmpdir"
    git init -q
    git config user.email "test@test.invalid"
    git config user.name "Test"

    mkdir -p desktop/src/main desktop

    # Base commit
    printf 'export const IPC_CONTRACT_VERSION = %s;\n' "$base_contract" \
      > desktop/src/main/ipcContract.ts
    if [[ "$base_spa_min" != "absent" ]]; then
      printf 'export const SPA_MIN_CONTRACT = %s;\n' "$base_spa_min" \
        >> desktop/src/main/ipcContract.ts
    fi
    printf '{\n  "name": "concord-desktop",\n  "version": "%s"\n}\n' "$base_version" \
      > desktop/package.json
    if [[ "$shell_change" == "shell" ]]; then
      echo "// base shell file" > desktop/src/main/dummy.ts
    fi
    if [[ "$shell_change" == "maker" ]]; then
      mkdir -p desktop/build
      echo "// base DMG maker" > desktop/build/makerDmg.ts
    fi
    if [[ "$shell_change" == "dmg-checker" ]]; then
      mkdir -p desktop/scripts
      echo "# base DMG checker" > desktop/scripts/verify-dmg-artifact.sh
    fi
    if [[ "$shell_change" == "smoke-workflow" ]]; then
      mkdir -p .github/workflows
      printf 'name: Desktop PR Smoke\n# base fixture\n' > .github/workflows/desktop-pr-smoke.yml
    fi
    git add . >/dev/null
    git commit -q -m "base commit"
    BASE_SHA_INNER=$(git rev-parse HEAD)

    # Head commit — write new values; always add a renderer-side marker so
    # git commit never sees "nothing to commit" (renderer changes don't affect
    # shell_changed since they fall outside the SHELL_FILES diff set).
    printf 'export const IPC_CONTRACT_VERSION = %s;\n' "$head_contract" \
      > desktop/src/main/ipcContract.ts
    if [[ "$head_spa_min" != "absent" ]]; then
      printf 'export const SPA_MIN_CONTRACT = %s;\n' "$head_spa_min" \
        >> desktop/src/main/ipcContract.ts
    fi
    if [[ "$ipc_extra" == "ipc_surface" ]]; then
      # Append a non-version surface line so ipcContract.ts DIFFERS from base
      # without the version constant moving (#1568 IPC-surface-change case).
      echo "export const NEW_CHANNEL = 'voice:probe';" >> desktop/src/main/ipcContract.ts
    fi
    printf '{\n  "name": "concord-desktop",\n  "version": "%s"\n}\n' "$head_version" \
      > desktop/package.json
    mkdir -p desktop/src/renderer
    echo "// renderer change marker" > desktop/src/renderer/marker.ts
    if [[ "$shell_change" == "shell" ]]; then
      echo "// head shell file changed" > desktop/src/main/dummy.ts
    fi
    if [[ "$shell_change" == "maker" ]]; then
      echo "// head DMG maker changed" > desktop/build/makerDmg.ts
    fi
    if [[ "$shell_change" == "dmg-checker" ]]; then
      echo "# head DMG checker changed" > desktop/scripts/verify-dmg-artifact.sh
    fi
    if [[ "$shell_change" == "smoke-workflow" ]]; then
      printf 'name: Desktop PR Smoke\n# changed fixture\n' > .github/workflows/desktop-pr-smoke.yml
    fi
    git add . >/dev/null
    git commit -q -m "head commit"

    # Output dir and sha to stdout for the caller
    echo "$tmpdir"
    echo "$BASE_SHA_INNER"
  )
}

# ── Sanity tests ──────────────────────────────────────────────────────────────
echo "Sanity tests:"
assert_exit 0 "--help exits 0" bash "$SCRIPT" --help
assert_exit 1 "missing BASE_SHA exits 1" bash "$SCRIPT"

# ── Case 1: renderer-only (no shell change, contract unchanged, version unchanged)
# Expected: contract_action=none, version_action=none, shell_changed=false
echo ""
echo "Case 1: renderer-only — no shell change, no bumps:"
fixture1_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "")
FIXTURE1_DIR=$(echo "$fixture1_output" | sed -n '1p')
FIXTURE1_BASE=$(echo "$fixture1_output" | sed -n '2p')

assert_output_contains "shell_changed=false" \
  "renderer-only: shell_changed=false" "$FIXTURE1_DIR" "$FIXTURE1_BASE"

assert_output_contains "contract_action=none" \
  "renderer-only: contract_action=none" "$FIXTURE1_DIR" "$FIXTURE1_BASE"

assert_output_contains "version_action=none" \
  "renderer-only: version_action=none" "$FIXTURE1_DIR" "$FIXTURE1_BASE"

# ── Case 2 (#1568): shell changed in a NON-ipcContract file, contract not bumped
# Expected: shell_changed=true, contract_action=NONE (ipcContract.ts untouched),
# version_action=notes-needed (a shippable shell change → release). This is the
# decoupling: general shell churn drives the VERSION axis, NOT the IPC axis.
# (Pre-#1568 this asserted contract_action=needed — that was the over-flag bug.)
echo ""
echo "Case 2: shell changed (non-ipcContract), contract not bumped:"
fixture2_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "shell")
FIXTURE2_DIR=$(echo "$fixture2_output" | sed -n '1p')
FIXTURE2_BASE=$(echo "$fixture2_output" | sed -n '2p')

assert_output_contains "shell_changed=true" \
  "shell-non-ipc: shell_changed=true" "$FIXTURE2_DIR" "$FIXTURE2_BASE"

assert_output_contains "contract_action=none" \
  "shell-non-ipc: contract_action=none (ipcContract.ts untouched)" "$FIXTURE2_DIR" "$FIXTURE2_BASE"

assert_output_contains "version_action=notes-needed" \
  "shell-non-ipc: version_action=notes-needed (release)" "$FIXTURE2_DIR" "$FIXTURE2_BASE"

# ── Case 3: shell changed, version NOT bumped
# Expected: shell_changed=true, version_action=notes-needed
echo ""
echo "Case 3: shell changed, version not bumped:"
fixture3_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "shell")
FIXTURE3_DIR=$(echo "$fixture3_output" | sed -n '1p')
FIXTURE3_BASE=$(echo "$fixture3_output" | sed -n '2p')

assert_output_contains "shell_changed=true" \
  "shell-no-version-bump: shell_changed=true" "$FIXTURE3_DIR" "$FIXTURE3_BASE"

assert_output_contains "version_action=notes-needed" \
  "shell-no-version-bump: version_action=notes-needed" "$FIXTURE3_DIR" "$FIXTURE3_BASE"

# ── Case 3b (#2727): local desktop maker changed without a version bump
# Packaging makers are shell/build inputs even though they are outside src/main.
# Expected: shell_changed=true, version_action=notes-needed.
echo ""
echo "Case 3b: local desktop maker changed, version not bumped:"
maker_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "maker")
MAKER_FIXTURE_DIR=$(echo "$maker_fixture_output" | sed -n '1p')
MAKER_FIXTURE_BASE=$(echo "$maker_fixture_output" | sed -n '2p')

assert_output_contains "shell_changed=true" \
  "maker-only: shell_changed=true" "$MAKER_FIXTURE_DIR" "$MAKER_FIXTURE_BASE"

assert_output_contains "contract_action=none" \
  "maker-only: contract_action=none" "$MAKER_FIXTURE_DIR" "$MAKER_FIXTURE_BASE"

assert_output_contains "version_action=notes-needed" \
  "maker-only: version_action=notes-needed" "$MAKER_FIXTURE_DIR" "$MAKER_FIXTURE_BASE"

# ── Case 3c (#2727): DMG verifier changed without a version bump
# The release verifier is part of the desktop packaging contract and must keep
# triggering the smoke/release path when its checks change.
echo ""
echo "Case 3c: DMG verifier changed, version not bumped:"
checker_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "dmg-checker")
CHECKER_FIXTURE_DIR=$(echo "$checker_fixture_output" | sed -n '1p')
CHECKER_FIXTURE_BASE=$(echo "$checker_fixture_output" | sed -n '2p')

assert_output_contains "shell_changed=true" \
  "dmg-checker-only: shell_changed=true" "$CHECKER_FIXTURE_DIR" "$CHECKER_FIXTURE_BASE"

assert_output_contains "version_action=notes-needed" \
  "dmg-checker-only: version_action=notes-needed" "$CHECKER_FIXTURE_DIR" "$CHECKER_FIXTURE_BASE"

# ── Case 3d: the canonical PR smoke workflow path is a shell input ────────────
# The workflow owns the desktop-shell filter after the PR/release workflow split;
# changing only that workflow must still reach the classifier's version axis.
echo ""
echo "Case 3d: desktop PR smoke workflow changed, version not bumped:"
smoke_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "smoke-workflow")
SMOKE_FIXTURE_DIR=$(echo "$smoke_fixture_output" | sed -n '1p')
SMOKE_FIXTURE_BASE=$(echo "$smoke_fixture_output" | sed -n '2p')

assert_output_contains "shell_changed=true" \
  "smoke-workflow-only: shell_changed=true" "$SMOKE_FIXTURE_DIR" "$SMOKE_FIXTURE_BASE"

assert_output_contains "version_action=notes-needed" \
  "smoke-workflow-only: version_action=notes-needed" "$SMOKE_FIXTURE_DIR" "$SMOKE_FIXTURE_BASE"

# ── Case 3e: pull_request_target classifies the fetched target SHA as data ────
# The protected base remains checked out. The PR target commit exists in the
# local object database, but must be read by SHA rather than checked out.
echo ""
echo "Case 3e: TARGET_SHA override does not require a target checkout:"
target_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "smoke-workflow")
TARGET_FIXTURE_DIR=$(echo "$target_fixture_output" | sed -n '1p')
TARGET_FIXTURE_BASE=$(echo "$target_fixture_output" | sed -n '2p')
TARGET_FIXTURE_SHA=$(git -C "$TARGET_FIXTURE_DIR" rev-parse HEAD)
git -C "$TARGET_FIXTURE_DIR" checkout -q "$TARGET_FIXTURE_BASE"
assert_target_sha_without_checkout "$TARGET_FIXTURE_DIR" "$TARGET_FIXTURE_BASE" "$TARGET_FIXTURE_SHA"
assert_output_contains "shell_changed=false" \
  "TARGET_SHA unset retains legacy HEAD behavior" "$TARGET_FIXTURE_DIR" "$TARGET_FIXTURE_BASE"
assert_target_sha_rejected "$TARGET_FIXTURE_DIR" "$TARGET_FIXTURE_BASE" \
  "not-a-canonical-sha" "TARGET_SHA must be a canonical 40-character lowercase SHA"
assert_target_sha_rejected "$TARGET_FIXTURE_DIR" "$TARGET_FIXTURE_BASE" \
  "0000000000000000000000000000000000000000" "TARGET_SHA commit is unavailable"

# Fixed classifier blobs are data, not paths to follow or unbounded input.
echo ""
echo "Case 3f: fixed Git blobs must be regular and bounded:"
blob_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "")
BLOB_FIXTURE_DIR=$(echo "$blob_fixture_output" | sed -n '1p')
BLOB_FIXTURE_BASE=$(echo "$blob_fixture_output" | sed -n '2p')
git -C "$BLOB_FIXTURE_DIR" checkout -q "$BLOB_FIXTURE_BASE"
rm "$BLOB_FIXTURE_DIR/desktop/package.json"
ln -s src/main/ipcContract.ts "$BLOB_FIXTURE_DIR/desktop/package.json"
git -C "$BLOB_FIXTURE_DIR" add -A
git -C "$BLOB_FIXTURE_DIR" commit -q -m "non-regular classifier blob"
BLOB_SYMLINK_SHA=$(git -C "$BLOB_FIXTURE_DIR" rev-parse HEAD)
assert_target_sha_rejected "$BLOB_FIXTURE_DIR" "$BLOB_FIXTURE_BASE" "$BLOB_SYMLINK_SHA" \
  "classify-release.sh input exceeds the bounded classifier contract"

oversize_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "")
OVERSIZE_FIXTURE_DIR=$(echo "$oversize_fixture_output" | sed -n '1p')
OVERSIZE_FIXTURE_BASE=$(echo "$oversize_fixture_output" | sed -n '2p')
git -C "$OVERSIZE_FIXTURE_DIR" checkout -q "$OVERSIZE_FIXTURE_BASE"
python3 - "$OVERSIZE_FIXTURE_DIR/desktop/package.json" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({"name": "concord-desktop", "version": "0.1.57", "padding": "x" * (256 * 1024)}))
PY
git -C "$OVERSIZE_FIXTURE_DIR" add desktop/package.json
git -C "$OVERSIZE_FIXTURE_DIR" commit -q -m "oversized classifier blob"
OVERSIZE_FIXTURE_SHA=$(git -C "$OVERSIZE_FIXTURE_DIR" rev-parse HEAD)
assert_target_sha_rejected "$OVERSIZE_FIXTURE_DIR" "$OVERSIZE_FIXTURE_BASE" "$OVERSIZE_FIXTURE_SHA" \
  "classify-release.sh input exceeds the bounded classifier contract"

echo ""
echo "Case 3g: version and contract scalars stay within canonical bounds:"
semver_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "")
SEMVER_FIXTURE_DIR=$(echo "$semver_fixture_output" | sed -n '1p')
SEMVER_FIXTURE_BASE=$(echo "$semver_fixture_output" | sed -n '2p')
git -C "$SEMVER_FIXTURE_DIR" checkout -q "$SEMVER_FIXTURE_BASE"
python3 - "$SEMVER_FIXTURE_DIR/desktop/package.json" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({"name": "concord-desktop", "version": "1.2.3-" + "a" * 129}))
PY
git -C "$SEMVER_FIXTURE_DIR" add desktop/package.json
git -C "$SEMVER_FIXTURE_DIR" commit -q -m "overlong semantic version"
SEMVER_FIXTURE_SHA=$(git -C "$SEMVER_FIXTURE_DIR" rev-parse HEAD)
assert_target_sha_rejected "$SEMVER_FIXTURE_DIR" "$SEMVER_FIXTURE_BASE" "$SEMVER_FIXTURE_SHA" \
  "classify-release.sh semantic version exceeds 128 bytes"

integer_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "")
INTEGER_FIXTURE_DIR=$(echo "$integer_fixture_output" | sed -n '1p')
INTEGER_FIXTURE_BASE=$(echo "$integer_fixture_output" | sed -n '2p')
git -C "$INTEGER_FIXTURE_DIR" checkout -q "$INTEGER_FIXTURE_BASE"
printf 'export const IPC_CONTRACT_VERSION = 1234567890;\nexport const SPA_MIN_CONTRACT = 12;\n' \
  > "$INTEGER_FIXTURE_DIR/desktop/src/main/ipcContract.ts"
git -C "$INTEGER_FIXTURE_DIR" add desktop/src/main/ipcContract.ts
git -C "$INTEGER_FIXTURE_DIR" commit -q -m "overlong contract integer"
INTEGER_FIXTURE_SHA=$(git -C "$INTEGER_FIXTURE_DIR" rev-parse HEAD)
assert_target_sha_rejected "$INTEGER_FIXTURE_DIR" "$INTEGER_FIXTURE_BASE" "$INTEGER_FIXTURE_SHA" \
  "classify-release.sh contract integer is not canonical or exceeds 9 digits"

canonical_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "")
CANONICAL_FIXTURE_DIR=$(echo "$canonical_fixture_output" | sed -n '1p')
CANONICAL_FIXTURE_BASE=$(echo "$canonical_fixture_output" | sed -n '2p')
git -C "$CANONICAL_FIXTURE_DIR" checkout -q "$CANONICAL_FIXTURE_BASE"
printf 'export const IPC_CONTRACT_VERSION = 012;\nexport const SPA_MIN_CONTRACT = 12;\n' \
  > "$CANONICAL_FIXTURE_DIR/desktop/src/main/ipcContract.ts"
git -C "$CANONICAL_FIXTURE_DIR" add desktop/src/main/ipcContract.ts
git -C "$CANONICAL_FIXTURE_DIR" commit -q -m "noncanonical contract integer"
CANONICAL_FIXTURE_SHA=$(git -C "$CANONICAL_FIXTURE_DIR" rev-parse HEAD)
assert_target_sha_rejected "$CANONICAL_FIXTURE_DIR" "$CANONICAL_FIXTURE_BASE" "$CANONICAL_FIXTURE_SHA" \
  "classify-release.sh contract integer is not canonical or exceeds 9 digits"

diff_fixture_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "")
DIFF_FIXTURE_DIR=$(echo "$diff_fixture_output" | sed -n '1p')
DIFF_FIXTURE_BASE=$(echo "$diff_fixture_output" | sed -n '2p')
git -C "$DIFF_FIXTURE_DIR" checkout -q "$DIFF_FIXTURE_BASE"
python3 - "$DIFF_FIXTURE_DIR/desktop/src/main" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
for index in range(1200):
    (root / f"{index:04d}-{'x' * 120}.ts").write_text("// bounded metadata fixture\n")
PY
git -C "$DIFF_FIXTURE_DIR" add desktop/src/main
git -C "$DIFF_FIXTURE_DIR" commit -q -m "oversized diff metadata"
DIFF_FIXTURE_SHA=$(git -C "$DIFF_FIXTURE_DIR" rev-parse HEAD)
assert_target_sha_rejected "$DIFF_FIXTURE_DIR" "$DIFF_FIXTURE_BASE" "$DIFF_FIXTURE_SHA" \
  "classify-release.sh diff metadata exceeds 128 KiB"

MAX_VERSION="1.2.3-$(printf '%122s' '' | tr ' ' a)"
max_fixture_output=$(make_fixture 999999999 "$MAX_VERSION" 999999999 "$MAX_VERSION" "" "" 999999999 999999999)
MAX_FIXTURE_DIR=$(echo "$max_fixture_output" | sed -n '1p')
MAX_FIXTURE_BASE=$(echo "$max_fixture_output" | sed -n '2p')
MAX_FIXTURE_SHA=$(git -C "$MAX_FIXTURE_DIR" rev-parse HEAD)
assert_classifier_output_bounded "$MAX_FIXTURE_DIR" "$MAX_FIXTURE_BASE" "$MAX_FIXTURE_SHA"

# ── Case 4: contract bumped 10→12
# Expected: contract_action=bumped, old_contract=10, new_contract=12
echo ""
echo "Case 4: contract bumped 10→12:"
fixture4_output=$(make_fixture 10 "0.1.57" 12 "0.1.57" "shell")
FIXTURE4_DIR=$(echo "$fixture4_output" | sed -n '1p')
FIXTURE4_BASE=$(echo "$fixture4_output" | sed -n '2p')

assert_output_contains "contract_action=bumped" \
  "contract-bumped: contract_action=bumped" "$FIXTURE4_DIR" "$FIXTURE4_BASE"

assert_output_contains "old_contract=10" \
  "contract-bumped: old_contract=10" "$FIXTURE4_DIR" "$FIXTURE4_BASE"

assert_output_contains "new_contract=12" \
  "contract-bumped: new_contract=12" "$FIXTURE4_DIR" "$FIXTURE4_BASE"

# ── Case 5: version bumped (with shell change)
# Expected: version_action=bumped, old_version, new_version
echo ""
echo "Case 5: version bumped 0.1.57→0.1.58 (with shell change):"
fixture5_output=$(make_fixture 12 "0.1.57" 12 "0.1.58" "shell")
FIXTURE5_DIR=$(echo "$fixture5_output" | sed -n '1p')
FIXTURE5_BASE=$(echo "$fixture5_output" | sed -n '2p')

assert_output_contains "version_action=bumped" \
  "version-bumped: version_action=bumped" "$FIXTURE5_DIR" "$FIXTURE5_BASE"

assert_output_contains "old_version=0.1.57" \
  "version-bumped: old_version=0.1.57" "$FIXTURE5_DIR" "$FIXTURE5_BASE"

assert_output_contains "new_version=0.1.58" \
  "version-bumped: new_version=0.1.58" "$FIXTURE5_DIR" "$FIXTURE5_BASE"

# ── Case 6: both contract and version bumped
# Expected: contract_action=bumped, version_action=bumped
echo ""
echo "Case 6: both contract and version bumped:"
fixture6_output=$(make_fixture 10 "0.1.57" 12 "0.1.58" "shell")
FIXTURE6_DIR=$(echo "$fixture6_output" | sed -n '1p')
FIXTURE6_BASE=$(echo "$fixture6_output" | sed -n '2p')

assert_output_contains "contract_action=bumped" \
  "both-bumped: contract_action=bumped" "$FIXTURE6_DIR" "$FIXTURE6_BASE"

assert_output_contains "version_action=bumped" \
  "both-bumped: version_action=bumped" "$FIXTURE6_DIR" "$FIXTURE6_BASE"

# ── Case 7 (#1568): ipcContract.ts SURFACE changed, version constant NOT bumped
# Expected: contract_action=needed — the IPC axis fires on an actual contract
# surface change (positive case for the file-gated IPC detection).
echo ""
echo "Case 7: ipcContract surface changed, version constant unchanged:"
fixture7_output=$(make_fixture 12 "0.1.57" 12 "0.1.57" "" "ipc_surface")
FIXTURE7_DIR=$(echo "$fixture7_output" | sed -n '1p')
FIXTURE7_BASE=$(echo "$fixture7_output" | sed -n '2p')

assert_output_contains "contract_action=needed" \
  "ipc-surface-change: contract_action=needed" "$FIXTURE7_DIR" "$FIXTURE7_BASE"

# ── Case 8 (#1568 regression): PR branch trails main — must NOT inherit main's
# shell churn. Branch forks at B; "main" advances to M with a shell change; the
# feature branch (HEAD=F) has only a renderer change and does NOT contain M.
# BASE_SHA=M. merge-base(M,F)=B, so diff(B,F)=renderer-only → shell_changed=false.
# (The pre-#1568 two-dot diff(M,F) would falsely see main's dummy.ts shell change
# and flag a bump — this case locks the merge-base fix.)
echo ""
echo "Case 8: PR branch behind main does not inherit main's shell changes:"
C8_DIR=$(mktemp -d); echo "$C8_DIR" >> "$FIXTURE_REGISTRY"
C8_BASE=$(
  cd "$C8_DIR"
  git init -q; git config user.email "test@test.invalid"; git config user.name "Test"
  mkdir -p desktop/src/main desktop desktop/src/renderer
  printf 'export const IPC_CONTRACT_VERSION = 12;\n' > desktop/src/main/ipcContract.ts
  printf '{\n  "name": "concord-desktop",\n  "version": "0.1.57"\n}\n' > desktop/package.json
  echo "// v1" > desktop/src/main/dummy.ts
  git add . >/dev/null; git commit -qm "B fork point"
  B=$(git rev-parse HEAD)
  echo "// v2 main shell change" > desktop/src/main/dummy.ts
  git add . >/dev/null; git commit -qm "M main advances (shell)"
  M=$(git rev-parse HEAD)
  git checkout -q -b feature "$B"
  echo "// renderer-only" > desktop/src/renderer/marker.ts
  git add . >/dev/null; git commit -qm "F feature renderer-only"
  echo "$M"
)
assert_output_contains "shell_changed=false" \
  "behind-main: shell_changed=false (merge-base excludes main's churn)" "$C8_DIR" "$C8_BASE"
assert_output_contains "contract_action=none" \
  "behind-main: contract_action=none" "$C8_DIR" "$C8_BASE"

# ── Case 9 (#1572 / Gitar #1): the REAL CI shape. actions/checkout checks out the
# PR test-merge commit (refs/pull/N/merge), so HEAD is a MERGE commit whose parent
# IS the base tip, and base.sha can be STALE. The classifier must anchor on the live
# base branch (origin/$GITHUB_BASE_REF), not base.sha, to diff only the PR's OWN
# changes. Renderer-only PR on a merge-commit HEAD → shell_changed=false even though
# main advanced with a shell change and the passed base.sha is stale.
# (Case 8 used a feature-branch-tip HEAD, which does NOT reproduce CI's merge HEAD —
#  the gap Gitar flagged. This case builds the real merge commit + an origin/main ref.)
echo ""
echo "Case 9: test-merge HEAD + stale base.sha → anchors on origin/main, not base.sha:"
C9_DIR=$(mktemp -d); echo "$C9_DIR" >> "$FIXTURE_REGISTRY"
C9_STALE_BASE=$(
  cd "$C9_DIR"
  git init -q; git config user.email "test@test.invalid"; git config user.name "Test"
  mkdir -p desktop/src/main desktop desktop/src/renderer
  printf 'export const IPC_CONTRACT_VERSION = 12;\n' > desktop/src/main/ipcContract.ts
  printf '{\n  "name": "concord-desktop",\n  "version": "0.1.57"\n}\n' > desktop/package.json
  echo "// v1" > desktop/src/main/dummy.ts
  git add . >/dev/null; git commit -qm "B (stale base.sha point)"
  B=$(git rev-parse HEAD)
  echo "// v2 main shell change" > desktop/src/main/dummy.ts
  git add . >/dev/null; git commit -qm "M main advances (shell)"
  M=$(git rev-parse HEAD)
  git checkout -q -b feature "$B"
  echo "// renderer-only" > desktop/src/renderer/marker.ts
  git add . >/dev/null; git commit -qm "F feature renderer-only"
  # Build the test-merge commit GitHub creates as refs/pull/N/merge (merge main into PR head):
  git checkout -q -b prmerge
  git merge -q --no-edit "$M" >/dev/null 2>&1
  # Simulate the post-checkout remote-tracking ref for the live base branch:
  git update-ref refs/remotes/origin/main "$M"
  echo "$B"  # emit the STALE base.sha the classifier receives
)
C9_GHO=$(mktemp)
( cd "$C9_DIR" && BASE_SHA="$C9_STALE_BASE" GITHUB_BASE_REF="main" GITHUB_OUTPUT="$C9_GHO" bash "$SCRIPT" >/dev/null 2>&1 )
C9_OUT=$(cat "$C9_GHO"); rm -f "$C9_GHO"
for kv in "shell_changed=false" "contract_action=none" "version_action=none"; do
  if grep -qF -- "$kv" <<<"$C9_OUT"; then
    echo "  ✓ merge-HEAD/stale-base: $kv"; pass=$((pass + 1))
  else
    echo "  ✗ merge-HEAD/stale-base: $kv" >&2; echo "    output: $C9_OUT" >&2; fail=$((fail + 1))
  fi
done

# ── Drift-guard: SHELL_FILES ↔ desktop-pr-smoke.yml desktop-shell filter ───────
# classify-release.sh's SHELL_FILES list is a hand-copy of desktop-pr-smoke.yml's
# `desktop-shell:` dorny/paths-filter. They MUST stay in sync EXCEPT for ONE
# intentional delta (#827):
#   - desktop-pr-smoke.yml-only: 'desktop/package.json'  (omitted from
#       SHELL_FILES so version_bump_only stays reachable)
# NOTE: both lists DO include '.github/workflows/desktop-pr-smoke.yml' — the
# desktop-pr-smoke.yml `desktop-shell:` filter has listed itself since #3570,
# so it is NOT a classify-only delta (verified against this PR's tree; the
# #1388 review batch's "two deltas" framing was a stale assumption).
# Any OTHER difference is drift and fails this guard with the offending path.
echo ""
echo "Drift-guard: SHELL_FILES ↔ desktop-pr-smoke.yml desktop-shell filter:"

SMOKE_WORKFLOW_YML="${REPO_ROOT}/.github/workflows/desktop-pr-smoke.yml"

# Extract the single-quoted glob paths from classify-release.sh's SHELL_FILES
# block: everything between the `SHELL_FILES=$(git diff ...` line and the
# closing `2>/dev/null`. Pull the first single-quoted token off each line.
extract_shell_files_globs() {
  awk '
    /^if ! git diff --name-only / { capon=1; next }
    capon && / > "\$DIFF_METADATA_FILE"/ { capon=0 }
    capon {
      if (match($0, /'\''[^'\'']+'\''/)) {
        s = substr($0, RSTART+1, RLENGTH-2)
        print s
      }
    }
  ' "$SCRIPT" | sort
}

# Extract the `- '<glob>'` entries under the `desktop-shell:` key in
# desktop-pr-smoke.yml, stopping at the next less-indented (non-list) line.
extract_smoke_workflow_globs() {
  awk '
    /^[[:space:]]*desktop-shell:[[:space:]]*$/ { capon=1; next }
    capon {
      if ($0 ~ /^[[:space:]]*-[[:space:]]*'\''[^'\'']+'\''/) {
        if (match($0, /'\''[^'\'']+'\''/)) {
          print substr($0, RSTART+1, RLENGTH-2)
        }
      } else if ($0 ~ /[^[:space:]]/) {
        # First non-blank, non-list line ends the block.
        capon=0
      }
    }
  ' "$SMOKE_WORKFLOW_YML" | sort
}

if [[ ! -f "$SMOKE_WORKFLOW_YML" ]]; then
  echo "  ✗ desktop-pr-smoke.yml not found at $SMOKE_WORKFLOW_YML" >&2
  fail=$((fail + 1))
else
  CLASSIFY_GLOBS=$(extract_shell_files_globs)
  BUILD_GLOBS=$(extract_smoke_workflow_globs)

  # Sanity: neither extraction may be empty (a parse regression would silently
  # make the symmetric-difference check vacuously pass).
  if [[ -z "$CLASSIFY_GLOBS" ]]; then
    echo "  ✗ extracted ZERO globs from classify-release.sh SHELL_FILES (parse regression?)" >&2
    fail=$((fail + 1))
  elif [[ -z "$BUILD_GLOBS" ]]; then
    echo "  ✗ extracted ZERO globs from desktop-pr-smoke.yml desktop-shell filter (parse regression?)" >&2
    fail=$((fail + 1))
  else
    # build-desktop-only = in build filter, NOT in SHELL_FILES.
    BUILD_ONLY=$(comm -23 <(echo "$BUILD_GLOBS") <(echo "$CLASSIFY_GLOBS"))
    # classify-only = in SHELL_FILES, NOT in build filter.
    CLASSIFY_ONLY=$(comm -13 <(echo "$BUILD_GLOBS") <(echo "$CLASSIFY_GLOBS"))

    # The ONLY accepted delta is desktop-pr-smoke.yml carrying package.json that
    # SHELL_FILES omits (#827). classify-release.sh must add nothing the smoke
    # filter lacks — '.github/workflows/desktop-pr-smoke.yml' is present in BOTH.
    EXPECTED_BUILD_ONLY="desktop/package.json"
    EXPECTED_CLASSIFY_ONLY=""

    if [[ "$BUILD_ONLY" == "$EXPECTED_BUILD_ONLY" && "$CLASSIFY_ONLY" == "$EXPECTED_CLASSIFY_ONLY" ]]; then
      echo "  ✓ symmetric difference is exactly the 1 intentional delta (#827: package.json filter-only)"
      pass=$((pass + 1))
    else
      echo "  ✗ SHELL_FILES drifted from desktop-pr-smoke.yml desktop-shell filter" >&2
      echo "    desktop-pr-smoke.yml-only (expected '$EXPECTED_BUILD_ONLY'):" >&2
      printf '      %s\n' "${BUILD_ONLY:-(none)}" >&2
      echo "    classify-release.sh-only (expected none):" >&2
      printf '      %s\n' "${CLASSIFY_ONLY:-(none)}" >&2
      fail=$((fail + 1))
    fi
  fi
fi

# ── Workflow trigger guard ────────────────────────────────────────────────────
echo ""
echo "Hosted classification contract fixtures (publication remains outside Desktop):"
CLASSIFY_RELEASE_YML="${REPO_ROOT}/.github/scripts/tests/fixtures/hosted-release/classify-release.yml"
CLASSIFY_COMMENT_YML="${REPO_ROOT}/.github/scripts/tests/fixtures/hosted-release/classify-release-comment.yml"
assert_exit 0 "build-desktop.yml is included in pull_request.paths" awk '
  /^  pull_request:/ { in_pr=1; next }
  in_pr && /^[^ ]/ { in_pr=0; in_paths=0 }
  in_pr && /^    paths:/ { in_paths=1; next }
  in_paths && /^    [^ ]/ { in_paths=0 }
  in_paths && $0 == "      - '\''.github/workflows/build-desktop.yml'\''" { found=1 }
  END { exit !found }
' "$CLASSIFY_RELEASE_YML"

assert_exit 0 "desktop-pr-smoke.yml is included in pull_request.paths" awk '
  /^  pull_request:/ { in_pr=1; next }
  in_pr && /^[^ ]/ { in_pr=0; in_paths=0 }
  in_pr && /^    paths:/ { in_paths=1; next }
  in_paths && /^    [^ ]/ { in_paths=0 }
  in_paths && $0 == "      - '\''.github/workflows/desktop-pr-smoke.yml'\''" { found=1 }
  END { exit !found }
' "$CLASSIFY_RELEASE_YML"

# classify-release.yml was absent from its OWN paths filter, so every edit to the
# classifier shipped without ever executing on the PR that made the edit — the
# change could only be observed after it reached main. Caught on PR #2925.
assert_exit 0 "classify-release.yml is included in its own pull_request.paths" awk '
  /^  pull_request:/ { in_pr=1; next }
  in_pr && /^[^ ]/ { in_pr=0; in_paths=0 }
  in_pr && /^    paths:/ { in_paths=1; next }
  in_paths && /^    [^ ]/ { in_paths=0 }
  in_paths && $0 == "      - '\''.github/workflows/classify-release.yml'\''" { found=1 }
  END { exit !found }
' "$CLASSIFY_RELEASE_YML"

# `risk: hotfix` is normally applied during triage AFTER the PR opens. Without
# labeled/unlabeled the classification comment reports "standard" on a PR that is
# in fact flagged — stale at exactly the moment someone reads it to decide how to
# merge. Both types are required; a partial list is as stale as none.
for _type in labeled unlabeled; do
  assert_exit 0 "pull_request.types includes '$_type'" awk -v want="$_type" '
    /^  pull_request:/ { in_pr=1; next }
    in_pr && /^[^ ]/ { in_pr=0 }
    in_pr && /^    types:/ {
      line=$0
      gsub(/[][,]/, " ", line)
      n=split(line, parts, /[ \t]+/)
      for (i=1; i<=n; i++) if (parts[i] == want) found=1
    }
    END { exit !found }
  ' "$CLASSIFY_RELEASE_YML"
done

# ── SPA-minimum / version lockstep (#2967) ────────────────────────────────────
# The gate keys on the DEMAND (SPA_MIN_CONTRACT), never the capability.
# Case C is the falsifier that matters: it is the exact #2967 shape, and it must
# PASS. Keying the gate on IPC_CONTRACT_VERSION flips it to a failure, which
# would force a release for shell capability no renderer requires.
echo ""
echo "Case L-A: SPA minimum RAISED, version NOT bumped:"
fixtureLA_output=$(make_fixture 24 "0.2.41" 25 "0.2.41" "" "" 19 20)
FIXTURELA_DIR=$(echo "$fixtureLA_output" | sed -n '1p')
FIXTURELA_BASE=$(echo "$fixtureLA_output" | sed -n '2p')

assert_output_contains "spa_min_action=raised" \
  "lockstep-A: spa_min_action=raised" "$FIXTURELA_DIR" "$FIXTURELA_BASE"

assert_output_contains "version_bump_required=true" \
  "lockstep-A: version_bump_required=true (gate FIRES)" "$FIXTURELA_DIR" "$FIXTURELA_BASE"

echo ""
echo "Case L-B: SPA minimum raised WITH a version bump:"
fixtureLB_output=$(make_fixture 24 "0.2.41" 25 "0.2.42" "" "" 19 20)
FIXTURELB_DIR=$(echo "$fixtureLB_output" | sed -n '1p')
FIXTURELB_BASE=$(echo "$fixtureLB_output" | sed -n '2p')

assert_output_contains "version_action=bumped" \
  "lockstep-B: version_action=bumped" "$FIXTURELB_DIR" "$FIXTURELB_BASE"

assert_output_contains "version_bump_required=false" \
  "lockstep-B: version_bump_required=false (gate PASSES)" "$FIXTURELB_DIR" "$FIXTURELB_BASE"

echo ""
echo "Case L-C: capability bumped, minimum HELD, no version bump (#2967 exactly):"
# 23 -> 25 with the demand steady at 19: additive shell surface the renderer
# feature-detects. No client is required and none must be demanded.
fixtureLC_output=$(make_fixture 23 "0.2.41" 25 "0.2.41" "" "" 19 19)
FIXTURELC_DIR=$(echo "$fixtureLC_output" | sed -n '1p')
FIXTURELC_BASE=$(echo "$fixtureLC_output" | sed -n '2p')

assert_output_contains "contract_action=bumped" \
  "lockstep-C: contract_action=bumped (capability moved)" "$FIXTURELC_DIR" "$FIXTURELC_BASE"

assert_output_contains "spa_min_action=none" \
  "lockstep-C: spa_min_action=none (demand steady)" "$FIXTURELC_DIR" "$FIXTURELC_BASE"

assert_output_contains "version_bump_required=false" \
  "lockstep-C: version_bump_required=false (#2967 must NOT be blocked)" "$FIXTURELC_DIR" "$FIXTURELC_BASE"

echo ""
echo "Case L-D: SPA minimum LOWERED, no version bump:"
# Lowering admits MORE shells, never fewer. Always safe, never demanded of.
fixtureLD_output=$(make_fixture 25 "0.2.41" 25 "0.2.41" "" "" 22 19)
FIXTURELD_DIR=$(echo "$fixtureLD_output" | sed -n '1p')
FIXTURELD_BASE=$(echo "$fixtureLD_output" | sed -n '2p')

assert_output_contains "spa_min_action=lowered" \
  "lockstep-D: spa_min_action=lowered" "$FIXTURELD_DIR" "$FIXTURELD_BASE"

# The IPC axis must NOT fire here. ipcContract.ts changed, but only the demand
# moved — that is not IPC surface. Before the axis read diff CONTENT rather than
# the filename, this PR tripped its own classifier into demanding a phantom bump
# to 26 for declaring a constant. Case 7 is the control: a real added export
# still reads "needed", so this is a narrowing, not a disabling.
assert_output_contains "contract_action=none" \
  "lockstep-D: a demand-only edit is not an IPC surface change" "$FIXTURELD_DIR" "$FIXTURELD_BASE"

assert_output_contains "version_bump_required=false" \
  "lockstep-D: version_bump_required=false (lowering is always safe)" "$FIXTURELD_DIR" "$FIXTURELD_BASE"

echo ""
echo "Case L-E: ordinary shell change, nothing moved:"
fixtureLE_output=$(make_fixture 25 "0.2.41" 25 "0.2.41" "shell")
FIXTURELE_DIR=$(echo "$fixtureLE_output" | sed -n '1p')
FIXTURELE_BASE=$(echo "$fixtureLE_output" | sed -n '2p')

assert_output_contains "version_bump_required=false" \
  "lockstep-E: version_bump_required=false (ordinary shell PR untouched)" "$FIXTURELE_DIR" "$FIXTURELE_BASE"

echo ""
echo "Case L-F: SPA_MIN_CONTRACT introduced where none existed:"
# The migration commit itself. ABSENT at base means the effective demand back
# there was the CAPABILITY, because deploy-spa.sh published that. So introducing
# 19 against a base capability of 25 is a large LOWERING, not a raise. A naive
# `${OLD_SPA_MIN:-0}` reads it as 0 -> 19 and blocks the very PR that fixes the
# conflation — which is what PR 3014's own CI did before this was corrected.
fixtureLF_output=$(make_fixture 25 "0.2.41" 25 "0.2.41" "" "" "absent" 19)
FIXTURELF_DIR=$(echo "$fixtureLF_output" | sed -n '1p')
FIXTURELF_BASE=$(echo "$fixtureLF_output" | sed -n '2p')

assert_output_contains "version_bump_required=false" \
  "lockstep-F: introducing the constant is not a raise" "$FIXTURELF_DIR" "$FIXTURELF_BASE"

assert_output_contains "spa_min_action=lowered" \
  "lockstep-F: 25 (implied) -> 19 reads as lowered" "$FIXTURELF_DIR" "$FIXTURELF_BASE"

echo ""
echo "Case L-G: SPA_MIN_CONTRACT REMOVED at HEAD:"
# Not a lowering to 0. deploy-spa.sh exits 2 on an unparseable minimum, so
# deleting the declaration breaks every SPA deploy after merge — the
# only-visible-at-deploy-time failure this split exists to eliminate.
fixtureLG_output=$(make_fixture 25 "0.2.41" 25 "0.2.41" "" "" 19 "absent")
FIXTURELG_DIR=$(echo "$fixtureLG_output" | sed -n '1p')
FIXTURELG_BASE=$(echo "$fixtureLG_output" | sed -n '2p')

assert_output_contains "spa_min_action=removed" \
  "lockstep-G: removal is its own verdict, not 'lowered'" "$FIXTURELG_DIR" "$FIXTURELG_BASE"

assert_output_contains "spa_min_present=false" \
  "lockstep-G: spa_min_present=false (gate refuses)" "$FIXTURELG_DIR" "$FIXTURELG_BASE"

# The workflow must act on it, not merely emit it. A check that computes a
# verdict and never branches on it is the 'prints but does not gate' failure.
echo ""
echo "Workflow: the gate branches on a removed declaration:"
assert_exit 0 "lockstep job fails when spa_min_present is false" grep -q 'PRESENT.*}} == .false.\|\[\[ "\${PRESENT}" == "false" \]\]' "$CLASSIFY_RELEASE_YML"

echo ""
echo "Case L-H: constant absent on BOTH sides (pre-split branch):"
# A branch cut before SPA_MIN_CONTRACT existed has not removed anything. Reading
# that as a removal would red-gate every in-flight PR the moment this lands.
fixtureLH_output=$(make_fixture 25 "0.2.41" 25 "0.2.41" "shell" "" "absent" "absent")
FIXTURELH_DIR=$(echo "$fixtureLH_output" | sed -n '1p')
FIXTURELH_BASE=$(echo "$fixtureLH_output" | sed -n '2p')

assert_output_contains "spa_min_present=true" \
  "lockstep-H: absent on both sides is not a removal" "$FIXTURELH_DIR" "$FIXTURELH_BASE"

assert_output_contains "version_bump_required=false" \
  "lockstep-H: pre-split branch is not blocked" "$FIXTURELH_DIR" "$FIXTURELH_BASE"

# ── PR-comment table: the live probe belongs to ONE row ───────────────────────
# /api/v1/client/config returns .spaIpcContract — the published DEMAND. It was
# rendered in BOTH the IPC Contract row (labelled capability) and the SPA
# minimum row, so one number appeared under two different questions; once they
# diverge (19 vs 25) the capability row reads as a regression. Gitar caught it
# on PR 3014. These are shape assertions over the inline github-script block,
# matching how this file already checks the workflow's trigger surface.
echo ""
echo "PR comment: the demand probe is not shown as the capability:"

assert_publisher_probe_behavior() {
  python3 - "$CLASSIFY_COMMENT_YML" <<'PY'
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml

workflow = yaml.load(Path(sys.argv[1]).read_text(), Loader=yaml.BaseLoader)
script = workflow["jobs"]["classify-comment"]["steps"][0]["with"]["script"]
match = re.search(
    r"(?ms)^\s*const NA = 'unknown \(probe failed\)';.*?^\s*const activeContract = liveContract \|\| NA;",
    script,
)
if not match:
    raise SystemExit("FAIL: could not extract the publisher's live-contract probe")
probe = match.group(0)

def evaluate(source, config, *, ok=True):
    runner = (
        "(async () => {\n"
        "global.fetch = async () => ({ ok: " + json.dumps(ok) + ", json: async () => JSON.parse(process.env.CONFIG_JSON) });\n"
        + source
        + "\nprocess.stdout.write(JSON.stringify(activeContract));\n})().catch((error) => { console.error(error); process.exit(1); });"
    )
    env = {**os.environ, "CONFIG_JSON": json.dumps(config, allow_nan=False)}
    result = subprocess.run(["node", "-e", runner], text=True, capture_output=True, env=env, check=False)
    if result.returncode:
        raise AssertionError(f"node probe failed: {result.stderr.strip()}")
    return json.loads(result.stdout)

unknown = "unknown (probe failed)"
cases = [
    ("integer 19 is normalized to a string", {"spaIpcContract": 19}, "19"),
    ("zero is accepted", {"spaIpcContract": 0}, "0"),
    ("maximum bounded integer is accepted", {"spaIpcContract": 999999999}, "999999999"),
    ("string contract remains unknown", {"spaIpcContract": "19"}, unknown),
    ("fractional contract remains unknown", {"spaIpcContract": 19.5}, unknown),
    ("negative contract remains unknown", {"spaIpcContract": -1}, unknown),
    ("out-of-range contract remains unknown", {"spaIpcContract": 1000000000}, unknown),
    ("missing contract remains unknown", {}, unknown),
    ("null response shape remains unknown", None, unknown),
    ("failed response remains unknown", {"spaIpcContract": 19}, unknown, False),
]
for case in cases:
    label, config, expected, *ok_arg = case
    actual = evaluate(probe, config, ok=ok_arg[0] if ok_arg else True)
    if actual != expected:
        raise SystemExit(f"FAIL: {label}: expected {expected!r}, got {actual!r}")

# Prove this test distinguishes a numeric passthrough from the required string conversion.
mutated = probe.replace("String(config.spaIpcContract)", "config.spaIpcContract")
if mutated == probe or evaluate(mutated, {"spaIpcContract": 19}) == "19":
    raise SystemExit("FAIL: extracted publisher regression did not catch missing string conversion")
print(f"PASS: extracted live-contract publisher probe ({len(cases)} cases + conversion mutation)")
PY
}

if assert_publisher_probe_behavior; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
fi

assert_exit 0 "IPC Contract row does not render activeContract" awk '
  /^[[:space:]]*\/\// { next }
  /\*\*IPC Contract\*\*/ && /activeContract/ { found=1 }
  END { exit found }
' "$CLASSIFY_COMMENT_YML"

assert_exit 0 "SPA minimum row DOES render activeContract" grep -q 'SPA minimum\*\* | .*activeContract' "$CLASSIFY_COMMENT_YML"

# The capability has no deploy, so it can never be "awaiting" one. That branch
# also compared the capability against the demand probe.
assert_exit 0 "no 'awaiting deploy' branch on the capability axis" awk '
  /^[[:space:]]*\/\// { next }
  /already on .* awaiting deploy/ { found=1 }
  END { exit found }
' "$CLASSIFY_COMMENT_YML"

assert_exit 0 "comment branches on VERSION_BUMP_REQUIRED" \
  grep -q "VERSION_BUMP_REQUIRED === 'true'" "$CLASSIFY_COMMENT_YML"

assert_exit 0 "SPA minimum validator accepts the legacy removed action" \
  grep -Fq '[[ "${SPA_MIN_ACTION}" =~ ^(none|raised|lowered|removed)$ ]]' "$CLASSIFY_COMMENT_YML"

assert_exit 0 "publisher output validator accepts the legacy removed action" \
  grep -Fq "enumValue(SPA_MIN_ACTION, ['none', 'raised', 'lowered', 'removed'])" "$CLASSIFY_COMMENT_YML"

assert_exit 0 "publisher accepts bounded integer spaIpcContract API values" \
  grep -Fq "Number.isSafeInteger(config.spaIpcContract) && config.spaIpcContract >= 0 && config.spaIpcContract <= 999999999" "$CLASSIFY_COMMENT_YML"

assert_exit 0 "invalid public contract JSON preserves the unknown fallback" awk '
  /const NA = '\''unknown \(probe failed\)'\'';/ { unknown=NR }
  /let liveContract = NA;/ { fallback=NR }
  /Number.isSafeInteger\(config.spaIpcContract\)/ { numeric=NR }
  /const activeContract = liveContract \|\| NA;/ { exposed=NR }
  END { exit !(unknown && fallback > unknown && numeric > fallback && exposed > numeric) }
' "$CLASSIFY_COMMENT_YML"

assert_exit 0 "classifier output validator accepts prerelease and build metadata" \
  grep -Fq '(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/' "$CLASSIFY_COMMENT_YML"

# A traceback here would REPLACE the remediation block, which is the only
# actionable output the gate produces.
assert_exit 0 "next-version computation falls back instead of raising" \
  grep -q "next-version" "$CLASSIFY_RELEASE_YML"

# ── PR comment: "on merge" is a hotfix-only claim ─────────────────────────────
# main-ci.yml:179 gates the release dispatch on `risk: hotfix`; an ordinary
# version bump defers to nightly-ci.yml. Claiming "on merge" unconditionally
# made the Client Version cell contradict the Release timing row three lines
# below it on every non-hotfix release PR. CodeRabbit caught it on PR 3013.
echo ""
echo "PR comment: release timing is conditioned on the hotfix label:"

assert_exit 0 "no unconditional 'release ... on merge' claim" awk '
  /^[[:space:]]*\/\// { next }
  /versionBump = `.*on merge`/ { found=1 }
  END { exit found }
' "$CLASSIFY_COMMENT_YML"

assert_exit 0 "versionBump branches on hotfix" \
  grep -q 'versionBump = hotfix' "$CLASSIFY_COMMENT_YML"

assert_exit 0 "verdict branches on hotfix" \
  grep -q 'verdictTitle = hotfix' "$CLASSIFY_COMMENT_YML"

assert_exit 0 "non-hotfix path names the nightly as the dispatcher" \
  grep -q 'at the next nightly' "$CLASSIFY_COMMENT_YML"

# ORDERING, not just presence: `const hotfix` is in the temporal dead zone
# until declared, so using it above its declaration is a ReferenceError at
# runtime rather than a lint error at author time.
assert_exit 0 "hotfix is declared before versionBump uses it" awk '
  /const hotfix =/ && !decl { decl=NR }
  /versionBump = hotfix/ && !use { use=NR }
  END { exit !(decl && use && decl < use) }
' "$CLASSIFY_COMMENT_YML"

# ── The gate must be allowed to fail ──────────────────────────────────────────
# A `continue-on-error: true` on the lockstep job would leave the assertion
# running, the annotation printing, and the check reporting success — a gate
# that displays rather than gates. Pin its absence.
echo ""
echo "Workflow: the lockstep job is not continue-on-error:"
assert_exit 0 "contract-version-lockstep has no continue-on-error" awk '
  /^  contract-version-lockstep:/ { inj=1; next }
  inj && /^  [a-z]/ { inj=0 }
  inj && /^[[:space:]]*continue-on-error:/ { found=1 }
  END { exit found }
' "$CLASSIFY_RELEASE_YML"

assert_exit 0 "contract-version-lockstep job exists" \
  grep -q "^  contract-version-lockstep:" "$CLASSIFY_RELEASE_YML"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────"
echo "PASS: $pass  FAIL: $fail"
[[ "$fail" == "0" ]]
