#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCANNER="$REPO_ROOT/.github/scripts/lint-pr-release-trust.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
case_number=0
categories_covered=0
CASE_ROOT=""

assert_run() {
  local expected="$1"
  local diagnostic="$2"
  local label="$3"
  shift 3

  local output actual
  set +e
  output=$("$@" 2>&1)
  actual=$?
  set -e

  if [[ "$actual" == "$expected" && -n "$output" && "$output" == *"$diagnostic"* ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected exit $expected and diagnostic '$diagnostic'; got exit $actual)" >&2
    [[ -n "$output" ]] && printf '    %s\n' "$output" >&2
    fail=$((fail + 1))
  fi
}

assert_run_without() {
  local expected="$1"
  local diagnostic="$2"
  local forbidden="$3"
  local label="$4"
  shift 4

  local output actual
  set +e
  output=$("$@" 2>&1)
  actual=$?
  set -e

  if [[ "$actual" == "$expected" && -n "$output" && "$output" == *"$diagnostic"* && "$output" != *"$forbidden"* ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected exit $expected, diagnostic '$diagnostic', and no '$forbidden'; got exit $actual)" >&2
    [[ -n "$output" ]] && printf '    %s\n' "$output" >&2
    fail=$((fail + 1))
  fi
}

assert_smoke_sentinel_behavior() {
  python3 - "$CASE_ROOT/.github/workflows/desktop-pr-smoke.yml" <<'PY'
import os
import subprocess
import sys
from pathlib import Path

import yaml

workflow = yaml.load(Path(sys.argv[1]).read_text(), Loader=yaml.BaseLoader)
script = workflow["jobs"]["pr-smoke-result"]["steps"][0]["run"]
cases = (
    ("nonmatching paths succeed", "success", "false", "skipped", 0),
    ("path-filter failure fails", "failure", "false", "skipped", 1),
    ("matching successful build succeeds", "success", "true", "success", 0),
    ("matching failed build fails", "success", "true", "failure", 1),
    ("cancelled build fails", "success", "true", "cancelled", 1),
    ("unexpected skip fails", "success", "true", "skipped", 1),
)
for label, filter_result, desktop_shell, build_result, expected in cases:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PATHS_FILTER_RESULT": filter_result,
        "DESKTOP_SHELL": desktop_shell,
        "SMOKE_BUILD_RESULT": build_result,
    }
    actual = subprocess.run(["bash", "-c", script], env=env, check=False).returncode
    if actual != expected:
        raise SystemExit(f"FAIL: {label} (expected {expected}, got {actual})")
print("PASS: PR smoke sentinel behavior (6 cases)")
PY
}

begin_category() {
  local number="$1"
  local name="$2"
  if [[ "$number" != "$((categories_covered + 1))" ]]; then
    echo "FATAL: rejection categories must be declared in order" >&2
    exit 2
  fi
  categories_covered=$number
  echo "Category $number: $name"
}

write_clean_tree() {
  local root="$1"
  mkdir -p "$root/.github/workflows"

  cat >"$root/.github/workflows/build-desktop.yml" <<'YAML'
name: Build Desktop Client

on:
  workflow_dispatch:
    inputs:
      force_release:
        required: false
        type: boolean
        default: false
      expected_sha:
        required: false
        type: string
        default: ''

permissions:
  contents: read

jobs:
  detect-release:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    # TEST_MARKER_DETECT_JOB
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      # TEST_MARKER_BINDING_START
      - name: Verify dispatched SHA binding
        shell: bash
        env:
          BASH_ENV: /dev/null
          EXPECTED_SHA: ${{ inputs.expected_sha }}
        run: |
          actual="$(git rev-parse HEAD)"
          if [[ -n "$EXPECTED_SHA" && "$actual" != "$EXPECTED_SHA" ]]; then
            printf '::error::main advanced past the gated commit (expected %s, HEAD %s); the next Main CI run re-dispatches after its own gates.\n' "$EXPECTED_SHA" "$actual"
            exit 1
          fi
      # TEST_MARKER_BINDING_END
      - run: echo "release=true"

  release-build:
    needs: [detect-release]
    if: >-
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      github.event_name == 'workflow_dispatch' &&
      needs.detect-release.result == 'success' &&
      needs.detect-release.outputs.should_release == 'true'
    environment: desktop-release
    permissions:
      contents: read
      id-token: write
      attestations: write
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - {os: windows-latest, platform: win32, arch: x64, label: windows-x64}
          - {os: windows-latest, platform: win32, arch: arm64, label: windows-arm64}
          - {os: macos-latest, platform: darwin, arch: arm64, label: macos-arm64}
          - {os: macos-latest, platform: darwin, arch: x64, label: macos-x64}
          - {os: ubuntu-latest, platform: linux, arch: x64, label: linux-x64}
          - {os: ubuntu-latest, platform: linux, arch: arm64, label: linux-arm64}
    steps:
      - name: Checkout trusted commit
        uses: actions/checkout@v7
        with:
          ref: ${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
          # TEST_MARKER_CHECKOUT_INPUT

      - name: Verify exact trusted HEAD
        shell: bash
        env:
          BASH_ENV: /dev/null
        run: |
          actual="$(git rev-parse HEAD)"
          if [[ "$actual" != "$GITHUB_SHA" ]]; then
            printf 'expected=%s actual=%s\n' "$GITHUB_SHA" "$actual" >&2
            exit 1
          fi

      - name: Setup Apple API key for notarization (darwin only)
        if: matrix.platform == 'darwin'
        shell: bash
        run: echo "APPLE_API_KEY=${KEY_PATH}" >> "$GITHUB_ENV"

      # TEST_MARKER_OIDC_START
      - name: Validate environment OIDC claims
        if: matrix.platform == 'win32'
        shell: bash
        env:
          BASH_ENV: /dev/null
        run: |
          set -euo pipefail
          expected_issuer='https://token.actions.githubusercontent.com'
          expected_subject='repo:Concord-Voice/Desktop:environment:desktop-release'
          expected_audience='api://AzureADTokenExchange'
          response="$(curl --fail --silent --show-error \
            --header "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${expected_audience}")"
          token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])' <<<"$response")"
          payload="$(python3 - "$token" <<'PY'
          import base64
          import json
          import sys
          encoded = sys.argv[1].split(".")[1]
          encoded += "=" * (-len(encoded) % 4)
          claims = json.loads(base64.urlsafe_b64decode(encoded))
          allowlist = (
              "iss", "sub", "aud", "repository", "repository_id",
              "repository_owner_id", "ref", "workflow_ref",
              "job_workflow_ref", "environment",
          )
          print(json.dumps({key: claims[key] for key in allowlist if key in claims}, sort_keys=True), file=sys.stderr)
          print(json.dumps(claims))
          PY
          )"
          issuer="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["iss"])' <<<"$payload")"
          subject="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["sub"])' <<<"$payload")"
          audience="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["aud"])' <<<"$payload")"
          if [[ "$issuer" != "$expected_issuer" || "$subject" != "$expected_subject" || "$audience" != "$expected_audience" ]]; then
            exit 1
          fi
      # TEST_MARKER_OIDC_END

      # TEST_MARKER_AZURE_START
      - name: Azure login
        if: matrix.platform == 'win32'
        uses: azure/login@v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      # TEST_MARKER_AZURE_END

      - name: Package signed desktop release
        env:
          APPLE_CERTIFICATE_P12: ${{ secrets.APPLE_CERTIFICATE_P12 }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          AZURE_SIGNING_ENDPOINT: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          AZURE_SIGNING_ACCOUNT: ${{ secrets.AZURE_SIGNING_ACCOUNT }}
          AZURE_SIGNING_CERT_PROFILE: ${{ secrets.AZURE_SIGNING_CERT_PROFILE }}
        run: npm run make

      - name: Upload promotion artifacts
        uses: actions/upload-artifact@v7
        with:
          name: concord-voice-${{ matrix.label }}-v${{ needs.detect-release.outputs.version }}
          path: out/artifacts

  release:
    needs: [detect-release, release-build]
    if: >-
      always() &&
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      github.event_name == 'workflow_dispatch' &&
      needs.detect-release.result == 'success' &&
      needs.release-build.result == 'success' &&
      needs.detect-release.outputs.should_release == 'true'
    environment: desktop-release
    permissions:
      contents: write
      attestations: read
    runs-on: ubuntu-latest
    steps:
      - name: Prepare empty release artifact directory
        shell: bash
        env:
          BASH_ENV: /dev/null
        run: |
          set -euo pipefail
          rm -rf -- artifacts
          mkdir -- artifacts
          test -d artifacts
          test -z "$(find artifacts -mindepth 1 -maxdepth 1 -print -quit)"
      - name: Download same-run promotion artifacts
        uses: actions/download-artifact@v8
        with:
          path: artifacts
          pattern: concord-voice-*
          # TEST_MARKER_DOWNLOAD_INPUT
      - name: Verify exact release-build artifact set
        shell: bash
        env:
          BASH_ENV: /dev/null
          VERSION: ${{ needs.detect-release.outputs.version }}
        run: |
          set -euo pipefail
          expected=(
            "concord-voice-linux-arm64-v${VERSION}"
            "concord-voice-linux-x64-v${VERSION}"
            "concord-voice-macos-arm64-v${VERSION}"
            "concord-voice-macos-x64-v${VERSION}"
            "concord-voice-windows-arm64-v${VERSION}"
            "concord-voice-windows-x64-v${VERSION}"
            # TEST_MARKER_ARTIFACT_EXPECTED_EXTRA
          )
          mapfile -t paths < <(find artifacts -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort)
          if [[ ${#paths[@]} -ne ${#expected[@]} ]]; then
            printf '::error::expected %d release-build artifact directories, found %d\n' "${#expected[@]}" "${#paths[@]}"
            printf 'found: %s\n' "${paths[*]:-"<none>"}" >&2
            exit 1
          fi
          for index in "${!expected[@]}"; do
            actual="${paths[$index]#artifacts/}"
            if [[ ! -d "${paths[$index]}" || "$actual" != "${expected[$index]}" ]]; then
              printf '::error::release-build artifact set mismatch at index %s: expected=%s actual=%s\n' "$index" "${expected[$index]}" "$actual" >&2
              exit 1
            fi
          done
      - name: Sign Linux update metadata and publish release
        env:
          LINUX_UPDATE_SIGNING_KEY: ${{ secrets.LINUX_UPDATE_SIGNING_KEY }}
        run: |
          ./desktop/scripts/sign-linux-update.mjs
          gh release create "$GITHUB_REF_NAME" out/artifacts/*

  public-release-mirror:
    needs: [detect-release, release-build, release]
    if: >-
      always() &&
      github.repository == 'Concord-Voice/Desktop' &&
      github.event_name == 'workflow_dispatch' &&
      github.ref == 'refs/heads/main' &&
      needs.release.result == 'success'
    permissions:
      actions: write
      checks: read
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch and await public mirror
        env:
          GH_TOKEN: ${{ github.token }}
          RELEASE_TAG: ${{ needs.release.outputs.release_tag }}
        run: |
          set -euo pipefail
          RUN_ID=$(gh api --method POST \
            "repos/$GITHUB_REPOSITORY/actions/workflows/publish-public-mirror.yml/dispatches" \
            -F return_run_details=true \
            -f ref=main \
            -f "inputs[mirror_release_tag]=$RELEASE_TAG" \
            --jq '.workflow_run_id')
          test -n "$RUN_ID" || { echo "::error::Dispatch returned no workflow run ID"; exit 1; }
          gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --compact --exit-status

  dispatch-summary:
    if: github.event_name == 'workflow_dispatch'
    needs: [release]
    runs-on: ubuntu-latest
    permissions: {}
    # TEST_MARKER_UNDESIGNATED_UPLOAD
    steps:
      - run: echo "dispatch complete"
YAML

  cat >"$root/.github/workflows/desktop-pr-smoke.yml" <<'YAML'
name: Desktop PR Smoke
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
jobs:
  pr-paths-filter:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      desktop-shell: ${{ steps.filter.outputs.desktop-shell }}
    steps:
      - id: filter
        uses: dorny/paths-filter@v4
        with:
          filters: |
            desktop-shell:
              - '.github/workflows/desktop-pr-smoke.yml'
  pr-smoke-build:
    needs: [pr-paths-filter]
    if: github.event_name == 'pull_request' && needs.pr-paths-filter.outputs.desktop-shell == 'true'
    runs-on: macos-latest
    permissions:
      contents: read
      # TEST_MARKER_PR_PERMISSION
    # TEST_MARKER_PR_JOB
    steps:
      - uses: actions/checkout@v7
      # TEST_MARKER_PR_STEP
      - name: Package unsigned desktop smoke build
        run: npm run make -- --platform=darwin --arch=arm64
  pr-smoke-result:
    name: PR smoke test result
    needs: [pr-paths-filter, pr-smoke-build]
    if: ${{ always() && github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - name: Aggregate result
        shell: bash
        env:
          PATHS_FILTER_RESULT: ${{ needs.pr-paths-filter.result }}
          DESKTOP_SHELL: ${{ needs.pr-paths-filter.outputs.desktop-shell }}
          SMOKE_BUILD_RESULT: ${{ needs.pr-smoke-build.result }}
        run: |
          case "${PATHS_FILTER_RESULT}" in
            success) ;;
            *) echo "::error::path filter failed"; exit 1 ;;
          esac
          if [[ "${DESKTOP_SHELL}" != "true" ]]; then
            echo "::notice::No desktop-shell paths modified; skipping smoke test."
            exit 0
          fi
          case "${SMOKE_BUILD_RESULT}" in
            success) exit 0 ;;
            failure) echo "::error::Desktop smoke test failed"; exit 1 ;;
            cancelled) echo "::error::Desktop smoke test was cancelled"; exit 1 ;;
            skipped) echo "::error::Desktop smoke test was unexpectedly skipped"; exit 1 ;;
            *) echo "::error::Unexpected smoke build result"; exit 1 ;;
          esac
YAML

  cat >"$root/.github/workflows/publish-public-mirror.yml" <<'YAML'
name: Publish Public Mirror
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      dry_run:
        type: string
        required: false
        default: 'true'
      mirror_release_tag:
        type: string
        required: false
      force_bootstrap:
        type: boolean
        required: false
      stage_selfhost:
        type: boolean
        required: false
permissions:
  contents: read
jobs:
  mirror-prepare:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    if: >-
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.mirror_release_tag == ''))
    steps: [{run: echo prepare mirror data}]
  mirror-scan:
    runs-on: ubuntu-latest
    needs: [mirror-prepare]
    permissions: {}
    if: >-
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.mirror_release_tag == ''))
    steps:
      - run: echo scan mirror data
      - run: echo secrets are mentioned here as plain prose only
  publish:
    needs: [mirror-prepare, mirror-scan]
    if: >-
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.mirror_release_tag == ''))
    environment: public-mirror
    runs-on: ubuntu-latest
    steps:
      - run: echo "publish source"
  release-mirror:
    if: >-
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      github.event_name == 'workflow_dispatch' &&
      format('{0}', inputs.stage_selfhost) != 'true' &&
      startsWith(inputs.mirror_release_tag, 'desktop-v')
    environment: public-mirror
    runs-on: ubuntu-latest
    steps:
      - run: echo "publish release"
  selfhost-release:
    needs: [selfhost-prepare, selfhost-scan]
    if: >-
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      github.event_name == 'workflow_dispatch' &&
      format('{0}', inputs.stage_selfhost) != 'true' &&
      format('{0}', inputs.dry_run) == 'false' &&
      startsWith(inputs.mirror_release_tag, 'selfhost-v')
    environment: public-mirror
    permissions:
      contents: read
      actions: read
      pull-requests: read
    runs-on: ubuntu-24.04
    steps:
      - run: echo "publish verified self-host release"
  selfhost-prepare:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      pull-requests: read
    if: >-
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      github.event_name == 'workflow_dispatch' &&
      format('{0}', inputs.stage_selfhost) != 'true' &&
      format('{0}', inputs.dry_run) == 'false' &&
      startsWith(inputs.mirror_release_tag, 'selfhost-v')
    steps: [{run: echo prepare selfhost data}]
  selfhost-scan:
    runs-on: ubuntu-latest
    needs: [selfhost-prepare]
    permissions: {}
    if: >-
      github.repository == 'Concord-Voice/Desktop' &&
      github.ref == 'refs/heads/main' &&
      github.event_name == 'workflow_dispatch' &&
      format('{0}', inputs.stage_selfhost) != 'true' &&
      format('{0}', inputs.dry_run) == 'false' &&
      startsWith(inputs.mirror_release_tag, 'selfhost-v')
    steps:
      - run: echo scan selfhost data
      - run: echo secrets are mentioned here as plain prose only
YAML

  cat >"$root/.github/workflows/main-ci.yml" <<'YAML'
name: Main CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  changes:
    runs-on: ubuntu-latest
    steps: [{run: echo changes}]
  ioc:
    runs-on: ubuntu-latest
    steps: [{run: echo ioc}]
  eslint:
    runs-on: ubuntu-latest
    steps: [{run: echo eslint}]
  codeql:
    runs-on: ubuntu-latest
    steps: [{run: echo codeql}]
  govulncheck:
    runs-on: ubuntu-latest
    steps: [{run: echo govulncheck}]
  scorecard:
    runs-on: ubuntu-latest
    steps: [{run: echo scorecard}]
  build:
    runs-on: ubuntu-latest
    steps: [{run: echo build}]
  sonar:
    runs-on: ubuntu-latest
    steps: [{run: echo sonar}]
  build-desktop:
    needs: [changes, ioc, eslint, codeql, govulncheck, scorecard, build, sonar]
    if: success() && needs.changes.outputs.desktop-release == 'true' && needs.changes.outputs.hotfix == 'true'
    permissions:
      actions: write
      checks: read
      # TEST_MARKER_DISPATCHER_PERMISSION
    runs-on: ubuntu-latest
    # TEST_MARKER_DISPATCHER_JOB
    steps:
      - name: Dispatch and await trusted desktop build
        env:
          GH_TOKEN: ${{ github.token }}
          EXPECTED_SHA: ${{ github.sha }}
          # TEST_MARKER_DISPATCHER_ENV
        run: |
          set -euo pipefail
          RUN_ID=$(gh api --method POST \
            -H "X-GitHub-Api-Version: 2026-03-10" \
            "repos/$GITHUB_REPOSITORY/actions/workflows/build-desktop.yml/dispatches" \
            -F return_run_details=true \
            -f ref=main \
            -f "inputs[expected_sha]=$EXPECTED_SHA" \
            --jq '.workflow_run_id')
          test -n "$RUN_ID" || { echo "::error::Dispatch returned no workflow run ID"; exit 1; }
          echo "::notice::Watching trusted desktop build run ${RUN_ID} for ${EXPECTED_SHA}"
          gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --compact --exit-status
YAML

  cat >"$root/.github/workflows/nightly-ci.yml" <<'YAML'
name: Nightly CI
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  window:
    runs-on: ubuntu-latest
    steps: [{run: echo window}]
  ioc:
    runs-on: ubuntu-latest
    steps: [{run: echo ioc}]
  eslint:
    runs-on: ubuntu-latest
    steps: [{run: echo eslint}]
  codeql:
    runs-on: ubuntu-latest
    steps: [{run: echo codeql}]
  govulncheck:
    runs-on: ubuntu-latest
    steps: [{run: echo govulncheck}]
  secret-scanning:
    runs-on: ubuntu-latest
    steps: [{run: echo secret-scanning}]
  native-audiocap:
    runs-on: ubuntu-latest
    steps: [{run: echo native-audiocap}]
  scorecard:
    runs-on: ubuntu-latest
    steps: [{run: echo scorecard}]
  build:
    runs-on: ubuntu-latest
    steps: [{run: echo build}]
  unit-smoke:
    runs-on: ubuntu-latest
    steps: [{run: echo unit-smoke}]
  sonar:
    runs-on: ubuntu-latest
    steps: [{run: echo sonar}]
  zap:
    runs-on: ubuntu-latest
    steps: [{run: echo zap}]
  release:
    needs: [window, ioc, eslint, codeql, govulncheck, secret-scanning, native-audiocap, scorecard, build, unit-smoke, sonar, zap]
    if: >-
      !cancelled()
      && needs.window.outputs.pending == 'true'
      && needs.ioc.result == 'success'
      && needs.build.result == 'success'
      && needs.unit-smoke.result == 'success'
      && needs.eslint.result == 'success'
      && needs.codeql.result == 'success'
      && needs.govulncheck.result == 'success'
      && needs.secret-scanning.result == 'success'
      && needs.native-audiocap.result == 'success'
    permissions:
      actions: write
      checks: read
      contents: read
      # TEST_MARKER_NIGHTLY_PERMISSION
    runs-on: ubuntu-latest
    # TEST_MARKER_NIGHTLY_JOB
    steps:
      - name: Dispatch and await the trusted desktop build
        env:
          GH_TOKEN: ${{ github.token }}
          EXPECTED_SHA: ${{ github.sha }}
          VERSION: ${{ needs.window.outputs.version }}
          # TEST_MARKER_NIGHTLY_ENV
        run: |
          set -euo pipefail
          HEAD_SHA=$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq '.sha')
          if [ "$HEAD_SHA" != "$EXPECTED_SHA" ]; then
            echo "::notice::main advanced to ${HEAD_SHA} during this run;" \
                 "deferring desktop-v${VERSION} to the next nightly."
            exit 0
          fi
          echo "::notice::Releasing desktop-v${VERSION} (nightly, non-urgent path)"
          RUN_ID=$(gh api --method POST \
            -H "X-GitHub-Api-Version: 2026-03-10" \
            "repos/$GITHUB_REPOSITORY/actions/workflows/build-desktop.yml/dispatches" \
            -F return_run_details=true \
            -f ref=main \
            -f "inputs[expected_sha]=$EXPECTED_SHA" \
            --jq '.workflow_run_id')
          test -n "$RUN_ID" || { echo "::error::Dispatch returned no workflow run ID"; exit 1; }
          echo "::notice::Watching trusted desktop build run ${RUN_ID} for ${EXPECTED_SHA}"
          gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --compact --exit-status
YAML

  cat >"$root/.github/workflows/labeler.yml" <<'YAML'
name: Legitimate unrelated labeler
on:
  pull_request_target:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: write
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh pr edit "$PR_NUMBER" --add-label triage
YAML

  cat >"$root/.github/workflows/provision-secrets.yml" <<'YAML'
name: Provision Secrets
on:
  workflow_dispatch:
    inputs:
      environment:
        required: true
        type: choice
        options:
          - production
          - production-west-stage
permissions:
  contents: read
jobs:
  provision:
    name: Write secrets to production
    runs-on: ubuntu-latest
    # ADR-0033 (#2317): the provision job is the one sanctioned
    # environment-scoped OIDC job outside build-desktop.yml — Infisical
    # fetch. The exception is pinned to this exact job + dynamic
    # environment expression.
    environment: ${{ inputs.environment }}
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Fetch runtime secrets from Infisical (OIDC)
        run: echo fetch
      - name: Write Apple SSO private key
        env:
          APPLE_API_KEY: ${{ steps.apple-p8.outputs.p8 }}
          # TEST_MARKER_PROVISION_SIGNING_REFERENCE
        run: echo provision
YAML
}

write_classifier_workflows() {
  cat >"$CASE_ROOT/.github/workflows/classify-release.yml" <<'YAML'
name: Classify release
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
    branches: [main]
permissions:
  contents: read
jobs:
  contract-version-lockstep:
    name: SPA minimum ships with its client
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Classify and assert lockstep
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: bash .github/scripts/classify-release.sh
YAML

  cat >"$CASE_ROOT/.github/workflows/classify-release-comment.yml" <<'YAML'
name: Classify release comment
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled]
    branches: [main]
permissions:
  contents: read
jobs:
  classify-data:
    if: github.repository == 'Concord-Voice/Desktop' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      shell_changed: ${{ steps.validate.outputs.shell_changed }}
      old_contract: ${{ steps.validate.outputs.old_contract }}
      new_contract: ${{ steps.validate.outputs.new_contract }}
      contract_action: ${{ steps.validate.outputs.contract_action }}
      old_version: ${{ steps.validate.outputs.old_version }}
      new_version: ${{ steps.validate.outputs.new_version }}
      version_action: ${{ steps.validate.outputs.version_action }}
      old_spa_min: ${{ steps.validate.outputs.old_spa_min }}
      new_spa_min: ${{ steps.validate.outputs.new_spa_min }}
      spa_min_action: ${{ steps.validate.outputs.spa_min_action }}
      spa_min_present: ${{ steps.validate.outputs.spa_min_present }}
      version_bump_required: ${{ steps.validate.outputs.version_bump_required }}
      bump_level: ${{ steps.validate.outputs.bump_level }}
      bump_basis: ${{ steps.validate.outputs.bump_basis }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        id: checkout-base
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Fetch target commit as data
        id: fetch-target
        env:
          PR_NUMBER: ${{ github.event.pull_request.number }}
          EVENT_HEAD: ${{ github.event.pull_request.head.sha }}
        run: |
          set -euo pipefail
          [[ "${PR_NUMBER}" =~ ^[1-9][0-9]{0,8}$ ]]
          [[ "${EVENT_HEAD}" =~ ^[0-9a-f]{40}$ ]]
          git fetch --no-tags origin "refs/pull/${PR_NUMBER}/head"
          fetched="$(git rev-parse FETCH_HEAD)"
          [[ "${fetched}" =~ ^[0-9a-f]{40}$ ]]
          [[ "${fetched}" == "${EVENT_HEAD}" ]]
          printf 'TARGET_SHA=%s\n' "${fetched}" >> "${GITHUB_ENV}"
      - name: Classify target commit
        id: classify
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: bash .github/scripts/classify-release.sh
      - name: Validate classifier outputs
        id: validate
        env:
          SHELL_CHANGED: ${{ steps.classify.outputs.shell_changed }}
          OLD_CONTRACT: ${{ steps.classify.outputs.old_contract }}
          NEW_CONTRACT: ${{ steps.classify.outputs.new_contract }}
          CONTRACT_ACTION: ${{ steps.classify.outputs.contract_action }}
          OLD_VERSION: ${{ steps.classify.outputs.old_version }}
          NEW_VERSION: ${{ steps.classify.outputs.new_version }}
          VERSION_ACTION: ${{ steps.classify.outputs.version_action }}
          OLD_SPA_MIN: ${{ steps.classify.outputs.old_spa_min }}
          NEW_SPA_MIN: ${{ steps.classify.outputs.new_spa_min }}
          SPA_MIN_ACTION: ${{ steps.classify.outputs.spa_min_action }}
          SPA_MIN_PRESENT: ${{ steps.classify.outputs.spa_min_present }}
          VERSION_BUMP_REQUIRED: ${{ steps.classify.outputs.version_bump_required }}
          BUMP_LEVEL: ${{ steps.classify.outputs.bump_level }}
          BUMP_BASIS: ${{ steps.classify.outputs.bump_basis }}
        run: |
          set -euo pipefail
          [[ "${SHELL_CHANGED}" =~ ^(true|false)$ ]]
          [[ "${OLD_CONTRACT}" =~ ^(0|[1-9][0-9]{0,8})$ ]]
          [[ "${NEW_CONTRACT}" =~ ^(0|[1-9][0-9]{0,8})$ ]]
          [[ "${CONTRACT_ACTION}" =~ ^(none|needed|bumped)$ ]]
          [[ "${OLD_VERSION}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ && ${#OLD_VERSION} -le 128 ]]
          [[ "${NEW_VERSION}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ && ${#NEW_VERSION} -le 128 ]]
          [[ "${VERSION_ACTION}" =~ ^(none|notes-needed|bumped)$ ]]
          [[ "${OLD_SPA_MIN}" =~ ^(0|[1-9][0-9]{0,8})$ ]]
          [[ "${NEW_SPA_MIN}" =~ ^(0|[1-9][0-9]{0,8})$ ]]
          [[ "${SPA_MIN_ACTION}" =~ ^(none|raised|lowered|removed)$ ]]
          [[ "${SPA_MIN_PRESENT}" =~ ^(true|false)$ ]]
          [[ "${VERSION_BUMP_REQUIRED}" =~ ^(true|false)$ ]]
          [[ "${BUMP_LEVEL}" =~ ^(none|patch|minor|major)$ ]]
          [[ "${BUMP_BASIS}" =~ ^(none|breaking|added|ipc|notes|shell)$ ]]
          output_file="$(mktemp)"
          trap 'rm -f "${output_file}"' EXIT
          printf 'shell_changed=%s\nold_contract=%s\nnew_contract=%s\ncontract_action=%s\nold_version=%s\nnew_version=%s\nversion_action=%s\nold_spa_min=%s\nnew_spa_min=%s\nspa_min_action=%s\nspa_min_present=%s\nversion_bump_required=%s\nbump_level=%s\nbump_basis=%s\n' \
            "${SHELL_CHANGED}" "${OLD_CONTRACT}" "${NEW_CONTRACT}" "${CONTRACT_ACTION}" \
            "${OLD_VERSION}" "${NEW_VERSION}" "${VERSION_ACTION}" "${OLD_SPA_MIN}" \
            "${NEW_SPA_MIN}" "${SPA_MIN_ACTION}" "${SPA_MIN_PRESENT}" "${VERSION_BUMP_REQUIRED}" \
            "${BUMP_LEVEL}" "${BUMP_BASIS}" \
            > "${output_file}"
          output_bytes="$(wc -c < "${output_file}" | tr -d '[:space:]')"
          (( output_bytes <= 8192 ))
          cat "${output_file}" >> "${GITHUB_OUTPUT}"
  classify-comment:
    name: Classify release impact
    needs: classify-data
    if: github.repository == 'Concord-Voice/Desktop' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository && needs.classify-data.result == 'success' && needs.classify-data.outputs.shell_changed != '' && needs.classify-data.outputs.old_contract != '' && needs.classify-data.outputs.new_contract != '' && needs.classify-data.outputs.contract_action != '' && needs.classify-data.outputs.old_version != '' && needs.classify-data.outputs.new_version != '' && needs.classify-data.outputs.version_action != '' && needs.classify-data.outputs.old_spa_min != '' && needs.classify-data.outputs.new_spa_min != '' && needs.classify-data.outputs.spa_min_action != '' && needs.classify-data.outputs.spa_min_present != '' && needs.classify-data.outputs.version_bump_required != '' && needs.classify-data.outputs.bump_level != '' && needs.classify-data.outputs.bump_basis != ''
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Post two-axis PR comment
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea
        env:
          SHELL_CHANGED: ${{ needs.classify-data.outputs.shell_changed }}
          OLD_CONTRACT: ${{ needs.classify-data.outputs.old_contract }}
          NEW_CONTRACT: ${{ needs.classify-data.outputs.new_contract }}
          CONTRACT_ACTION: ${{ needs.classify-data.outputs.contract_action }}
          OLD_VERSION: ${{ needs.classify-data.outputs.old_version }}
          NEW_VERSION: ${{ needs.classify-data.outputs.new_version }}
          VERSION_ACTION: ${{ needs.classify-data.outputs.version_action }}
          OLD_SPA_MIN: ${{ needs.classify-data.outputs.old_spa_min }}
          NEW_SPA_MIN: ${{ needs.classify-data.outputs.new_spa_min }}
          SPA_MIN_ACTION: ${{ needs.classify-data.outputs.spa_min_action }}
          SPA_MIN_PRESENT: ${{ needs.classify-data.outputs.spa_min_present }}
          VERSION_BUMP_REQUIRED: ${{ needs.classify-data.outputs.version_bump_required }}
          BUMP_LEVEL: ${{ needs.classify-data.outputs.bump_level }}
          BUMP_BASIS: ${{ needs.classify-data.outputs.bump_basis }}
        with:
          script: |
            const { owner, repo } = context.repo;
            const { SPA_MIN_ACTION, BUMP_LEVEL, BUMP_BASIS } = process.env;
            const NA = 'unknown (probe failed)';
            const enumValue = (value, allowed) => allowed.includes(value);
            if (!enumValue(SPA_MIN_ACTION, ['none', 'raised', 'lowered', 'removed'])) return;
            if (!enumValue(BUMP_LEVEL, ['none', 'patch', 'minor', 'major']) ||
                !enumValue(BUMP_BASIS, ['none', 'breaking', 'added', 'ipc', 'notes', 'shell'])) return;
            let liveContract = NA;
            try {
              const response = await fetch('https://api.concordvoice.chat/api/v1/client/config', { signal: AbortSignal.timeout(5000) });
              if (response.ok) {
                const config = await response.json();
                if (typeof config.spaIpcContract === 'number' && Number.isSafeInteger(config.spaIpcContract) && config.spaIpcContract >= 0 && config.spaIpcContract <= 999999999) liveContract = String(config.spaIpcContract);
              }
            } catch (_error) {
              // Preserve the bounded fallback on probe failure.
            }
            const activeContract = liveContract || NA;
            const releaseProbe = await github.rest.repos.listReleases({ owner, repo, per_page: 30 });
            const classifierValues = [process.env.SHELL_CHANGED, process.env.OLD_CONTRACT, process.env.NEW_CONTRACT, process.env.CONTRACT_ACTION, process.env.OLD_VERSION, process.env.NEW_VERSION, process.env.VERSION_ACTION, process.env.OLD_SPA_MIN, process.env.NEW_SPA_MIN, process.env.SPA_MIN_ACTION, process.env.SPA_MIN_PRESENT, process.env.VERSION_BUMP_REQUIRED];
            const number = context.issue.number;
            const current = await github.rest.pulls.get({ owner, repo, pull_number: number });
            if (current.data.state !== 'open' || current.data.base.ref !== 'main' || current.data.head.sha !== context.payload.pull_request.head.sha || current.data.base.sha !== context.payload.pull_request.base.sha) return;
            const labels = current.data.labels.map(label => label.name);
            const hotfix = labels.includes('risk: hotfix');
            const body = `<!-- classify-release -->\n${hotfix ? 'hotfix' : 'standard'}\n${classifierValues.join(' ')}\n${liveContract}\n${releaseProbe.data.length}`;
            await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
YAML
}

new_case() {
  case_number=$((case_number + 1))
  CASE_ROOT="$TMP/case-$case_number"
  write_clean_tree "$CASE_ROOT"
  write_classifier_workflows
}

replace_once() {
  local relative="$1"
  local old="$2"
  local new="$3"
  python3 - "$CASE_ROOT/$relative" "$old" "$new" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
old, new = sys.argv[2:]
text = path.read_text()
if text.count(old) != 1:
    raise SystemExit(f"mutation expected one match in {path}: {old!r}")
path.write_text(text.replace(old, new, 1))
PY
}

replace_in_job_once() {
  local relative="$1"
  local job_id="$2"
  local old="$3"
  local new="$4"
  python3 - "$CASE_ROOT/$relative" "$job_id" "$old" "$new" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
job_id, old, new = sys.argv[2:]
text = path.read_text()
match = re.search(rf"(?m)^  {re.escape(job_id)}:\n", text)
if not match:
    raise SystemExit(f"job not found in {path}: {job_id}")
next_job = re.search(r"(?m)^  [-A-Za-z0-9_]+:\n", text[match.end():])
end = match.end() + next_job.start() if next_job else len(text)
section = text[match.start():end]
if section.count(old) != 1:
    raise SystemExit(f"mutation expected one match in {job_id}: {old!r}")
path.write_text(text[:match.start()] + section.replace(old, new, 1) + text[end:])
PY
}

remove_caller_need() {
  local need="$1"
  python3 - "$CASE_ROOT/.github/workflows/main-ci.yml" "$need" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
need = sys.argv[2]
text = path.read_text()
match = re.search(r"(?m)^    needs: \[([^]]+)\]$", text)
if not match:
    raise SystemExit("caller needs list not found")
needs = [item.strip() for item in match.group(1).split(",")]
needs.remove(need)
path.write_text(text[:match.start()] + f"    needs: [{', '.join(needs)}]" + text[match.end():])
PY
}

add_unexpected_mirror_job() {
  cat >>"$CASE_ROOT/.github/workflows/publish-public-mirror.yml" <<'YAML'
  spare-writer:
    runs-on: ubuntu-latest
    steps: [{run: echo unexpected writer}]
YAML
}

extend_publish_graph_for_prepare_scan_and_extra_job() {
  add_unexpected_mirror_job
}

mutate_prepared_publish_job() {
  local job_id="$1" old="$2" new="$3"
  replace_in_job_once ".github/workflows/publish-public-mirror.yml" "$job_id" "$old" "$new"
}

mutate_preparer_job() {
  local job_id="$1" old="$2" new="$3"
  replace_in_job_once ".github/workflows/publish-public-mirror.yml" "$job_id" "$old" "$new"
}

mutate_scanner_job() {
  local job_id="$1" old="$2" new="$3"
  replace_in_job_once ".github/workflows/publish-public-mirror.yml" "$job_id" "$old" "$new"
}

inject_secret_context_into_scanner() {
  python3 - "$CASE_ROOT/.github/workflows/publish-public-mirror.yml" "$1" "$2" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
job_id, context_form = sys.argv[2:]
contexts = {
    "single": "secrets['PUBLIC_MIRROR_APP_PRIVATE_KEY']",
    "double": 'secrets["PUBLIC_MIRROR_APP_PRIVATE_KEY"]',
    "mixed": "SeCrEtS['PUBLIC_MIRROR_APP_PRIVATE_KEY']",
    "json": "toJSON(secrets)",
    "format": "format('}}{0}', secrets.PUBLIC_MIRROR_APP_PRIVATE_KEY)",
}
if context_form not in contexts:
    raise SystemExit(f"unsupported secret-context fixture: {context_form}")
text = path.read_text()
match = re.search(rf"(?m)^  {re.escape(job_id)}:\n", text)
if not match:
    raise SystemExit(f"scanner job not found: {job_id}")
next_job = re.search(r"(?m)^  [-A-Za-z0-9_]+:\n", text[match.end():])
end = match.end() + next_job.start() if next_job else len(text)
section = text[match.start():end]
family = "mirror" if job_id == "mirror-scan" else "selfhost"
old = ("    steps:\n"
       f"      - run: echo scan {family} data\n"
       "      - run: echo secrets are mentioned here as plain prose only\n")
new = ("    steps:\n"
       f"      - run: echo scan {family} data\n"
       "        env:\n"
       f"          EXFILTRATION_CANARY: ${{{{ {contexts[context_form]} }}}}\n"
       "      - run: echo secrets are mentioned here as plain prose only\n")
if section.count(old) != 1:
    raise SystemExit(f"expected one scanner fixture step in {job_id}")
path.write_text(text[:match.start()] + section.replace(old, new, 1) + text[end:])
PY
}

swap_oidc_and_azure() {
  python3 - "$CASE_ROOT/.github/workflows/build-desktop.yml" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
oidc_start = text.index("      # TEST_MARKER_OIDC_START")
oidc_end = text.index("      # TEST_MARKER_OIDC_END") + len("      # TEST_MARKER_OIDC_END\n")
azure_start = text.index("      # TEST_MARKER_AZURE_START")
azure_end = text.index("      # TEST_MARKER_AZURE_END") + len("      # TEST_MARKER_AZURE_END\n")
oidc = text[oidc_start:oidc_end]
between = text[oidc_end:azure_start]
azure = text[azure_start:azure_end]
path.write_text(text[:oidc_start] + azure + between + oidc + text[azure_end:])
PY
}

make_oidc_comment_only() {
  python3 - "$CASE_ROOT/.github/workflows/build-desktop.yml" <<'PY'
import pathlib

path = pathlib.Path(__import__("sys").argv[1])
text = path.read_text()
start = text.index("        run: |\n", text.index("      # TEST_MARKER_OIDC_START")) + len("        run: |\n")
end = text.index("      # TEST_MARKER_OIDC_END", start)
commented = '''          : # set -euo pipefail
          : # expected_issuer='https://token.actions.githubusercontent.com'
          : # expected_subject='repo:Concord-Voice/Desktop:environment:desktop-release'
          : # expected_audience='api://AzureADTokenExchange'
          : # response="$(curl --fail ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN audience=${expected_audience}
          : # token="$(python3 json.load(sys.stdin) ["value"] <<<"$response"
          : # payload="$(python3 - "$token" .split(".")[1] base64.urlsafe_b64decode(encoded) json.loads(base64.urlsafe_b64decode(encoded))
          : # issuer="$(python3 subject="$(python3 audience="$(python3 ["iss"] ["sub"] ["aud"] <<<"$payload"
          : # if [[ "$issuer" != "$expected_issuer" || "$subject" != "$expected_subject" || "$audience" != "$expected_audience" ]]; then exit 1 fi
'''
path.write_text(text[:start] + commented + text[end:])
PY
}

overwrite_oidc_claims_with_expected() {
  replace_in_job_once \
    ".github/workflows/build-desktop.yml" release-build \
    $'          if [[ "$issuer" != "$expected_issuer" ||' \
    $'          issuer="$expected_issuer"\n          subject="$expected_subject"\n          audience="$expected_audience"\n          if [[ "$issuer" != "$expected_issuer" ||'
}

make_dynamic_matrix() {
  python3 - "$CASE_ROOT/.github/workflows/build-desktop.yml" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
match = re.search(
    r"(?m)^      matrix:\n        include:\n(?:          - \{[^\n]+\}\n){6}",
    text,
)
if not match:
    raise SystemExit("static matrix block not found")
path.write_text(
    text[:match.start()]
    + "      matrix: ${{ fromJSON(needs.detect-release.outputs.matrix) }}\n"
    + text[match.end():]
)
PY
}

policy_case() {
  local label="$1"
  shift
  new_case
  "$@"
  assert_run 1 "ERROR:" "$label" "$SCANNER" "$CASE_ROOT"
}

policy_case_diagnostic() {
  local label="$1"
  local diagnostic="$2"
  shift 2
  new_case
  "$@"
  assert_run 1 "$diagnostic" "$label" "$SCANNER" "$CASE_ROOT"
}

invalid_case() {
  local label="$1"
  shift
  new_case
  "$@"
  assert_run 2 "ERROR:" "$label" "$SCANNER" "$CASE_ROOT"
}

invalid_case_without() {
  local label="$1"
  local diagnostic="$2"
  local forbidden="$3"
  shift 3
  new_case
  "$@"
  assert_run_without 2 "$diagnostic" "$forbidden" "$label" "$SCANNER" "$CASE_ROOT"
}

write_second_caller() {
  cat >"$CASE_ROOT/.github/workflows/second-caller.yml" <<'YAML'
name: Second caller
on: workflow_dispatch
jobs:
  desktop-again:
    uses: ./.github/workflows/build-desktop.yml
YAML
}

make_dispatcher_reusable_caller() {
  python3 - "$CASE_ROOT/.github/workflows/main-ci.yml" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
match = re.search(r"(?m)^  build-desktop:\n", text)
if not match:
    raise SystemExit("build-desktop dispatcher not found")
next_job = re.search(r"(?m)^  [-A-Za-z0-9_]+:\n", text[match.end():])
end = match.end() + next_job.start() if next_job else len(text)
section = (
    "  build-desktop:\n"
    "    needs: [changes, ioc, eslint, codeql, govulncheck, scorecard, build, sonar]\n"
    "    if: success() && needs.changes.outputs.desktop-release == 'true'\n"
    "    uses: ./.github/workflows/build-desktop.yml\n"
)
path.write_text(text[:match.start()] + section + text[end:])
PY
}

displace_dispatch_input() {
  replace_once ".github/workflows/main-ci.yml" \
    $'            -f "inputs[expected_sha]=$EXPECTED_SHA" \\\n' \
    ""
  replace_once ".github/workflows/main-ci.yml" \
    '          echo "::notice::Watching trusted desktop build run ${RUN_ID} for ${EXPECTED_SHA}"' \
    '          echo "::notice::decoy -f \"inputs[expected_sha]=$EXPECTED_SHA\" -f ref=main for ${RUN_ID}"'
}

remove_binding_step() {
  python3 - "$CASE_ROOT/.github/workflows/build-desktop.yml" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
start = text.index("      # TEST_MARKER_BINDING_START")
end = text.index("      # TEST_MARKER_BINDING_END") + len("      # TEST_MARKER_BINDING_END\n")
path.write_text(text[:start] + text[end:])
PY
}

write_qualified_second_caller() {
  cat >"$CASE_ROOT/.github/workflows/qualified-second-caller.yml" <<'YAML'
name: Qualified second caller
on: workflow_dispatch
jobs:
  desktop-again:
    uses: Concord-Voice/Desktop/.github/workflows/build-desktop.yml@main
YAML
}

write_unrelated_signing_reference() {
  cat >"$CASE_ROOT/.github/workflows/unrelated-signing.yml" <<'YAML'
name: Unrelated signing reference
on: workflow_dispatch
jobs:
  inspect:
    runs-on: ubuntu-latest
    env:
      OUT_OF_SCOPE: ${{ secrets.APPLE_CERTIFICATE_P12 }}
    steps:
      - run: echo inspect
YAML
}

make_pr_job_reusable() {
  cat >"$CASE_ROOT/.github/workflows/smoke-reusable.yml" <<'YAML'
name: Smoke reusable
on: workflow_call
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - run: echo smoke
YAML
  python3 - "$CASE_ROOT/.github/workflows/desktop-pr-smoke.yml" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
match = re.search(r"(?m)^  pr-smoke-build:\n", text)
if not match:
    raise SystemExit("pr-smoke-build not found")
next_job = re.search(r"(?m)^  [-A-Za-z0-9_]+:\n", text[match.end():])
end = match.end() + next_job.start() if next_job else len(text)
section = text[match.start():end]
section = section.replace("    runs-on: macos-latest\n", "", 1)
steps = section.index("    steps:\n")
section = section[:steps] + "    uses: ./.github/workflows/smoke-reusable.yml\n\n"
path.write_text(text[:match.start()] + section + text[end:])
PY
}

make_pr_job_call_mirror() {
  python3 - "$CASE_ROOT/.github/workflows/desktop-pr-smoke.yml" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
match = re.search(r"(?m)^  pr-smoke-build:\n", text)
if not match:
    raise SystemExit("pr-smoke-build not found")
next_job = re.search(r"(?m)^  [-A-Za-z0-9_]+:\n", text[match.end():])
end = match.end() + next_job.start() if next_job else len(text)
section = text[match.start():end]
steps = section.index("    steps:\n")
section = section[:steps] + "    uses: ./.github/workflows/publish-public-mirror.yml\n\n"
path.write_text(text[:match.start()] + section + text[end:])
PY
}

add_unrelated_environment_oidc() {
  cat >"$CASE_ROOT/.github/workflows/unrelated-oidc.yml" <<'YAML'
name: Unrelated environment OIDC
on: workflow_dispatch
permissions:
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: echo deploy
YAML
}

add_signing_reference() {
  local name="$1"
  replace_once ".github/workflows/build-desktop.yml" \
    "    # TEST_MARKER_DETECT_JOB" \
    "    env:\n      OUT_OF_PLACE: \${{ secrets.$name }}"
}

add_provision_signing_reference() {
  local name="$1"
  replace_in_job_once ".github/workflows/provision-secrets.yml" provision \
    "          # TEST_MARKER_PROVISION_SIGNING_REFERENCE" \
    "          EXTRA_SIGNING_REFERENCE: \${{ secrets.$name }}"
}

# ADR-0033 exception pinning: the provision job's environment-scoped OIDC
# allowance must not survive a retargeted environment or leak to other jobs.
retarget_provision_environment() {
  replace_in_job_once ".github/workflows/provision-secrets.yml" provision \
    '    environment: ${{ inputs.environment }}' \
    '    environment: production'
}

add_rogue_provision_oidc_job() {
  cat >>"$CASE_ROOT/.github/workflows/provision-secrets.yml" <<'YAML'
  rogue:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write
    steps:
      - run: echo rogue
YAML
}

add_provision_workflow_call() {
  # Turning provision-secrets.yml into a reusable workflow must void the OIDC
  # exception (a caller could invoke the environment-scoped provision job).
  # Insert a `workflow_call:` trigger right after the `on:` line.
  local f="$CASE_ROOT/.github/workflows/provision-secrets.yml"
  awk '{print} /^on:/ && !done {print "  workflow_call:"; done=1}' "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
}

widen_provision_environment_options() {
  # Swapping West staging for desktop-release models the widening attack: the
  # dispatch input can now select the signing environment while the job's
  # `environment: ${{ inputs.environment }}` expression — the thing the OIDC
  # exception pins on — is unchanged.
  replace_once ".github/workflows/provision-secrets.yml" \
    "          - production-west-stage" \
    "          - desktop-release"
}

make_workflow_symlink() {
  local external="$TMP/external-malformed-$case_number.yml"
  printf '%s\n' 'EXTERNAL_SYMLINK_CONTENT_MUST_NOT_LEAK: [' >"$external"
  ln -s "$external" "$CASE_ROOT/.github/workflows/external-link.yml"
}

make_non_utf8_workflow() {
  python3 - "$CASE_ROOT/.github/workflows/non-utf8.yml" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_bytes(b"name: Non UTF-8\non: workflow_dispatch\njobs: {}\n\xff")
PY
}

make_malformed_yaml() {
  replace_once ".github/workflows/build-desktop.yml" \
    "jobs:" \
    "jobs: ["
}

make_duplicate_key() {
  replace_once ".github/workflows/build-desktop.yml" \
    "name: Build Desktop Client" \
    $'name: Build Desktop Client\nname: Duplicate'
}

remove_jobs_mapping() {
  python3 - "$CASE_ROOT/.github/workflows/build-desktop.yml" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
path.write_text(text[:text.index("jobs:\n")])
PY
}

make_non_mapping_workflow() {
  printf '%s\n' '- not' '- a' '- mapping' >"$CASE_ROOT/.github/workflows/build-desktop.yml"
}

make_non_mapping_jobs() {
  python3 - "$CASE_ROOT/.github/workflows/build-desktop.yml" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
path.write_text(text[:text.index("jobs:\n")] + "jobs: []\n")
PY
}

remove_fixed_workflow() {
  rm "$CASE_ROOT/.github/workflows/main-ci.yml"
}

assert_selfhost_publisher_dry_run_behavior() {
  # D: the self-hosted publisher lives in Hosted. Desktop must have no publisher.
  python3 "$REPO_ROOT/.github/scripts/verify-unsigned-desktop.py" "$REPO_ROOT"
  printf 'PASS: Desktop has no signing or publishing consumers\n'
}

selfhost_dry_run_policy_cases() {
  new_case
  assert_run 0 "OK:" "selfhost writer fixture requires normalized explicit dry_run=false" "$SCANNER" "$CASE_ROOT"
  assert_run 0 "PASS:" "actual Desktop workflow delegates publishing and refuses release credentials" assert_selfhost_publisher_dry_run_behavior
  policy_case_diagnostic "selfhost publisher drops the dry_run refusal" \
    "publisher job 'selfhost-release' must use the exact repository, main-ref, and event guard" \
    replace_in_job_once ".github/workflows/publish-public-mirror.yml" selfhost-release \
    "      format('{0}', inputs.dry_run) == 'false' &&" ""
  policy_case_diagnostic "selfhost publisher permits blank and malformed dry_run inputs" \
    "publisher job 'selfhost-release' must use the exact repository, main-ref, and event guard" \
    replace_in_job_once ".github/workflows/publish-public-mirror.yml" selfhost-release \
    "format('{0}', inputs.dry_run) == 'false'" "format('{0}', inputs.dry_run) != 'true'"
  policy_case_diagnostic "selfhost publisher loses dry_run delivery normalization" \
    "publisher job 'selfhost-release' must use the exact repository, main-ref, and event guard" \
    replace_in_job_once ".github/workflows/publish-public-mirror.yml" selfhost-release \
    "format('{0}', inputs.dry_run) == 'false'" "inputs.dry_run == false"
}

if [[ ! -f "$SCANNER" ]]; then
  echo "FATAL: scanner missing: $SCANNER" >&2
  exit 1
fi

if [[ $# -gt 0 ]]; then
  [[ $# -eq 1 && "$1" == --selfhost-dry-run-only ]] || {
    echo 'FATAL: expected no arguments or --selfhost-dry-run-only' >&2
    exit 2
  }
  selfhost_dry_run_policy_cases
  echo "PASS: $pass  FAIL: $fail"
  [[ "$fail" == 0 ]]
  exit
fi

echo "Clean controls"
new_case
assert_smoke_sentinel_behavior
assert_run 0 "OK:" "clean desktop policy and unrelated labeler" "$SCANNER" "$CASE_ROOT"
assert_run 0 "OK:" "repository root defaults to current directory" \
  bash -c 'cd "$1" && "$2"' _ "$CASE_ROOT" "$SCANNER"
assert_run 2 "ERROR:" "extra repository-root argument" "$SCANNER" "$CASE_ROOT" extra
assert_run 2 "ERROR:" "bad repository root" "$SCANNER" "$TMP/not-a-repository"

remove_nightly_need() {
  local need="$1"
  python3 - "$CASE_ROOT/.github/workflows/nightly-ci.yml" "$need" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
need = sys.argv[2]
text = path.read_text()
match = re.search(r"(?m)^    needs: \[([^]]+)\]$", text)
if not match:
    raise SystemExit("nightly release needs list not found")
needs = [item.strip() for item in match.group(1).split(",")]
needs.remove(need)
path.write_text(text[:match.start()] + f"    needs: [{', '.join(needs)}]" + text[match.end():])
PY
}

make_nightly_release_reusable() {
  python3 - "$CASE_ROOT/.github/workflows/nightly-ci.yml" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
match = re.search(r"(?m)^  release:\n", text)
if not match:
    raise SystemExit("release job not found")
head = text[: match.end()]
body = text[match.end() :]
steps = body.index("    steps:")
path.write_text(head + body[:steps] + "    uses: ./.github/workflows/build-desktop.yml\n")
PY
}

remove_nightly_release_job() {
  python3 - "$CASE_ROOT/.github/workflows/nightly-ci.yml" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
match = re.search(r"(?m)^  release:\n", text)
if not match:
    raise SystemExit("release job not found")
following = re.search(r"(?m)^  [-A-Za-z0-9_]+:\n", text[match.end():])
end = match.end() + following.start() if following else len(text)
path.write_text(text[: match.start()] + text[end:])
PY
}

write_third_dispatcher() {
  # An unrelated workflow that POSTs to build-desktop's dispatch endpoint. Before
  # the dispatcher inventory existed, this path had ZERO coverage: the linter knew
  # main-ci by name and never asked who else could dispatch the signed build.
  cat >"$CASE_ROOT/.github/workflows/rogue-dispatcher.yml" <<'YAML'
name: Rogue dispatcher
on: workflow_dispatch
permissions:
  contents: read
jobs:
  sneak:
    runs-on: ubuntu-latest
    permissions:
      actions: write
    steps:
      - name: dispatch
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh api --method POST \
            "repos/$GITHUB_REPOSITORY/actions/workflows/build-desktop.yml/dispatches" \
            -f ref=main
YAML
}

begin_category 1 "desktop triggers"
policy_case "unexpected desktop push trigger" replace_once \
  ".github/workflows/build-desktop.yml" \
  $'on:\n  workflow_dispatch:' \
  $'on:\n  push:\n    branches: [main]\n  workflow_dispatch:'
policy_case_diagnostic "desktop workflow regains pull_request" \
  "build-desktop.yml must be dispatch-only" replace_once \
  ".github/workflows/build-desktop.yml" \
  $'on:\n  workflow_dispatch:' \
  $'on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n  workflow_dispatch:'
policy_case_diagnostic "smoke workflow adds workflow_dispatch" \
  "desktop-pr-smoke.yml must use pull_request only" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  $'  pull_request:\n    types: [opened, synchronize, reopened]' \
  $'  pull_request:\n    types: [opened, synchronize, reopened]\n  workflow_dispatch: {}'
policy_case_diagnostic "desktop workflow regains workflow_call" \
  "dispatch-only: workflow_call loses desktop-release environment secrets" replace_once \
  ".github/workflows/build-desktop.yml" \
  $'on:\n  workflow_dispatch:' \
  $'on:\n  workflow_call: {}\n  workflow_dispatch:'
policy_case_diagnostic "expected_sha input loses its string type" \
  "workflow_dispatch must declare the optional expected_sha string input" replace_once \
  ".github/workflows/build-desktop.yml" \
  "        type: string" \
  "        type: boolean"
policy_case_diagnostic "expected_sha input becomes required" \
  "workflow_dispatch must declare the optional expected_sha string input" replace_once \
  ".github/workflows/build-desktop.yml" \
  $'      expected_sha:\n        required: false' \
  $'      expected_sha:\n        required: true'

begin_category 2 "dispatch-only custody (no reusable callers)"
policy_case "local desktop caller reappears" write_second_caller
policy_case "same-repository qualified desktop caller reappears" write_qualified_second_caller
policy_case_diagnostic "dispatcher regresses to a reusable-workflow caller" \
  "build-desktop.yml is dispatch-only; workflow_call callers are forbidden" \
  make_dispatcher_reusable_caller
policy_case "dispatcher workflow gains an additional tag push filter" replace_once \
  ".github/workflows/main-ci.yml" \
  "    branches: [main]" \
  $'    branches: [main]\n    tags: [desktop-test]'

begin_category 3 "dispatcher dependency set"
for need in changes ioc eslint codeql govulncheck scorecard build sonar; do
  policy_case "dispatcher missing '$need' dependency" remove_caller_need "$need"
done
policy_case "dispatcher has an extra dependency" replace_in_job_once \
  ".github/workflows/main-ci.yml" build-desktop \
  "needs: [changes, ioc, eslint, codeql, govulncheck, scorecard, build, sonar]" \
  "needs: [changes, ioc, eslint, codeql, govulncheck, scorecard, build, sonar, extra]"

begin_category 4 "explicit dispatcher success gate"
policy_case "dispatcher omits explicit success()" replace_in_job_once \
  ".github/workflows/main-ci.yml" build-desktop \
  "if: success() && needs.changes.outputs.desktop-release == 'true' && needs.changes.outputs.hotfix == 'true'" \
  "if: needs.changes.outputs.desktop-release == 'true' && needs.changes.outputs.hotfix == 'true'"
# The hotfix conjunct (ADR-0018 amendment) only ever NARROWS what may be
# dispatched, but dropping it WIDENS the gate back to every merge — which is a
# release-policy change, not a refactor, and must not pass silently.
policy_case "dispatcher drops the hotfix conjunct" replace_in_job_once \
  ".github/workflows/main-ci.yml" build-desktop \
  "if: success() && needs.changes.outputs.desktop-release == 'true' && needs.changes.outputs.hotfix == 'true'" \
  "if: success() && needs.changes.outputs.desktop-release == 'true'"
policy_case "dispatcher success() is not a fail-closed conjunction" replace_in_job_once \
  ".github/workflows/main-ci.yml" build-desktop \
  "if: success() && needs.changes.outputs.desktop-release == 'true'" \
  "if: success() || needs.changes.outputs.desktop-release == 'true'"

begin_category 5 "dispatcher trust contract"
policy_case_diagnostic "dispatcher references secrets context" \
  "build-desktop dispatcher must not map or reference secrets" replace_once \
  ".github/workflows/main-ci.yml" \
  "          # TEST_MARKER_DISPATCHER_ENV" \
  '          TOKEN: ${{ secrets.GITHUB_TOKEN }}'
policy_case_diagnostic "dispatcher gains an environment" \
  "build-desktop dispatcher must not reference an environment" replace_once \
  ".github/workflows/main-ci.yml" \
  "    # TEST_MARKER_DISPATCHER_JOB" \
  "    environment: staging"
policy_case_diagnostic "dispatcher permissions drift" \
  "build-desktop dispatcher permissions must be exactly actions: write and checks: read" replace_once \
  ".github/workflows/main-ci.yml" \
  "      # TEST_MARKER_DISPATCHER_PERMISSION" \
  "      contents: write"
policy_case_diagnostic "dispatcher loses the gated SHA binding" \
  "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract" replace_once \
  ".github/workflows/main-ci.yml" \
  '          EXPECTED_SHA: ${{ github.sha }}' \
  '          EXPECTED_SHA: ${{ github.ref }}'
policy_case_diagnostic "dispatcher stops awaiting the child run" \
  "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract" replace_once \
  ".github/workflows/main-ci.yml" \
  '          gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --compact --exit-status' \
  '          echo "fire and forget"'
policy_case_diagnostic "dispatcher swallows child failure" \
  "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract" replace_once \
  ".github/workflows/main-ci.yml" \
  '          gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --compact --exit-status' \
  '          gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --compact --exit-status || true'
policy_case_diagnostic "dispatcher tolerates failure via continue-on-error" \
  "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract" replace_once \
  ".github/workflows/main-ci.yml" \
  "      - name: Dispatch and await trusted desktop build" \
  $'      - name: Dispatch and await trusted desktop build\n        continue-on-error: true'
# The next two strings are plain single-quoted on purpose, and each ends in ONE literal backslash.
# Written as $'...\\' they desynchronise Semgrep's bash grammar, which reads the \' as an escaped
# quote and swallows the text after it (internal-reference P18).
policy_case_diagnostic "dispatcher dispatches an unpinned ref" \
  "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract" replace_once \
  ".github/workflows/main-ci.yml" \
  '            -f ref=main \' \
  '            -f "ref=$GITHUB_REF" \'
policy_case_diagnostic "dispatcher omits the expected_sha dispatch input" \
  "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract" replace_once \
  ".github/workflows/main-ci.yml" \
  $'            -f "inputs[expected_sha]=$EXPECTED_SHA" \\\n' \
  ""
policy_case_diagnostic "dispatcher displaces the dispatch input into a log line" \
  "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract" \
  displace_dispatch_input
policy_case_diagnostic "dispatcher adds a second step" \
  "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract" replace_once \
  ".github/workflows/main-ci.yml" \
  "      - name: Dispatch and await trusted desktop build" \
  $'      - name: Prepare decoy\n        run: echo decoy\n      - name: Dispatch and await trusted desktop build'
policy_case_diagnostic "detect-release checkout pins a dispatched ref" \
  "detect-release must have exactly one checkout with only fetch-depth: 0" replace_in_job_once \
  ".github/workflows/build-desktop.yml" detect-release \
  "          fetch-depth: 0" \
  $'          fetch-depth: 0\n          ref: decoy'
policy_case_diagnostic "detect-release drops the dispatched SHA binding" \
  "detect-release must fail closed when the dispatched expected_sha no longer matches main HEAD" \
  remove_binding_step
policy_case_diagnostic "dispatched SHA binding does not exit" \
  "detect-release must fail closed when the dispatched expected_sha no longer matches main HEAD" replace_in_job_once \
  ".github/workflows/build-desktop.yml" detect-release \
  "            exit 1" \
  "            echo mismatch"
policy_case_diagnostic "dispatched SHA binding redirects BASH_ENV" \
  "detect-release must fail closed when the dispatched expected_sha no longer matches main HEAD" replace_in_job_once \
  ".github/workflows/build-desktop.yml" detect-release \
  "          BASH_ENV: /dev/null" \
  "          BASH_ENV: ./attacker.sh"
policy_case_diagnostic "dispatched SHA binding compares a different input" \
  "detect-release must fail closed when the dispatched expected_sha no longer matches main HEAD" replace_in_job_once \
  ".github/workflows/build-desktop.yml" detect-release \
  '          EXPECTED_SHA: ${{ inputs.expected_sha }}' \
  '          EXPECTED_SHA: ${{ inputs.force_release }}'

begin_category 6 "desktop PR permissions"
policy_case "PR job gains contents write" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-build \
  "contents: read" "contents: write"
for permission in id-token attestations deployments; do
  policy_case "PR job gains $permission write" replace_once \
    ".github/workflows/desktop-pr-smoke.yml" \
    "      # TEST_MARKER_PR_PERMISSION" \
    "      $permission: write"
done
policy_case "PR paths filter loses pull-requests read" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-paths-filter \
  $'      pull-requests: read\n' ""
policy_case "PR paths filter gains pull-requests write" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-paths-filter \
  "pull-requests: read" "pull-requests: write"
policy_case "PR result job gains contents read" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-result \
  "permissions: {}" $'permissions:\n      contents: read'

begin_category 7 "desktop PR capabilities/operations"
policy_case_diagnostic "PR job references a general environment" \
  "PR-reachable job 'pr-smoke-build' must not reference an environment" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "    # TEST_MARKER_PR_JOB" \
  "    environment: staging"
policy_case "PR job references secrets context" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "    # TEST_MARKER_PR_JOB" \
  $'    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}'
policy_case "PR job uses bracket-index secrets context" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "    # TEST_MARKER_PR_JOB" \
  $'    env:\n      TOKEN: ${{ secrets["GITHUB_TOKEN"] }}'
policy_case "PR workflow exposes a secret through workflow env" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  $'jobs:\n' \
  $'env:\n  TOKEN: ${{ secrets.GITHUB_TOKEN }}\njobs:\n'
policy_case "PR job runs signing operation" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Sign application\n        run: codesign --verify app'
policy_case_diagnostic "PR job runs cosign sign-blob" \
  "prohibited operation(s): signing" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Sign blob\n        run: cosign sign-blob app.tar.gz'
policy_case_diagnostic "PR job runs Azure Trusted Signing action" \
  "PR-reachable job 'pr-smoke-build' has prohibited operation(s): signing" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Sign with Azure Trusted Signing\n        uses: azure/trusted-signing-action@v0.5.1'
policy_case "PR job runs notarization" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Notarize application\n        run: xcrun notarytool submit app.zip'
policy_case "PR job persists an attestation" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Attest build\n        uses: actions/attest-build-provenance@v3'
policy_case "PR job creates a release" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Create release\n        run: gh release create desktop-v1.2.3'
policy_case "PR job publishes a package" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Publish package\n        run: npm publish'
policy_case "PR job uploads an artifact" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Upload smoke artifact\n        uses: actions/upload-artifact@v7\n        with:\n          path: out'
policy_case "PR job calls the artifact API" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Fetch artifact\n        run: gh api repos/acme/repo/actions/artifacts'
policy_case_diagnostic "PR job calls the run-artifacts API" \
  "prohibited operation(s): cross-run artifact retrieval" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "      # TEST_MARKER_PR_STEP" \
  $'      - name: Fetch run artifact\n        run: gh api repos/acme/repo/actions/runs/123/artifacts'
policy_case_diagnostic "PR job becomes a reusable-workflow caller" \
  "desktop-pr-smoke.yml jobs must be normal step jobs" make_pr_job_reusable
policy_case "unexpected job becomes PR reachable" replace_in_job_once \
  ".github/workflows/build-desktop.yml" dispatch-summary \
  "if: github.event_name == 'workflow_dispatch'" \
  "if: github.event_name == 'pull_request'"
policy_case "unexpected job uses a fail-open PR exclusion" replace_in_job_once \
  ".github/workflows/build-desktop.yml" dispatch-summary \
  "if: github.event_name == 'workflow_dispatch'" \
  "if: github.event_name != 'pull_request' || github.event_name == 'pull_request'"
policy_case_diagnostic "unexpected job OR-injects a pull-request path after a non-PR conjunct" \
  "job 'dispatch-summary' is an undesignated pull-request path" replace_in_job_once \
  ".github/workflows/build-desktop.yml" dispatch-summary \
  "if: github.event_name == 'workflow_dispatch'" \
  "if: github.event_name != 'pull_request' && true || github.event_name == 'pull_request'"
policy_case "required PR job is renamed" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  $'  pr-smoke-build:\n' \
  $'  renamed-smoke-build:\n'

begin_category 8 "undesignated environment or environment+OIDC"
policy_case "undesignated desktop job uses desktop-release" replace_once \
  ".github/workflows/build-desktop.yml" \
  "    # TEST_MARKER_DETECT_JOB" \
  "    environment: desktop-release"
policy_case "unrelated workflow combines environment and inherited OIDC" \
  add_unrelated_environment_oidc
policy_case "unrelated workflow job uses desktop-release" replace_once \
  ".github/workflows/labeler.yml" \
  $'  label:\n' \
  $'  label:\n    environment: desktop-release\n'
policy_case_diagnostic "reserved environment expression on unrelated job" \
  "desktop-release environment is forbidden on job 'label'" replace_once \
  ".github/workflows/labeler.yml" \
  $'  label:\n' \
  $'  label:\n    environment: ${{ \'desktop-release\' }}\n'

begin_category 9 "trusted-job contract"
policy_case_diagnostic "workflow-level BASH_ENV reaches trusted shells" \
  "desktop workflow must not define inherited env or defaults" replace_once \
  ".github/workflows/build-desktop.yml" \
  $'permissions:\n  contents: read' \
  $'env:\n  BASH_ENV: ./attacker.sh\n\npermissions:\n  contents: read'
policy_case_diagnostic "workflow-level working-directory reaches trusted shells" \
  "desktop workflow must not define inherited env or defaults" replace_once \
  ".github/workflows/build-desktop.yml" \
  $'permissions:\n  contents: read' \
  $'defaults:\n  run:\n    working-directory: decoy\n\npermissions:\n  contents: read'
policy_case_diagnostic "release-build BASH_ENV reaches trusted shells" \
  "release-build must not define inherited env or defaults" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "    environment: desktop-release" \
  $'    environment: desktop-release\n    env:\n      BASH_ENV: ./attacker.sh'
policy_case_diagnostic "release defaults reach artifact shells" \
  "release must not define inherited env or defaults" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "    environment: desktop-release" \
  $'    environment: desktop-release\n    defaults:\n      run:\n        working-directory: decoy'
policy_case_diagnostic "release adds a container execution context" \
  "release must not define a container execution context" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "    environment: desktop-release" \
  $'    environment: desktop-release\n    container:\n      image: attacker.invalid/release-tools:latest\n      env:\n        BASH_ENV: ./attacker.sh'
policy_case_diagnostic "release moves to a self-hosted runner" \
  "release must use exactly runs-on: ubuntu-latest" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "    runs-on: ubuntu-latest" \
  "    runs-on: [self-hosted, linux]"
policy_case_diagnostic "release-build runner stops following the fixed matrix" \
  'release-build must use exactly runs-on: ${{ matrix.os }}' replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  '    runs-on: ${{ matrix.os }}' \
  "    runs-on: windows-latest"
policy_case_diagnostic "release-build tolerates job failure" \
  "release-build trusted job keys must match the reviewed contract" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "    environment: desktop-release" \
  $'    environment: desktop-release\n    continue-on-error: true'
policy_case_diagnostic "release adds unreviewed services" \
  "release trusted job keys must match the reviewed contract" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "    environment: desktop-release" \
  $'    environment: desktop-release\n    services:\n      helper:\n        image: attacker.invalid/helper:latest'
policy_case_diagnostic "preceding step persists BASH_ENV through GITHUB_ENV" \
  "trusted jobs may persist only the exact Apple API key path" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "      # TEST_MARKER_OIDC_START" \
  $'      - name: Persist attacker BASH_ENV\n        shell: bash\n        run: echo "BASH_ENV=./attacker.sh" >> "$GITHUB_ENV"\n\n      # TEST_MARKER_OIDC_START'
policy_case_diagnostic "preceding step prepends an attacker GITHUB_PATH" \
  "trusted jobs may persist only the exact Apple API key path" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "      # TEST_MARKER_OIDC_START" \
  $'      - name: Persist attacker PATH\n        shell: bash\n        run: echo "$PWD/attacker-bin" >> "$GITHUB_PATH"\n\n      # TEST_MARKER_OIDC_START'
policy_case_diagnostic "approved Apple key-path export is missing" \
  "trusted jobs must contain exactly one approved Apple API key path export" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  '        run: echo "APPLE_API_KEY=${KEY_PATH}" >> "$GITHUB_ENV"' \
  '        run: echo "Apple API key path export removed"'
policy_case_diagnostic "approved Apple key-path export is duplicated" \
  "trusted jobs must contain exactly one approved Apple API key path export" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  '        run: echo "APPLE_API_KEY=${KEY_PATH}" >> "$GITHUB_ENV"' \
  $'        run: |\n          echo "APPLE_API_KEY=${KEY_PATH}" >> "$GITHUB_ENV"\n          echo "APPLE_API_KEY=${KEY_PATH}" >> "$GITHUB_ENV"'
for job in release-build release; do
  policy_case "$job omits exact repository guard" replace_in_job_once \
    ".github/workflows/build-desktop.yml" "$job" \
    "      github.repository == 'Concord-Voice/Desktop' &&" \
    ""
  policy_case "$job omits exact main ref guard" replace_in_job_once \
    ".github/workflows/build-desktop.yml" "$job" \
    "      github.ref == 'refs/heads/main' &&" \
    ""
  policy_case_diagnostic "$job uses a valid but overbroad event guard" \
    "$job condition must match the exact trusted release guard" replace_in_job_once \
    ".github/workflows/build-desktop.yml" "$job" \
    "      github.event_name == 'workflow_dispatch' &&" \
    "      github.event_name != 'pull_request' &&"
  policy_case "$job omits desktop-release environment" replace_in_job_once \
    ".github/workflows/build-desktop.yml" "$job" \
    $'    environment: desktop-release\n' \
    ""
done
policy_case "release-build omits detect-release success guard" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "      needs.detect-release.result == 'success' &&" \
  ""
policy_case "release-build repository guard is not a conjunction" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "      github.repository == 'Concord-Voice/Desktop' &&" \
  "      github.repository == 'Concord-Voice/Desktop' ||"
policy_case "release-build omits should-release guard" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "      needs.detect-release.outputs.should_release == 'true'" \
  "      true"
policy_case "release omits release-build success guard" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "      needs.release-build.result == 'success' &&" \
  ""
policy_case_diagnostic "release-build guard accepts OR-injected PRs" \
  "release-build condition must match the exact trusted release guard" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "      needs.detect-release.outputs.should_release == 'true'" \
  "      needs.detect-release.outputs.should_release == 'true' && true || github.event_name == 'pull_request'"
policy_case_diagnostic "release guard omits load-bearing always()" \
  "release condition must match the exact trusted release guard" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  $'      always() &&\n' \
  ""
policy_case_diagnostic "release trusted guard clauses are reordered" \
  "release condition must match the exact trusted release guard" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  $'      github.repository == \'Concord-Voice/Desktop\' &&\n      github.ref == \'refs/heads/main\' &&' \
  $'      github.ref == \'refs/heads/main\' &&\n      github.repository == \'Concord-Voice/Desktop\' &&'
policy_case_diagnostic "release-build trusted guard clauses are reordered" \
  "release-build condition must match the exact trusted release guard" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      github.repository == \'Concord-Voice/Desktop\' &&\n      github.ref == \'refs/heads/main\' &&' \
  $'      github.ref == \'refs/heads/main\' &&\n      github.repository == \'Concord-Voice/Desktop\' &&'
policy_case "release-build matrix loses one platform" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          - {os: ubuntu-latest, platform: linux, arch: arm64, label: linux-arm64}\n' \
  ""
policy_case "release-build matrix becomes dynamic" make_dynamic_matrix
policy_case "release-build matrix gains an extra platform" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          - {os: ubuntu-latest, platform: linux, arch: arm64, label: linux-arm64}" \
  $'          - {os: ubuntu-latest, platform: linux, arch: arm64, label: linux-arm64}\n          - {os: freebsd-latest, platform: freebsd, arch: x64, label: freebsd-x64}'
policy_case_diagnostic "release-build matrix gains an extra dimension" \
  "release-build must use the exact static six-entry release matrix" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      matrix:\n        include:' \
  $'      matrix:\n        node: [24]\n        include:'
policy_case_diagnostic "OIDC validator contract exists only in inline shell comments" \
  "OIDC validator must assign each exact expected claim exactly once" \
  make_oidc_comment_only
policy_case_diagnostic "OIDC validator exits successfully before strict mode" \
  "OIDC validator must start with set -euo pipefail and reject successful early termination" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          set -euo pipefail" \
  $'          exit 0\n          set -euo pipefail'
policy_case_diagnostic "OIDC validator uses a bare successful return" \
  "OIDC validator must start with set -euo pipefail and reject successful early termination" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          expected_audience='api://AzureADTokenExchange'" \
  $'          expected_audience=\'api://AzureADTokenExchange\'\n          return'
policy_case_diagnostic "OIDC validator returns success explicitly" \
  "OIDC validator must start with set -euo pipefail and reject successful early termination" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          expected_audience='api://AzureADTokenExchange'" \
  $'          expected_audience=\'api://AzureADTokenExchange\'\n          return 0'
policy_case_diagnostic "OIDC validator hides a successful exit in a compound command" \
  "OIDC validator must start with set -euo pipefail and reject successful early termination" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          expected_audience='api://AzureADTokenExchange'" \
  $'          expected_audience=\'api://AzureADTokenExchange\'\n          if true; then exit 0; fi'
policy_case_diagnostic "OIDC validator redirects a successful exit" \
  "OIDC validator must start with set -euo pipefail and reject successful early termination" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          expected_audience='api://AzureADTokenExchange'" \
  $'          expected_audience=\'api://AzureADTokenExchange\'\n          if true; then exit 0 >/dev/null; fi'
policy_case_diagnostic "OIDC validator redirects a bare exit" \
  "OIDC validator must start with set -euo pipefail and reject successful early termination" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          expected_audience='api://AzureADTokenExchange'" \
  $'          expected_audience=\'api://AzureADTokenExchange\'\n          if true; then exit >/dev/null; fi'
policy_case_diagnostic "OIDC validator step is disabled" \
  "OIDC validation step must use exactly if: matrix.platform == 'win32'" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Validate environment OIDC claims\n        if: matrix.platform == \'win32\'' \
  $'      - name: Validate environment OIDC claims\n        if: false'
policy_case_diagnostic "OIDC validator tolerates failure" \
  "OIDC validation step must not use continue-on-error" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Validate environment OIDC claims\n        if: matrix.platform == \'win32\'' \
  $'      - name: Validate environment OIDC claims\n        if: matrix.platform == \'win32\'\n        continue-on-error: true'
policy_case_diagnostic "OIDC validator shell swallows failure" \
  "OIDC validation step must use exactly shell: bash" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Validate environment OIDC claims\n        if: matrix.platform == \'win32\'\n        shell: bash' \
  $'      - name: Validate environment OIDC claims\n        if: matrix.platform == \'win32\'\n        shell: bash {0} || true'
policy_case_diagnostic "OIDC validator redirects BASH_ENV" \
  "OIDC validation step must isolate BASH_ENV" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Validate environment OIDC claims\n        if: matrix.platform == \'win32\'\n        shell: bash\n        env:\n          BASH_ENV: /dev/null' \
  $'      - name: Validate environment OIDC claims\n        if: matrix.platform == \'win32\'\n        shell: bash\n        env:\n          BASH_ENV: ./attacker.sh'
policy_case_diagnostic "OIDC validator is not directly before azure login" \
  "OIDC validation step must be directly before azure/login" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      # TEST_MARKER_OIDC_END\n\n      # TEST_MARKER_AZURE_START' \
  $'      # TEST_MARKER_OIDC_END\n\n      - name: Gap before Azure login\n        run: true\n\n      # TEST_MARKER_AZURE_START'
policy_case_diagnostic "OIDC validator overwrites parsed claims with expected values" \
  "OIDC validator must read issuer, subject, and audience from parsed payload claims" \
  overwrite_oidc_claims_with_expected
policy_case_diagnostic "OIDC expected claims are reassigned from parsed claims" \
  "OIDC validator must assign each exact expected claim exactly once" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          audience="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["aud"])\' <<<"$payload")"' \
  $'          audience="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["aud"])\' <<<"$payload")"\n          expected_issuer="$issuer"\n          expected_subject="$subject"\n          expected_audience="$audience"'
policy_case_diagnostic "OIDC expected issuer is indirectly reassigned" \
  "OIDC validator must match the exact reviewed shell contract" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          audience="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["aud"])\' <<<"$payload")"' \
  $'          audience="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["aud"])\' <<<"$payload")"\n          eval \'expected_\'issuer\'="$issuer"\''
policy_case_diagnostic "OIDC validator adds an unreviewed unbraced variable" \
  "OIDC validator must match the exact reviewed shell contract" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          expected_audience='api://AzureADTokenExchange'" \
  $'          expected_audience=\'api://AzureADTokenExchange\'\n          token_extra=\'safe\'\n          printf \'%s\\n\' "$token_extra"'
policy_case_diagnostic "OIDC validator adds an unreviewed braced variable" \
  "OIDC validator must match the exact reviewed shell contract" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          expected_audience='api://AzureADTokenExchange'" \
  $'          expected_audience=\'api://AzureADTokenExchange\'\n          token_extra=\'safe\'\n          printf \'%s\\n\' "${token_extra}"'
policy_case_diagnostic "OIDC validator prints the full token" \
  "OIDC validator must not print or persist the full token" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          token="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["value"])\' <<<"$response")"' \
  $'          token="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["value"])\' <<<"$response")"\n          echo "$token"'
policy_case_diagnostic "OIDC validator persists the full token" \
  "OIDC validator must not print or persist the full token" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          token="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["value"])\' <<<"$response")"' \
  $'          token="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["value"])\' <<<"$response")"\n          printf \'%s\' "$token" > token.txt'
policy_case_diagnostic "OIDC validator leaks a token substring expansion" \
  "OIDC validator must not print or persist the full token" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          token="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["value"])\' <<<"$response")"' \
  $'          token="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["value"])\' <<<"$response")"\n          env LEAK="${token:0}" printenv LEAK'
policy_case_diagnostic "OIDC validator prints the decoded payload" \
  "OIDC validator must not print or persist the full token" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          audience="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["aud"])\' <<<"$payload")"' \
  $'          audience="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["aud"])\' <<<"$payload")"\n          printf \'%s\\n\' "${payload}"'
policy_case_diagnostic "OIDC validator has wrong issuer" \
  "OIDC validator must assign each exact expected claim exactly once" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "https://token.actions.githubusercontent.com" \
  "https://issuer.example.invalid"
policy_case_diagnostic "OIDC validator has wrong subject" \
  "OIDC validator must assign each exact expected claim exactly once" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "repo:Concord-Voice/Desktop:environment:desktop-release" \
  "repo:Concord-Voice/Desktop:ref:refs/heads/main"
policy_case_diagnostic "OIDC validator has wrong audience" \
  "OIDC validator must assign each exact expected claim exactly once" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "api://AzureADTokenExchange" \
  "api://wrong-audience"
policy_case_diagnostic "OIDC validator does not request a token" \
  "OIDC validator must request a runner ID token" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "curl --fail --silent --show-error" \
  "printf '%s'"
policy_case_diagnostic "OIDC validator does not base64url-decode claims" \
  "OIDC validator must decode and parse JWT claims in memory" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "base64.urlsafe_b64decode(encoded)" \
  "encoded"
policy_case_diagnostic "OIDC validator does not parse JSON claims" \
  "OIDC validator must decode and parse JWT claims in memory" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "json.loads(base64.urlsafe_b64decode(encoded))" \
  "dict(base64.urlsafe_b64decode(encoded))"
policy_case_diagnostic "OIDC validator comparison is fail-open" \
  "OIDC validator must fail closed on exact issuer, subject, and audience claims" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  'if [[ "$issuer" != "$expected_issuer" ||' \
  'if false && [[ "$issuer" != "$expected_issuer" ||'
policy_case_diagnostic "OIDC validator mismatch branch does not exit" \
  "OIDC validator must fail closed on exact issuer, subject, and audience claims" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          if [[ "$issuer" != "$expected_issuer" || "$subject" != "$expected_subject" || "$audience" != "$expected_audience" ]]; then\n            exit 1' \
  $'          if [[ "$issuer" != "$expected_issuer" || "$subject" != "$expected_subject" || "$audience" != "$expected_audience" ]]; then\n            echo mismatch'
policy_case_diagnostic "OIDC validator step identity drifts" \
  "OIDC validation step must use the exact fixed identity" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "name: Validate environment OIDC claims" \
  "name: Mention expected OIDC literals"
policy_case_diagnostic "OIDC validator runs after azure login" \
  "OIDC validation must precede azure/login" swap_oidc_and_azure
policy_case_diagnostic "azure login bypasses validator failure with always" \
  "azure/login must use exactly if: matrix.platform == 'win32'" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Azure login\n        if: matrix.platform == \'win32\'' \
  $'      - name: Azure login\n        if: always() && matrix.platform == \'win32\''
policy_case_diagnostic "azure login tolerates failure" \
  "azure/login must not use continue-on-error" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Azure login\n        if: matrix.platform == \'win32\'' \
  $'      - name: Azure login\n        if: matrix.platform == \'win32\'\n        continue-on-error: true'
policy_case "release-build omits azure login" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "uses: azure/login@v3" \
  "run: echo azure-login-removed"
policy_case "release-build trusted permissions drift" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "contents: read" \
  "contents: write"
policy_case "release trusted permissions drift" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "attestations: read" \
  "attestations: write"

begin_category 10 "trusted checkout/HEAD custody"
policy_case "trusted checkout overrides repository" replace_once \
  ".github/workflows/build-desktop.yml" \
  "          # TEST_MARKER_CHECKOUT_INPUT" \
  "          repository: attacker/example"
policy_case_diagnostic "trusted checkout persists credentials" \
  "trusted checkout inputs must match the exact reviewed contract" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          persist-credentials: false" \
  "          persist-credentials: true"
policy_case_diagnostic "trusted checkout uses shallow history" \
  "trusted checkout inputs must match the exact reviewed contract" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "          fetch-depth: 0" \
  "          fetch-depth: 1"
policy_case "trusted checkout uses a dynamic non-current ref" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  'ref: ${{ github.sha }}' \
  'ref: ${{ github.ref }}'
policy_case_diagnostic "trusted checkout uses literal github.sha" \
  'trusted checkout ref must be the exact ${{ github.sha }} expression' replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  'ref: ${{ github.sha }}' \
  'ref: github.sha'
policy_case "trusted checkout omits checkout action" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "uses: actions/checkout@v7" \
  "run: echo checkout-removed"
policy_case "trusted checkout has no later HEAD assertion" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "git rev-parse HEAD" \
  "git log -1 --format=%H"
policy_case "trusted HEAD assertion compares the wrong ref" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  '"$actual" != "$GITHUB_SHA"' \
  '"$actual" != "$GITHUB_REF"'
policy_case_diagnostic "trusted HEAD assertion only prints a comparison" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          if [[ "$actual" != "$GITHUB_SHA" ]]; then\n            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'          echo "$actual != $GITHUB_SHA"'
policy_case_diagnostic "trusted HEAD assertion is nested in an unreachable branch" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          actual="$(git rev-parse HEAD)"\n          if [[ "$actual" != "$GITHUB_SHA" ]]; then\n            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'          actual="$(git rev-parse HEAD)"\n          if false; then\n            if [[ "$actual" != "$GITHUB_SHA" ]]; then\n              printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n              exit 1\n            fi\n          fi'
policy_case_diagnostic "trusted HEAD mismatch branch does not exit" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1' \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            echo mismatch'
policy_case_diagnostic "trusted HEAD assertion is unreachable after exit" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          actual="$(git rev-parse HEAD)"' \
  $'          exit 0\n          actual="$(git rev-parse HEAD)"'
policy_case_diagnostic "trusted HEAD assertion step is disabled" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Verify exact trusted HEAD\n        shell: bash' \
  $'      - name: Verify exact trusted HEAD\n        if: false\n        shell: bash'
policy_case_diagnostic "trusted HEAD assertion tolerates failure" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Verify exact trusted HEAD\n        shell: bash' \
  $'      - name: Verify exact trusted HEAD\n        continue-on-error: true\n        shell: bash'
policy_case_diagnostic "trusted HEAD assertion redirects BASH_ENV" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Verify exact trusted HEAD\n        shell: bash\n        env:\n          BASH_ENV: /dev/null' \
  $'      - name: Verify exact trusted HEAD\n        shell: bash\n        env:\n          BASH_ENV: ./attacker.sh'
policy_case_diagnostic "trusted HEAD assertion changes shell" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'      - name: Verify exact trusted HEAD\n        shell: bash' \
  $'      - name: Verify exact trusted HEAD\n        shell: pwsh'
policy_case_diagnostic "trusted HEAD assertion is not immediately after checkout" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'          # TEST_MARKER_CHECKOUT_INPUT\n\n      - name: Verify exact trusted HEAD' \
  $'          # TEST_MARKER_CHECKOUT_INPUT\n\n      - name: Gap after checkout\n        run: true\n\n      - name: Verify exact trusted HEAD'
policy_case_diagnostic "trusted HEAD mismatch exits with the wrong status" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 2\n          fi'
policy_case_diagnostic "trusted HEAD mismatch exits successfully before failure" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 0\n            exit 1\n          fi'
policy_case_diagnostic "trusted HEAD mismatch uses a bare return before failure" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            return\n            exit 1\n          fi'
policy_case_diagnostic "trusted HEAD mismatch returns success before failure" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            return 0\n            exit 1\n          fi'
policy_case_diagnostic "trusted HEAD mismatch hides a return in a compound command" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            if true; then return 0; fi\n            exit 1\n          fi'
policy_case_diagnostic "trusted HEAD mismatch redirects a return" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            if true; then return 0 >/dev/null; fi\n            exit 1\n          fi'
policy_case_diagnostic "trusted HEAD mismatch redirects a bare exit" \
  "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            exit 1\n          fi' \
  $'            printf \'expected=%s actual=%s\\n\' "$GITHUB_SHA" "$actual" >&2\n            if true; then exit >/dev/null; fi\n            exit 1\n          fi'

begin_category 11 "artifact custody/promotion ownership"
for input in run-id repository github-token; do
  policy_case "release download sets cross-run '$input'" replace_once \
    ".github/workflows/build-desktop.yml" \
    "          # TEST_MARKER_DOWNLOAD_INPUT" \
    "          $input: untrusted"
done
policy_case "release invokes gh run download" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "./desktop/scripts/sign-linux-update.mjs" \
  $'gh run download 1234\n          ./desktop/scripts/sign-linux-update.mjs'
policy_case "release no longer needs release-build" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "needs: [detect-release, release-build]" \
  "needs: [detect-release]"
policy_case "release omits same-run download" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "uses: actions/download-artifact@v8" \
  "run: echo download-removed"
policy_case_diagnostic "release does not empty the artifact directory before download" \
  "release must empty the artifact directory immediately before download" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "          rm -rf -- artifacts" \
  "          echo keep-checked-out-artifacts"
policy_case_diagnostic "release artifact preparation redirects BASH_ENV" \
  "release must empty the artifact directory immediately before download" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  $'      - name: Prepare empty release artifact directory\n        shell: bash\n        env:\n          BASH_ENV: /dev/null' \
  $'      - name: Prepare empty release artifact directory\n        shell: bash\n        env:\n          BASH_ENV: ./attacker.sh'
policy_case_diagnostic "release download broadens the artifact namespace" \
  "release download must use the exact current-run artifact namespace" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "          pattern: concord-voice-*" \
  "          pattern: '*'"
policy_case_diagnostic "release artifact assertion accepts a seventh directory" \
  "release must verify the exact six release-build artifact directories" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "            # TEST_MARKER_ARTIFACT_EXPECTED_EXTRA" \
  '            "concord-voice-evil-x64-v${VERSION}"'
policy_case_diagnostic "release artifact assertion loses an expected directory" \
  "release must verify the exact six release-build artifact directories" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  $'            "concord-voice-linux-arm64-v${VERSION}"\n' \
  ""
policy_case_diagnostic "release artifact assertion tolerates failure" \
  "release must verify the exact six release-build artifact directories" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  $'      - name: Verify exact release-build artifact set\n        shell: bash' \
  $'      - name: Verify exact release-build artifact set\n        continue-on-error: true\n        shell: bash'
policy_case_diagnostic "release artifact assertion changes working directory" \
  "release must verify the exact six release-build artifact directories" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  $'      - name: Verify exact release-build artifact set\n        shell: bash' \
  $'      - name: Verify exact release-build artifact set\n        shell: bash\n        working-directory: decoy'
policy_case_diagnostic "release artifact assertion redirects BASH_ENV" \
  "release must verify the exact six release-build artifact directories" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  $'      - name: Verify exact release-build artifact set\n        shell: bash\n        env:\n          BASH_ENV: /dev/null' \
  $'      - name: Verify exact release-build artifact set\n        shell: bash\n        env:\n          BASH_ENV: ./attacker.sh'
policy_case "release-build omits promotion upload" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release-build \
  "uses: actions/upload-artifact@v7" \
  "run: echo upload-removed"
policy_case "release job uploads promotion artifact" replace_in_job_once \
  ".github/workflows/build-desktop.yml" release \
  "uses: actions/download-artifact@v8" \
  "uses: actions/upload-artifact@v7"
policy_case "undesignated desktop job uploads artifact" replace_in_job_once \
  ".github/workflows/build-desktop.yml" dispatch-summary \
  '- run: echo "dispatch complete"' \
  $'- uses: actions/upload-artifact@v7\n        with:\n          path: out'
policy_case_diagnostic "non-PR desktop job calls the run-artifacts API" \
  "cross-run artifact retrieval is forbidden in job 'dispatch-summary'" replace_in_job_once \
  ".github/workflows/build-desktop.yml" dispatch-summary \
  'run: echo "dispatch complete"' \
  "run: gh api repos/acme/repo/actions/runs/123/artifacts"
policy_case_diagnostic "non-PR desktop job calls a dynamic run-artifacts API" \
  "cross-run artifact retrieval is forbidden in job 'dispatch-summary'" replace_in_job_once \
  ".github/workflows/build-desktop.yml" dispatch-summary \
  'run: echo "dispatch complete"' \
  $'run: gh api "repos/acme/repo/actions/runs/${{ github.event.inputs.run_id }}/artifacts"'

begin_category 12 "signing-reference placement"
policy_case_diagnostic "unrelated workflow references a signing value" \
  "signing references are forbidden outside build-desktop release-build/release" \
  write_unrelated_signing_reference
policy_case "signing reference appears in workflow-level env" replace_once \
  ".github/workflows/build-desktop.yml" \
  $'jobs:\n' \
  $'env:\n  SIGNING_VALUE: ${{ secrets.APPLE_CERTIFICATE_P12 }}\njobs:\n'
for name in \
  APPLE_CERTIFICATE_P12 \
  APPLE_CERTIFICATE_PASSWORD \
  APPLE_API_KEY \
  APPLE_API_KEY_ID \
  APPLE_API_ISSUER \
  AZURE_CLIENT_ID \
  AZURE_TENANT_ID \
  AZURE_SUBSCRIPTION_ID \
  AZURE_SIGNING_ENDPOINT \
  AZURE_SIGNING_ACCOUNT \
  AZURE_SIGNING_CERT_PROFILE \
  LINUX_UPDATE_SIGNING_KEY; do
  policy_case "$name outside trusted jobs" add_signing_reference "$name"
done
for name in \
  APPLE_CERTIFICATE_P12 \
  APPLE_CERTIFICATE_PASSWORD \
  APPLE_API_KEY_ID \
  APPLE_API_ISSUER \
  AZURE_CLIENT_ID \
  AZURE_TENANT_ID \
  AZURE_SUBSCRIPTION_ID \
  AZURE_SIGNING_ENDPOINT \
  AZURE_SIGNING_ACCOUNT \
  AZURE_SIGNING_CERT_PROFILE \
  LINUX_UPDATE_SIGNING_KEY; do
  policy_case "$name remains forbidden in provision-secrets" \
    add_provision_signing_reference "$name"
done
policy_case_diagnostic "provision OIDC exception dies on a retargeted environment" \
  "environment-scoped OIDC is forbidden" retarget_provision_environment
policy_case_diagnostic "provision OIDC exception does not leak to other jobs" \
  "environment-scoped OIDC is forbidden" add_rogue_provision_oidc_job
policy_case_diagnostic "provision OIDC exception dies when the environment input widens" \
  "environment-scoped OIDC is forbidden" widen_provision_environment_options
policy_case_diagnostic "provision OIDC exception dies when the workflow becomes reusable" \
  "environment-scoped OIDC is forbidden" add_provision_workflow_call

begin_category 13 "invalid YAML/document shape"
invalid_case "malformed workflow YAML" make_malformed_yaml
invalid_case "duplicate workflow mapping key" make_duplicate_key
invalid_case "workflow missing jobs" remove_jobs_mapping
invalid_case "workflow jobs is not a mapping" make_non_mapping_jobs
invalid_case "workflow document is not a mapping" make_non_mapping_workflow
invalid_case "fixed workflow file is missing" remove_fixed_workflow
invalid_case_without "workflow symlink is rejected without reading its target" \
  ".github/workflows/external-link.yml: workflow file must not be a symlink" \
  "EXTERNAL_SYMLINK_CONTENT_MUST_NOT_LEAK" make_workflow_symlink
invalid_case_without "non-UTF-8 workflow is rejected without a traceback" \
  ".github/workflows/non-utf8.yml: workflow file is not valid UTF-8" \
  "Traceback" make_non_utf8_workflow

begin_category 14 "nightly release dispatcher custody (ADR-0018 amendment)"
# nightly-ci.yml's release job is the SECOND dispatcher of the trusted signed
# build. Every case here is a way the contract could be weakened; a dispatcher no
# linter polices is precisely the gap this file exists to close.
policy_case_diagnostic "an unreviewed third dispatcher appears" \
  "only the reviewed dispatchers may dispatch build-desktop.yml" \
  write_third_dispatcher
for need in window ioc eslint codeql govulncheck secret-scanning native-audiocap scorecard build unit-smoke sonar zap; do
  policy_case_diagnostic "nightly dispatcher missing '$need' dependency" \
    "release dispatcher needs exact complete scan/build dependency set" \
    remove_nightly_need "$need"
done
# Each BLOCKING conjunct individually. scorecard/sonar/zap are deliberately
# absent from this list -- they stay in `needs` for visibility but must never
# strand a release, and a test asserting otherwise would encode the wrong policy.
for conjunct in \
  "needs.window.outputs.pending == 'true'" \
  "needs.ioc.result == 'success'" \
  "needs.build.result == 'success'" \
  "needs.unit-smoke.result == 'success'" \
  "needs.eslint.result == 'success'" \
  "needs.codeql.result == 'success'" \
  "needs.govulncheck.result == 'success'" \
  "needs.secret-scanning.result == 'success'" \
  "needs.native-audiocap.result == 'success'"; do
  policy_case_diagnostic "nightly gate drops \"$conjunct\"" \
    "release dispatcher gate is missing required conjunct" \
    replace_once ".github/workflows/nightly-ci.yml" \
    "      && $conjunct
" ""
done
# always() ALSO runs on cancellation, so it is not a superset of !cancelled() --
# it would let a cancelled scan leg release.
policy_case_diagnostic "nightly gate swaps !cancelled() for always()" \
  "release dispatcher gate is missing required conjunct" \
  replace_once ".github/workflows/nightly-ci.yml" "      !cancelled()" "      always()"
policy_case_diagnostic "nightly dispatcher gains the desktop-release environment" \
  "release dispatcher must not reference an environment" \
  replace_in_job_once ".github/workflows/nightly-ci.yml" release \
  "    runs-on: ubuntu-latest" \
  $'    environment: desktop-release\n    runs-on: ubuntu-latest'
policy_case_diagnostic "nightly dispatcher loses contents: read" \
  "release dispatcher permissions must be exactly" \
  replace_in_job_once ".github/workflows/nightly-ci.yml" release \
  "      contents: read
" ""
policy_case_diagnostic "nightly dispatcher gains a broader permission" \
  "release dispatcher permissions must be exactly" \
  replace_in_job_once ".github/workflows/nightly-ci.yml" release \
  "      contents: read" $'      contents: write'
# The overtake preamble must DEFER, not fail. A merge landing mid-nightly is
# normal; a nightly that reds for it trains everyone to ignore red nightlies.
policy_case_diagnostic "nightly overtake preamble fails instead of deferring" \
  "release dispatcher must match the exact reviewed dispatch-and-await contract" \
  replace_in_job_once ".github/workflows/nightly-ci.yml" release \
  "            exit 0" "            exit 1"
policy_case_diagnostic "nightly overtake preamble is removed entirely" \
  "release dispatcher must match the exact reviewed dispatch-and-await contract" \
  replace_in_job_once ".github/workflows/nightly-ci.yml" release \
  "          HEAD_SHA=\$(gh api \"repos/\$GITHUB_REPOSITORY/commits/main\" --jq '.sha')
" ""
policy_case_diagnostic "nightly dispatcher binds a ref other than main" \
  "release dispatcher must match the exact reviewed dispatch-and-await contract" \
  replace_in_job_once ".github/workflows/nightly-ci.yml" release \
  "            -f ref=main" "            -f ref=develop"
policy_case_diagnostic "nightly dispatcher drops the expected_sha binding" \
  "release dispatcher must match the exact reviewed dispatch-and-await contract" \
  replace_in_job_once ".github/workflows/nightly-ci.yml" release \
  "            -f \"inputs[expected_sha]=\$EXPECTED_SHA\" \\
" ""
policy_case_diagnostic "nightly dispatcher stops awaiting the child run" \
  "release dispatcher must match the exact reviewed dispatch-and-await contract" \
  replace_in_job_once ".github/workflows/nightly-ci.yml" release \
  "          gh run watch \"\$RUN_ID\" --repo \"\$GITHUB_REPOSITORY\" --compact --exit-status
" ""
policy_case_diagnostic "nightly dispatcher becomes a reusable-workflow caller" \
  "release dispatcher must be a normal step job" \
  make_nightly_release_reusable
policy_case_diagnostic "the nightly release dispatcher disappears" \
  "expected dispatcher(s) not found" \
  remove_nightly_release_job

add_publish_workflow_global_env() {
  local value="$1"
  python3 - "$CASE_ROOT/.github/workflows/publish-public-mirror.yml" "$value" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
value = sys.argv[2]
text = path.read_text()
needle = "name: Publish Public Mirror\non:\n"
if text.count(needle) != 1:
    raise SystemExit("workflow name/on insertion point not unique")
text = text.replace(needle, "name: Publish Public Mirror\nenv:\n" + value + "\non:\n", 1)
path.write_text(text)
PY
}

# Workflow-level env is inherited by scanner jobs, so secret-context checks
# must include it while permitting unrelated expressions and ordinary prose.
new_case
add_publish_workflow_global_env $'  COMMENT: "secrets is only prose here"\n  RUN_ID: "${{ github.run_id }}"'
assert_run 0 "OK:" "safe workflow-global prose and github.run_id expression" "$SCANNER" "$CASE_ROOT"
policy_case_diagnostic "mirror scanner inherits workflow-global repository secret" \
  "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
  add_publish_workflow_global_env $'  INHERITED_ENV_CHECK: "${{ secrets.REPO_CREDENTIAL }}"'
policy_case_diagnostic "scanner inherits mixed-case indexed workflow-global secret" \
  "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
  add_publish_workflow_global_env $'  INHERITED_ENV_CHECK: "${{ SeCrEtS[\'REPO_CREDENTIAL\'] }}"'
policy_case_diagnostic "scanner inherits workflow-global GitHub token context" \
  "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
  add_publish_workflow_global_env $'  INHERITED_ENV_CHECK: "${{ github.token }}"'

begin_category 15 "public mirror PR isolation and release handoff"
selfhost_dry_run_policy_cases
new_case
assert_run 0 "OK:" "seven-job prepare/scan/publisher fixture baseline" "$SCANNER" "$CASE_ROOT"
policy_case_diagnostic "mirror scanner may run without verified prepared input" \
  "publish-public-mirror.yml must keep the reviewed prepare/scan/publish job graph" \
  mutate_scanner_job mirror-scan 'needs: [mirror-prepare]' 'needs: []'
policy_case_diagnostic "selfhost scanner may run without verified prepared input" \
  "publish-public-mirror.yml must keep the reviewed prepare/scan/publish job graph" \
  mutate_scanner_job selfhost-scan 'needs: [selfhost-prepare]' 'needs: []'
policy_case_diagnostic "mirror publisher may bypass required scan receipt" \
  "publish-public-mirror.yml must keep the reviewed prepare/scan/publish job graph" \
  mutate_prepared_publish_job publish 'needs: [mirror-prepare, mirror-scan]' 'needs: [mirror-prepare]'
policy_case_diagnostic "selfhost publisher may bypass required scan receipt" \
  "publish-public-mirror.yml must keep the reviewed prepare/scan/publish job graph" \
  mutate_prepared_publish_job selfhost-release 'needs: [selfhost-prepare, selfhost-scan]' 'needs: [selfhost-prepare]'
for job in mirror-scan selfhost-scan; do
  policy_case_diagnostic "$job gains repository token permissions" \
    "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
    mutate_scanner_job "$job" '    permissions: {}' $'    permissions:\n      contents: read'
  policy_case_diagnostic "$job gains privileged environment access" \
    "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
    mutate_scanner_job "$job" '    runs-on: ubuntu-latest' $'    runs-on: ubuntu-latest\n    environment: public-mirror'
  for quote in single double; do
    policy_case_diagnostic "$job reads indexed App secret with $quote quotes" \
      "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
      inject_secret_context_into_scanner "$job" "$quote"
  done
  policy_case_diagnostic "$job reads mixed-case indexed App secret" \
    "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
    inject_secret_context_into_scanner "$job" mixed
  policy_case_diagnostic "$job serializes the secrets context to JSON" \
    "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
    inject_secret_context_into_scanner "$job" json
  policy_case_diagnostic "$job cannot hide secret context after a format brace escape" \
    "mirror-scan and selfhost-scan must have no environment or repository token permissions" \
    inject_secret_context_into_scanner "$job" format
done
for job in mirror-prepare selfhost-prepare; do
  policy_case_diagnostic "$job gains write permission" \
    "mirror-prepare and selfhost-prepare must use read-only permissions and no public-mirror environment" \
    mutate_preparer_job "$job" '      contents: read' '      contents: write'
  policy_case_diagnostic "$job gains privileged environment access" \
    "mirror-prepare and selfhost-prepare must use read-only permissions and no public-mirror environment" \
    mutate_preparer_job "$job" '    runs-on: ubuntu-latest' $'    runs-on: ubuntu-latest\n    environment: public-mirror'
done
policy_case_diagnostic "public mirror graph admits an extra writer job" \
  "publish-public-mirror.yml must keep the reviewed prepare/scan/publish job graph" \
  extend_publish_graph_for_prepare_scan_and_extra_job
policy_case_diagnostic "desktop build re-adds pull_request" \
  "build-desktop.yml must be dispatch-only" replace_once \
  ".github/workflows/build-desktop.yml" \
  $'on:\n  workflow_dispatch:' \
  $'on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n  workflow_dispatch:'
policy_case_diagnostic "smoke workflow gains workflow_dispatch" \
  "desktop-pr-smoke.yml must use pull_request only" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  $'  pull_request:\n    types: [opened, synchronize, reopened]' \
  $'  pull_request:\n    types: [opened, synchronize, reopened]\n  workflow_dispatch: {}'
policy_case_diagnostic "smoke filter omits its own workflow path" \
  "pr-paths-filter must include desktop-pr-smoke.yml in desktop-shell filter" replace_once \
  ".github/workflows/desktop-pr-smoke.yml" \
  "              - '.github/workflows/desktop-pr-smoke.yml'" \
  ""
policy_case_diagnostic "PR smoke job references a mirror secret" \
  "mirror secrets may be referenced only from publish-public-mirror.yml" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-build \
  "    # TEST_MARKER_PR_JOB" \
  $'    # TEST_MARKER_PR_JOB\n    env:\n      MIRROR_KEY: ${{ secrets.PUBLIC_MIRROR_APP_PRIVATE_KEY }}'
policy_case_diagnostic "PR smoke calls the mirror reusable workflow" \
  "desktop-pr-smoke.yml must not call publish-public-mirror.yml" \
  make_pr_job_call_mirror
# `\|` rather than `|` in the two expansions below, and in the loop further down: Semgrep's bash
# grammar rejects a bare bar inside a ${var%%...} or ${var#...} pattern (P18, as above).
for pair in \
  "repository|      github.repository == 'Concord-Voice/Desktop' &&" \
  "main|      github.ref == 'refs/heads/main' &&" \
  "release success|      needs.release.result == 'success'"; do
  label="${pair%%\|*}"
  clause="${pair#*\|}"
  policy_case_diagnostic "mirror dispatcher drops $label guard" \
    "public-release-mirror condition is missing required trusted-release guard" \
    replace_in_job_once ".github/workflows/build-desktop.yml" public-release-mirror \
    "$clause" ""
done
policy_case_diagnostic "mirror dispatch targets a non-main ref" \
  "public-release-mirror dispatch must use literal ref=main" replace_in_job_once \
  ".github/workflows/build-desktop.yml" public-release-mirror \
  "            -f ref=main \\" \
  '            -f "ref=$GITHUB_REF" \\'
policy_case_diagnostic "mirror dispatcher does not await child failure" \
  "public-release-mirror must watch the child run with --exit-status" replace_in_job_once \
  ".github/workflows/build-desktop.yml" public-release-mirror \
  '          gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --compact --exit-status' \
  '          echo "dispatch complete"'
for job in publish release-mirror selfhost-release; do
  policy_case_diagnostic "$job publisher job loses public-mirror environment" \
    "publisher job '$job' must use environment public-mirror" replace_in_job_once \
    ".github/workflows/publish-public-mirror.yml" "$job" \
    "    environment: public-mirror" ""
done
for job in release-mirror selfhost-release; do
  family=desktop-v
  [[ "$job" == selfhost-release ]] && family=selfhost-v
  for pair in \
    "repository|      github.repository == 'Concord-Voice/Desktop' &&" \
    "main|      github.ref == 'refs/heads/main' &&" \
    "dispatch event|      github.event_name == 'workflow_dispatch' &&" \
    "staging refusal|      format('{0}', inputs.stage_selfhost) != 'true' &&"; do
    label="${pair%%\|*}"
    clause="${pair#*\|}"
    policy_case_diagnostic "$job publisher drops $label boundary" \
      "publisher job '$job' must use the exact repository, main-ref, and event guard" \
      replace_in_job_once ".github/workflows/publish-public-mirror.yml" "$job" "$clause" ""
  done
  policy_case_diagnostic "$job publisher accepts every nonempty release tag" \
    "publisher job '$job' must use the exact repository, main-ref, and event guard" \
    replace_in_job_once ".github/workflows/publish-public-mirror.yml" "$job" \
    "startsWith(inputs.mirror_release_tag, '$family')" "inputs.mirror_release_tag != ''"
  wrong_family=selfhost-v
  [[ "$job" == selfhost-release ]] && wrong_family=desktop-v
  policy_case_diagnostic "$job publisher accepts the other release family" \
    "publisher job '$job' must use the exact repository, main-ref, and event guard" \
    replace_in_job_once ".github/workflows/publish-public-mirror.yml" "$job" \
    "startsWith(inputs.mirror_release_tag, '$family')" "startsWith(inputs.mirror_release_tag, '$wrong_family')"
done
for scope in contents actions pull-requests; do
  policy_case_diagnostic "selfhost publisher widens $scope permission" \
    "publisher job 'selfhost-release' permissions must be exactly contents: read, actions: read, and pull-requests: read" \
    replace_in_job_once ".github/workflows/publish-public-mirror.yml" selfhost-release \
    "      $scope: read" "      $scope: write"
  policy_case_diagnostic "selfhost publisher loses $scope permission" \
    "publisher job 'selfhost-release' permissions must be exactly contents: read, actions: read, and pull-requests: read" \
    replace_in_job_once ".github/workflows/publish-public-mirror.yml" selfhost-release \
    "      $scope: read" ""
done
policy_case_diagnostic "selfhost publisher gains unrelated token authority" \
  "publisher job 'selfhost-release' permissions must be exactly contents: read, actions: read, and pull-requests: read" \
  replace_in_job_once ".github/workflows/publish-public-mirror.yml" selfhost-release \
  "      contents: read" $'      contents: read\n      id-token: write'
policy_case_diagnostic "publisher regains release: published trigger" \
  "publish-public-mirror.yml must not accept release events" replace_once \
  ".github/workflows/publish-public-mirror.yml" \
  $'on:\n  push:' \
  $'on:\n  release:\n    types: [published]\n  push:'
policy_case_diagnostic "mirror secret is mapped outside publisher" \
  "mirror secrets may be referenced only from publish-public-mirror.yml" replace_in_job_once \
  ".github/workflows/build-desktop.yml" public-release-mirror \
  '          RELEASE_TAG: ${{ needs.release.outputs.release_tag }}' \
  $'          RELEASE_TAG: ${{ needs.release.outputs.release_tag }}\n          MIRROR_KEY: ${{ secrets.PUBLIC_MIRROR_APP_PRIVATE_KEY }}'
policy_case_diagnostic "publisher reintroduces workflow_call secret contract" \
  "publish-public-mirror.yml triggers must be exactly push and workflow_dispatch" replace_once \
  ".github/workflows/publish-public-mirror.yml" \
  $'  workflow_dispatch:\n' \
  $'  workflow_call:\n    secrets:\n      PUBLIC_MIRROR_APP_PRIVATE_KEY:\n        required: true\n  workflow_dispatch:\n'
policy_case_diagnostic "smoke sentinel changes its required status name" \
  "pr-smoke-result must be named exactly 'PR smoke test result'" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-result \
  "name: PR smoke test result" "name: Desktop smoke"
policy_case_diagnostic "smoke sentinel lets path-filter failure pass" \
  "pr-smoke-result must fail closed when the path filter fails" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-result \
  '*) echo "::error::path filter failed"; exit 1 ;;' \
  '*) echo "::error::path filter failed"; exit 0 ;;'
policy_case_diagnostic "smoke sentinel fails when no desktop paths match" \
  "pr-smoke-result must succeed when no desktop-shell paths match" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-result \
  $'          if [[ "${DESKTOP_SHELL}" != "true" ]]; then\n            echo "::notice::No desktop-shell paths modified; skipping smoke test."\n            exit 0\n          fi' \
  $'          if [[ "${DESKTOP_SHELL}" != "true" ]]; then\n            echo "::notice::No desktop-shell paths modified; skipping smoke test."\n            exit 1\n          fi'
policy_case_diagnostic "smoke sentinel treats a matching build failure as success" \
  "pr-smoke-result must fail when the matching smoke build fails" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-result \
  'failure) echo "::error::Desktop smoke test failed"; exit 1 ;;' \
  'failure) echo "::error::Desktop smoke test failed"; exit 0 ;;'
policy_case_diagnostic "smoke sentinel treats cancellation as success" \
  "pr-smoke-result must fail when the smoke build is cancelled" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-result \
  'cancelled) echo "::error::Desktop smoke test was cancelled"; exit 1 ;;' \
  'cancelled) echo "::error::Desktop smoke test was cancelled"; exit 0 ;;'
policy_case_diagnostic "smoke sentinel accepts unexpected skip after path match" \
  "pr-smoke-result must fail when the matching smoke build is skipped" replace_in_job_once \
  ".github/workflows/desktop-pr-smoke.yml" pr-smoke-result \
  'skipped) echo "::error::Desktop smoke test was unexpectedly skipped"; exit 1 ;;' \
  'skipped) echo "::error::Desktop smoke test was unexpectedly skipped"; exit 0 ;;'

begin_category 16 "protected-base classifier comment boundary"
policy_case_diagnostic "comment publisher workflow uses ordinary pull_request" \
  "classify-comment must use the exact repository/main/same-repository and complete-data gate" \
  replace_once ".github/workflows/classify-release-comment.yml" \
  "  pull_request_target:" "  pull_request:"
policy_case_diagnostic "comment workflow accepts a non-main base" \
  "classify-comment must use the exact repository/main/same-repository and complete-data gate" \
  replace_in_job_once ".github/workflows/classify-release-comment.yml" classify-data \
  "github.event.pull_request.base.ref == 'main'" "github.event.pull_request.base.ref != 'main'"
policy_case_diagnostic "classifier data job gains write permission" \
  "classify-data must have exactly contents: read" replace_in_job_once \
  ".github/workflows/classify-release-comment.yml" classify-data \
  "      contents: read" "      contents: write"
policy_case_diagnostic "classifier data job turns failure into a success" \
  "classify-data must preserve advisory behavior without job-level continue-on-error" replace_in_job_once \
  ".github/workflows/classify-release-comment.yml" classify-data \
  "    runs-on: ubuntu-latest" $'    runs-on: ubuntu-latest\n    continue-on-error: true'
policy_case_diagnostic "classifier job relays raw output instead of validated output" \
  "classify-data must expose only validated classifier outputs" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  'steps.validate.outputs.shell_changed' 'steps.classify.outputs.shell_changed'
policy_case_diagnostic "ordinary lockstep job gains PR-write authority" \
  "only classify-comment may have pull-requests: write" replace_in_job_once \
  ".github/workflows/classify-release.yml" contract-version-lockstep \
  "      contents: read" $'      contents: read\n      pull-requests: write'
policy_case_diagnostic "classifier data job checks out PR head" \
  "classify-data must not check out or execute PR-head code" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  'ref: ${{ github.event.pull_request.base.sha }}' \
  'ref: ${{ github.event.pull_request.head.sha }}'
policy_case_diagnostic "classifier base checkout loses full history" \
  "classify-data must check out the protected base with full history and persist-credentials: false" replace_in_job_once \
  ".github/workflows/classify-release-comment.yml" classify-data \
  "          fetch-depth: 0" "          fetch-depth: 1"
policy_case_diagnostic "comment publisher checks out code" \
  "classify-comment must not check out code" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  $'      - name: Post two-axis PR comment\n        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea' \
  $'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - name: Post two-axis PR comment\n        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea'
policy_case_diagnostic "classifier does not bind fetched commit to event head" \
  "classify-data must compare the fetched commit to the event head SHA" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  '[[ "${fetched}" == "${EVENT_HEAD}" ]]' '[[ "${fetched}" != "${EVENT_HEAD}" ]]'
policy_case_diagnostic "comment publisher skips current PR and hotfix revalidation" \
  "classify-comment must revalidate the open PR head/base/main state and current hotfix labels before publishing" \
  replace_once ".github/workflows/classify-release-comment.yml" \
  "if (current.data.state !== 'open' || current.data.base.ref !== 'main' || current.data.head.sha !== context.payload.pull_request.head.sha || current.data.base.sha !== context.payload.pull_request.base.sha) return;" \
  "if (current.data.state !== 'open') return;"
policy_case_diagnostic "classifier omits one allowlisted output" \
  "classify-data must expose only validated classifier outputs" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  '      version_bump_required: ${{ steps.validate.outputs.version_bump_required }}' ''
policy_case_diagnostic "comment publisher permissions drift" \
  "classify-comment must have exactly contents: read and pull-requests: write" replace_in_job_once \
  ".github/workflows/classify-release-comment.yml" classify-comment \
  "      contents: read" "      contents: write"

move_classifier_probe_outside_publisher() {
  replace_once ".github/workflows/classify-release-comment.yml" \
    $'    steps:\n      - name: Post two-axis PR comment\n        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea' \
    $'    steps:\n      - name: Probe live production values\n        run: curl -fsS --max-time 5 https://api.concordvoice.chat/api/v1/client/config\n      - name: Post two-axis PR comment\n        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea'
  replace_in_job_once ".github/workflows/classify-release-comment.yml" classify-comment \
    "const response = await fetch('https://api.concordvoice.chat/api/v1/client/config', { signal: AbortSignal.timeout(5000) });" \
    "const response = null; // probe moved outside the publisher script"
}
policy_case_diagnostic "publisher live probe moves outside github-script" \
  "classify-comment must keep the live production probe inside its sole github-script step" \
  move_classifier_probe_outside_publisher

policy_case_diagnostic "publisher rejects the numeric public SPA contract" \
  "classify-comment must accept bounded numeric spaIpcContract values and preserve unknown for invalid values" \
  replace_once ".github/workflows/classify-release-comment.yml" \
  'if (typeof config.spaIpcContract === '\''number'\'' && Number.isSafeInteger(config.spaIpcContract) && config.spaIpcContract >= 0 && config.spaIpcContract <= 999999999) liveContract = String(config.spaIpcContract);' \
  'if (typeof config.spaIpcContract === '\''string'\'' && config.spaIpcContract.length <= 128) liveContract = config.spaIpcContract;'

policy_case_diagnostic "publisher uses an unsafe fallback for invalid SPA contract JSON" \
  "classify-comment must accept bounded numeric spaIpcContract values and preserve unknown for invalid values" \
  replace_once ".github/workflows/classify-release-comment.yml" \
  "const NA = 'unknown (probe failed)'" "const NA = '0'"

policy_case_diagnostic "classifier shell validator rejects removed SPA minimum" \
  "classify-comment must validate spa_min_action including removed" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  '[[ "${SPA_MIN_ACTION}" =~ ^(none|raised|lowered|removed)$ ]]' \
  '[[ "${SPA_MIN_ACTION}" =~ ^(none|raised|lowered)$ ]]'

policy_case_diagnostic "classifier publisher rejects removed SPA minimum" \
  "classify-comment must validate spa_min_action including removed" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  "enumValue(SPA_MIN_ACTION, ['none', 'raised', 'lowered', 'removed'])" \
  "enumValue(SPA_MIN_ACTION, ['none', 'raised', 'lowered'])"

policy_case_diagnostic "classifier publisher drops the bump_level revalidation" \
  "classify-comment must revalidate bump_level and bump_basis" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  "enumValue(BUMP_LEVEL, ['none', 'patch', 'minor', 'major'])" "true"

policy_case_diagnostic "classifier validator omits the old contract scalar bound" \
  "classify-data must validate every classifier output before exposing them" replace_once \
  ".github/workflows/classify-release-comment.yml" \
  '[[ "${OLD_CONTRACT}" =~ ^(0|[1-9][0-9]{0,8})$ ]]' ':'

policy_case_diagnostic "classifier workflow gains an unexpected job" \
  "classify-release-comment.yml must contain exactly classify-data and classify-comment jobs" \
  replace_once ".github/workflows/classify-release-comment.yml" \
  'jobs:
  classify-data:' \
  'jobs:
  spare: {}
  classify-data:'

policy_case_diagnostic "comment writer gate is widened with OR" \
  "classify-comment must use the exact repository/main/same-repository and complete-data gate" \
  replace_in_job_once ".github/workflows/classify-release-comment.yml" classify-comment \
  "needs.classify-data.outputs.version_bump_required != ''" \
  "needs.classify-data.outputs.version_bump_required != '' || true"

policy_case_diagnostic "classifier data job adds a second protected-base checkout" \
  "classify-data must have exactly one protected-base checkout and the approved data-step inventory" \
  replace_in_job_once ".github/workflows/classify-release-comment.yml" classify-data \
  '      - name: Fetch target commit as data' \
  $'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.base.sha }}\n          fetch-depth: 0\n          persist-credentials: false\n      - name: Fetch target commit as data'

policy_case_diagnostic "comment publisher gains an unrelated action step" \
  "classify-comment must have exactly one pinned github-script publisher step" \
  replace_in_job_once ".github/workflows/classify-release-comment.yml" classify-comment \
  '    steps:
      - name: Post two-axis PR comment' \
  '    steps:
      - uses: actions/upload-artifact@3d3c42e5aac5ba805825da76410c181273ba90b1
      - name: Post two-axis PR comment'


assert_run 0 "OK:" "checked-in unsigned workflow tree" "$SCANNER" --unsigned "$REPO_ROOT"

echo
if [[ "$categories_covered" == "16" ]]; then
  echo "16/16 rejection categories covered"
else
  echo "$categories_covered/16 rejection categories covered" >&2
  fail=$((fail + 1))
fi
echo "PASS: $pass  FAIL: $fail"
[[ "$fail" == "0" ]]
