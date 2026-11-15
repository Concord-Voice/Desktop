#!/usr/bin/env bash
#
# check-lockfile-registries.sh — fail when a lockfile, .npmrc or go.mod can
# send an install outside the approved registries (#216).
#
# npm installs whatever host a lockfile `resolved` URL names, so a changed URL
# can point an install at a registry we do not control. Every rule below fails
# closed: anything that is not on a short, known-good shape fails.
#
# package-lock.json / npm-shrinkwrap.json — for every entry (v2/v3 `packages`,
# and the v1 nested `dependencies` tree):
#   - `resolved` must be a plain registry URL, https://<host>/<seg>/…/<seg>,
#     with <host> listed in .github/scripts/approved-registries.txt (owned by
#     the security team in CODEOWNERS, like this script). No port, no
#     credentials, no empty path segment (npm rebuilds `//host/…` paths into a
#     new host), no backslash, query or whitespace.
#   - or a relative local path: `file:<relative>`, or a `link: true` entry.
#     These are the in-repo compat packages; npm copies them, fetches nothing.
#   - `version` must be plain semver, an `npm:<name>@<semver>` alias, or a
#     relative `file:` path. v1 git, URL and GitHub `user/repo#sha` specs fail.
#   - an installed entry with no `resolved` fails: npm resolves it from config.
#   - every dependency request map (dependencies, devDependencies,
#     optionalDependencies, peerDependencies; v1: requires), the root's too,
#     holds only registry ranges, npm: aliases or relative file: paths.
# package.json — the same rule for its request maps, and every `overrides`
#   value may also be a `$name` reference. npm ci reads both.
# .npmrc — only the settings in NPMRC_ALLOWED may appear. registry, userconfig,
#   globalconfig and others can all move npm's fetches.
# yarn.lock / pnpm-lock.yaml — fail as unsupported.
# go.mod / go.work — every `replace` directive fails: it points a module at a
#   source other than the module proxy's copy of it.
#
# Usage: check-lockfile-registries.sh [file...]
#   With no arguments it checks every tracked file of those kinds, except the
#   script-test fixtures.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${APPROVED_REGISTRIES:-$HERE/approved-registries.txt}"
NPMRC_ALLOWED=(install-links min-release-age)

if [ "$#" -eq 0 ]; then
  cd "$HERE/../.."
  # :(icase) because npm finds `.NPMRC` on a case-insensitive filesystem
  # (the Windows build legs). A name in other case then fails below as an
  # unknown file type, since the `case` patterns are lower-case.
  list="$(git ls-files -- ':(icase)*package-lock.json' ':(icase)*npm-shrinkwrap.json' \
    ':(icase)*.npmrc' ':(icase)*yarn.lock' ':(icase)*pnpm-lock.yaml' \
    ':(icase)*go.mod' ':(icase)*go.work' ':(icase)*package.json' \
    ':!:.github/scripts/tests/fixtures/**')"
  # Fail closed: an empty list means git or the pathspec broke, not "clean".
  [ -n "$list" ] || { echo "::error::no lockfiles found to check"; exit 2; }
  mapfile -t files <<<"$list"
  set -- "${files[@]}"
fi

approved="$(jq -Rnc '[inputs | select(test("^\\s*(#|$)") | not) | gsub("\\s"; "")]' "$CONFIG")"
[ "$approved" != "[]" ] || { echo "::error file=$CONFIG::no approved hosts in $CONFIG"; exit 2; }
approved_list="$(jq -r 'join(", ")' <<<"$approved")"

# jq definitions shared by the lockfile and package.json checks. Anchor with
# \A and \z, not ^ and $: in jq ^ also matches just after a newline.
# A dependency request spec is a registry range or dist-tag, an npm: alias to
# one, or a relative file: path. npm ci fetches any other spec (a URL, git, a
# GitHub shorthand) even when the installed lockfile entry looks like a
# registry package.
SPEC_DEFS='
  def relpath: test("\\A[^/\\\\:\\s][^:\\\\\\s]*\\z");
  def range: test("\\A[0-9A-Za-z.^~<>=|* +-]*\\z");
  def okspec: type == "string"
    and (range
         or test("\\Anpm:(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*@[0-9A-Za-z.^~<>=|* +-]*\\z")
         or (startswith("file:") and (.[5:] | relpath)));
'

status=0
for f in "$@"; do
  # A symlink is refused before it is read, whatever it points at. Here the
  # target is read, but a checkout with core.symlinks=false (Windows) writes
  # the link text into the file, and npm then reads that text as settings.
  # git's mode catches the link even in such a checkout.
  mode="$(git -C "$(dirname "$f")" ls-files -s -- "$(basename "$f")" 2>/dev/null | cut -d' ' -f1)" || mode=""
  if [ -L "$f" ] || [ "$mode" = 120000 ]; then
    echo "::error file=$f,title=symlinked file::$f is a symlink. Commit the file itself, not a link."
    status=1; continue
  fi
  if [ ! -f "$f" ]; then
    echo "::error file=$f::$f not found"; status=1; continue
  fi
  case "$f" in
    *package-lock.json|*npm-shrinkwrap.json)
      if ! bad="$(jq -r --argjson ok "$approved" "$SPEC_DEFS"'
          # Anchor with \A, not ^: in jq ^ also matches just after a newline.
          def semver: test("\\A[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.+-]+)?\\z");
          def host: (capture("\\Ahttps://(?<h>[a-z0-9.-]+)/[A-Za-z0-9@._~+-]+(/[A-Za-z0-9@._~+-]+)*\\z") | .h) // null;
          def okversion: semver or (test("\\Anpm:[^:/\\s]+(/[^:/\\s]+)?@") and (sub("\\Anpm:.+@"; "") | semver))
            or (startswith("file:") and (.[5:] | relpath));
          # Lockfile entries only: packages["<key>"], and the v1 tree
          # dependencies.<name>(.dependencies.<name>)*. A dependency map that
          # happens to hold a package named "version" is not an entry.
          [ paths(type == "object") as $p
            | select(($p | length) == 2 and $p[0] == "packages"
                     or (($p | length) > 0 and ($p | length) % 2 == 0
                         and ([range(0; $p | length; 2) as $i | $p[$i]] | all(. == "dependencies"))))
            | {key: ($p[-1] | tostring), v1: ($p[0] == "dependencies"), e: getpath($p)} ]
          | .[] | .key as $k | .e as $e | .v1 as $v1
          | if ([$k, $e.resolved, $e.version] | map(strings) | any(test("[\\x00-\\x1f\\x7f]"))) then
              [$k, "has a control character in its key, resolved or version", "-"]
            elif ($e.resolved | type) == "string" then
              $e.resolved as $u
              | select(($u | startswith("file:") and (.[5:] | relpath)) or (($v1 | not) and $e.link == true and ($u | relpath)) | not)
              | ($u | host) as $h
              | select($h == null or ($ok | index($h)) == null)
              | [$k, (if $h == null then "is not a plain https registry URL" else "resolves to unapproved host \($h)" end), $u]
            # No resolved URL: npm resolves the entry from config. Skip the
            # root, bundled entries, v1 local file: entries, and v3 links and
            # link targets (keys outside node_modules/). Exemptions follow the
            # fields npm reads for each format: v1 knows `bundled` only, v3
            # knows `link` and `inBundle`.
            elif $k == "" then empty
            # v1 falls back to `from` when there is no resolved or integrity, so
            # every exemption below needs `from` absent or a local file: path.
            # v3 entries carry no `from`; one that does is held to the same rule.
            elif ($e.from != null)
                 and ((($e.from | type) == "string" and ($e.from | startswith("file:")) and ($e.from[5:] | relpath)) | not)
              then [$k, "has no resolved URL and a from that is not a relative file: path", ($e.from | tostring)]
            elif $v1 and $e.bundled == true then empty
            elif ($v1 | not) and ($e.link == true or $e.inBundle == true) then empty
            # A local file: version (its v1 `from` was checked above).
            elif (($e.version // "") | tostring | startswith("file:")) then empty
            elif $v1 or ($k | test("(\\A|/)node_modules/")) then [$k, "has no resolved URL", "-"]
            else empty end,
            ( select(($e.version | type) == "string" and ($e.version | okversion | not))
              | [$k, "has a version that is not a registry version", $e.version] ),
            # Request maps, the root included. v1 keeps them in `requires`; its
            # `dependencies` is the entry tree, checked as entries above.
            ( (if $v1 then ["requires"] else ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] end)[] as $m
              | $e[$m] | select(. != null)
              | if type != "object" then [$k, "has a \($m) that is not a map", "-"]
                else to_entries[] | select(.value | okspec | not)
                  | [$k, "has a \($m) spec that is not a registry range, npm: alias or relative file: path", "\(.key)@\(.value | tostring)"]
                end )
          | @tsv' "$f")"; then
        echo "::error file=$f::$f is not readable JSON"; status=1; continue
      fi
      while IFS=$'\t' read -r pkg why url; do
        [ -n "$pkg" ] || continue
        echo "::error file=$f,title=off-registry package::$f: $pkg $why ($url). Approved hosts: $approved_list — see .github/scripts/approved-registries.txt."
        status=1
      done <<<"$bad"
      ;;
    *package.json)
      # The manifest's own request maps and npm `overrides`: npm ci fetches a
      # URL there even when the lockfile entry looks like npmjs. An override
      # value may also be a `$name` reference to a root dependency.
      if ! bad="$(jq -r "$SPEC_DEFS"'
          def okover: okspec or (type == "string" and test("\\A\\$[A-Za-z0-9@/._-]+\\z"));
          if type != "object" then ["-", "is not a JSON object", "-"] | @tsv else
          ( ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"][] as $m
            | .[$m] | select(. != null)
            | if type != "object" then [$m, "is not a map", "-"]
              else to_entries[] | select(.value | okspec | not)
                | ["\($m).\(.key)", "is not a registry range, npm: alias or relative file: path", (.value | tostring)]
              end ),
          ( .overrides | select(. != null)
            | if type != "object" then ["overrides", "is not a map", "-"]
              else paths(type != "object") as $p | getpath($p) as $v | select($v | okover | not)
                | ["overrides.\($p | map(tostring) | join("."))", "is not a registry range, npm: alias, relative file: path or $reference", ($v | tostring)]
              end )
          | @tsv end' "$f")"; then
        echo "::error file=$f::$f is not readable JSON"; status=1; continue
      fi
      while IFS=$'\t' read -r pkg why url; do
        [ -n "$pkg" ] || continue
        echo "::error file=$f,title=off-registry dependency spec::$f: $pkg $why ($url)."
        status=1
      done <<<"$bad"
      ;;
    *.npmrc)
      # An allowlist, not a copy of npm's ini reader (which splits on bare CR,
      # decodes quoted names and expands ${VAR} in them): a setting name must
      # be exactly one of NPMRC_ALLOWED.
      if ! content="$(tr '\r' '\n' < "$f")"; then
        echo "::error file=$f::$f is not readable"; status=1; continue
      fi
      while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*([\#\;]|$) ]] && continue
        key="${line%%=*}"; key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
        allowed=0
        for a in "${NPMRC_ALLOWED[@]}"; do [ "$key" = "$a" ] && allowed=1; done
        if [ "$allowed" -eq 0 ]; then
          echo "::error file=$f,title=npmrc setting not allowed::$f: setting '$key' is not on the allowed list (${NPMRC_ALLOWED[*]}). Settings such as registry, userconfig or globalconfig can move npm's fetches; to allow another, add it to NPMRC_ALLOWED in check-lockfile-registries.sh."
          status=1
        fi
      done <<<"$content"
      ;;
    *yarn.lock|*pnpm-lock.yaml)
      echo "::error file=$f,title=unsupported lockfile::$f: this check reads npm lockfiles only. Remove it, or extend check-lockfile-registries.sh first."
      status=1
      ;;
    *go.mod|*go.work)
      if ! replaces="$(awk '
          # Go reads CR as whitespace anywhere, so map every CR to a space,
          # and treat any line whose first token starts with "replace" as one.
          { gsub(/\r/, " "); sub(/\/\/.*/, ""); gsub(/^[ \t]+|[ \t]+$/, "") }
          $0 == "" { next }
          blk && $0 == ")" { blk = 0; next }
          blk { print FNR ":" $0; next }
          /^replace[ \t]*\($/ { blk = 1; next }
          $1 ~ /^replace/ { sub(/^replace[ \t]*/, ""); print FNR ":" $0 }
        ' "$f")"; then
        echo "::error file=$f::$f is not readable"; status=1; continue
      fi
      while IFS=: read -r line text; do
        [ -n "$line" ] || continue
        echo "::error file=$f,line=$line,title=go replace directive::$f:$line: replace directive ($text) points a module at a source other than the module proxy. Remove it, or depend on the published module."
        status=1
      done <<<"$replaces"
      ;;
    *)
      echo "::error file=$f::$f is not a file type this check reads"; status=1
      ;;
  esac
done

exit "$status"
