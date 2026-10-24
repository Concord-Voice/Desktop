#!/usr/bin/env bash
# Regression coverage for the macOS DMG layout checker (#2727).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "FAIL: DMG verification requires macOS hdiutil" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "usage: ${ELECTRON_BUILDER_CACHE:+ELECTRON_BUILDER_CACHE=/path/to/cache }$0 <dmg> [<dmg> ...]" >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKER="$SCRIPT_DIR/../../../desktop/scripts/verify-dmg-artifact.sh"
CACHE_DIR=${ELECTRON_BUILDER_CACHE:-"$HOME/Library/Caches/electron-builder"}

if [[ ! -f "$CHECKER" ]]; then
  echo "FAIL: DMG checker is missing: $CHECKER" >&2
  exit 1
fi
if [[ ! -d "$CACHE_DIR" ]]; then
  echo "FAIL: pinned dmg-builder cache is unavailable: $CACHE_DIR" >&2
  exit 1
fi
for dmg in "$@"; do
  if [[ ! -f "$dmg" ]]; then
    echo "FAIL: DMG artifact is unavailable: $dmg" >&2
    exit 1
  fi
done

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/concord-dmg-test.XXXXXX")
export TMPDIR="$TEST_TMP"
MUTATED_DEVICE=""
MUTATED_ATTACHED=0
SOURCE_DEVICE=""
SOURCE_ATTACHED=0
cleanup() {
  local leaked
  if [[ "$SOURCE_ATTACHED" -eq 1 ]]; then
    if [[ -z "$SOURCE_DEVICE" ]] || ! hdiutil detach -force "$SOURCE_DEVICE" >/dev/null 2>&1; then
      echo "ERROR: preserving test directory because the source DMG could not be detached: $TEST_TMP" >&2
      return 1
    fi
    SOURCE_ATTACHED=0
  fi
  if [[ "$MUTATED_ATTACHED" -eq 1 ]]; then
    if [[ -z "$MUTATED_DEVICE" ]] || ! hdiutil detach -force "$MUTATED_DEVICE" >/dev/null 2>&1; then
      echo "ERROR: preserving test directory because the mutated DMG could not be detached: $TEST_TMP" >&2
      return 1
    fi
    MUTATED_ATTACHED=0
  fi
  leaked=$(find "$TEST_TMP" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)
  if [[ -n "$leaked" ]]; then
    echo "ERROR: preserving test directory because a DMG mount leaked: $TEST_TMP" >&2
    echo "$leaked" >&2
    return 1
  fi
  rm -rf "$TEST_TMP"
}
trap cleanup EXIT

run_positive() {
  local label="$1" dmg="$2"
  local before after
  before=$(find "$TMPDIR" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)
  if ELECTRON_BUILDER_CACHE="$CACHE_DIR" bash "$CHECKER" "$dmg" >/dev/null; then
    after=$(find "$TMPDIR" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)
    if [[ "$after" != "$before" ]]; then
      echo "FAIL: $label left a temporary mount directory" >&2
      exit 1
    fi
    echo "PASS: $label"
  else
    echo "FAIL: $label" >&2
    exit 1
  fi
}

for dmg in "$@"; do
  run_positive "$(basename "$dmg")" "$dmg"
done

before_mounts=$(find "$TMPDIR" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)

# Start from the real generated artifact, make a writable copy, and change only
# the Finder background alias to another benign volume asset. This exercises the
# metadata rejection path without introducing a hand-built or hostile image.
mutated_base="$TEST_TMP/icvp-mutated"
source_mount="$TEST_TMP/source-mount"
mkdir -p "$source_mount"
SOURCE_ATTACHED=1
source_plist=$(hdiutil attach -readonly -nobrowse -plist -mountpoint "$source_mount" "$1")
SOURCE_DEVICE=$(plutil -extract system-entities.0.dev-entry raw -o - - <<<"$source_plist")
cp "$source_mount/.DS_Store" "$TEST_TMP/source.DS_Store"
cp "$source_mount/.background.tiff" "$TEST_TMP/source.background.tiff"
cp "$source_mount/.VolumeIcon.icns" "$TEST_TMP/source.VolumeIcon.icns"
hdiutil detach -force "$SOURCE_DEVICE" >/dev/null
SOURCE_DEVICE=""
SOURCE_ATTACHED=0
hdiutil create -quiet -size 20m -fs HFS+ -volname "Concord Test" -ov "$mutated_base.dmg" >/dev/null
mutated_dmg="$mutated_base.dmg"
mutated_mount="$TEST_TMP/icvp-mount"
mkdir -p "$mutated_mount"
MUTATED_ATTACHED=1
mutated_plist=$(hdiutil attach -readwrite -nobrowse -plist -mountpoint "$mutated_mount" "$mutated_dmg")
MUTATED_DEVICE=$(plutil -extract system-entities.0.dev-entry raw -o - - <<<"$mutated_plist")
mkdir -p "$mutated_mount/Concord Voice.app"
ln -s /Applications "$mutated_mount/Applications"
cp "$TEST_TMP/source.DS_Store" "$mutated_mount/.DS_Store"
cp "$TEST_TMP/source.background.tiff" "$mutated_mount/.background.tiff"
cp "$TEST_TMP/source.VolumeIcon.icns" "$mutated_mount/.VolumeIcon.icns"
case "$(uname -m)" in
  arm64) bundle_arch=arm64 ;;
  x86_64) bundle_arch=x86_64 ;;
  *) echo "FAIL: unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac
DMG_BUILDER_PYTHON=$(find "$CACHE_DIR/dmg-builder@1.2.5" -maxdepth 1 -type d -name "dmgbuild-bundle-${bundle_arch}-*" -print | sort | head -1)
DMG_BUILDER_PYTHON=$(find "$DMG_BUILDER_PYTHON/python/bin" -type f -name 'python3.[0-9]*' -perm -111 -print | sort | head -1)
if [[ -z "$DMG_BUILDER_PYTHON" ]]; then
  echo "FAIL: pinned dmg-builder Python was not found" >&2
  exit 1
fi
"$DMG_BUILDER_PYTHON" - "$mutated_mount/.DS_Store" "$mutated_mount/.VolumeIcon.icns" <<'PY'
import sys

from ds_store import DSStore
from mac_alias import Alias

store_path, replacement = sys.argv[1:]
with DSStore.open(store_path, "r+") as store:
    root = store["."]
    icvp = root["icvp"]
    icvp["backgroundImageAlias"] = Alias.for_file(replacement).to_bytes()
    root["icvp"] = icvp
PY
hdiutil detach -force "$MUTATED_DEVICE" >/dev/null
MUTATED_DEVICE=""
MUTATED_ATTACHED=0
mutated_output="$TEST_TMP/icvp-output.txt"
set +e
ELECTRON_BUILDER_CACHE="$CACHE_DIR" bash "$CHECKER" "$mutated_dmg" >"$mutated_output" 2>&1
mutated_rc=$?
set -e
if [[ "$mutated_rc" -eq 0 ]]; then
  echo "FAIL: DMG with an incorrect background alias was accepted" >&2
  exit 1
fi
if ! grep -qF 'background alias filename' "$mutated_output"; then
  echo "FAIL: incorrect-background-alias fixture did not reach the expected checker failure" >&2
  cat "$mutated_output" >&2
  exit 1
fi
after_mounts=$(find "$TMPDIR" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)
if [[ "$after_mounts" != "$before_mounts" ]]; then
  echo "FAIL: incorrect-background-alias failure left a temporary mount directory" >&2
  exit 1
fi
echo "PASS: incorrect background alias rejected and mount cleanup completed"

# Keep the basename valid while redirecting the alias into another directory,
# so only the root-path guard can reject this image.
MUTATED_ATTACHED=1
mutated_plist=$(hdiutil attach -readwrite -nobrowse -plist -mountpoint "$mutated_mount" "$mutated_dmg")
MUTATED_DEVICE=$(plutil -extract system-entities.0.dev-entry raw -o - - <<<"$mutated_plist")
mkdir -p "$mutated_mount/elsewhere"
cp "$TEST_TMP/source.background.tiff" "$mutated_mount/elsewhere/.background.tiff"
"$DMG_BUILDER_PYTHON" - "$mutated_mount/.DS_Store" "$mutated_mount/elsewhere/.background.tiff" <<'PY'
import sys

from ds_store import DSStore
from mac_alias import Alias

store_path, replacement = sys.argv[1:]
with DSStore.open(store_path, "r+") as store:
    root = store["."]
    icvp = root["icvp"]
    icvp["backgroundImageAlias"] = Alias.for_file(replacement).to_bytes()
    root["icvp"] = icvp
PY
hdiutil detach -force "$MUTATED_DEVICE" >/dev/null
MUTATED_DEVICE=""
MUTATED_ATTACHED=0
path_output="$TEST_TMP/icvp-path-output.txt"
set +e
ELECTRON_BUILDER_CACHE="$CACHE_DIR" bash "$CHECKER" "$mutated_dmg" >"$path_output" 2>&1
path_rc=$?
set -e
if [[ "$path_rc" -eq 0 ]] || ! grep -qF 'background alias path' "$path_output"; then
  echo "FAIL: wrong-directory background alias did not reach the path guard" >&2
  cat "$path_output" >&2
  exit 1
fi
after_mounts=$(find "$TMPDIR" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)
if [[ "$after_mounts" != "$before_mounts" ]]; then
  echo "FAIL: wrong-directory background alias left a temporary mount directory" >&2
  exit 1
fi
echo "PASS: wrong-directory background alias rejected and mount cleanup completed"

# A valid DMG without the expected app exercises the post-attach failure path.
fixture_dir="$TEST_TMP/empty-volume"
mkdir -p "$fixture_dir"
printf 'benign fixture\n' > "$fixture_dir/README.txt"
missing_app_dmg="$TEST_TMP/missing-app.dmg"
hdiutil create -quiet -srcfolder "$fixture_dir" -format UDZO -ov "$missing_app_dmg" >/dev/null
missing_app_output="$TEST_TMP/missing-app-output.txt"
set +e
ELECTRON_BUILDER_CACHE="$CACHE_DIR" bash "$CHECKER" "$missing_app_dmg" >"$missing_app_output" 2>&1
missing_app_rc=$?
set -e
if [[ "$missing_app_rc" -eq 0 ]]; then
  echo "FAIL: DMG missing Concord Voice.app was accepted" >&2
  exit 1
fi
if ! grep -qF 'missing Concord Voice.app' "$missing_app_output"; then
  echo "FAIL: missing-app fixture did not reach the expected checker failure" >&2
  cat "$missing_app_output" >&2
  exit 1
fi
after_mounts=$(find "$TMPDIR" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)
if [[ "$after_mounts" != "$before_mounts" ]]; then
  echo "FAIL: post-attach DMG failure left a temporary mount directory" >&2
  diff -u <(printf '%s\n' "$before_mounts") <(printf '%s\n' "$after_mounts") >&2 || true
  exit 1
fi
echo "PASS: valid DMG missing app rejected and mount cleanup completed"

# A regular, non-DMG file is a benign malformed-artifact attach-failure control.
invalid_dmg="$TEST_TMP/not-a-dmg"
printf 'not a disk image\n' > "$invalid_dmg"
before_mounts=$(find "$TMPDIR" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)
if ELECTRON_BUILDER_CACHE="$CACHE_DIR" bash "$CHECKER" "$invalid_dmg" >/dev/null 2>&1; then
  echo "FAIL: malformed DMG was accepted" >&2
  exit 1
fi
after_mounts=$(find "$TMPDIR" -maxdepth 1 -type d -name 'concord-dmg-mount.*' -print | sort)
if [[ "$after_mounts" != "$before_mounts" ]]; then
  echo "FAIL: malformed DMG left a temporary mount directory" >&2
  exit 1
fi
echo "PASS: malformed DMG rejected and mount cleanup completed"
