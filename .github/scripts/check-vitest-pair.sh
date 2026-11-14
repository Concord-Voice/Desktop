#!/usr/bin/env bash
#
# check-vitest-pair.sh — fail when `vitest` and `@vitest/coverage-istanbul`
# resolve to different versions in an npm root (#215).
#
# The coverage plugin pins `vitest` as an EXACT peer, so a split pair cannot
# install. Dependabot groups the pair for version and security updates, but a
# security advisory on one half still moves only that half. This check makes
# such a PR fail with the reason and the fix.
#
# It only reports. CI never pushes to a Dependabot branch; a person pushes the
# fix, or closes the PR and lets a grouped update move both halves.
#
# Usage: check-vitest-pair.sh <root>...   (each root holds a package-lock.json)
set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <root>..." >&2; exit 2; }

status=0
for root in "$@"; do
  lock="$root/package-lock.json"
  if [ ! -f "$lock" ]; then
    echo "::error file=$lock::$lock not found"
    status=1; continue
  fi
  if ! pair="$(jq -er '[.packages["node_modules/vitest"].version // "",
                        .packages["node_modules/@vitest/coverage-istanbul"].version // ""]
                       | join(" ")' "$lock")"; then
    echo "::error file=$lock::$lock is not a readable npm v2/v3 lockfile"
    status=1; continue
  fi
  # Split on the one space by hand: `read` would drop an empty first field.
  v="${pair%% *}"; c="${pair#* }"

  if [ -z "$c" ]; then
    echo "ok   $root: no @vitest/coverage-istanbul, nothing to pair"
    continue
  fi
  if [ -z "$v" ]; then
    echo "::error file=$lock,title=vitest pair split::$root: vitest missing, @vitest/coverage-istanbul $c. The plugin needs vitest $c. Fix: in $root, run npm install --save-dev vitest@$c and push to this branch."
    status=1; continue
  fi
  if [ "$v" = "$c" ]; then
    echo "ok   $root: vitest $v, @vitest/coverage-istanbul $c"
    continue
  fi

  low="$(printf '%s\n%s\n' "$v" "$c" | sort -V | head -n1)"
  if [ "$low" = "$v" ]; then behind=vitest; ahead="$c"; else behind=@vitest/coverage-istanbul; ahead="$v"; fi
  echo "::error file=$lock,title=vitest pair split::$root: vitest $v, @vitest/coverage-istanbul $c — $behind is behind. The plugin pins vitest as an exact peer, so this lockfile cannot install. Fix: in $root, run npm install --save-dev vitest@$ahead @vitest/coverage-istanbul@$ahead and push to this branch, or close this PR and let a grouped update move both. CI does not push this fix."
  status=1
done

exit "$status"
