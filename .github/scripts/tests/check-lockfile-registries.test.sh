#!/usr/bin/env bash
# Hermetic suite for check-lockfile-registries.sh (#216). The off-registry
# fixture MUST fail and name the file, the package and the host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/../check-lockfile-registries.sh"
FIX="$HERE/fixtures/lockfile-registries"
fail=0

expect() { # <want-exit> <name> <file> [<substring>...]
  local want="$1" name="$2" file="$3" out rc=0
  shift 3
  out="$(bash "$CHECK" "$file" 2>&1)" || rc=$?
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

expect 1 "off-registry fixture fails" "$FIX/off-registry/package-lock.json" \
  "$FIX/off-registry/package-lock.json" "node_modules/is-odd" "registry.example.invalid"
expect 0 "approved and local entries pass" "$FIX/ok/package-lock.json"
expect 1 "go.mod replace fails" "$FIX/replace/go.mod" \
  "$FIX/replace/go.mod:7" "example.invalid/dep => ../dep"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
bad() { # <name> <resolved> <expected substring>
  jq --arg u "$2" '.packages["node_modules/left-pad"].resolved = $u' \
    "$FIX/ok/package-lock.json" > "$tmp/package-lock.json"
  expect 1 "$1" "$tmp/package-lock.json" "node_modules/left-pad" "$3"
}
bad "plain http fails" "http://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" "not an https URL"
bad "credentials before the host fail" "https://registry.npmjs.org@evil.example/x.tgz" "not an https URL"
bad "explicit port fails" "https://registry.npmjs.org:8443/x.tgz" "registry.npmjs.org:8443"
bad "git+ssh fails" "git+ssh://git@github.com/x/left-pad.git#abc" "not an https URL"
bad "lookalike host fails" "https://registry.npmjs.org.evil.example/x.tgz" "registry.npmjs.org.evil.example"

jq '{lockfileVersion: 1, dependencies: {a: {version: "1.0.0",
      resolved: "https://evil.example/a.tgz",
      dependencies: {b: {version: "1.0.0", resolved: "https://evil.example/b.tgz"}}}}}' \
  -n > "$tmp/package-lock.json"
expect 1 "v1 nested dependencies are checked" "$tmp/package-lock.json" "evil.example" "b"

printf 'module x\n\nreplace (\n\t// note\n\ta => b v1.0.0\n)\n' > "$tmp/go.mod"
expect 1 "replace block fails" "$tmp/go.mod" "$tmp/go.mod:5" "a => b v1.0.0"
printf 'module x\n\n// replace a => b\nrequire a v1.0.0\n' > "$tmp/go.mod"
expect 0 "commented replace passes" "$tmp/go.mod"

jq '{lockfileVersion: 1, dependencies: {x: {version: "git+https://evil.example/x.git#abc"}}}' \
  -n > "$tmp/package-lock.json"
expect 1 "v1 git version fails" "$tmp/package-lock.json" "has a URL or git spec" "evil.example"
jq '.packages["node_modules/sneaky"] = {version: "https://evil.example/x.tgz"}' \
  "$FIX/ok/package-lock.json" > "$tmp/package-lock.json"
expect 1 "v3 URL version fails" "$tmp/package-lock.json" "node_modules/sneaky" "has a URL or git spec"
jq '.packages["node_modules/share"] = {version: "1.0.0", resolved: "file://evil.example/share/x.tgz"}' \
  "$FIX/ok/package-lock.json" > "$tmp/package-lock.json"
expect 1 "file:// share fails" "$tmp/package-lock.json" "node_modules/share" "not an https URL"
jq '.packages["node_modules/unc"] = {resolved: "\\\\evil.example\\share", link: true}' \
  "$FIX/ok/package-lock.json" > "$tmp/package-lock.json"
expect 1 "UNC link fails" "$tmp/package-lock.json" "node_modules/unc"
jq '.packages["node_modules/sneaky"] = {version: "1.0.0"}' \
  "$FIX/ok/package-lock.json" > "$tmp/package-lock.json"
expect 1 "entry with no resolved fails" "$tmp/package-lock.json" "node_modules/sneaky" "no resolved URL"

cp "$FIX/off-registry/package-lock.json" "$tmp/npm-shrinkwrap.json"
expect 1 "npm-shrinkwrap.json is checked" "$tmp/npm-shrinkwrap.json" "registry.example.invalid"

npmrc() { # <want-exit> <name> <contents> [<substring>...]
  local want="$1" name="$2"; printf '%s\n' "$3" > "$tmp/.npmrc"; shift 3
  expect "$want" "$name" "$tmp/.npmrc" "$@"
}
npmrc 0 "npmrc without a registry passes" $'install-links=true\nmin-release-age=7'
npmrc 0 "npmrc commented registry passes" '# registry=https://npm.evil.example/'
npmrc 0 "npmrc semicolon comment passes" '; registry=https://npm.evil.example/'
npmrc 1 "npmrc registry fails, even the approved host" 'registry=https://registry.npmjs.org/' "setting 'registry'"
npmrc 1 "npmrc scoped registry fails" '@acme:registry=https://npm.evil.example' "@acme:registry"
npmrc 1 "npmrc replace-registry-host fails" 'replace-registry-host=always' "replace-registry-host"
npmrc 1 "npmrc odd-case registry fails" 'REGISTRY=https://npm.evil.example/' "REGISTRY"
npmrc 1 "npmrc quoted key fails" '"registry" = https://npm.evil.example/' "can point npm"
npmrc 1 "npmrc JSON-escaped key fails" '"registry"=https://npm.evil.example/' "can point npm"
# shellcheck disable=SC2016  # the literal ${X} is the input under test
npmrc 1 "npmrc env-expanded key fails" '${X}=https://npm.evil.example/' "can point npm"
printf '# note\rregistry=https://npm.evil.example/\n' > "$tmp/.npmrc"
expect 1 "npmrc bare CR splits a line" "$tmp/.npmrc" "setting 'registry'"
printf 'install-links=true\nregistry=https://npm.evil.example/' > "$tmp/.npmrc"
expect 1 "npmrc last line without newline is read" "$tmp/.npmrc" "setting 'registry'"

: > "$tmp/yarn.lock"
expect 1 "yarn.lock is unsupported" "$tmp/yarn.lock" "npm lockfiles only"

exit "$fail"
