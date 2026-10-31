#!/usr/bin/env bash
#
# classify-release.sh — Two-axis release classifier for desktop PRs.
#
# Extracted from the `classify-release` job inline bash so the logic is unit-testable
# without a live GitHub Actions runner. Called by build.yml classify-release step.
# Spec: internal-reference §4 (#976)
#
# Inputs (environment variables):
#   BASE_SHA  — git SHA of the PR base (required)
#   TARGET_SHA — git SHA to classify (optional; defaults to HEAD)
#
# Outputs (written to $GITHUB_OUTPUT if set, else stdout key=value):
#   shell_changed      — "true" | "false"
#   old_contract       — integer string (IPC_CONTRACT_VERSION at base)
#   new_contract       — integer string (IPC_CONTRACT_VERSION in working tree)
#   contract_action    — "bumped" | "needed" | "none"
#   old_version        — semver string (package.json version at base)
#   new_version        — semver string (package.json version in working tree)
#   version_action     — "bumped" | "notes-needed" | "none"
#   old_spa_min        — integer string (SPA_MIN_CONTRACT at base)
#   new_spa_min        — integer string (SPA_MIN_CONTRACT in working tree)
#   spa_min_action     — "raised" | "lowered" | "none" | "removed"
#   spa_min_present    — "true" | "false" (declaration exists at HEAD)
#   version_bump_required — "true" | "false" (SPA minimum raised without a version bump)
#   bump_level         — "major" | "minor" | "patch" | "none" (recommended level for the next release)
#   bump_basis         — "breaking" | "added" | "ipc" | "notes" | "shell" | "none" (why)
#
# The version axis says "notes-needed", NOT "needed" (#2996): what a shell
# change OWES is an entry under `## [Prerelease]`. Whether to cut a release is
# the human's call, and bump_level/bump_basis are the recommendation that call
# is made from. A PR that cuts runs the promoter and `npm version` together,
# which verify-changelog.sh Rules 1 and 3 accept (#3354).
#
# Usage:
#   BASE_SHA=<sha> bash .github/scripts/classify-release.sh
#
# Exit codes: 0 on success, 1 on usage error.

set -euo pipefail

# first_line: `| head -1` under `set -o pipefail` is a RACE, not a shorthand. head
# exits after the first line and closes the pipe; if the producer has not already
# finished, its next write takes SIGPIPE, the pipeline reports 141, and `set -e`
# kills the script silently with every later statement unreached. Whether it fires
# depends on producer buffering, so it passes on one machine and fails on another.
# first_line DRAINS its input, so there is nothing to race. Prose ABOUT the defect
# deliberately keeps saying `head -1`. Reference: #3105, commit 3f7144952 in
# internal-reference
first_line() {
  local l first=
  while IFS= read -r l || [[ -n "$l" ]]; do
    [[ -n "$first" ]] || { first=1; printf '%s\n' "$l"; }
  done
}

# ── Argument validation ───────────────────────────────────────────────────────

if [[ "${1-}" == "--help" ]]; then
  grep '^#' "$0" | sed 's/^# \?//'
  exit 0
fi

if [[ -z "${BASE_SHA:-}" ]]; then
  echo "ERROR: BASE_SHA environment variable is required." >&2
  exit 1
fi

TARGET_INPUT="${TARGET_SHA:-HEAD}"
if [[ -n "${TARGET_SHA:-}" && ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: TARGET_SHA must be a canonical 40-character lowercase SHA" >&2
  exit 1
fi
TARGET_COMMIT=$(git rev-parse --verify --quiet "${TARGET_INPUT}^{commit}" 2>/dev/null || true)
if [[ ! "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: TARGET_SHA commit is unavailable" >&2
  exit 1
fi

# ── Output helper ─────────────────────────────────────────────────────────────
# Write a key=value pair to $GITHUB_OUTPUT if set; otherwise to stdout.
emit() {
  local key="$1"
  local value="$2"
  case "$key" in
    shell_changed|old_contract|new_contract|contract_action|old_version|new_version|version_action|old_spa_min|new_spa_min|spa_min_action|spa_min_present|version_bump_required|bump_level|bump_basis) ;;
    *) echo "ERROR: classify-release.sh input exceeds the bounded classifier contract" >&2; exit 1 ;;
  esac
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "ERROR: classify-release.sh input exceeds the bounded classifier contract" >&2
    exit 1
  fi
  printf '%s=%s\n' "$key" "$value" >> "$OUTPUT_BUFFER"
}

# ── Resolve the PR's own changeset (diff anchor) ──────────────────────────────
# Anchor the diff on the CURRENT base branch tip, NOT the event's BASE_SHA.
# In CI, actions/checkout checks out the PR's test-merge ref (refs/pull/N/merge),
# so HEAD is a merge commit whose parent IS BASE_SHA → `git merge-base BASE_SHA
# HEAD` == BASE_SHA and a BASE_SHA two-dot diff sweeps in everything the branch
# merged from main (#1568: a renderer-only PR was flagged for main's blockmap /
# build-desktop shell churn; the #1572 Gitar review caught that a BASE_SHA
# merge-base is a NO-OP against the merge-commit HEAD). Anchoring on
# `origin/$GITHUB_BASE_REF` (the live base tip) and taking its merge-base with
# HEAD yields ONLY the PR's own changes — immune to a stale BASE_SHA AND to the
# merge-commit HEAD shape. Fall back to BASE_SHA when the base branch can't be
# resolved (local runs / unit-test fixtures with no remote).
BASE_REF="${GITHUB_BASE_REF:-}"
BASE_TIP="${BASE_SHA}"
if [[ -n "$BASE_REF" ]]; then
  if git rev-parse --verify --quiet "origin/${BASE_REF}" >/dev/null 2>&1; then
    BASE_TIP="origin/${BASE_REF}"
  elif git fetch --no-tags --quiet origin "$BASE_REF" 2>/dev/null; then
    BASE_TIP="FETCH_HEAD"
  fi
fi
MERGE_BASE=$(git merge-base "${BASE_TIP}" "${TARGET_COMMIT}" 2>/dev/null \
  || git merge-base "${BASE_SHA}" "${TARGET_COMMIT}" 2>/dev/null \
  || echo "${BASE_SHA}")

# Classifier inputs are intentionally narrow: two fixed source files at the
# base and target (four blobs total), plus bounded changed-path metadata. The
# advisory bump level also reads CHANGELOG.md at the target (capped, reduced to
# enums) and ipcContract.ts at the released tag; those skip read_fixed_blob so a
# bad file degrades the recommendation instead of failing the run.
read_fixed_blob() {
  local revision="$1" path="$2" entry mode object_type oid size stripped_size
  entry=$(git ls-tree --format='%(objectmode) %(objecttype) %(objectname)' "$revision" -- "$path" 2>/dev/null || true)
  read -r mode object_type oid <<< "$entry"
  if [[ "$object_type" != "blob" || ( "$mode" != "100644" && "$mode" != "100755" ) || ! "$oid" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: classify-release.sh input exceeds the bounded classifier contract" >&2
    exit 1
  fi
  size=$(git cat-file -s "$oid" 2>/dev/null || true)
  if [[ ! "$size" =~ ^[0-9]+$ ]] || (( size > 262144 )); then
    echo "ERROR: classify-release.sh input exceeds the bounded classifier contract" >&2
    exit 1
  fi
  BLOB_FILE=$(mktemp)
  if ! git cat-file blob "$oid" > "$BLOB_FILE" 2>/dev/null; then
    rm -f "$BLOB_FILE"
    echo "ERROR: classify-release.sh input exceeds the bounded classifier contract" >&2
    exit 1
  fi
  stripped_size=$(LC_ALL=C tr -d '\000' < "$BLOB_FILE" | wc -c | tr -d '[:space:]')
  if [[ "$stripped_size" != "$size" ]]; then
    rm -f "$BLOB_FILE"
    echo "ERROR: classify-release.sh input exceeds the bounded classifier contract" >&2
    exit 1
  fi
  BLOB_CONTENT=$(cat "$BLOB_FILE")
  rm -f "$BLOB_FILE"
}

# ── Shell (main process) file detection ───────────────────────────────────────
# Any change to a desktop-shell path (see list below) is a shippable shell change
# that drives the CLIENT VERSION / release axis. (The IPC-contract axis is gated
# separately, below, on the contract file itself — NOT on general shell churn.)
#
# CANONICAL SOURCE: the `desktop-shell:` key of the dorny/paths-filter step in
# the `pr-paths-filter` job of .github/workflows/desktop-pr-smoke.yml. Located by
# those two names, deliberately NOT by line number: this comment cited
# "~lines 138-149" for long enough that the filter had moved to ~181, and #3194
# moved it again by two lines. The PR smoke jobs moved out of build-desktop.yml
# in #3570. Grep for `desktop-shell:` instead.
#
# This SHELL_FILES list is a hand-copy of that filter and MUST stay in sync with
# it, EXCEPT for ONE intentional delta (#827):
#   - desktop-pr-smoke.yml's filter includes 'desktop/package.json';
#     this list OMITS it. package.json is tracked separately below for
#     version-bump detection — including it here would make the
#     version_bump_only category unreachable.
# Both lists DO include '.github/workflows/build-desktop.yml' (the smoke filter
# retains it from the old filter since #829/#889) and
# '.github/workflows/desktop-pr-smoke.yml' (the filter lists itself), so those
# paths are NOT deltas. Any OTHER divergence is drift. The symmetric difference
# is asserted to be EXACTLY the one package.json delta by the drift-guard in
# .github/scripts/tests/classify-release.test.sh — keep both in sync.
DIFF_METADATA_FILE=$(mktemp)
trap 'rm -f "${DIFF_METADATA_FILE:-}" "${OUTPUT_BUFFER:-}"' EXIT
if ! git diff --name-only "${MERGE_BASE}" "${TARGET_COMMIT}" -- \
  'desktop/forge.config.ts' \
  'desktop/build/makerDmg.ts' \
  'desktop/package-lock.json' \
  'desktop/tsconfig.main.json' \
  'desktop/tsconfig.preload.json' \
  'desktop/vite.config.ts' \
  'desktop/src/main/**' \
  'desktop/src/preload/**' \
  'desktop/native/**' \
  'desktop/scripts/build-native.mjs' \
  'desktop/scripts/build-preload.mjs' \
  'desktop/scripts/desktop-engine-probe/**' \
  'desktop/scripts/dialog-top-layer-probe/**' \
  'desktop/scripts/audiocap-host-probe/**' \
  'desktop/scripts/patch-electron-plist.sh' \
  'desktop/scripts/patch-rpm-sandbox-spec.mjs' \
  'desktop/scripts/verify-asar-payload.sh' \
  'desktop/scripts/verify-dmg-artifact.sh' \
  'desktop/scripts/verify-packaged-app.mts' \
  'desktop/scripts/verify-packaged-app.lib.mts' \
  'desktop/scripts/verify-windows-signature.ps1' \
  '.github/scripts/tests/verify-dmg-artifact.test.sh' \
  '.github/workflows/build-desktop.yml' \
  '.github/workflows/desktop-pr-smoke.yml' \
  > "$DIFF_METADATA_FILE" 2>/dev/null; then
  echo "ERROR: classify-release.sh input exceeds the bounded classifier contract" >&2
  exit 1
fi
DIFF_METADATA_BYTES=$(wc -c < "$DIFF_METADATA_FILE" | tr -d '[:space:]')
if (( DIFF_METADATA_BYTES > 131072 )); then
  echo "ERROR: classify-release.sh diff metadata exceeds 128 KiB" >&2
  exit 1
fi
SHELL_FILES=$(cat "$DIFF_METADATA_FILE")

SHELL_CHANGED="false"
if [[ -n "$SHELL_FILES" ]]; then
  SHELL_CHANGED="true"
fi

# ── IPC contract version ──────────────────────────────────────────────────────
# Read the four fixed blobs, checking mode, type, NUL absence and size first.
read_fixed_blob "$MERGE_BASE" "desktop/src/main/ipcContract.ts"
OLD_IPC_CONTRACT_BLOB="$BLOB_CONTENT"
OLD_SPA_CONTRACT_BLOB="$BLOB_CONTENT"
read_fixed_blob "$MERGE_BASE" "desktop/package.json"
OLD_PACKAGE_BLOB="$BLOB_CONTENT"
read_fixed_blob "$TARGET_COMMIT" "desktop/src/main/ipcContract.ts"
NEW_IPC_CONTRACT_BLOB="$BLOB_CONTENT"
NEW_SPA_CONTRACT_BLOB="$BLOB_CONTENT"
read_fixed_blob "$TARGET_COMMIT" "desktop/package.json"
NEW_PACKAGE_BLOB="$BLOB_CONTENT"

# Use sed with POSIX character classes for portability (macOS BSD sed lacks \s).
OLD_CONTRACT=$(printf '%s\n' "$OLD_IPC_CONTRACT_BLOB" \
  | sed -n 's/.*IPC_CONTRACT_VERSION[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
  | first_line || true)
OLD_CONTRACT="${OLD_CONTRACT:-0}"
NEW_CONTRACT=$(printf '%s\n' "$NEW_IPC_CONTRACT_BLOB" \
  | sed -n 's/.*IPC_CONTRACT_VERSION[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
  | first_line || true)
NEW_CONTRACT="${NEW_CONTRACT:-0}"
for contract_value in "$OLD_CONTRACT" "$NEW_CONTRACT"; do
  if [[ ! "$contract_value" =~ ^(0|[1-9][0-9]{0,8})$ ]]; then
    echo "ERROR: classify-release.sh contract integer is not canonical or exceeds 9 digits" >&2
    exit 1
  fi
done

# IPC-contract axis: a bump is "needed" only when the IPC contract SURFACE
# itself changed without a version bump — i.e. ipcContract.ts changed in the
# PR's own changeset (the "bumped" branch below already handles the version
# constant moving). Gating on the contract FILE, NOT SHELL_CHANGED, stops every
# unrelated shell edit (tray, window chrome, vite/tsconfig, lockfile) from
# demanding a phantom IPC bump (#1568). The version constant is a shell↔renderer
# compatibility gate, not a general shell-change marker.
#
# CONTENT, not just filename. The file now also declares SPA_MIN_CONTRACT and
# carries ~230 lines of per-version doc comments, so "the file changed" stopped
# meaning "the IPC surface changed" the moment the second constant landed —
# this PR tripped its own classifier into demanding a phantom bump to 26 for
# adding a constant that is not IPC surface at all. Strip comment lines, blank
# lines and SPA_MIN_CONTRACT from the diff; whatever survives is real surface.
IPC_CONTRACT_FILE_CHANGED=$(git diff -U0 "${MERGE_BASE}" "${TARGET_COMMIT}" -- \
    desktop/src/main/ipcContract.ts 2>/dev/null \
  | grep -E '^[+-]' \
  | grep -vE '^(\+\+\+|---)' \
  | grep -vE '^[+-][[:space:]]*(\*|//|/\*)' \
  | grep -vE 'SPA_MIN_CONTRACT' \
  | grep -vE '^[+-][[:space:]]*$' || true)
if [[ "$OLD_CONTRACT" != "$NEW_CONTRACT" ]]; then
  CONTRACT_ACTION="bumped"
elif [[ -n "$IPC_CONTRACT_FILE_CHANGED" ]]; then
  CONTRACT_ACTION="needed"
else
  CONTRACT_ACTION="none"
fi

# ── SPA minimum contract (the DEMAND) ────────────────────────────────────────
# IPC_CONTRACT_VERSION is what this shell IMPLEMENTS; SPA_MIN_CONTRACT is the
# oldest shell the renderer RUNS ON, and it is the number deploy-spa.sh
# publishes. Raising the capability costs nothing — no client is affected.
# Raising the demand takes every shell below it onto its bundled renderer, so
# it is the movement that obliges a client release.
OLD_SPA_MIN=$(printf '%s\n' "$OLD_SPA_CONTRACT_BLOB" \
  | sed -n 's/.*SPA_MIN_CONTRACT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
  | first_line || true)
# ABSENT at the base is not "zero" — before the constant existed, deploy-spa.sh
# published IPC_CONTRACT_VERSION, so the effective demand back there WAS the
# capability. Defaulting to 0 would read the commit that introduces the split as
# a raise from nothing and demand a release for what is actually a large
# LOWERING (25 -> 19). Caught by this gate firing on its own introducing PR.
# After that commit the constant always exists and this fallback never fires.
OLD_SPA_MIN_DECLARED="true"
if [[ -z "$OLD_SPA_MIN" ]]; then
  OLD_SPA_MIN_DECLARED="false"
fi
OLD_SPA_MIN="${OLD_SPA_MIN:-$OLD_CONTRACT}"
NEW_SPA_MIN=$(printf '%s\n' "$NEW_SPA_CONTRACT_BLOB" \
  | sed -n 's/.*SPA_MIN_CONTRACT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
  | first_line || true)
# Track absence separately from value. Removing the declaration is not a
# lowering to 0 — deploy-spa.sh cannot parse a minimum that is not there and
# exits 2, so a PR that deletes it breaks every SPA deploy AFTER merge, which
# is the failure class this whole split exists to stop. Caught here instead.
# "Removed" requires that it was THERE to remove. Absent on BOTH sides is a
# branch cut before the constant existed, not a deletion — failing those would
# red-gate every in-flight PR the moment this lands, which is a self-inflicted
# outage of exactly the shape this change is about. Such a branch keeps its own
# (pre-split) copy of this workflow anyway, so the case is defensive.
SPA_MIN_PRESENT="true"
if [[ -z "$NEW_SPA_MIN" && "$OLD_SPA_MIN_DECLARED" == "true" ]]; then
  SPA_MIN_PRESENT="false"
fi
NEW_SPA_MIN="${NEW_SPA_MIN:-0}"
for contract_value in "$OLD_SPA_MIN" "$NEW_SPA_MIN"; do
  if [[ ! "$contract_value" =~ ^(0|[1-9][0-9]{0,8})$ ]]; then
    echo "ERROR: classify-release.sh contract integer is not canonical or exceeds 9 digits" >&2
    exit 1
  fi
done

# LOWERING is always safe — it admits more shells, never fewer — so it is
# reported but never demanded of.
if [[ "$SPA_MIN_PRESENT" == "false" ]]; then
  SPA_MIN_ACTION="removed"
elif (( NEW_SPA_MIN > OLD_SPA_MIN )); then
  SPA_MIN_ACTION="raised"
elif (( NEW_SPA_MIN < OLD_SPA_MIN )); then
  SPA_MIN_ACTION="lowered"
else
  SPA_MIN_ACTION="none"
fi

# ── Package version ───────────────────────────────────────────────────────────
# Use sed with POSIX character classes for portability (macOS BSD sed lacks \s).
OLD_VERSION=$(printf '%s\n' "$OLD_PACKAGE_BLOB" \
  | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | first_line || true)
OLD_VERSION="${OLD_VERSION:-0.0.0}"
NEW_VERSION=$(printf '%s\n' "$NEW_PACKAGE_BLOB" \
  | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | first_line || true)
NEW_VERSION="${NEW_VERSION:-0.0.0}"
for version in "$OLD_VERSION" "$NEW_VERSION"; do
  version_bytes=$(printf '%s' "$version" | wc -c | tr -d '[:space:]')
  if (( version_bytes > 128 )); then
    echo "ERROR: classify-release.sh semantic version exceeds 128 bytes" >&2
    exit 1
  fi
  if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
    echo "ERROR: classify-release.sh semantic version is invalid" >&2
    exit 1
  fi
done

if [[ "$OLD_VERSION" != "$NEW_VERSION" ]]; then
  VERSION_ACTION="bumped"
elif [[ "$SHELL_CHANGED" == "true" ]]; then
  VERSION_ACTION="notes-needed"
else
  VERSION_ACTION="none"
fi

# ── Lockstep: a raised SPA minimum must ship with a client that satisfies it ──
# deploy-spa.sh publishes SPA_MIN_CONTRACT as SPA_IPC_CONTRACT, and spaLoader.ts
# drops any shell below it to its bundled renderer with a bare `<`. Raising it is
# therefore the act of saying "shells older than this cannot run this renderer" —
# and a shell only reaches users inside a build, which is armed by the VERSION
# bump (package.json vs the desktop-v<version> tag). Nothing treats either
# contract number as a release trigger.
#
# So a raised minimum travelling alone strands every client below it until some
# later release happens to ship, and `risk: hotfix` on the PR is inert because
# main-ci has no untagged version to cut.
#
# This is the ONE condition the classifier asserts rather than advises, and it
# keys on the DEMAND, never the capability. Gating on IPC_CONTRACT_VERSION would
# force a release for shell capability that no renderer requires — which is the
# #2967 shape inverted, and would make the classifier demand exactly the
# unnecessary releases the capability/demand split exists to avoid.
if [[ "$SPA_MIN_ACTION" == "raised" && "$VERSION_ACTION" != "bumped" ]]; then
  VERSION_BUMP_REQUIRED="true"
else
  VERSION_BUMP_REQUIRED="false"
fi

# ── Recommended bump level (docs/policies/release-versioning.md § Bump-level criteria) ──
# The classifier RECOMMENDS; the human decides when to cut. #3006 dropped the
# version recommendation and #3354 never restored it, so for two months nothing
# said "this is worth a release, and at what level". The level is diagnosed from
# what the next release would carry, not from this PR alone:
#   - the pending CHANGELOG section at the target (`## [Prerelease]`, or the
#     dated `## [<new version>] - <date>` section when this PR promotes it), and
#   - IPC_CONTRACT_VERSION against the last released tag.
# First match wins:
#   major  — an entry marked **BREAKING**
#   minor  — an Added, Deprecated or Removed entry, or the shell's IPC contract
#            is ahead of the last release (policy: an IPC contract bump is minor)
#   patch  — any other entry (Changed, Fixed, Security), or a shell change with
#            no notes yet
#   none   — nothing pending
# The CHANGELOG is read as data only: it reduces to two enums, and a missing or
# oversized file degrades to the IPC/shell signals instead of failing the run.
CHANGELOG_BLOB=""
changelog_entry=$(git ls-tree --format='%(objecttype) %(objectname)' "$TARGET_COMMIT" -- CHANGELOG.md 2>/dev/null || true)
read -r changelog_type changelog_oid <<< "$changelog_entry"
if [[ "${changelog_type:-}" == "blob" && "${changelog_oid:-}" =~ ^[0-9a-f]{40}$ ]]; then
  changelog_size=$(git cat-file -s "$changelog_oid" 2>/dev/null || echo 0)
  # ponytail: 1 MiB ceiling; the file is ~160 KB. Above it the notes signal is skipped, not trusted.
  if [[ "$changelog_size" =~ ^[0-9]+$ ]] && (( changelog_size <= 1048576 )); then
    CHANGELOG_BLOB="$changelog_oid"
  fi
fi
# Prints one version section with CR, trailing blanks and fenced blocks
# removed, so a code sample can neither end the section nor add entries.
read_changelog_section() {
  [[ -n "$CHANGELOG_BLOB" ]] || return 0
  git cat-file blob "$CHANGELOG_BLOB" 2>/dev/null | LC_ALL=C tr -d '\000\r' \
    | awk -v h="$1" '
        { sub(/[ \t]+$/, "") }
        /^[ \t]*```/ { fence = !fence; next }
        fence { next }
        /^## \[/ { if (f) exit; f = ($0 == "## [" h "]" || index($0, "## [" h "] - ") == 1 || (h == "Prerelease" && $0 == "## [Unreleased]")); next }
        f' || true
}
CHANGELOG_SECTION=""
if [[ "$VERSION_ACTION" == "bumped" ]]; then
  CHANGELOG_SECTION=$(read_changelog_section "$NEW_VERSION")
fi
# A bump without its promoted section (verify-changelog Rule 1 fails that PR
# too) still reads what is pending, so the recommendation is not understated.
if [[ -z "$CHANGELOG_SECTION" ]]; then
  CHANGELOG_SECTION=$(read_changelog_section Prerelease)
fi
count_category_entries() {
  printf '%s\n' "$CHANGELOG_SECTION" | awk -v c="$1" '
    /^### / { f = ($0 == "### " c); next }
    f && /^[-*+] / { n++ }
    END { print n + 0 }'
}
BREAKING_ENTRIES=$(printf '%s\n' "$CHANGELOG_SECTION" | grep -cE '^[-*+] .*\*\*BREAKING\*\*' || true)
MINOR_ENTRIES=$(( $(count_category_entries Added) + $(count_category_entries Deprecated) + $(count_category_entries Removed) ))
ANY_ENTRIES=$(printf '%s\n' "$CHANGELOG_SECTION" | grep -cE '^[-*+] ' || true)

# IPC baseline: the last released tag, so a contract bump merged three PRs ago
# still counts toward the release this PR would cut. An untagged base version
# (bump merged, nightly not yet run) falls back to the merge-base.
RELEASED_CONTRACT="$OLD_CONTRACT"
if git rev-parse --verify --quiet "refs/tags/desktop-v${OLD_VERSION}^{commit}" >/dev/null 2>&1; then
  RELEASED_CONTRACT=$(git show "refs/tags/desktop-v${OLD_VERSION}:desktop/src/main/ipcContract.ts" 2>/dev/null \
    | sed -n 's/.*IPC_CONTRACT_VERSION[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    | first_line || true)
  [[ "$RELEASED_CONTRACT" =~ ^(0|[1-9][0-9]{0,8})$ ]] || RELEASED_CONTRACT="$OLD_CONTRACT"
fi

if (( BREAKING_ENTRIES > 0 )); then
  BUMP_LEVEL="major"; BUMP_BASIS="breaking"
elif (( MINOR_ENTRIES > 0 )); then
  BUMP_LEVEL="minor"; BUMP_BASIS="added"
elif (( NEW_CONTRACT > RELEASED_CONTRACT )); then
  BUMP_LEVEL="minor"; BUMP_BASIS="ipc"
elif (( ANY_ENTRIES > 0 )); then
  BUMP_LEVEL="patch"; BUMP_BASIS="notes"
elif [[ "$SHELL_CHANGED" == "true" ]]; then
  BUMP_LEVEL="patch"; BUMP_BASIS="shell"
else
  BUMP_LEVEL="none"; BUMP_BASIS="none"
fi

# ── Emit outputs ─────────────────────────────────────────────────────────────
OUTPUT_BUFFER=$(mktemp)
emit "shell_changed"     "${SHELL_CHANGED}"
emit "old_contract"      "${OLD_CONTRACT}"
emit "new_contract"      "${NEW_CONTRACT}"
emit "contract_action"   "${CONTRACT_ACTION}"
emit "old_version"       "${OLD_VERSION}"
emit "new_version"       "${NEW_VERSION}"
emit "version_action"    "${VERSION_ACTION}"
emit "old_spa_min"       "${OLD_SPA_MIN}"
emit "new_spa_min"       "${NEW_SPA_MIN}"
emit "spa_min_action"    "${SPA_MIN_ACTION}"
emit "spa_min_present"   "${SPA_MIN_PRESENT}"
emit "version_bump_required" "${VERSION_BUMP_REQUIRED}"
emit "bump_level"        "${BUMP_LEVEL}"
emit "bump_basis"        "${BUMP_BASIS}"
OUTPUT_BYTES=$(wc -c < "$OUTPUT_BUFFER" | tr -d '[:space:]')
OUTPUT_LINES=$(wc -l < "$OUTPUT_BUFFER" | tr -d '[:space:]')
if (( OUTPUT_BYTES > 8192 )); then
  echo "ERROR: classify-release.sh output exceeds 8 KiB" >&2
  exit 1
fi
if [[ "$OUTPUT_LINES" != "14" ]]; then
  echo "ERROR: classify-release.sh input exceeds the bounded classifier contract" >&2
  exit 1
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  cat "$OUTPUT_BUFFER" >> "$GITHUB_OUTPUT"
else
  cat "$OUTPUT_BUFFER"
fi
