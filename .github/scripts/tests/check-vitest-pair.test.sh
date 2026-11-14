#!/usr/bin/env bash
# Hermetic suite for check-vitest-pair.sh (#215). The split fixture MUST fail
# and name the root, both versions, the half that is behind and the fix.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/../check-vitest-pair.sh"
FIX="$HERE/fixtures/vitest-pair"
fail=0

expect() { # <want-exit> <name> <root> [<substring>...]
  local want="$1" name="$2" root="$3" out rc=0
  shift 3
  out="$(bash "$CHECK" "$root" 2>&1)" || rc=$?
  if [ "$rc" -ne "$want" ]; then
    echo "FAIL $name: exit $rc, want $want"; echo "$out"; fail=1; return
  fi
  for s in "$@"; do
    if [[ "$out" != *"$s"* ]]; then
      echo "FAIL $name: output lacks '$s'"; echo "$out"; fail=1; return
    fi
  done
  echo "ok   $name"
}

expect 1 "split pair fails" "$FIX/split" \
  "$FIX/split" "vitest 5.0.5" "@vitest/coverage-istanbul 5.1.0" \
  "vitest is behind" "npm install --save-dev vitest@5.1.0 @vitest/coverage-istanbul@5.1.0"
expect 0 "matched pair passes" "$FIX/matched"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/no-plugin" "$tmp/no-vitest" "$tmp/plugin-behind" "$tmp/missing" \
  "$tmp/prerelease" "$tmp/no-packages" "$tmp/injection"
jq 'del(.packages["node_modules/@vitest/coverage-istanbul"])' \
  "$FIX/matched/package-lock.json" > "$tmp/no-plugin/package-lock.json"
jq 'del(.packages["node_modules/vitest"])' \
  "$FIX/matched/package-lock.json" > "$tmp/no-vitest/package-lock.json"
jq '.packages["node_modules/vitest"].version = "5.2.0"' \
  "$FIX/matched/package-lock.json" > "$tmp/plugin-behind/package-lock.json"
expect 1 "plugin behind names the plugin" "$tmp/plugin-behind" \
  "@vitest/coverage-istanbul is behind" "vitest@5.2.0 @vitest/coverage-istanbul@5.2.0"
jq '.packages["node_modules/vitest"].version = "5.1.0-beta.1"' \
  "$FIX/matched/package-lock.json" > "$tmp/prerelease/package-lock.json"
expect 1 "pre-release vitest is behind its release" "$tmp/prerelease" \
  "vitest is behind" "vitest@5.1.0 @vitest/coverage-istanbul@5.1.0"
jq -n '{lockfileVersion: 1, dependencies: {}}' > "$tmp/no-packages/package-lock.json"
expect 1 "lockfile without packages fails" "$tmp/no-packages" "no packages map"
jq '.packages["node_modules/vitest"].version = "5.0.0\n::notice::x"' \
  "$FIX/matched/package-lock.json" > "$tmp/injection/package-lock.json"
out="$(bash "$CHECK" "$tmp/injection" 2>&1 || true)"
if grep -q '^::notice::' <<<"$out" || [[ "$out" != *"not plain semver"* ]]; then
  echo "FAIL newline in a version cannot start a workflow command"; echo "$out"; fail=1
else
  echo "ok   newline in a version cannot start a workflow command"
fi
expect 0 "root without the plugin passes" "$tmp/no-plugin"
expect 1 "plugin without vitest fails" "$tmp/no-vitest" "vitest missing"
expect 1 "missing lockfile fails" "$tmp/missing" "not found"

exit "$fail"
