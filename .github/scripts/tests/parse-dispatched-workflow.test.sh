#!/usr/bin/env bash
#
# parse-dispatched-workflow.test.sh — Self-test for parse-dispatched-workflow.sh.
#
# Mirrors the assert-helper pattern from lint-branch-protection.test.sh.
# Verifies V1 (production-environment detection) and V7 (secret-reference
# enumeration) enforcement per spec §3.3.
# Spec: internal-reference §3.3

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/parse-dispatched-workflow.sh"
FIXTURES="${SCRIPT_DIR}/fixtures/workflow-validate"

pass=0
fail=0

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

assert_jq_equals() {
  local label="$1"
  local fixture="$2"
  local jq_filter="$3"
  local expected="$4"

  local parser_out parser_rc
  set +e
  parser_out=$(bash "$SCRIPT" "${FIXTURES}/${fixture}" 2>/dev/null)
  parser_rc=$?
  set -e
  if [[ $parser_rc -ne 0 ]]; then
    echo "FAIL: $label"
    echo "  parser exited with rc=$parser_rc"
    fail=$((fail + 1))
    return
  fi
  local actual
  actual=$(printf '%s' "$parser_out" | jq -r "$jq_filter")

  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $label"
    pass=$((pass + 1))
  else
    echo "  ✗ $label" >&2
    echo "    expected: $expected" >&2
    echo "    actual:   $actual" >&2
    fail=$((fail + 1))
  fi
}

# Sanity tests
echo "Sanity tests:"
assert_exit 2 "Sanity: no args exits 2" bash "$SCRIPT"
assert_exit 2 "Sanity: missing file exits 2" bash "$SCRIPT" /tmp/does-not-exist-$$.yml

# V1: environment detection
echo ""
echo "V1 / V7 assertions:"
assert_jq_equals "V1: staging-only emits ['staging']" \
  "staging-only.yml" \
  '.environments | sort | join(",")' \
  "staging"

assert_jq_equals "V1: production fixture emits ['production']" \
  "production.yml" \
  '.environments | sort | join(",")' \
  "production"

assert_jq_equals "V1: mixed-env emits both" \
  "mixed-env.yml" \
  '.environments | sort | join(",")' \
  "production,staging"

assert_jq_equals "V1: no-env emits empty array" \
  "no-env.yml" \
  '.environments | length' \
  "0"

assert_jq_equals "V1: dict-form environment captured" \
  "staging-dict-form.yml" \
  '.environments | sort | join(",")' \
  "staging"

# V7: secret-reference enumeration
assert_jq_equals "V7: many-secrets enumerates all five (sorted, unique)" \
  "many-secrets.yml" \
  '.secrets | sort | join(",")' \
  "ANOTHER_SECRET,DATABASE_URL,JWT_SECRET,REDIS_URL,SMTP_PASSWORD"

assert_jq_equals "V7: no-secrets emits empty array" \
  "no-secrets.yml" \
  '.secrets | length' \
  "0"

assert_jq_equals "V7: job-level env block secrets captured" \
  "secrets-in-env-block.yml" \
  '.secrets | sort | join(",")' \
  "API_KEY,SHARED_TOKEN"

# Output schema: top-level keys
assert_jq_equals "Schema: emits .environments + .secrets" \
  "staging-only.yml" \
  'keys | sort | join(",")' \
  "environments,secrets"

# Finding #6 — malformed YAML exits 2 (lock in YAML parse-error → exit 2 behavior).
echo ""
echo "Malformed YAML tests:"
assert_exit 2 "Malformed YAML exits 2" bash "$SCRIPT" "${FIXTURES}/parse-malformed.yml"

echo ""
echo "─────────────────────────────────────────"
echo "PASS: $pass  FAIL: $fail"
[[ "$fail" == "0" ]]
