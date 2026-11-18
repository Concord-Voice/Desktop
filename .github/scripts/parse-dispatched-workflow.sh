#!/usr/bin/env bash
#
# parse-dispatched-workflow.sh — Extracts trust-model relevant data from a
# GitHub Actions workflow YAML file for the L3 sandbox (#921 G6 / #1003).
#
# Reads ONE workflow file path. Emits JSON with two keys:
#   .environments — array of distinct `environment:` declarations across all
#                   jobs in the file. Strings, case-preserved as written.
#                   Empty array if no jobs declare `environment:`.
#   .secrets      — array of distinct secret names referenced via
#                   `${{ secrets.X }}` anywhere in the file. Names are
#                   case-preserved.
#
# This script is the security boundary for Invariants V1 (staging-only
# dispatch) and V7 (staging-secret blast radius surfacing) per spec
# `internal-reference`
# §3.3.
#
# Pure parser. No I/O beyond reading the input file and printing to stdout.
# No network. No `gh` calls. Independently testable from fixtures.
#
# Dependencies: bash 4+, python3 with PyYAML, jq 1.6+. python3 is pre-installed
# on ubuntu-latest GHA runners; PyYAML is installed by pr-ci.yml's hash-locked
# install of .github/requirements-pyyaml.txt in the workflow-lint job (and is
# pre-installed on most developer macOS/Linux systems).
#
# Matching the existing repo precedent — other lint scripts under
# .github/scripts/ (lint-pr-release-trust.sh, lint-multisecret-andcheck.sh,
# lint-always-needs-comment.sh) all use python3+PyYAML for YAML parsing.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <workflow-yaml-path>" >&2
  exit 2
fi

WORKFLOW="$1"

if [[ ! -f "$WORKFLOW" ]]; then
  echo "error: file not found: $WORKFLOW" >&2
  exit 2
fi

# Note: environment declarations are captured as literal strings (case-preserved).
# The V1 static FLAG (computed in workflow-validate.yml) marks any workflow whose
# env name contains "production" (case-insensitive SUBSTRING) — catching
# production, production-cloudflare, production-secrets, and expression-valued envs
# whose text contains the "production" token (e.g. `environment: ${{ inputs.x ==
# 'production' && ... }}`). A PURE expression env with no "production" token (e.g.
# `environment: ${{ inputs.target }}`) cannot be statically resolved and is NOT
# flagged. This is static analysis only — #921's dispatch half was collapsed out
# in PR #1371, so the flag is informational (reviewer attention), not a gate.

# Environments: every distinct `environment:` declaration across .jobs.*.
# `environment:` can be a bare string (`environment: staging`) or a mapping
# (`environment: { name: staging, url: ... }`); both forms resolve to a
# string name. python3+PyYAML handles both. Empty array if no jobs declare
# `environment:`.
ENVS_JSON=$(python3 - "$WORKFLOW" <<'PYEOF'
import sys, yaml, json

with open(sys.argv[1]) as f:
    try:
        doc = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
        print(f"error: YAML parse error in {sys.argv[1]}: {e}", file=sys.stderr)
        sys.exit(2)

envs = set()
for job in (doc.get("jobs") or {}).values():
    if not isinstance(job, dict):
        continue
    env = job.get("environment")
    if isinstance(env, str):
        envs.add(env)
    elif isinstance(env, dict) and isinstance(env.get("name"), str):
        envs.add(env["name"])

print(json.dumps(sorted(envs)))
PYEOF
)

# Secrets: every secret the workflow can reach. The YAML is parsed, so only real
# YAML comments drop out (a file name such as provision-secrets.yml in a comment is
# not a secret). Every string value is then searched, so a reference in env:, with:,
# run: or if: counts wherever it sits; this stays a superset of what GitHub expands.
# `secrets.NAME` and `secrets['NAME']` give NAME. A job with `secrets: inherit`
# gives "inherit", and any other use of the secrets context inside an expression
# (toJSON(secrets), secrets[matrix.key]) gives "dynamic": both mean every secret.
# Context and secret names are case-insensitive, so matching is too and names
# are reported upper-case. GITHUB_TOKEN is reported if referenced because the labeler should still see it
# in the blast-radius table — it's a real grant even though it's the default token.
SECRETS_JSON=$(python3 - "$WORKFLOW" <<'PYEOF'
import json, re, sys, yaml

with open(sys.argv[1]) as f:
    doc = yaml.safe_load(f) or {}

NAMED = re.compile(r"""\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\]|\[\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\])""", re.I)
ANY = re.compile(r"\bsecrets\b", re.I)


def expressions(text, whole):
    """Yield ${{ }} bodies, skipping '...' literals so a '}' inside one cannot end it."""
    if whole:
        yield text
    i = 0
    while (i := text.find("${{", i)) != -1:
        j, quoted = i + 3, False
        while j < len(text) and (quoted or not text.startswith("}}", j)):
            if text[j] == "'":
                quoted = not quoted
            j += 1
        yield text[i + 3:j]
        i = j + 2


names = set()


def walk(node, key=None):
    if isinstance(node, dict):
        if str(node.get("secrets", "")).strip().lower() == "inherit":
            names.add("inherit")
        for k, v in node.items():
            walk(v, k)
    elif isinstance(node, list):
        for v in node:
            walk(v)
    elif isinstance(node, str):
        for m in NAMED.finditer(node):
            names.add(next(g for g in m.groups() if g).upper())  # names are case-insensitive
        for expr in expressions(node, key == "if"):
            if len(ANY.findall(expr)) > len(NAMED.findall(expr)):
                names.add("dynamic")


walk(doc)
print(json.dumps(sorted(names)))
PYEOF
)

# Combine into the contract output.
jq -n \
  --argjson envs "$ENVS_JSON" \
  --argjson secrets "$SECRETS_JSON" \
  '{environments: $envs, secrets: $secrets}'
