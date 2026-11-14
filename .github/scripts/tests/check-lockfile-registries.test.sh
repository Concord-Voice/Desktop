#!/usr/bin/env bash
# Hermetic suite for check-lockfile-registries.sh (#216). The off-registry
# fixture MUST fail and name the file, the package and the host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/../check-lockfile-registries.sh"
FIX="$HERE/fixtures/lockfile-registries"
fail=0

report() { # <name> <want-exit> <rc> <out> [<substring>...]
  local name="$1" want="$2" rc="$3" out="$4"
  shift 4
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
expect() { # <want-exit> <name> <file> [<substring>...]
  local want="$1" name="$2" file="$3" out rc=0
  shift 3
  out="$(bash "$CHECK" "$file" 2>&1)" || rc=$?
  report "$name" "$want" "$rc" "$out" "$@"
}

# ── fixtures ──────────────────────────────────────────────────────────
expect 1 "off-registry fixture fails" "$FIX/off-registry/package-lock.json" \
  "$FIX/off-registry/package-lock.json" "node_modules/is-odd resolves to unapproved host registry.example.invalid"
expect 0 "approved and local entries pass" "$FIX/ok/package-lock.json"
expect 1 "go.mod replace fails" "$FIX/replace/go.mod" \
  "$FIX/replace/go.mod:7" "example.invalid/dep => ../dep"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
lock="$tmp/package-lock.json"
edit() { jq "$@" "$FIX/ok/package-lock.json" > "$lock"; }

# ── resolved URLs ─────────────────────────────────────────────────────
bad() { # <name> <resolved> <expected substring>
  # shellcheck disable=SC2016  # $u is a jq variable
  edit --arg u "$2" '.packages["node_modules/left-pad"].resolved = $u'
  expect 1 "$1" "$lock" "node_modules/left-pad" "$3"
}
bad "plain http fails" "http://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" "not a plain https registry URL"
bad "credentials before the host fail" "https://registry.npmjs.org@evil.example/x.tgz" "not a plain https registry URL"
bad "explicit port fails" "https://registry.npmjs.org:8443/x.tgz" "not a plain https registry URL"
bad "git+ssh fails" "git+ssh://git@github.com/x/left-pad.git#abc" "not a plain https registry URL"
bad "lookalike host fails" "https://registry.npmjs.org.evil.example/x.tgz" "unapproved host registry.npmjs.org.evil.example"
bad "empty path segment fails" "https://registry.npmjs.org//evil.example/x.tgz" "not a plain https registry URL"
bad "backslash in the path fails" 'https://registry.npmjs.org/\/evil.example/x.tgz' "not a plain https registry URL"
bad "query string fails" "https://registry.npmjs.org/x.tgz?u=evil.example" "not a plain https registry URL"
bad "absolute file: path fails" "file:/mnt/share/x.tgz" "not a plain https registry URL"
bad "file:// share fails" "file://evil.example/share/x.tgz" "not a plain https registry URL"
bad "drive-letter file: path fails" "file:C:/x.tgz" "not a plain https registry URL"
edit '.packages["node_modules/unc"] = {resolved: "\\\\evil.example\\share", link: true}'
expect 1 "UNC link fails" "$lock" "node_modules/unc"
edit '.packages["node_modules/abs"] = {resolved: "/mnt/share/abs", link: true}'
expect 1 "absolute link path fails" "$lock" "node_modules/abs"
edit '.packages["tools/local-tool"] = {name: "local-tool", version: "1.0.0"}'
expect 0 "link target entry without resolved passes" "$lock"
cp "$FIX/off-registry/package-lock.json" "$tmp/npm-shrinkwrap.json"
expect 1 "npm-shrinkwrap.json is checked" "$tmp/npm-shrinkwrap.json" "registry.example.invalid"

# ── missing resolved and versions ─────────────────────────────────────
edit '.packages["node_modules/sneaky"] = {version: "1.0.0"}'
expect 1 "entry with no resolved fails" "$lock" "node_modules/sneaky has no resolved URL"
edit '.packages["node_modules/sneaky"] = {version: "https://evil.example/x.tgz"}'
expect 1 "v3 URL version fails" "$lock" "node_modules/sneaky has a version that is not a registry version"
edit '.packages["node_modules/dep"] = {version: "1.0.0", resolved: "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz", dependencies: {version: "^1.0.0"}}'
expect 0 "a dependency named version is not an entry" "$lock"
v1() { jq -n --argjson d "$1" '{lockfileVersion: 1, dependencies: $d}' > "$lock"; }
v1 '{"a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
      "dependencies": {"b": {"version": "1.0.0", "resolved": "https://evil.example/b.tgz"}}}}'
expect 1 "v1 nested dependencies are checked" "$lock" "b resolves to unapproved host evil.example"
v1 '{"x": {"version": "git+https://evil.example/x.git#abc"}}'
expect 1 "v1 git version fails" "$lock" "x has a version that is not a registry version"
v1 '{"x": {"version": "attacker/payload#0123456789abcdef"}}'
expect 1 "v1 GitHub shorthand fails" "$lock" "x has a version that is not a registry version"
v1 '{"x": {"version": "file:///mnt/share/x.tgz"}}'
expect 1 "v1 absolute file: version fails" "$lock" "x has a version that is not a registry version"
v1 '{"x": {"version": "1.0.0"}}'
expect 1 "v1 entry with no resolved fails" "$lock" "x has no resolved URL"
v1 '{"x": {"version": "file:tools/x"}, "y": {"version": "npm:string-width@4.2.3", "resolved": "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz"}}'
expect 0 "v1 relative file: and npm: alias pass" "$lock"

# ── go.mod / go.work ──────────────────────────────────────────────────
printf 'module x\n\nreplace (\n\t// note\n\ta => b v1.0.0\n)\n' > "$tmp/go.mod"
expect 1 "replace block fails" "$tmp/go.mod" "$tmp/go.mod:5" "a => b v1.0.0"
printf 'module x\r\n\r\nreplace(\r\n\ta => b v1.0.0\r\n)\r\n' > "$tmp/go.mod"
expect 1 "CRLF replace block fails" "$tmp/go.mod" "$tmp/go.mod:4" "a => b v1.0.0"
printf 'module x\n\n// replace a => b\nrequire a v1.0.0\n' > "$tmp/go.mod"
expect 0 "commented replace passes" "$tmp/go.mod"
printf 'go 1.27\n\nuse ./a\n\nreplace a => ../evil\n' > "$tmp/go.work"
expect 1 "go.work replace fails" "$tmp/go.work" "a => ../evil"

# ── .npmrc ────────────────────────────────────────────────────────────
npmrc() { # <want-exit> <name> <contents> [<substring>...]
  local want="$1" name="$2"; printf '%s\n' "$3" > "$tmp/.npmrc"; shift 3
  expect "$want" "$name" "$tmp/.npmrc" "$@"
}
npmrc 0 "npmrc with allowed settings passes" $'install-links=true\nmin-release-age = 7\n\n# note\n; note'
npmrc 1 "npmrc registry fails, even the approved host" 'registry=https://registry.npmjs.org/' "setting 'registry' is not on the allowed list"
npmrc 1 "npmrc scoped registry fails" '@acme:registry=https://npm.evil.example' "setting '@acme:registry'"
npmrc 1 "npmrc replace-registry-host fails" 'replace-registry-host=always' "setting 'replace-registry-host'"
npmrc 1 "npmrc userconfig fails" 'userconfig=./extra' "setting 'userconfig'"
npmrc 1 "npmrc globalconfig fails" 'globalconfig=./extra' "setting 'globalconfig'"
npmrc 1 "npmrc quoted key fails" '"registry" = https://npm.evil.example/' "not on the allowed list"
npmrc 1 "npmrc JSON-escaped key fails" '"regis\u0074ry"=https://npm.evil.example/' "not on the allowed list"
# shellcheck disable=SC2016  # the literal ${X?} is the input under test
npmrc 1 "npmrc env-expanded key fails" 'regis${X?}try=https://npm.evil.example/' "not on the allowed list"
npmrc 1 "npmrc section header fails" '[registry]' "not on the allowed list"
printf '# note\rregistry=https://npm.evil.example/\n' > "$tmp/.npmrc"
expect 1 "npmrc bare CR splits a line" "$tmp/.npmrc" "setting 'registry'"
printf 'install-links=true\nregistry=https://npm.evil.example/' > "$tmp/.npmrc"
expect 1 "npmrc last line without newline is read" "$tmp/.npmrc" "setting 'registry'"

# ── other files and fail-closed errors ────────────────────────────────
: > "$tmp/yarn.lock"
expect 1 "yarn.lock is unsupported" "$tmp/yarn.lock" "npm lockfiles only"
: > "$tmp/pnpm-lock.yaml"
expect 1 "pnpm-lock.yaml is unsupported" "$tmp/pnpm-lock.yaml" "npm lockfiles only"
expect 1 "missing file fails" "$tmp/nope/package-lock.json" "not found"
printf '{' > "$lock"
expect 1 "unreadable JSON fails" "$lock" "not readable JSON"
: > "$tmp/foo.txt"
expect 1 "unknown file type fails" "$tmp/foo.txt" "not a file type this check reads"
printf '# only a comment\n' > "$tmp/hosts.txt"
rc=0; out="$(APPROVED_REGISTRIES="$tmp/hosts.txt" bash "$CHECK" "$FIX/ok/package-lock.json" 2>&1)" || rc=$?
report "config without hosts exits 2" 2 "$rc" "$out" "no approved hosts"

# ── no-argument mode, as CI runs it ───────────────────────────────────
repo="$tmp/repo"
mkdir -p "$repo/.github/scripts/tests/fixtures/x" "$repo/app" "$repo/svc"
cp "$CHECK" "$repo/.github/scripts/"
cp "$HERE/../../approved-registries.txt" "$repo/.github/"
git -C "$repo" init -q
rc=0; out="$(bash "$repo/.github/scripts/check-lockfile-registries.sh" 2>&1)" || rc=$?
report "no-arg mode with nothing tracked exits 2" 2 "$rc" "$out" "no lockfiles found"
cp "$FIX/off-registry/package-lock.json" "$repo/app/package-lock.json"
cp "$FIX/off-registry/package-lock.json" "$repo/.github/scripts/tests/fixtures/x/package-lock.json"
printf 'registry=https://npm.evil.example/\n' > "$repo/app/.npmrc"
printf 'module x\n\nreplace a => ../b\n' > "$repo/svc/go.mod"
git -C "$repo" add -A
rc=0; out="$(bash "$repo/.github/scripts/check-lockfile-registries.sh" 2>&1)" || rc=$?
report "no-arg mode checks tracked lockfiles, .npmrc and go.mod" 1 "$rc" "$out" \
  "app/package-lock.json: node_modules/is-odd" "app/.npmrc: setting 'registry'" "svc/go.mod:3"
if [[ "$out" == *"tests/fixtures/x"* ]]; then
  echo "FAIL no-arg mode skips the test fixtures"; echo "$out"; fail=1
else
  echo "ok   no-arg mode skips the test fixtures"
fi

exit "$fail"
