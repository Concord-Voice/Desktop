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
# A v2/v3 `packages` entry with no `resolved` at all fails too (unless it is
# the root, a link, or bundled), since npm would resolve it from config.
#
# npm-shrinkwrap.json gets the same checks. A tracked .npmrc may not set any
# registry: npm rewrites lockfile npmjs URLs to the configured registry, so a
# .npmrc alone can move every fetch. A tracked yarn.lock or pnpm-lock.yaml
# fails as unsupported.
# In a go.mod or go.work, every `replace` directive fails: it points a module
# at a source other than the module proxy's copy of it.
#
# Usage: check-lockfile-registries.sh [file...]
#   With no arguments it checks every tracked file of those kinds, except the
#   script-test fixtures.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${APPROVED_REGISTRIES:-$HERE/../approved-registries.txt}"

if [ "$#" -eq 0 ]; then
  cd "$HERE/../.."
  list="$(git ls-files -- '*package-lock.json' '*npm-shrinkwrap.json' \
    '*.npmrc' '*yarn.lock' '*pnpm-lock.yaml' '*go.mod' '*go.work' \
    ':!:.github/scripts/tests/fixtures/**')"
  # Fail closed: an empty list means git or the pathspec broke, not "clean".
  [ -n "$list" ] || { echo "::error::no lockfiles found to check"; exit 2; }
  mapfile -t files <<<"$list"
  set -- "${files[@]}"
fi

approved="$(grep -vE '^[[:space:]]*(#|$)' "$CONFIG" | jq -Rnc '[inputs | gsub("\\s"; "")]')"
[ "$approved" != "[]" ] || { echo "::error file=$CONFIG::no approved hosts in $CONFIG"; exit 2; }

approved_list="$(jq -r 'join(", ")' <<<"$approved")"


status=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "::error file=$f::$f not found"; status=1; continue
  fi
  case "$f" in
    *package-lock.json|*npm-shrinkwrap.json)
      if ! bad="$(jq -r --argjson ok "$approved" '
          # Local: file:<relative path>, or a link entry with a relative path.
          # file:// and absolute or backslash paths can reach a network share.
          def local($e): ($e.resolved | test("^file:[^/\\\\]"))
            or ($e.link == true and ($e.resolved | test("^[^/\\\\][^:]*$")));
          ( paths(type == "object" and (.resolved | type) == "string") as $p
            | getpath($p) as $e
            | select(local($e) | not)
            | (($e.resolved | capture("^https://(?<h>[^/?#@]+)/") | .h) // null) as $h
            | select($h == null or ($ok | index($h)) == null)
            | [($p[-1] | tostring),
               (if $h == null then "is not an https URL" else "resolves to unapproved host \($h)" end),
               $e.resolved] ),
          # v1 git and URL dependencies keep the URL in `version`.
          ( paths(type == "object" and (.version | type) == "string") as $p
            | getpath($p).version as $v
            | select(($v | test(":")) and ($v | test("^(file|npm):") | not))
            | [($p[-1] | tostring), "has a URL or git spec as its version", $v] ),
          # A v2/v3 entry with no resolved URL is resolved from npm config.
          ( if (.packages | type) == "object" then
              .packages | to_entries[]
              | select(.key != "" and (.value.resolved | type) != "string"
                       and .value.link != true and .value.inBundle != true)
              | [.key, "has no resolved URL", "-"]
            else empty end )
          | @tsv' "$f")"; then
        echo "::error file=$f::$f is not readable JSON"; status=1; continue
      fi
      while IFS=$'\t' read -r pkg why url; do
        [ -n "$pkg" ] || continue
        echo "::error file=$f,title=off-registry package::$f: $pkg $why ($url). Approved hosts: $approved_list — see .github/approved-registries.txt."
        status=1
      done <<<"$bad"
      ;;
    *.npmrc)
      # Fail closed rather than copy npm's ini reader, which splits on bare CR,
      # decodes quoted names and expands ${VAR} in them. Any setting whose name
      # mentions "registry" or holds a quote, backslash or `$` fails. No
      # tracked .npmrc sets a registry; allowing one means extending this first.
      while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*[\#\;] ]] && continue
        key="${line%%=*}"
        if [[ "${key,,}" == *registry* || "$key" == *[\"\'\\\$]* ]]; then
          echo "::error file=$f,title=off-registry npmrc::$f: setting '$key' can point npm at another registry. No registry settings are allowed in a tracked .npmrc; to allow one, extend check-lockfile-registries.sh first."
          status=1
        fi
      done < <(tr '\r' '\n' < "$f")
      ;;
    *yarn.lock|*pnpm-lock.yaml)
      echo "::error file=$f,title=unsupported lockfile::$f: this check reads npm lockfiles only. Remove it, or extend check-lockfile-registries.sh first."
      status=1
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
      echo "::error file=$f::$f is not a file type this check reads"; status=1
      ;;
  esac
done

exit "$status"
