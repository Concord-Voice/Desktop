#!/usr/bin/env bash
#
# check-lockfile-registries.sh — fail when a lockfile resolves a package
# outside the approved registries (#216).
#
# npm installs whatever host a lockfile `resolved` URL names, so a changed URL
# can point an install at a registry we do not control. This check reads every
# `resolved` value, at any depth (so lockfile v1 nested `dependencies` count
# too), and fails unless it is:
#   - https://<host>/… with <host> listed in .github/approved-registries.txt
#     (exact match: a port, credentials or a lookalike suffix all fail), or
#   - a local path (`file:…`, or a `link: true` entry with no scheme). These
#     are the in-repo compat packages; npm copies them, it fetches nothing.
# In a go.mod or go.work, every `replace` directive fails: it points a module
# at a source other than the module proxy's copy of it.
#
# Usage: check-lockfile-registries.sh [file...]
#   With no arguments it checks every tracked package-lock.json, go.mod and
#   go.work, except the script-test fixtures.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${APPROVED_REGISTRIES:-$HERE/../approved-registries.txt}"

if [ "$#" -eq 0 ]; then
  cd "$HERE/../.."
  mapfile -t files < <(git ls-files -- '*package-lock.json' '*go.mod' '*go.work' \
    ':!:.github/scripts/tests/fixtures/**')
  set -- "${files[@]}"
fi

approved="$(grep -vE '^[[:space:]]*(#|$)' "$CONFIG" | jq -Rnc '[inputs | gsub("\\s"; "")]')"
[ "$approved" != "[]" ] || { echo "::error file=$CONFIG::no approved hosts in $CONFIG"; exit 2; }

status=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "::error file=$f::$f not found"; status=1; continue
  fi
  case "$f" in
    *package-lock.json)
      if ! bad="$(jq -r --argjson ok "$approved" '
          paths(type == "object" and (.resolved | type) == "string") as $p
          | getpath($p) as $e
          | $e.resolved as $u
          | select(($u | startswith("file:")) or ($e.link == true and ($u | test(":") | not)) | not)
          | (($u | capture("^https://(?<h>[^/?#@]+)/") | .h) // null) as $h
          | select($h == null or ($ok | index($h)) == null)
          | [($p[-1] | tostring), ($h // "not an https URL"), $u] | @tsv' "$f")"; then
        echo "::error file=$f::$f is not readable JSON"; status=1; continue
      fi
      while IFS=$'\t' read -r pkg host url; do
        [ -n "$pkg" ] || continue
        echo "::error file=$f,title=off-registry package::$f: $pkg resolves to $host ($url). Approved hosts: $(jq -r 'join(", ")' <<<"$approved") — see .github/approved-registries.txt."
        status=1
      done <<<"$bad"
      ;;
    *go.mod|*go.work)
      while IFS=: read -r line text; do
        [ -n "$line" ] || continue
        echo "::error file=$f,line=$line,title=go replace directive::$f:$line: replace directive ($text) points a module at a source other than the module proxy. Remove it, or depend on the published module."
        status=1
      done < <(awk '
        { sub(/\/\/.*/, ""); gsub(/^[ \t]+|[ \t]+$/, "") }
        $0 == "" { next }
        blk && $0 == ")" { blk = 0; next }
        blk { print FNR ":" $0; next }
        /^replace[ \t]*\($/ { blk = 1; next }
        /^replace[ \t]/ { sub(/^replace[ \t]+/, ""); print FNR ":" $0 }
      ' "$f")
      ;;
    *)
      echo "::error file=$f::$f is not a package-lock.json, go.mod or go.work"; status=1
      ;;
  esac
done

exit "$status"
