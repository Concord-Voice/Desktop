#!/usr/bin/env bash

set -euo pipefail

# P: Desktop's unsigned lane has no signing or publication consumers.
if [[ "${1:-}" == --unsigned ]]; then
  shift
  exec python3 "$(dirname "${BASH_SOURCE[0]}")/verify-unsigned-desktop.py" "$@"
fi

if [[ $# -gt 1 ]]; then
  echo "ERROR: lint-pr-release-trust.sh: expected zero or one repository-root argument" >&2
  exit 2
fi

ROOT="${1:-.}"
if [[ ! -d "$ROOT" ]]; then
  echo "ERROR: lint-pr-release-trust.sh: repository root is not a directory: $ROOT" >&2
  exit 2
fi

for workflow in build-desktop.yml desktop-pr-smoke.yml publish-public-mirror.yml main-ci.yml nightly-ci.yml; do
  if [[ ! -f "$ROOT/.github/workflows/$workflow" ]]; then
    echo "ERROR: .github/workflows/$workflow: required workflow is missing" >&2
    exit 2
  fi
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: lint-pr-release-trust.sh: python3 is required" >&2
  exit 2
fi

python3 - "$ROOT" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: lint-pr-release-trust.sh: PyYAML is required", file=sys.stderr)
    raise SystemExit(2)


class DuplicateKeyError(yaml.YAMLError):
    pass


class UniqueBaseLoader(yaml.BaseLoader):
    def construct_mapping(self, node, deep=False):
        if not isinstance(node, yaml.MappingNode):
            raise yaml.constructor.ConstructorError(
                None, None, "expected a mapping node", node.start_mark
            )
        mapping = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            try:
                duplicate = key in mapping
            except TypeError as exc:
                raise yaml.constructor.ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    "found an unhashable mapping key",
                    key_node.start_mark,
                ) from exc
            if duplicate:
                raise DuplicateKeyError(
                    f"duplicate mapping key {key!r} at line {key_node.start_mark.line + 1}"
                )
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping


class ShapeError(Exception):
    pass


ROOT = Path(sys.argv[1]).resolve()
WORKFLOW_DIR = ROOT / ".github" / "workflows"
BUILD_FILE = ".github/workflows/build-desktop.yml"
SMOKE_FILE = ".github/workflows/desktop-pr-smoke.yml"
PUBLISH_FILE = ".github/workflows/publish-public-mirror.yml"
MAIN_FILE = ".github/workflows/main-ci.yml"
NIGHTLY_FILE = ".github/workflows/nightly-ci.yml"
PROVISION_FILE = ".github/workflows/provision-secrets.yml"

SIGNING_NAMES = {
    "APPLE_CERTIFICATE_P12",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_SIGNING_ENDPOINT",
    "AZURE_SIGNING_ACCOUNT",
    "AZURE_SIGNING_CERT_PROFILE",
    "LINUX_UPDATE_SIGNING_KEY",
}
CALLER_NEEDS = {
    "changes",
    "ioc",
    "eslint",
    "codeql",
    "govulncheck",
    "scorecard",
    "build",
    "sonar",
}
# nightly-ci.yml's release job is the SECOND dispatcher of the trusted signed
# build (ADR-0018 amendment, 2026-08-26): main-ci dispatches `risk: hotfix`
# merges immediately, the nightly dispatches everything else at 07:00 UTC.
# Both are held to the same contract below — a dispatcher that no linter
# polices is exactly the gap this file exists to close.
NIGHTLY_RELEASE_NEEDS = {
    "window",
    "ioc",
    "eslint",
    "codeql",
    "govulncheck",
    # semgrep is deliberately ABSENT: semgrep.yml is pull_request-only
    # (--baseline-commit needs a PR base SHA) and failed on the nightly's first
    # run. Main has never had a Semgrep baseline and the #1431 gate works
    # without one. Do not re-add it here without fixing semgrep.yml first.
    "secret-scanning",
    # native-audiocap is BLOCKING (ADR-0043 § Standing requirements, decided on
    # PR #3155). Its PR-time leg is path-gated and main-ci's jobs are
    # hotfix-gated, so this unconditional nightly node is the only thing that
    # runs the concord-audiocap ASAN/UBSAN and fuzz legs against `main` at all.
    # It is asserted BOTH here and in required_conjuncts below: present in one
    # and not the other means the summary table prints "blocking" while the
    # release cuts anyway.
    "native-audiocap",
    "scorecard",
    "build",
    "unit-smoke",
    "sonar",
    "zap",
}
PR_JOBS = {"pr-paths-filter", "pr-smoke-build", "pr-smoke-result"}
TRUSTED_JOBS = {"release-build", "release"}
EXPECTED_MATRIX = [
    {"os": "windows-latest", "platform": "win32", "arch": "x64", "label": "windows-x64"},
    {"os": "windows-latest", "platform": "win32", "arch": "arm64", "label": "windows-arm64"},
    {"os": "macos-latest", "platform": "darwin", "arch": "arm64", "label": "macos-arm64"},
    {"os": "macos-latest", "platform": "darwin", "arch": "x64", "label": "macos-x64"},
    {"os": "ubuntu-latest", "platform": "linux", "arch": "x64", "label": "linux-x64"},
    {"os": "ubuntu-latest", "platform": "linux", "arch": "arm64", "label": "linux-arm64"},
]
EXPECTED_ARTIFACT_ASSERTION = [
    "set -euo pipefail",
    "expected=(",
    '"concord-voice-linux-arm64-v${VERSION}"',
    '"concord-voice-linux-x64-v${VERSION}"',
    '"concord-voice-macos-arm64-v${VERSION}"',
    '"concord-voice-macos-x64-v${VERSION}"',
    '"concord-voice-windows-arm64-v${VERSION}"',
    '"concord-voice-windows-x64-v${VERSION}"',
    ")",
    "mapfile -t paths < <(find artifacts -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort)",
    "if [[ ${#paths[@]} -ne ${#expected[@]} ]]; then",
    "printf '::error::expected %d release-build artifact directories, found %d\\n' \"${#expected[@]}\" \"${#paths[@]}\"",
    "printf 'found: %s\\n' \"${paths[*]:-\"<none>\"}\" >&2",
    "exit 1",
    "fi",
    'for index in "${!expected[@]}"; do',
    'actual="${paths[$index]#artifacts/}"',
    'if [[ ! -d "${paths[$index]}" || "$actual" != "${expected[$index]}" ]]; then',
    "printf '::error::release-build artifact set mismatch at index %s: expected=%s actual=%s\\n' \"$index\" \"${expected[$index]}\" \"$actual\" >&2",
    "exit 1",
    "fi",
    "done",
]
EXPECTED_ARTIFACT_DIRECTORY_PREP = [
    "set -euo pipefail",
    "rm -rf -- artifacts",
    "mkdir -- artifacts",
    "test -d artifacts",
    'test -z "$(find artifacts -mindepth 1 -maxdepth 1 -print -quit)"',
]
EXPECTED_OIDC_VALIDATOR = [
    "set -euo pipefail",
    "expected_issuer='https://token.actions.githubusercontent.com'",
    "expected_subject='repo:Concord-Voice/Desktop:environment:desktop-release'",
    "expected_audience='api://AzureADTokenExchange'",
    'response="$(curl --fail --silent --show-error \\',
    '  --header "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \\',
    '  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${expected_audience}")"',
    'token="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["value"])\' <<<"$response")"',
    'payload="$(python3 - "$token" <<\'PY\'',
    "import base64",
    "import json",
    "import sys",
    'encoded = sys.argv[1].split(".")[1]',
    'encoded += "=" * (-len(encoded) % 4)',
    "claims = json.loads(base64.urlsafe_b64decode(encoded))",
    "allowlist = (",
    '    "iss", "sub", "aud", "repository", "repository_id",',
    '    "repository_owner_id", "ref", "workflow_ref",',
    '    "job_workflow_ref", "environment",',
    ")",
    "print(json.dumps({key: claims[key] for key in allowlist if key in claims}, sort_keys=True), file=sys.stderr)",
    "print(json.dumps(claims))",
    "PY",
    ')"',
    'issuer="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["iss"])\' <<<"$payload")"',
    'subject="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["sub"])\' <<<"$payload")"',
    'audience="$(python3 -c \'import json,sys; print(json.load(sys.stdin)["aud"])\' <<<"$payload")"',
    'if [[ "$issuer" != "$expected_issuer" || "$subject" != "$expected_subject" || "$audience" != "$expected_audience" ]]; then',
    "  exit 1",
    "fi",
]
RELEASE_BUILD_CONDITION = (
    "github.repository == 'Concord-Voice/Desktop' && "
    "github.ref == 'refs/heads/main' && "
    "github.event_name == 'workflow_dispatch' && "
    "needs.detect-release.result == 'success' && "
    "needs.detect-release.outputs.should_release == 'true'"
)
RELEASE_CONDITION = (
    "always() && "
    "github.repository == 'Concord-Voice/Desktop' && "
    "github.ref == 'refs/heads/main' && "
    "github.event_name == 'workflow_dispatch' && "
    "needs.detect-release.result == 'success' && "
    "needs.release-build.result == 'success' && "
    "needs.detect-release.outputs.should_release == 'true'"
)
# detect-release must fail closed when a Main CI dispatch's expected_sha no
# longer matches main HEAD (main advanced past the gated commit). Exact-line
# contract, mirroring checkout_assertion (#2274 dispatch topology).
EXPECTED_SHA_BINDING = [
    'actual="$(git rev-parse HEAD)"',
    'if [[ -n "$EXPECTED_SHA" && "$actual" != "$EXPECTED_SHA" ]]; then',
    "printf '::error::main advanced past the gated commit (expected %s, HEAD %s); "
    "the next Main CI run re-dispatches after its own gates.\\n' \"$EXPECTED_SHA\" \"$actual\"",
    "exit 1",
    "fi",
]
# main-ci's dispatcher must dispatch the standalone build-desktop.yml run on
# protected main, bind the gated commit via expected_sha, and await the child
# with failure propagation (#2048 topology, third incident #2274). Exact
# stripped-line contract (like checkout_assertion / the OIDC validator) — a
# token-presence check was demonstrated evadable by `|| true` on the watch
# line and by displacing tokens into quoted log lines.
EXPECTED_DISPATCHER_STEP = [
    "set -euo pipefail",
    "RUN_ID=$(gh api --method POST \\",
    '-H "X-GitHub-Api-Version: 2026-03-10" \\',
    '"repos/$GITHUB_REPOSITORY/actions/workflows/build-desktop.yml/dispatches" \\',
    "-F return_run_details=true \\",
    "-f ref=main \\",
    '-f "inputs[expected_sha]=$EXPECTED_SHA" \\',
    "--jq '.workflow_run_id')",
    'test -n "$RUN_ID" || { echo "::error::Dispatch returned no workflow run ID"; exit 1; }',
    'echo "::notice::Watching trusted desktop build run ${RUN_ID} for ${EXPECTED_SHA}"',
    'gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --compact --exit-status',
]
# The nightly's step is the main-ci contract with an overtake-deferral preamble.
# Its gate window (~45 min with a full ZAP scan) is longer than main-ci's ~14 min,
# so it is more likely to be overtaken, and it has no next push to re-arm on. The
# preamble must EXIT 0, not fail: a merge landing mid-run is normal, and the probe
# is version-based so tomorrow's nightly re-gates the newer SHA.
EXPECTED_NIGHTLY_DISPATCHER_STEP = [
    "set -euo pipefail",
    "HEAD_SHA=$(gh api \"repos/$GITHUB_REPOSITORY/commits/main\" --jq '.sha')",
    'if [ "$HEAD_SHA" != "$EXPECTED_SHA" ]; then',
    'echo "::notice::main advanced to ${HEAD_SHA} during this run;" \\',
    '"deferring desktop-v${VERSION} to the next nightly."',
    "exit 0",
    "fi",
    'echo "::notice::Releasing desktop-v${VERSION} (nightly, non-urgent path)"',
] + EXPECTED_DISPATCHER_STEP[1:]

NON_PR_CONDITIONS = {
    "github.event_name != 'pull_request'",
    "github.event_name == 'workflow_dispatch'",
    RELEASE_BUILD_CONDITION,
    RELEASE_CONDITION,
    (
        "always() && github.event_name == 'workflow_dispatch' && "
        "github.ref == 'refs/heads/main' && "
        "needs.release.result == 'success'"
    ),
    (
        "always() && github.repository == 'Concord-Voice/Desktop' && "
        "github.event_name == 'workflow_dispatch' && "
        "github.ref == 'refs/heads/main' && "
        "needs.release.result == 'success'"
    ),
}
NON_PR_CONDITIONS |= {condition.replace("'", '"') for condition in NON_PR_CONDITIONS}
CROSS_RUN_ARTIFACT_API = re.compile(r"/actions/(?:runs/[^/\r\n]+/)?artifacts\b")

violations: list[tuple[str, str]] = []


def fail(path: str, contract: str) -> None:
    item = (path, contract)
    if item not in violations:
        violations.append(item)


def normalize_expression(value) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if value.startswith("${{") and value.endswith("}}"):
        value = value[3:-2].strip()
        quoted_literal = re.fullmatch(r"(['\"])(.*)\1", value)
        if quoted_literal:
            value = quoted_literal.group(2)
    return re.sub(r"\s+", " ", value).strip()


def flatten_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from flatten_strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from flatten_strings(item)


def rendered(value) -> str:
    return "\n".join(flatten_strings(value))


def mapping(value, where: str, *, none_as_empty: bool = False) -> dict:
    if value is None and none_as_empty:
        return {}
    if not isinstance(value, dict):
        raise ShapeError(f"{where} must be a mapping")
    return value


def trigger_names(value, where: str) -> set[str]:
    if isinstance(value, str):
        return {value}
    if isinstance(value, list):
        if not all(isinstance(item, str) for item in value):
            raise ShapeError(f"{where} trigger list must contain only scalars")
        return set(value)
    if isinstance(value, dict):
        return set(value)
    raise ShapeError(f"{where} must be a scalar, list, or mapping")


def normalize_needs(value, where: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    raise ShapeError(f"{where} must be a scalar or list of scalars")


def permission_map(value, where: str) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, str):
        if value not in {"read-all", "write-all"}:
            raise ShapeError(f"{where} scalar must be read-all or write-all")
        return {"*": value}
    if not isinstance(value, dict):
        raise ShapeError(f"{where} must be a scalar or mapping")
    result = {}
    for key, permission in value.items():
        if not isinstance(key, str) or not isinstance(permission, str):
            raise ShapeError(f"{where} entries must be scalar pairs")
        result[key] = permission
    return result


def effective_permissions(workflow: dict, job: dict, where: str) -> dict[str, str]:
    value = job.get("permissions") if "permissions" in job else workflow.get("permissions")
    return permission_map(value, f"{where}.permissions")


def has_permission(permissions: dict[str, str], name: str, level: str) -> bool:
    return permissions.get(name) == level or permissions.get("*") == "write-all"


def environment_name(value, where: str) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return normalize_expression(value)
    if isinstance(value, dict):
        name = value.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ShapeError(f"{where}.environment mapping requires a scalar name")
        return normalize_expression(name)
    raise ShapeError(f"{where}.environment must be a scalar or mapping")


def job_steps(job: dict, where: str) -> list[dict]:
    value = job.get("steps", [])
    if not isinstance(value, list):
        raise ShapeError(f"{where}.steps must be a list")
    for index, step in enumerate(value):
        if not isinstance(step, dict):
            raise ShapeError(f"{where}.steps[{index}] must be a mapping")
    return value


def action_name(step: dict) -> str:
    uses = step.get("uses", "")
    if uses is None:
        return ""
    if not isinstance(uses, str):
        raise ShapeError("step uses must be a scalar")
    return normalize_expression(uses).lower()


def calls_desktop_workflow(uses: str) -> bool:
    value = normalize_expression(uses)
    if value == "./.github/workflows/build-desktop.yml":
        return True
    qualified, separator, ref = value.partition("@")
    return bool(separator and ref) and qualified.casefold() == (
        "Concord-Voice/Desktop/.github/workflows/build-desktop.yml".casefold()
    )


def action_inputs(step: dict, where: str) -> dict:
    value = step.get("with", {})
    return mapping(value, f"{where}.with", none_as_empty=True)


def has_exact_comparison(condition: str, left: str, right: str) -> bool:
    pattern = re.compile(
        rf"{re.escape(left)}\s*==\s*(['\"]){re.escape(right)}\1"
    )
    return bool(pattern.search(condition))


def excludes_pull_request(condition: str) -> bool:
    return condition in NON_PR_CONDITIONS


def signing_references(value) -> set[str]:
    text = rendered(value)
    return {
        name
        for name in SIGNING_NAMES
        if re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", text)
    }


def parameter_expansions(text: str, name: str) -> list[str]:
    return re.findall(
        rf"\$(?:{re.escape(name)}(?![A-Za-z0-9_])|"
        rf"\{{(?:[!#])?{re.escape(name)}(?![A-Za-z0-9_])[^}}]*\}})",
        text,
    )


def has_secrets_context(value) -> bool:
    return bool(
        re.search(r"(?<![A-Za-z0-9_])secrets\s*(?:\.|\[)", rendered(value))
    )


def load_workflows() -> dict[str, dict]:
    try:
        paths = sorted(WORKFLOW_DIR.iterdir())
    except OSError:
        print(
            "ERROR: .github/workflows: unable to enumerate workflow directory",
            file=sys.stderr,
        )
        raise SystemExit(2)
    loaded = {}
    errors = []
    for path in paths:
        if path.suffix not in {".yml", ".yaml"}:
            continue
        relative = path.relative_to(ROOT).as_posix()
        try:
            if path.is_symlink():
                errors.append((relative, "workflow file must not be a symlink"))
                continue
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8")
        except UnicodeError:
            errors.append((relative, "workflow file is not valid UTF-8"))
            continue
        except OSError:
            errors.append((relative, "unable to read workflow file"))
            continue
        try:
            document = yaml.load(text, Loader=UniqueBaseLoader)
        except yaml.YAMLError as exc:
            errors.append((relative, f"invalid YAML: {exc}"))
            continue
        if not isinstance(document, dict):
            errors.append((relative, "workflow document must be a mapping"))
            continue
        jobs = document.get("jobs")
        if not isinstance(jobs, dict):
            errors.append((relative, "workflow jobs must be a mapping"))
            continue
        bad_job = next(
            (job_id for job_id, job in jobs.items() if not isinstance(job_id, str) or not isinstance(job, dict)),
            None,
        )
        if bad_job is not None:
            errors.append((relative, f"job {bad_job!r} must be a mapping"))
            continue
        loaded[relative] = document
    if errors:
        for path, message in errors:
            print(f"ERROR: {path}: {message}", file=sys.stderr)
        raise SystemExit(2)
    return loaded


WORKFLOWS = load_workflows()
BUILD = WORKFLOWS[BUILD_FILE]
SMOKE = WORKFLOWS[SMOKE_FILE]
PUBLISH = WORKFLOWS[PUBLISH_FILE]
MAIN = WORKFLOWS[MAIN_FILE]
BUILD_JOBS = BUILD["jobs"]
SMOKE_JOBS = SMOKE["jobs"]
PUBLISH_JOBS = PUBLISH["jobs"]
MAIN_JOBS = MAIN["jobs"]


def check_triggers_and_dispatcher() -> None:
    build_triggers = trigger_names(BUILD.get("on"), f"{BUILD_FILE}.on")
    if build_triggers != {"workflow_dispatch"}:
        fail(
            BUILD_FILE,
            "build-desktop.yml must be dispatch-only (dispatch-only: workflow_call loses desktop-release environment secrets, #2048/#2274)",
        )

    smoke_triggers = trigger_names(SMOKE.get("on"), f"{SMOKE_FILE}.on")
    if smoke_triggers != {"pull_request"}:
        fail(SMOKE_FILE, "desktop-pr-smoke.yml must use pull_request only")
    smoke_on = mapping(SMOKE.get("on"), f"{SMOKE_FILE}.on")
    pull_request = mapping(smoke_on.get("pull_request"), f"{SMOKE_FILE}.on.pull_request")
    if pull_request.get("types") != ["opened", "synchronize", "reopened"]:
        fail(SMOKE_FILE, "desktop-pr-smoke.yml must use the exact PR event types")
    if "env" in SMOKE or "defaults" in SMOKE:
        fail(SMOKE_FILE, "desktop-pr-smoke.yml must not define inherited env or defaults")
    if effective_permissions(SMOKE, {}, SMOKE_FILE) != {"contents": "read"}:
        fail(SMOKE_FILE, "desktop-pr-smoke.yml workflow permissions must be exactly contents: read")

    publish_on = mapping(PUBLISH.get("on"), f"{PUBLISH_FILE}.on")
    publish_triggers = trigger_names(publish_on, f"{PUBLISH_FILE}.on")
    if "release" in publish_triggers:
        fail(PUBLISH_FILE, "publish-public-mirror.yml must not accept release events")
    if publish_triggers != {"push", "workflow_dispatch"}:
        fail(PUBLISH_FILE, "publish-public-mirror.yml triggers must be exactly push and workflow_dispatch")
    push_config = mapping(publish_on.get("push"), f"{PUBLISH_FILE}.on.push")
    branches = push_config.get("branches")
    if isinstance(branches, str):
        branches = [branches]
    if set(push_config) != {"branches"} or branches != ["main"]:
        fail(PUBLISH_FILE, "publish-public-mirror.yml push must target main only")

    build_on = BUILD.get("on")
    dispatch_inputs = {}
    if isinstance(build_on, dict):
        dispatch = mapping(
            build_on.get("workflow_dispatch"),
            f"{BUILD_FILE}.on.workflow_dispatch",
            none_as_empty=True,
        )
        dispatch_inputs = mapping(
            dispatch.get("inputs"),
            f"{BUILD_FILE}.on.workflow_dispatch.inputs",
            none_as_empty=True,
        )
    expected_sha = dispatch_inputs.get("expected_sha")
    if (
        not isinstance(expected_sha, dict)
        or expected_sha.get("type") != "string"
        or expected_sha.get("required") != "false"
    ):
        fail(
            BUILD_FILE,
            "workflow_dispatch must declare the optional expected_sha string input",
        )

    callers = []
    for path, workflow in WORKFLOWS.items():
        for job_id, job in workflow["jobs"].items():
            uses = job.get("uses")
            if uses is not None and not isinstance(uses, str):
                raise ShapeError(f"{path}.jobs.{job_id}.uses must be a scalar")
            if isinstance(uses, str) and calls_desktop_workflow(uses):
                callers.append((path, job_id))

    if callers:
        locations = ", ".join(f"{path}:{job_id}" for path, job_id in callers)
        fail(
            MAIN_FILE,
            f"build-desktop.yml is dispatch-only; workflow_call callers are forbidden (found {locations})",
        )

    dispatcher = MAIN_JOBS.get("build-desktop")
    if not isinstance(dispatcher, dict):
        fail(MAIN_FILE, "jobs.build-desktop dispatcher is required")
        return
    where = f"{MAIN_FILE}.jobs.build-desktop"

    if "uses" in dispatcher or "steps" not in dispatcher:
        fail(MAIN_FILE, "build-desktop dispatcher must be a normal step job, not a reusable-workflow caller")
        return

    needs = normalize_needs(dispatcher.get("needs"), f"{where}.needs")
    if set(needs) != CALLER_NEEDS or len(needs) != len(CALLER_NEEDS):
        fail(MAIN_FILE, "build-desktop dispatcher needs exact complete scan/build dependency set")

    condition = normalize_expression(dispatcher.get("if"))
    # The `hotfix` conjunct STRICTLY NARROWS what may be dispatched (ADR-0018
    # amendment): it can only ever prevent a release, never permit one the old
    # gate refused. Keep this an EXACT match — the point of the pin is that a
    # future edit cannot quietly swap success() for always() or drop a conjunct.
    if condition != (
        "success() && needs.changes.outputs.desktop-release == 'true' "
        "&& needs.changes.outputs.hotfix == 'true'"
    ):
        fail(MAIN_FILE, "build-desktop dispatcher must retain the exact explicit success() gate")

    if "secrets" in dispatcher or has_secrets_context(dispatcher):
        fail(MAIN_FILE, "build-desktop dispatcher must not map or reference secrets")
    if environment_name(dispatcher.get("environment"), where):
        fail(MAIN_FILE, "build-desktop dispatcher must not reference an environment")
    permissions = effective_permissions(MAIN, dispatcher, where)
    if "permissions" not in dispatcher or permissions != {"actions": "write", "checks": "read"}:
        fail(MAIN_FILE, "build-desktop dispatcher permissions must be exactly actions: write and checks: read")

    steps = job_steps(dispatcher, where)
    dispatch_contract = False
    if len(steps) == 1:
        step = steps[0]
        env = step.get("env")
        run = step.get("run", "")
        lines = (
            [line.strip() for line in executable_shell(run).splitlines() if line.strip()]
            if isinstance(run, str)
            else []
        )
        dispatch_contract = (
            set(step) == {"name", "env", "run"}
            and isinstance(env, dict)
            and set(env) == {"GH_TOKEN", "EXPECTED_SHA"}
            and normalize_expression(env.get("GH_TOKEN")) == "github.token"
            and normalize_expression(env.get("EXPECTED_SHA")) == "github.sha"
            and lines == EXPECTED_DISPATCHER_STEP
        )
    if not dispatch_contract:
        fail(
            MAIN_FILE,
            "build-desktop dispatcher must match the exact reviewed dispatch-and-await contract",
        )

    main_triggers = trigger_names(MAIN.get("on"), f"{MAIN_FILE}.on")
    push_config = MAIN.get("on", {}).get("push") if isinstance(MAIN.get("on"), dict) else None
    branches = push_config.get("branches") if isinstance(push_config, dict) else None
    if isinstance(branches, str):
        branches = [branches]
    if (
        main_triggers != {"push"}
        or not isinstance(push_config, dict)
        or set(push_config) != {"branches"}
        or branches != ["main"]
    ):
        fail(MAIN_FILE, "desktop dispatcher workflow must trigger only on push to main")


DISPATCH_ENDPOINT = "actions/workflows/build-desktop.yml/dispatches"
# EVERY job permitted to dispatch the trusted signed build. The set is closed:
# a third dispatcher added anywhere in .github/workflows/ fails this lint rather
# than inheriting zero coverage. Before 2026-08-26 this was implicit — the file
# knew main-ci by name and nothing looked for others.
KNOWN_DISPATCHERS = {(MAIN_FILE, "build-desktop"), (NIGHTLY_FILE, "release")}


def check_dispatcher_inventory() -> None:
    """No job outside KNOWN_DISPATCHERS may POST to build-desktop's dispatch API."""
    found = set()
    for relative, document in WORKFLOWS.items():
        jobs = document.get("jobs")
        if not isinstance(jobs, dict):
            continue
        for job_id, job in jobs.items():
            if not isinstance(job, dict):
                continue
            for step in job.get("steps") or []:
                if not isinstance(step, dict):
                    continue
                run = step.get("run")
                if isinstance(run, str) and DISPATCH_ENDPOINT in run:
                    found.add((relative, job_id))
    extra = found - KNOWN_DISPATCHERS
    if extra:
        locations = ", ".join(f"{path}:{job}" for path, job in sorted(extra))
        fail(
            MAIN_FILE,
            "only the reviewed dispatchers may dispatch build-desktop.yml; "
            f"unreviewed dispatcher(s): {locations}",
        )
    missing = KNOWN_DISPATCHERS - found
    if missing:
        locations = ", ".join(f"{path}:{job}" for path, job in sorted(missing))
        fail(MAIN_FILE, f"expected dispatcher(s) not found: {locations}")


def check_nightly_dispatcher() -> None:
    """The nightly release job is held to main-ci's dispatcher contract."""
    nightly = WORKFLOWS.get(NIGHTLY_FILE)
    if not isinstance(nightly, dict):
        fail(NIGHTLY_FILE, "nightly-ci.yml is required")
        return
    jobs = nightly.get("jobs")
    dispatcher = jobs.get("release") if isinstance(jobs, dict) else None
    if not isinstance(dispatcher, dict):
        fail(NIGHTLY_FILE, "jobs.release dispatcher is required")
        return
    where = f"{NIGHTLY_FILE}.jobs.release"

    if "uses" in dispatcher or "steps" not in dispatcher:
        fail(NIGHTLY_FILE, "release dispatcher must be a normal step job, not a reusable-workflow caller")
        return

    needs = normalize_needs(dispatcher.get("needs"), f"{where}.needs")
    if set(needs) != NIGHTLY_RELEASE_NEEDS or len(needs) != len(NIGHTLY_RELEASE_NEEDS):
        fail(NIGHTLY_FILE, "release dispatcher needs exact complete scan/build dependency set")

    # Deliberately NARROWER than success(): scorecard, sonar, and zap stay in
    # `needs` so their verdicts are visible and ordered, but they are posture and
    # advisory signals and must not strand a release. Every BLOCKING gate is
    # asserted present here; widening this set is a security decision, and
    # `!cancelled()` must never become `always()` (which would also run on cancel).
    condition = normalize_expression(dispatcher.get("if"))
    required_conjuncts = [
        "!cancelled()",
        "needs.window.outputs.pending == 'true'",
        "needs.ioc.result == 'success'",
        "needs.build.result == 'success'",
        "needs.unit-smoke.result == 'success'",
        "needs.eslint.result == 'success'",
        "needs.codeql.result == 'success'",
        "needs.govulncheck.result == 'success'",
        "needs.secret-scanning.result == 'success'",
        "needs.native-audiocap.result == 'success'",
    ]
    missing = [c for c in required_conjuncts if c not in condition]
    if missing or "always()" in condition:
        fail(
            NIGHTLY_FILE,
            "release dispatcher gate is missing required conjunct(s): "
            + (", ".join(missing) or "always() is forbidden"),
        )

    if "secrets" in dispatcher or has_secrets_context(dispatcher):
        fail(NIGHTLY_FILE, "release dispatcher must not map or reference secrets")
    if environment_name(dispatcher.get("environment"), where):
        fail(NIGHTLY_FILE, "release dispatcher must not reference an environment")
    permissions = effective_permissions(nightly, dispatcher, where)
    if "permissions" not in dispatcher or permissions != {
        "actions": "write",
        "checks": "read",
        "contents": "read",
    }:
        fail(
            NIGHTLY_FILE,
            "release dispatcher permissions must be exactly actions: write, checks: read, contents: read",
        )

    steps = job_steps(dispatcher, where)
    dispatch_contract = False
    if len(steps) == 1:
        step = steps[0]
        env = step.get("env")
        run = step.get("run", "")
        lines = (
            [line.strip() for line in executable_shell(run).splitlines() if line.strip()]
            if isinstance(run, str)
            else []
        )
        dispatch_contract = (
            set(step) == {"name", "env", "run"}
            and isinstance(env, dict)
            and set(env) == {"GH_TOKEN", "EXPECTED_SHA", "VERSION"}
            and normalize_expression(env.get("GH_TOKEN")) == "github.token"
            and normalize_expression(env.get("EXPECTED_SHA")) == "github.sha"
            and normalize_expression(env.get("VERSION")) == "needs.window.outputs.version"
            and lines == EXPECTED_NIGHTLY_DISPATCHER_STEP
        )
    if not dispatch_contract:
        fail(
            NIGHTLY_FILE,
            "release dispatcher must match the exact reviewed dispatch-and-await contract",
        )


def check_dispatch_binding() -> None:
    detect = BUILD_JOBS.get("detect-release")
    if not isinstance(detect, dict):
        fail(BUILD_FILE, "detect-release job is required")
        return
    where = f"{BUILD_FILE}.jobs.detect-release"
    steps = job_steps(detect, where)

    # The binding compares EXPECTED_SHA against the checked-out HEAD, so the
    # preceding checkout must be unpinnable: a `ref:` override (e.g.
    # `ref: ${{ inputs.expected_sha }}`) would make the comparison
    # tautological and silently reopen the gated-commit race (#2274).
    checkout_indexes = [
        index for index, step in enumerate(steps) if action_name(step).startswith("actions/checkout@")
    ]
    checkout_pinned = False
    if len(checkout_indexes) == 1:
        checkout_index = checkout_indexes[0]
        inputs = action_inputs(steps[checkout_index], f"{where}.steps[{checkout_index}]")
        checkout_pinned = inputs == {"fetch-depth": "0"}
    if not checkout_pinned:
        fail(
            BUILD_FILE,
            "detect-release must have exactly one checkout with only fetch-depth: 0 (no ref/repository override)",
        )
        return

    binding_index = checkout_indexes[0] + 1
    if binding_index < len(steps):
        step = steps[binding_index]
        env = step.get("env")
        run = step.get("run", "")
        if (
            step.get("name") == "Verify dispatched SHA binding"
            and set(step) == {"name", "shell", "env", "run"}
            and normalize_expression(step.get("shell")) == "bash"
            and isinstance(env, dict)
            and set(env) == {"BASH_ENV", "EXPECTED_SHA"}
            and env.get("BASH_ENV") == "/dev/null"
            and normalize_expression(env.get("EXPECTED_SHA")) == "inputs.expected_sha"
            and isinstance(run, str)
            and [line.strip() for line in executable_shell(run).splitlines() if line.strip()]
            == EXPECTED_SHA_BINDING
        ):
            return
    fail(
        BUILD_FILE,
        "detect-release must fail closed when the dispatched expected_sha no longer matches main HEAD",
    )


def prohibited_pr_operations(job: dict, where: str) -> set[str]:
    found = set()
    for index, step in enumerate(job_steps(job, where)):
        uses = action_name(step)
        run = step.get("run", "")
        if run is None:
            run = ""
        if not isinstance(run, str):
            raise ShapeError(f"{where}.steps[{index}].run must be a scalar")
        command = executable_shell(run).lower()

        if "actions/upload-artifact@" in uses:
            found.add("artifact upload")
        if "attest" in uses or re.search(r"\battest(?:ation)?\b", command):
            found.add("attestation")
        if uses.startswith("azure/trusted-signing-action@") or any(
            token in uses
            for token in (
                "import-codesign-certs",
                "azure/login@",
                "artifact-signing",
                "action-gh-release",
                "release-action",
            )
        ) or re.search(
            r"\b(codesign|signtool|trusted-signing|sign-linux-update)\b|"
            r"\bcosign\s+sign(?:-blob)?\b",
            command,
        ):
            found.add("signing")
        if re.search(r"\b(notarytool|notariz(?:e|ation)|stapler)\b", command):
            found.add("notarization")
        if re.search(r"\bgh\s+release\b|\bnpm\s+publish\b|\bforge\s+publish\b", command):
            found.add("release or publish")
        if re.search(r"\bgh\s+run\s+download\b", command) or CROSS_RUN_ARTIFACT_API.search(command):
            found.add("cross-run artifact retrieval")
        if "actions/download-artifact@" in uses:
            inputs = action_inputs(step, f"{where}.steps[{index}]")
            if {"run-id", "repository", "github-token"} & set(inputs):
                found.add("cross-run artifact retrieval")
    return found


def check_pr_path() -> None:
    expected_permissions = {
        "pr-paths-filter": {"contents": "read", "pull-requests": "read"},
        "pr-smoke-build": {"contents": "read"},
        "pr-smoke-result": {},
    }
    if has_secrets_context(SMOKE.get("env")):
        fail(SMOKE_FILE, "desktop workflow-level env must not expose secrets to the PR path")
    for job_id in sorted(PR_JOBS):
        if job_id not in SMOKE_JOBS:
            fail(SMOKE_FILE, f"required desktop PR job '{job_id}' is missing")
        elif "uses" in SMOKE_JOBS[job_id] or "steps" not in SMOKE_JOBS[job_id]:
            fail(SMOKE_FILE, "desktop-pr-smoke.yml jobs must be normal step jobs")
        elif normalize_expression(SMOKE_JOBS[job_id].get("uses")) == "./.github/workflows/publish-public-mirror.yml":
            fail(SMOKE_FILE, "desktop-pr-smoke.yml must not call publish-public-mirror.yml")

    if set(SMOKE_JOBS) != PR_JOBS:
        fail(SMOKE_FILE, "desktop-pr-smoke.yml must contain exactly the three PR smoke jobs")

    if "pr-paths-filter" in SMOKE_JOBS:
        job = SMOKE_JOBS["pr-paths-filter"]
        if normalize_needs(job.get("needs"), f"{BUILD_FILE}.jobs.pr-paths-filter.needs"):
            fail(SMOKE_FILE, "pr-paths-filter must not depend on another job")
        filters = None
        for index, step in enumerate(job_steps(job, f"{SMOKE_FILE}.jobs.pr-paths-filter")):
            if action_name(step).partition("@")[0] != "dorny/paths-filter":
                continue
            inputs = action_inputs(step, f"{SMOKE_FILE}.jobs.pr-paths-filter.steps[{index}]")
            raw_filters = inputs.get("filters")
            if isinstance(raw_filters, str):
                try:
                    filters = yaml.load(raw_filters, Loader=UniqueBaseLoader)
                except yaml.YAMLError:
                    filters = None
            break
        desktop_paths = filters.get("desktop-shell") if isinstance(filters, dict) else None
        if not isinstance(desktop_paths, list) or SMOKE_FILE not in desktop_paths:
            fail(SMOKE_FILE, "pr-paths-filter must include desktop-pr-smoke.yml in desktop-shell filter")

    if "pr-smoke-build" in SMOKE_JOBS:
        job = SMOKE_JOBS["pr-smoke-build"]
        if normalize_needs(job.get("needs"), f"{BUILD_FILE}.jobs.pr-smoke-build.needs") != [
            "pr-paths-filter"
        ]:
            fail(SMOKE_FILE, "pr-smoke-build must need only pr-paths-filter")
        condition = normalize_expression(job.get("if"))
        if condition != (
            "github.event_name == 'pull_request' && "
            "needs.pr-paths-filter.outputs.desktop-shell == 'true'"
        ):
            fail(SMOKE_FILE, "pr-smoke-build must use the exact PR path-match gate")

    if "pr-smoke-result" in SMOKE_JOBS:
        job = SMOKE_JOBS["pr-smoke-result"]
        if job.get("name") != "PR smoke test result":
            fail(SMOKE_FILE, "pr-smoke-result must be named exactly 'PR smoke test result'")
        needs = normalize_needs(job.get("needs"), f"{BUILD_FILE}.jobs.pr-smoke-result.needs")
        if needs != ["pr-paths-filter", "pr-smoke-build"]:
            fail(SMOKE_FILE, "pr-smoke-result must need path filter and smoke build")
        condition = normalize_expression(job.get("if"))
        if "always()" not in condition or not has_exact_comparison(
            condition, "github.event_name", "pull_request"
        ):
            fail(SMOKE_FILE, "pr-smoke-result must retain its explicit pull_request sentinel")
        scripts = "\n".join(
            step.get("run", "")
            for step in job_steps(job, f"{SMOKE_FILE}.jobs.pr-smoke-result")
            if isinstance(step.get("run", ""), str)
        )
        path_case = re.search(
            r'case\s+"\$\{PATHS_FILTER_RESULT\}"\s+in(?P<body>[\s\S]*?)\besac',
            scripts,
        )
        default_arm = (
            re.search(r'(?m)^\s*\*\)\s*(?P<body>[\s\S]*?)\s*;;', path_case.group("body"))
            if path_case
            else None
        )
        if not default_arm or not re.search(r'\bexit\s+1\b', default_arm.group("body")):
            fail(SMOKE_FILE, "pr-smoke-result must fail closed when the path filter fails")

        no_match = re.search(
            r'if\s+\[\[\s+"\$\{DESKTOP_SHELL\}"\s+!=\s+"true"\s+\]\];\s*then(?P<body>[\s\S]*?)\bfi',
            scripts,
        )
        if not no_match or not re.search(r'\bexit\s+0\b', no_match.group("body")):
            fail(SMOKE_FILE, "pr-smoke-result must succeed when no desktop-shell paths match")

        smoke_case = re.search(
            r'case\s+"\$\{SMOKE_BUILD_RESULT\}"\s+in(?P<body>[\s\S]*?)\besac',
            scripts,
        )
        for label, contract in (
            ("failure", "pr-smoke-result must fail when the matching smoke build fails"),
            ("cancelled", "pr-smoke-result must fail when the smoke build is cancelled"),
            ("skipped", "pr-smoke-result must fail when the matching smoke build is skipped"),
        ):
            arm = (
                re.search(rf'(?m)^\s*{label}\)\s*(?P<body>[\s\S]*?)\s*;;', smoke_case.group("body"))
                if smoke_case
                else None
            )
            if not arm or not re.search(r'\bexit\s+1\b', arm.group("body")):
                fail(SMOKE_FILE, contract)

    pr_reachable = set()
    for job_id, job in BUILD_JOBS.items():
        condition = normalize_expression(job.get("if"))
        if job_id in PR_JOBS or not excludes_pull_request(condition):
            pr_reachable.add(job_id)

    unexpected = sorted(pr_reachable - PR_JOBS)
    for job_id in unexpected:
        fail(BUILD_FILE, f"job '{job_id}' is an undesignated pull-request path")

    for job_id in sorted(pr_reachable):
        job = BUILD_JOBS[job_id]
        where = f"{BUILD_FILE}.jobs.{job_id}"
        permissions = effective_permissions(BUILD, job, where)
        if job_id in expected_permissions:
            if "permissions" not in job or permissions != expected_permissions[job_id]:
                fail(BUILD_FILE, f"{job_id} effective permissions must match its exact PR contract")
        forbidden = [
            permission
            for permission in ("id-token", "attestations", "contents", "deployments")
            if has_permission(permissions, permission, "write")
        ]
        if forbidden:
            fail(BUILD_FILE, f"PR-reachable job '{job_id}' has forbidden write permissions: {', '.join(forbidden)}")
        if environment_name(job.get("environment"), where):
            fail(BUILD_FILE, f"PR-reachable job '{job_id}' must not reference an environment")
        if has_secrets_context(job):
            fail(BUILD_FILE, f"PR-reachable job '{job_id}' must not reference secrets context")
        operations = prohibited_pr_operations(job, where)
        if operations:
            fail(
                BUILD_FILE,
                f"PR-reachable job '{job_id}' has prohibited operation(s): {', '.join(sorted(operations))}",
            )

    for job_id in sorted(PR_JOBS):
        job = SMOKE_JOBS.get(job_id)
        if not isinstance(job, dict):
            continue
        where = f"{SMOKE_FILE}.jobs.{job_id}"
        if "uses" in job:
            if normalize_expression(job.get("uses")) == "./.github/workflows/publish-public-mirror.yml":
                fail(SMOKE_FILE, "desktop-pr-smoke.yml must not call publish-public-mirror.yml")
            fail(SMOKE_FILE, "desktop-pr-smoke.yml jobs must be normal step jobs")
        permissions = effective_permissions(SMOKE, job, where)
        if "permissions" not in job or permissions != expected_permissions[job_id]:
            fail(SMOKE_FILE, f"{job_id} effective permissions must match its exact PR contract")
        forbidden = [
            permission
            for permission in ("id-token", "attestations", "contents", "deployments")
            if has_permission(permissions, permission, "write")
        ]
        if forbidden:
            fail(SMOKE_FILE, f"PR-reachable job '{job_id}' has forbidden write permissions: {', '.join(forbidden)}")
        if environment_name(job.get("environment"), where):
            fail(SMOKE_FILE, f"PR-reachable job '{job_id}' must not reference an environment")
        if has_secrets_context(job):
            fail(SMOKE_FILE, f"PR-reachable job '{job_id}' must not reference secrets context")
        operations = prohibited_pr_operations(job, where)
        if operations:
            fail(SMOKE_FILE, f"PR-reachable job '{job_id}' has prohibited operation(s): {', '.join(sorted(operations))}")


def check_classifier_trust_boundary() -> None:
    lockstep_path = ".github/workflows/classify-release.yml"
    comment_path = ".github/workflows/classify-release-comment.yml"
    lockstep = WORKFLOWS.get(lockstep_path)
    publisher = WORKFLOWS.get(comment_path)
    if lockstep is None or publisher is None:
        fail(comment_path, "protected-base classifier comment workflow is required")
        return

    lockstep_jobs = mapping(lockstep.get("jobs"), f"{lockstep_path}.jobs")
    if set(lockstep_jobs) != {"contract-version-lockstep"}:
        fail(lockstep_path, "classify-release.yml must contain only the read-only lockstep job")
    lockstep_job = lockstep_jobs.get("contract-version-lockstep", {})
    if effective_permissions(lockstep, lockstep_job, f"{lockstep_path}.jobs.contract-version-lockstep") != {"contents": "read"}:
        fail(lockstep_path, "only classify-comment may have pull-requests: write")
    for path, workflow in ((lockstep_path, lockstep), (comment_path, publisher)):
        for job_id, job in mapping(workflow.get("jobs"), f"{path}.jobs").items():
            permissions = effective_permissions(workflow, job, f"{path}.jobs.{job_id}")
            if permissions.get("pull-requests") == "write" and not (
                path == comment_path and job_id == "classify-comment"
            ):
                fail(lockstep_path, "only classify-comment may have pull-requests: write")

    on = mapping(publisher.get("on"), f"{comment_path}.on")
    trigger = on.get("pull_request_target")
    gates = (
        "github.repository == 'Concord-Voice/Desktop' && "
        "github.event.pull_request.base.ref == 'main' && "
        "github.event.pull_request.head.repo.full_name == github.repository"
    )
    jobs = mapping(publisher.get("jobs"), f"{comment_path}.jobs")
    if set(jobs) != {"classify-data", "classify-comment"}:
        fail(comment_path, "classify-release-comment.yml must contain exactly classify-data and classify-comment jobs")
    data = jobs.get("classify-data", {})
    comment = jobs.get("classify-comment", {})
    output_names = (
        "shell_changed", "old_contract", "new_contract", "contract_action",
        "old_version", "new_version", "version_action", "old_spa_min",
        "new_spa_min", "spa_min_action", "spa_min_present", "version_bump_required",
    )
    expected_outputs = set(output_names)
    expected_comment_gate = (
        gates
        + " && needs.classify-data.result == 'success' && "
        + " && ".join(
            f"needs.classify-data.outputs.{name} != ''" for name in output_names
        )
    )
    if (
        trigger is None
        or trigger_names(publisher.get("on"), f"{comment_path}.on") != {"pull_request_target"}
        or not isinstance(trigger, dict)
        or trigger.get("branches") != ["main"]
        or set(trigger.get("types", [])) != {"opened", "synchronize", "reopened", "labeled", "unlabeled"}
        or normalize_expression(data.get("if")) != gates
        or normalize_expression(comment.get("if")) != expected_comment_gate
        or normalize_needs(comment.get("needs"), f"{comment_path}.jobs.classify-comment.needs") != ["classify-data"]
    ):
        fail(comment_path, "classify-comment must use the exact repository/main/same-repository and complete-data gate")

    if effective_permissions(publisher, data, f"{comment_path}.jobs.classify-data") != {"contents": "read"}:
        fail(comment_path, "classify-data must have exactly contents: read")
    if "continue-on-error" in data:
        fail(comment_path, "classify-data must preserve advisory behavior without job-level continue-on-error")
    if effective_permissions(publisher, comment, f"{comment_path}.jobs.classify-comment") != {
        "contents": "read", "pull-requests": "write"
    }:
        fail(comment_path, "classify-comment must have exactly contents: read and pull-requests: write")
    if comment.get("name") != "Classify release impact":
        fail(comment_path, "classify-comment must preserve the Classify release impact check name")

    outputs = mapping(data.get("outputs"), f"{comment_path}.jobs.classify-data.outputs", none_as_empty=True)
    if set(outputs) != expected_outputs or any(
        normalize_expression(value) != f"steps.validate.outputs.{name}"
        for name, value in outputs.items()
    ):
        fail(comment_path, "classify-data must expose only validated classifier outputs")

    data_steps = job_steps(data, f"{comment_path}.jobs.classify-data")
    data_step_ids = [step.get("id") for step in data_steps]
    checkout_step_count = sum(
        1 for step in data_steps if action_name(step).startswith("actions/checkout@")
    )
    if data_step_ids != ["checkout-base", "fetch-target", "classify", "validate"] or checkout_step_count != 1:
        fail(comment_path, "classify-data must have exactly one protected-base checkout and the approved data-step inventory")
    validator = next((step for step in data_steps if step.get("id") == "validate"), None)
    validator_script = str(validator.get("run", "")) if validator else ""
    validator_shell = executable_shell(validator_script)
    validator_env = mapping(validator.get("env"), f"{comment_path}.jobs.classify-data.validate.env") if validator else {}
    if '[[ "${SPA_MIN_ACTION}" =~ ^(none|raised|lowered|removed)$ ]]' not in validator_shell:
        fail(comment_path, "classify-comment must validate spa_min_action including removed")
    required_validator_predicates = (
        '[[ "${SHELL_CHANGED}" =~ ^(true|false)$ ]]',
        '[[ "${OLD_CONTRACT}" =~ ^(0|[1-9][0-9]{0,8})$ ]]',
        '[[ "${NEW_CONTRACT}" =~ ^(0|[1-9][0-9]{0,8})$ ]]',
        '[[ "${CONTRACT_ACTION}" =~ ^(none|needed|bumped)$ ]]',
        r'[[ "${OLD_VERSION}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ && ${#OLD_VERSION} -le 128 ]]',
        r'[[ "${NEW_VERSION}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ && ${#NEW_VERSION} -le 128 ]]',
        '[[ "${VERSION_ACTION}" =~ ^(none|notes-needed|bumped)$ ]]',
        '[[ "${OLD_SPA_MIN}" =~ ^(0|[1-9][0-9]{0,8})$ ]]',
        '[[ "${NEW_SPA_MIN}" =~ ^(0|[1-9][0-9]{0,8})$ ]]',
        '[[ "${SPA_MIN_ACTION}" =~ ^(none|raised|lowered|removed)$ ]]',
        '[[ "${SPA_MIN_PRESENT}" =~ ^(true|false)$ ]]',
        '[[ "${VERSION_BUMP_REQUIRED}" =~ ^(true|false)$ ]]',
    )
    output_buffer_start = validator_shell.find('output_file="$(mktemp)"')
    if (
        any(predicate not in validator_shell for predicate in required_validator_predicates)
        or any(validator_shell.find(predicate) < 0 or validator_shell.find(predicate) >= output_buffer_start for predicate in required_validator_predicates)
        or any(
            normalize_expression(validator_env.get(name.upper())) != f"steps.classify.outputs.{name}"
            for name in output_names
        )
        or "(( output_bytes <= 8192 ))" not in validator_shell
        or 'cat "${output_file}" >> "${GITHUB_OUTPUT}"' not in validator_shell
    ):
        fail(comment_path, "classify-data must validate every classifier output before exposing them")
    checkout = next((step for step in data_steps if action_name(step).startswith("actions/checkout@")), None)
    checkout_ok = False
    if checkout:
        checkout_inputs = action_inputs(checkout, f"{comment_path}.jobs.classify-data.checkout")
        checkout_ok = (
            bool(re.fullmatch(r"actions/checkout@[0-9a-f]{40}", action_name(checkout)))
            and normalize_expression(checkout_inputs.get("ref")) == "github.event.pull_request.base.sha"
            and str(checkout_inputs.get("fetch-depth")) == "0"
            and str(checkout_inputs.get("persist-credentials")).lower() == "false"
        )
    if not checkout_ok:
        fail(comment_path, "classify-data must check out the protected base with full history and persist-credentials: false")
    if not checkout_ok or any(re.search(r"\bgit\s+checkout\b", str(step.get("run", ""))) for step in data_steps):
        fail(comment_path, "classify-data must not check out or execute PR-head code")

    fetch_script = "\n".join(
        str(step.get("run", "")) for step in data_steps if isinstance(step.get("run"), str)
    )
    if not (
        '"refs/pull/${PR_NUMBER}/head"' in fetch_script
        and '[[ "${PR_NUMBER}" =~ ^[1-9][0-9]{0,8}$ ]]' in fetch_script
        and '[[ "${EVENT_HEAD}" =~ ^[0-9a-f]{40}$ ]]' in fetch_script
        and '[[ "${fetched}" == "${EVENT_HEAD}" ]]' in fetch_script
        and "FETCH_HEAD" in fetch_script
    ):
        fail(comment_path, "classify-data must compare the fetched commit to the event head SHA")
    if not (
        "bash .github/scripts/classify-release.sh" in fetch_script
        and "TARGET_SHA" in fetch_script
        and "BASE_SHA" in rendered(data_steps)
    ):
        fail(comment_path, "classify-data must classify the fetched target with the protected base script")

    comment_steps = job_steps(comment, f"{comment_path}.jobs.classify-comment")
    scripts = [step for step in comment_steps if action_name(step).startswith("actions/github-script@")]
    if any(action_name(step).startswith("actions/checkout@") for step in comment_steps):
        fail(comment_path, "classify-comment must not check out code")
    if len(scripts) != 1 or len(comment_steps) != 1 or not re.fullmatch(
        r"actions/github-script@[0-9a-f]{40}", action_name(scripts[0]) if scripts else ""
    ):
        fail(comment_path, "classify-comment must have exactly one pinned github-script publisher step")
    script_body = rendered(action_inputs(scripts[0], f"{comment_path}.github-script")) if scripts else ""
    step_env = mapping(scripts[0].get("env"), f"{comment_path}.github-script.env") if scripts else {}
    if "enumValue(SPA_MIN_ACTION, ['none', 'raised', 'lowered', 'removed'])" not in script_body:
        fail(comment_path, "classify-comment must validate spa_min_action including removed")
    if "<!-- classify-release -->" not in script_body:
        fail(comment_path, "classify-comment must preserve the release comment marker and check name")
    freshness = (
        "if (current.data.state !== 'open' || current.data.base.ref !== 'main' || "
        "current.data.head.sha !== context.payload.pull_request.head.sha || "
        "current.data.base.sha !== context.payload.pull_request.base.sha) return;"
    )
    if freshness not in script_body or "current.data.labels" not in script_body or "risk: hotfix" not in script_body:
        fail(comment_path, "classify-comment must revalidate the open PR head/base/main state and current hotfix labels before publishing")
    if (
        "const NA = 'unknown (probe failed)';" not in script_body
        or "let liveContract = NA;" not in script_body
        or "const activeContract = liveContract || NA;" not in script_body
        or "if (typeof config.spaIpcContract === 'number' && Number.isSafeInteger(config.spaIpcContract) && config.spaIpcContract >= 0 && config.spaIpcContract <= 999999999) liveContract = String(config.spaIpcContract);" not in script_body
    ):
        fail(comment_path, "classify-comment must accept bounded numeric spaIpcContract values and preserve unknown for invalid values")
    if (
        "https://api.concordvoice.chat/api/v1/client/config" not in script_body
        or "AbortSignal.timeout(5000)" not in script_body
        or any(isinstance(step.get("run"), str) for step in comment_steps)
    ):
        fail(comment_path, "classify-comment must keep the live production probe inside its sole github-script step")
    if any(name.upper() not in step_env for name in expected_outputs):
        fail(comment_path, "classify-comment must pass the complete validated classifier schema")


def check_public_mirror_contract() -> None:
    mirror = BUILD_JOBS.get("public-release-mirror")
    where = f"{BUILD_FILE}.jobs.public-release-mirror"
    if not isinstance(mirror, dict):
        fail(BUILD_FILE, "public-release-mirror job is required")
    else:
        needs = normalize_needs(mirror.get("needs"), f"{where}.needs")
        if needs != ["detect-release", "release-build", "release"]:
            fail(BUILD_FILE, "public-release-mirror must need detect-release, release-build, and release")
        condition = normalize_expression(mirror.get("if"))
        required = (
            "always()",
            "github.repository == 'Concord-Voice/Desktop'",
            "github.event_name == 'workflow_dispatch'",
            "github.ref == 'refs/heads/main'",
            "needs.release.result == 'success'",
        )
        if any(part not in condition for part in required) or "||" in condition:
            fail(BUILD_FILE, "public-release-mirror condition is missing required trusted-release guard")
        if "environment" in mirror or "secrets" in mirror or "uses" in mirror or "env" in mirror:
            fail(BUILD_FILE, "public-release-mirror must not use environment, secrets, or a reusable workflow")
        permissions = effective_permissions(BUILD, mirror, where)
        if "permissions" not in mirror or permissions != {"actions": "write", "checks": "read"}:
            fail(BUILD_FILE, "public-release-mirror permissions must be exactly actions: write and checks: read")
        if mirror.get("runs-on") != "ubuntu-latest":
            fail(BUILD_FILE, "public-release-mirror must run on ubuntu-latest")
        steps = job_steps(mirror, where)
        contract = False
        if len(steps) == 1:
            step = steps[0]
            env = step.get("env")
            run = step.get("run", "")
            run = executable_shell(run) if isinstance(run, str) else ""
            required_shell = (
                "set -euo pipefail",
                "actions/workflows/publish-public-mirror.yml/dispatches",
                "-F return_run_details=true",
                "-f ref=main",
                'inputs[mirror_release_tag]=$RELEASE_TAG',
                "--jq '.workflow_run_id'",
                'test -n "$RUN_ID"',
                'gh run watch "$RUN_ID"',
                "--exit-status",
            )
            contract = (
                set(step) == {"name", "env", "run"}
                and isinstance(env, dict)
                and set(env) == {"GH_TOKEN", "RELEASE_TAG"}
                and normalize_expression(env.get("GH_TOKEN")) == "github.token"
                and normalize_expression(env.get("RELEASE_TAG")) == "needs.release.outputs.release_tag"
                and all(token in run for token in required_shell)
            )
        if not contract:
            run_text = "\n".join(rendered(step) for step in steps)
            if "-f ref=main" not in run_text:
                fail(BUILD_FILE, "public-release-mirror dispatch must use literal ref=main")
            elif "gh run watch" not in run_text or "--exit-status" not in run_text:
                fail(BUILD_FILE, "public-release-mirror must watch the child run with --exit-status")
            else:
                fail(BUILD_FILE, "public-release-mirror must match the reviewed dispatch-and-watch contract")

    for job_id in ("publish", "release-mirror", "selfhost-release"):
        job = PUBLISH_JOBS.get(job_id)
        if not isinstance(job, dict):
            fail(PUBLISH_FILE, f"publisher job '{job_id}' is required")
            continue
        where = f"{PUBLISH_FILE}.jobs.{job_id}"
        if environment_name(job.get("environment"), where) != "public-mirror":
            fail(PUBLISH_FILE, f"publisher job '{job_id}' must use environment public-mirror")
        condition = normalize_expression(job.get("if"))
        expected = (
            "github.repository == 'Concord-Voice/Desktop' && "
            "github.ref == 'refs/heads/main' && "
            "(github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && "
            "inputs.mirror_release_tag == ''))"
            if job_id == "publish"
            else
            "github.repository == 'Concord-Voice/Desktop' && "
            "github.ref == 'refs/heads/main' && "
            "github.event_name == 'workflow_dispatch' && "
            "format('{0}', inputs.stage_selfhost) != 'true' && "
            + ("format('{0}', inputs.dry_run) == 'false' && " if job_id == "selfhost-release" else "")
            + f"startsWith(inputs.mirror_release_tag, '{'desktop-v' if job_id == 'release-mirror' else 'selfhost-v'}')"
        )
        if condition != expected:
            fail(PUBLISH_FILE, f"publisher job '{job_id}' must use the exact repository, main-ref, and event guard")
        if job_id == "selfhost-release" and effective_permissions(PUBLISH, job, where) != {
            "contents": "read", "actions": "read", "pull-requests": "read"
        }:
            fail(PUBLISH_FILE, "publisher job 'selfhost-release' permissions must be exactly contents: read, actions: read, and pull-requests: read")

    expected_jobs = {"mirror-prepare", "mirror-scan", "publish", "release-mirror",
                     "selfhost-prepare", "selfhost-scan", "selfhost-release"}
    if set(PUBLISH_JOBS) != expected_jobs:
        fail(PUBLISH_FILE, "publish-public-mirror.yml must keep the reviewed prepare/scan/publish job graph")

    # Only the three publisher jobs may bind the public-mirror environment. A
    # scanner must run in a separate native job with no repository-token scope,
    # private checkout, or publisher credential source.
    for job_id, expected in (
        ("mirror-prepare", {"contents": "read"}),
        ("selfhost-prepare", {"contents": "read", "actions": "read", "pull-requests": "read"}),
    ):
        job = PUBLISH_JOBS[job_id]
        where = f"{PUBLISH_FILE}.jobs.{job_id}"
        if (environment_name(job.get("environment"), where)
                or effective_permissions(PUBLISH, job, where) != expected
                or "create-github-app-token@" in rendered(job)
                or "PUBLIC_MIRROR_APP_PRIVATE_KEY" in rendered(job)):
            fail(PUBLISH_FILE, "mirror-prepare and selfhost-prepare must use read-only permissions and no public-mirror environment")

    for job_id in ("mirror-scan", "selfhost-scan"):
        job = PUBLISH_JOBS[job_id]
        where = f"{PUBLISH_FILE}.jobs.{job_id}"
        scanner_scope = [PUBLISH.get("env"), job]
        content = rendered(scanner_scope)
        secret_expression = any(
            "${{" in value
            and re.search(r"(?<![A-Za-z0-9_])secrets(?![A-Za-z0-9_])", value, re.IGNORECASE)
            for value in flatten_strings(scanner_scope)
        )
        if (environment_name(job.get("environment"), where)
                or effective_permissions(PUBLISH, job, where) != {}
                or secret_expression
                or any(item in content for item in (
                    "actions/checkout@", "create-github-app-token@",
                    "github.token", "PMIRROR_SOURCE_GH_TOKEN", "PMIRROR_PUBLIC_GH_TOKEN",
                    "PMIRROR_PUBLIC_REMOTE"))):
            fail(PUBLISH_FILE, "mirror-scan and selfhost-scan must have no environment or repository token permissions")

    mirror_guard = normalize_expression(PUBLISH_JOBS["publish"].get("if"))
    selfhost_guard = normalize_expression(PUBLISH_JOBS["selfhost-release"].get("if"))
    graph = (
        PUBLISH_JOBS["mirror-prepare"].get("needs") is None
        and PUBLISH_JOBS["mirror-scan"].get("needs") == ["mirror-prepare"]
        and PUBLISH_JOBS["publish"].get("needs") == ["mirror-prepare", "mirror-scan"]
        and PUBLISH_JOBS["selfhost-prepare"].get("needs") is None
        and PUBLISH_JOBS["selfhost-scan"].get("needs") == ["selfhost-prepare"]
        and PUBLISH_JOBS["selfhost-release"].get("needs") in (
            ["selfhost-prepare", "selfhost-scan"], ["selfhost-scan", "selfhost-prepare"])
        and all(normalize_expression(PUBLISH_JOBS[job].get("if")) == mirror_guard
                for job in ("mirror-prepare", "mirror-scan"))
        and all(normalize_expression(PUBLISH_JOBS[job].get("if")) == selfhost_guard
                for job in ("selfhost-prepare", "selfhost-scan"))
    )
    if not graph:
        fail(PUBLISH_FILE, "publish-public-mirror.yml must keep the reviewed prepare/scan/publish job graph")

    for path, workflow in WORKFLOWS.items():
        if path == PUBLISH_FILE:
            continue
        text = rendered(workflow)
        if "PUBLIC_MIRROR_APP_PRIVATE_KEY" in text or "CF_PAGES_DEPLOY_HOOK" in text:
            fail(path, "mirror secrets may be referenced only from publish-public-mirror.yml")


def provision_environment_input_pinned() -> bool:
    # ADR-0033 exception guard: the provision job's environment-scoped OIDC
    # allowance is only safe while the `environment` dispatch input cannot
    # select anything beyond production/production-west-stage. Widening the options (e.g.
    # adding desktop-release) would let a provision dispatch run inside the
    # signing environment and mint an Azure-trusted subject while the
    # exception still matched the unchanged `inputs.environment` expression.
    workflow = WORKFLOWS.get(PROVISION_FILE)
    if not isinstance(workflow, dict):
        return False
    on = workflow.get("on")
    if not isinstance(on, dict):
        return False
    dispatch = on.get("workflow_dispatch")
    if not isinstance(dispatch, dict):
        return False
    inputs = dispatch.get("inputs")
    if not isinstance(inputs, dict):
        return False
    # The identity's OIDC exception is only safe while provision-secrets.yml
    # stays DISPATCH-ONLY. A `workflow_call` trigger would let a reusable
    # caller invoke the provision job (with its environment-scoped OIDC) —
    # the #2048/#2274 class of trust leak. Require the exact trigger set.
    if set(on.keys()) != {"workflow_dispatch"}:
        return False
    environment = inputs.get("environment")
    if not isinstance(environment, dict):
        return False
    # ["production"] also remains safe if the West staging option is removed.
    # Anything beyond these closed sets rejects.
    return environment.get("options") in (
        ["production", "production-west-stage"], ["production"]
    )


def check_global_environments() -> None:
    for path, workflow in WORKFLOWS.items():
        for job_id, job in workflow["jobs"].items():
            where = f"{path}.jobs.{job_id}"
            environment = environment_name(job.get("environment"), where)
            permissions = effective_permissions(workflow, job, where)
            allowed_release_environment = path == BUILD_FILE and job_id in TRUSTED_JOBS
            allowed_oidc = (
                path == BUILD_FILE
                and job_id == "release-build"
                and environment == "desktop-release"
            ) or (
                # ADR-0033 (#2317): provision-secrets.yml sources runtime
                # secret values from Infisical via OIDC. Its provision job
                # legitimately binds BOTH the environment (CONCORD_DEPLOY_KEY
                # residency; the Infisical identity is bound to the
                # environment-form subject) AND id-token: write. The Azure
                # desktop-signing federation trusts only
                # environment:desktop-release subjects, so this exception
                # cannot cross the #2274 signing trust boundary. Pinned to
                # the exact dynamic environment expression so a retargeted
                # copy does not inherit the exception.
                path == PROVISION_FILE
                and job_id == "provision"
                and environment == "inputs.environment"
                # ...and only while the dispatch input cannot be widened to
                # select the signing environment (see helper above).
                and provision_environment_input_pinned()
            )
            if environment == "desktop-release" and not allowed_release_environment:
                fail(path, f"desktop-release environment is forbidden on job '{job_id}'")
            if environment and has_permission(permissions, "id-token", "write") and not allowed_oidc:
                fail(path, f"environment-scoped OIDC is forbidden on job '{job_id}'")


def check_trusted_jobs() -> None:
    if "env" in BUILD or "defaults" in BUILD:
        fail(BUILD_FILE, "desktop workflow must not define inherited env or defaults")

    for job_id in sorted(TRUSTED_JOBS):
        if job_id not in BUILD_JOBS:
            fail(BUILD_FILE, f"required trusted job '{job_id}' is missing")
            continue
        job = BUILD_JOBS[job_id]
        where = f"{BUILD_FILE}.jobs.{job_id}"
        allowed_keys = {
            "name",
            "needs",
            "if",
            "environment",
            "permissions",
            "runs-on",
            "timeout-minutes",
            "steps",
        }
        allowed_keys.add("strategy" if job_id == "release-build" else "outputs")
        if not set(job) <= allowed_keys:
            fail(BUILD_FILE, f"{job_id} trusted job keys must match the reviewed contract")
        if "env" in job or "defaults" in job:
            fail(BUILD_FILE, f"{job_id} must not define inherited env or defaults")
        if "container" in job:
            fail(BUILD_FILE, f"{job_id} must not define a container execution context")
        expected_runner = "${{ matrix.os }}" if job_id == "release-build" else "ubuntu-latest"
        raw_runner = job.get("runs-on")
        if not isinstance(raw_runner, str) or raw_runner.strip() != expected_runner:
            fail(BUILD_FILE, f"{job_id} must use exactly runs-on: {expected_runner}")
        if environment_name(job.get("environment"), where) != "desktop-release":
            fail(BUILD_FILE, f"{job_id} must use environment desktop-release")
        expected_condition = (
            RELEASE_BUILD_CONDITION if job_id == "release-build" else RELEASE_CONDITION
        )
        if normalize_expression(job.get("if")) != expected_condition:
            fail(BUILD_FILE, f"{job_id} condition must match the exact trusted release guard")

    release_build = BUILD_JOBS.get("release-build")
    if isinstance(release_build, dict):
        where = f"{BUILD_FILE}.jobs.release-build"
        needs = normalize_needs(release_build.get("needs"), f"{where}.needs")
        if needs != ["detect-release"]:
            fail(BUILD_FILE, "release-build must need only detect-release")
        expected_permissions = {
            "contents": "read",
            "id-token": "write",
            "attestations": "write",
        }
        if "permissions" not in release_build or effective_permissions(
            BUILD, release_build, where
        ) != expected_permissions:
            fail(BUILD_FILE, "release-build permissions must match the exact trusted contract")

        strategy = mapping(release_build.get("strategy"), f"{where}.strategy")
        matrix = strategy.get("matrix")
        if (
            not isinstance(matrix, dict)
            or set(matrix) != {"include"}
            or matrix.get("include") != EXPECTED_MATRIX
        ):
            fail(BUILD_FILE, "release-build must use the exact static six-entry release matrix")

    release = BUILD_JOBS.get("release")
    if isinstance(release, dict):
        where = f"{BUILD_FILE}.jobs.release"
        needs = normalize_needs(release.get("needs"), f"{where}.needs")
        if needs != ["detect-release", "release-build"]:
            fail(BUILD_FILE, "release must need detect-release and release-build")
        expected_permissions = {"contents": "write", "attestations": "read"}
        if "permissions" not in release or effective_permissions(
            BUILD, release, where
        ) != expected_permissions:
            fail(BUILD_FILE, "release permissions must match the exact trusted contract")


def checkout_assertion(step: dict) -> bool:
    if (
        set(step) != {"name", "shell", "env", "run"}
        or step.get("name") != "Verify exact trusted HEAD"
        or normalize_expression(step.get("shell")) != "bash"
        or step.get("env") != {"BASH_ENV": "/dev/null"}
    ):
        return False
    run = step.get("run", "")
    if not isinstance(run, str):
        return False
    lines = [line.strip() for line in executable_shell(run).splitlines() if line.strip()]
    return lines == [
        'actual="$(git rev-parse HEAD)"',
        'if [[ "$actual" != "$GITHUB_SHA" ]]; then',
        "printf 'expected=%s actual=%s\\n' \"$GITHUB_SHA\" \"$actual\" >&2",
        "exit 1",
        "fi",
    ]


def executable_shell(run: str) -> str:
    executable = []
    for line in run.splitlines():
        quote = None
        escaped = False
        for index, character in enumerate(line):
            if escaped:
                escaped = False
                continue
            if character == "\\" and quote != "'":
                escaped = True
                continue
            if quote:
                if character == quote:
                    quote = None
                continue
            if character in {"'", '"'}:
                quote = character
            elif character == "#" and (
                index == 0 or line[index - 1].isspace() or line[index - 1] in ";|&()"
            ):
                line = line[:index]
                break
        if line.strip():
            executable.append(line)
    return "\n".join(executable)


def check_persistent_runner_environment() -> None:
    allowed_step = "Setup Apple API key for notarization (darwin only)"
    allowed_line = 'echo "APPLE_API_KEY=${KEY_PATH}" >> "$GITHUB_ENV"'
    approved_exports = 0
    for job_id in sorted(TRUSTED_JOBS):
        job = BUILD_JOBS.get(job_id)
        if not isinstance(job, dict):
            continue
        where = f"{BUILD_FILE}.jobs.{job_id}"
        for step in job_steps(job, where):
            run = step.get("run", "")
            if not isinstance(run, str):
                continue
            command_file_lines = [
                line.strip()
                for line in executable_shell(run).splitlines()
                if "GITHUB_ENV" in line or "GITHUB_PATH" in line
            ]
            if not command_file_lines:
                continue
            approved_step = (
                job_id == "release-build"
                and step.get("name") == allowed_step
            )
            if approved_step and all(line == allowed_line for line in command_file_lines):
                approved_exports += len(command_file_lines)
            else:
                fail(BUILD_FILE, "trusted jobs may persist only the exact Apple API key path")
    if approved_exports != 1:
        fail(BUILD_FILE, "trusted jobs must contain exactly one approved Apple API key path export")


def check_oidc_validator(steps: list[dict], azure_index: int) -> None:
    validator_indexes = [
        index
        for index, step in enumerate(steps)
        if step.get("name") == "Validate environment OIDC claims"
    ]
    if len(validator_indexes) != 1:
        fail(BUILD_FILE, "OIDC validation step must use the exact fixed identity")
        return
    validator_index = validator_indexes[0]
    if validator_index >= azure_index:
        fail(BUILD_FILE, "OIDC validation must precede azure/login")
    elif validator_index + 1 != azure_index:
        fail(BUILD_FILE, "OIDC validation step must be directly before azure/login")

    validator = steps[validator_index]
    if normalize_expression(validator.get("if")) != "matrix.platform == 'win32'":
        fail(BUILD_FILE, "OIDC validation step must use exactly if: matrix.platform == 'win32'")
    if "continue-on-error" in validator:
        fail(BUILD_FILE, "OIDC validation step must not use continue-on-error")
    if normalize_expression(validator.get("shell")) != "bash":
        fail(BUILD_FILE, "OIDC validation step must use exactly shell: bash")
    if validator.get("env") != {"BASH_ENV": "/dev/null"}:
        fail(BUILD_FILE, "OIDC validation step must isolate BASH_ENV")

    run = validator.get("run", "")
    if not isinstance(run, str):
        fail(BUILD_FILE, "OIDC validation step must contain an executable shell contract")
        return
    run = executable_shell(run)
    flat = re.sub(r"\s+", " ", run).strip()

    executable_lines = run.splitlines()
    successful_termination = re.search(
        r"(?m)(?:^|[;&|(){}]|\bthen\b|\bdo\b)\s*"
        r"(?:exit(?:\s+0\b|(?=\s*(?:$|[;&|(){}<>])))|return\b)",
        run,
    )
    if not executable_lines or executable_lines[0].strip() != "set -euo pipefail" or successful_termination:
        fail(
            BUILD_FILE,
            "OIDC validator must start with set -euo pipefail and reject successful early termination",
        )

    expected_claims = {
        "expected_issuer": "https://token.actions.githubusercontent.com",
        "expected_subject": "repo:Concord-Voice/Desktop:environment:desktop-release",
        "expected_audience": "api://AzureADTokenExchange",
    }
    expected_occurrences = {
        "expected_issuer": 2,
        "expected_subject": 2,
        "expected_audience": 3,
    }
    exact_expected_claims = True
    for variable, value in expected_claims.items():
        exact_assignment = f"{variable}='{value}'"
        assignments = re.findall(rf"(?m)^\s*{re.escape(variable)}\s*=", run)
        occurrences = re.findall(rf"\b{re.escape(variable)}\b", run)
        if (
            len(assignments) != 1
            or len(occurrences) != expected_occurrences[variable]
            or not re.search(rf"(?m)^\s*{re.escape(exact_assignment)}\s*$", run)
        ):
            exact_expected_claims = False
    if not exact_expected_claims:
        fail(BUILD_FILE, "OIDC validator must assign each exact expected claim exactly once")

    request_tokens = (
        "set -euo pipefail",
        'response="$(curl --fail',
        "ACTIONS_ID_TOKEN_REQUEST_URL",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        "audience=${expected_audience}",
        'token="$(python3',
        "json.load(sys.stdin)",
        '["value"]',
        '<<<"$response"',
    )
    if not all(token in run for token in request_tokens):
        fail(BUILD_FILE, "OIDC validator must request a runner ID token")

    decode_tokens = (
        'payload="$(python3 - "$token"',
        '.split(".")[1]',
        "base64.urlsafe_b64decode(encoded)",
        "json.loads(base64.urlsafe_b64decode(encoded))",
    )
    if not all(token in run for token in decode_tokens):
        fail(BUILD_FILE, "OIDC validator must decode and parse JWT claims in memory")

    claims_from_payload = True
    for variable, field in (("issuer", "iss"), ("subject", "sub"), ("audience", "aud")):
        assignments = re.findall(rf"(?m)^\s*{variable}\s*=", run)
        parsed_assignment = re.search(
            rf'(?m)^\s*{variable}="\$\(python3[^\n]*\["{field}"\][^\n]*<<<"\$payload"\)"\s*$',
            run,
        )
        if len(assignments) != 1 or not parsed_assignment:
            claims_from_payload = False
    if not claims_from_payload:
        fail(BUILD_FILE, "OIDC validator must read issuer, subject, and audience from parsed payload claims")

    expected_references = {
        "response": ["$response"],
        "token": ["$token"],
        "payload": ["$payload", "$payload", "$payload"],
    }
    if any(
        parameter_expansions(run, name) != expected
        for name, expected in expected_references.items()
    ):
        fail(BUILD_FILE, "OIDC validator must not print or persist the full token")

    expected_if = (
        'if [[ "$issuer" != "$expected_issuer" || '
        '"$subject" != "$expected_subject" || '
        '"$audience" != "$expected_audience" ]]; then'
    )
    comparison = flat.find(expected_if)
    fail_closed = False
    if comparison >= 0:
        branch = flat[comparison + len(expected_if) :]
        branch = branch.split(" fi", 1)[0]
        fail_closed = bool(re.search(r"(?:^| )exit [1-9][0-9]*(?: |$)", branch))
    if not fail_closed:
        fail(BUILD_FILE, "OIDC validator must fail closed on exact issuer, subject, and audience claims")
    if set(validator) != {"name", "if", "shell", "env", "run"} or run.splitlines() != EXPECTED_OIDC_VALIDATOR:
        fail(BUILD_FILE, "OIDC validator must match the exact reviewed shell contract")


def check_checkout_and_oidc() -> None:
    release_build = BUILD_JOBS.get("release-build")
    if not isinstance(release_build, dict):
        return
    where = f"{BUILD_FILE}.jobs.release-build"
    steps = job_steps(release_build, where)

    checkout_indexes = [
        index for index, step in enumerate(steps) if action_name(step).startswith("actions/checkout@")
    ]
    if len(checkout_indexes) != 1:
        fail(BUILD_FILE, "release-build must have exactly one trusted checkout")
    for checkout_index in checkout_indexes:
        inputs = action_inputs(steps[checkout_index], f"{where}.steps[{checkout_index}]")
        if "repository" in inputs:
            fail(BUILD_FILE, "trusted checkout must not override repository")
        raw_ref = inputs.get("ref")
        if not isinstance(raw_ref, str) or raw_ref.strip() != "${{ github.sha }}":
            fail(BUILD_FILE, "trusted checkout ref must be the exact ${{ github.sha }} expression")
        if inputs != {
            "ref": "${{ github.sha }}",
            "fetch-depth": "0",
            "persist-credentials": "false",
        }:
            fail(BUILD_FILE, "trusted checkout inputs must match the exact reviewed contract")
        assertion_index = checkout_index + 1
        if assertion_index >= len(steps) or not checkout_assertion(steps[assertion_index]):
            fail(BUILD_FILE, "trusted checkout must have an immediate fail-closed HEAD assertion against GITHUB_SHA")

    azure_indexes = [
        index for index, step in enumerate(steps) if action_name(step).startswith("azure/login@")
    ]
    if len(azure_indexes) != 1:
        fail(BUILD_FILE, "release-build must contain exactly one azure/login step")
        return
    azure = steps[azure_indexes[0]]
    if normalize_expression(azure.get("if")) != "matrix.platform == 'win32'":
        fail(BUILD_FILE, "azure/login must use exactly if: matrix.platform == 'win32'")
    if "continue-on-error" in azure:
        fail(BUILD_FILE, "azure/login must not use continue-on-error")
    check_oidc_validator(steps, azure_indexes[0])


def exact_artifact_set_assertion(step: dict, where: str) -> bool:
    if (
        set(step) != {"name", "shell", "env", "run"}
        or step.get("name") != "Verify exact release-build artifact set"
        or normalize_expression(step.get("shell")) != "bash"
    ):
        return False
    environment = mapping(step.get("env"), f"{where}.env", none_as_empty=True)
    if (
        set(environment) != {"BASH_ENV", "VERSION"}
        or environment.get("BASH_ENV") != "/dev/null"
        or normalize_expression(environment.get("VERSION"))
        != "needs.detect-release.outputs.version"
    ):
        return False
    run = step.get("run", "")
    if not isinstance(run, str):
        return False
    lines = [line.strip() for line in executable_shell(run).splitlines() if line.strip()]
    return lines == EXPECTED_ARTIFACT_ASSERTION


def exact_artifact_directory_prep(step: dict) -> bool:
    if (
        set(step) != {"name", "shell", "env", "run"}
        or step.get("name") != "Prepare empty release artifact directory"
        or normalize_expression(step.get("shell")) != "bash"
        or step.get("env") != {"BASH_ENV": "/dev/null"}
    ):
        return False
    run = step.get("run", "")
    if not isinstance(run, str):
        return False
    lines = [line.strip() for line in executable_shell(run).splitlines() if line.strip()]
    return lines == EXPECTED_ARTIFACT_DIRECTORY_PREP


def check_artifact_custody() -> None:
    release_build_uploads = 0
    release_download_indexes = []
    for job_id, job in BUILD_JOBS.items():
        where = f"{BUILD_FILE}.jobs.{job_id}"
        for index, step in enumerate(job_steps(job, where)):
            uses = action_name(step)
            if "actions/upload-artifact@" in uses:
                if job_id != "release-build":
                    fail(BUILD_FILE, f"only release-build may upload promotion artifacts (found {job_id})")
                else:
                    release_build_uploads += 1
            if "actions/download-artifact@" in uses:
                inputs = action_inputs(step, f"{where}.steps[{index}]")
                forbidden = {"run-id", "repository", "github-token"} & set(inputs)
                if forbidden:
                    fail(
                        BUILD_FILE,
                        f"download-artifact must remain same-run; forbidden inputs: {', '.join(sorted(forbidden))}",
                    )
                if job_id == "release":
                    release_download_indexes.append(index)
            run = step.get("run", "")
            command = executable_shell(run).lower() if isinstance(run, str) else ""
            if (
                re.search(r"\bgh\s+run\s+download\b", command)
                or CROSS_RUN_ARTIFACT_API.search(command)
            ):
                fail(BUILD_FILE, f"cross-run artifact retrieval is forbidden in job '{job_id}'")
    if isinstance(BUILD_JOBS.get("release-build"), dict) and release_build_uploads == 0:
        fail(BUILD_FILE, "release-build must upload same-run promotion artifacts")
    release = BUILD_JOBS.get("release")
    if isinstance(release, dict):
        release_steps = job_steps(release, f"{BUILD_FILE}.jobs.release")
        if len(release_download_indexes) != 1:
            fail(BUILD_FILE, "release must download same-run promotion artifacts exactly once")
        else:
            download_index = release_download_indexes[0]
            prep_index = download_index - 1
            if prep_index < 0 or not exact_artifact_directory_prep(release_steps[prep_index]):
                fail(BUILD_FILE, "release must empty the artifact directory immediately before download")
            inputs = action_inputs(
                release_steps[download_index],
                f"{BUILD_FILE}.jobs.release.steps[{download_index}]",
            )
            if set(inputs) != {"path", "pattern"} or inputs != {
                "path": "artifacts",
                "pattern": "concord-voice-*",
            }:
                fail(BUILD_FILE, "release download must use the exact current-run artifact namespace")
            assertion_index = download_index + 1
            if assertion_index >= len(release_steps) or not exact_artifact_set_assertion(
                release_steps[assertion_index],
                f"{BUILD_FILE}.jobs.release.steps[{assertion_index}]",
            ):
                fail(BUILD_FILE, "release must verify the exact six release-build artifact directories")


def check_signing_placement() -> None:
    for path, workflow in WORKFLOWS.items():
        top_level = {key: value for key, value in workflow.items() if key != "jobs"}
        references = signing_references(top_level)
        if references:
            fail(
                path,
                "signing references are forbidden outside build-desktop release-build/release: "
                + ", ".join(sorted(references)),
            )
        for job_id, job in workflow["jobs"].items():
            references = signing_references(job)
            if path == ".github/workflows/provision-secrets.yml" and job_id == "provision":
                references.discard("APPLE_API_KEY")
            allowed = path == BUILD_FILE and job_id in TRUSTED_JOBS
            if references and not allowed:
                fail(
                    path,
                    "signing references are forbidden outside build-desktop release-build/release "
                    f"on job '{job_id}': "
                    + ", ".join(sorted(references)),
                )


try:
    check_triggers_and_dispatcher()
    check_dispatcher_inventory()
    check_nightly_dispatcher()
    check_dispatch_binding()
    check_pr_path()
    check_classifier_trust_boundary()
    check_public_mirror_contract()
    check_global_environments()
    check_trusted_jobs()
    check_persistent_runner_environment()
    check_checkout_and_oidc()
    check_artifact_custody()
    check_signing_placement()
except ShapeError as exc:
    print(f"ERROR: workflow document shape: {exc}", file=sys.stderr)
    raise SystemExit(2)

if violations:
    for path, contract in violations:
        print(f"ERROR: {path}: {contract}", file=sys.stderr)
    raise SystemExit(1)

print("OK: desktop release trust policy satisfied")
PY
