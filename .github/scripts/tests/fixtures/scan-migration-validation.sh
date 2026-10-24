# Read-only migration validation excerpts; administrative rollout stays in Hosted.
readonly CANARY_CASES='[
  {"id":"docs-baseline-pass","protected":"pass"},
  {"id":"selector-mask-01","protected":"pass"},
  {"id":"selector-mask-02","protected":"pass"},
  {"id":"selector-mask-03","protected":"pass"},
  {"id":"selector-mask-04","protected":"pass"},
  {"id":"selector-mask-05","protected":"pass"},
  {"id":"selector-mask-06","protected":"pass"},
  {"id":"selector-mask-07","protected":"pass"},
  {"id":"selector-mask-08","protected":"pass"},
  {"id":"selector-mask-09","protected":"pass"},
  {"id":"selector-mask-10","protected":"pass"},
  {"id":"selector-mask-11","protected":"pass"},
  {"id":"selector-mask-12","protected":"pass"},
  {"id":"selector-mask-13","protected":"pass"},
  {"id":"selector-mask-14","protected":"pass"},
  {"id":"selector-mask-15","protected":"pass"},
  {"id":"selector-mask-16","protected":"pass"},
  {"id":"selector-mask-17","protected":"pass"},
  {"id":"selector-mask-18","protected":"pass"},
  {"id":"selector-mask-19","protected":"pass"},
  {"id":"selector-mask-20","protected":"pass"},
  {"id":"selector-mask-21","protected":"pass"},
  {"id":"selector-mask-22","protected":"pass"},
  {"id":"selector-mask-23","protected":"pass"},
  {"id":"selector-mask-24","protected":"pass"},
  {"id":"selector-mask-25","protected":"pass"},
  {"id":"selector-mask-26","protected":"pass"},
  {"id":"selector-mask-27","protected":"pass"},
  {"id":"selector-mask-28","protected":"pass"},
  {"id":"failed-build-blocked","protected":"blocked"}
]'

validate_evidence_shape() {
  local main_sha=$1
  jq -e --argjson repo "$REPO_ID" --arg main "$main_sha" --argjson protected_rule "$workflow_rule_id" \
    --argjson expected "$CANARY_CASES" --slurpfile current "${snapshot_dir}/open-pr-heads.json" '
      def valid_case($c; $e):
        (($c|keys|sort) == (["case_id","number","head_sha","protected_run_id","run_attempt","protected_observed"]|sort)) and
        $c.protected_observed == $e.protected and
        ($c.number|type)=="number" and $c.number > 0 and $c.number == ($c.number|floor) and
        ($c.head_sha|test("^[0-9a-f]{40}$")) and
        ($c.protected_run_id|type)=="number" and $c.protected_run_id > 0 and $c.protected_run_id == ($c.protected_run_id|floor) and
        ($c.run_attempt|type)=="number" and $c.run_attempt > 0 and $c.run_attempt == ($c.run_attempt|floor) and
        any($current[0][]; .number == $c.number and .head_sha == $c.head_sha);

      ((keys|sort) == (["schema_version","repository_id","main_sha","protected","open_pr_heads","canaries"]|sort)) and
      .schema_version == 3 and .repository_id == $repo and .main_sha == $main and
      (.protected | type == "object" and ((keys|sort) == (["ruleset_id","source_path","source_sha","mode","run_id","run_attempt","conclusion"]|sort)) and
        .ruleset_id == $protected_rule and .source_path == ".github/workflows/required-pr-build.yml" and
        .source_sha == $main and .mode == "required-full" and
        (.run_id|type)=="number" and .run_id > 0 and (.run_attempt|type)=="number" and .run_attempt > 0 and .conclusion == "success") and
      (.open_pr_heads | type == "array" and all(.[]; ((keys|sort) == (["number","head_sha","protected_run_id","run_attempt","check_sha","conclusion"]|sort)) and
        (.number|type)=="number" and (.head_sha|test("^[0-9a-f]{40}$")) and
        (.protected_run_id|type)=="number" and (.run_attempt|type)=="number" and
        (.check_sha|test("^[0-9a-f]{40}$")) and (.conclusion|IN("success","failure")))) and
      ([.open_pr_heads[] | {number,head_sha,protected_run_id,run_attempt,conclusion}] | sort_by(.number)) ==
        ([.canaries[] | {number,head_sha,protected_run_id,run_attempt,
          conclusion:(if .protected_observed == "pass" then "success" else "failure" end)}] | sort_by(.number)) and
      (.canaries | type == "array" and length == ($expected|length) and
        ([.[].case_id] | sort) == ([$expected[].id] | sort) and
        ([.[].number] | unique | length) == ($expected|length) and
        ([.[] | [.protected_run_id,.run_attempt]] | unique | length) == ($expected|length) and
        all(.[]; . as $c | ($expected[] | select(.id == $c.case_id)) as $e | valid_case($c; $e))) and
      (.protected as $p | any(.canaries[];
        .case_id == "docs-baseline-pass" and .protected_run_id == $p.run_id and .run_attempt == $p.run_attempt))
    ' "$canary_evidence" >/dev/null || die 'canary evidence is missing, stale, malformed, or has an unknown observation'
}

verify_workflow_run() { :; }

verify_native_codeql() {
  local pr_number=$1 head_sha=$2 main_sha=$3 checks match_count
  [[ "$pr_number" =~ ^[1-9][0-9]*$ && "$head_sha" =~ ^[0-9a-f]{40}$ ]] \
    || die 'native CodeQL check binding is malformed'
  checks=$(api --paginate "repos/${ORG}/${REPO}/commits/${head_sha}/check-runs?filter=latest&per_page=100" \
    --jq '.check_runs[]') || die "cannot read latest native CodeQL check for PR #${pr_number}"
  match_count=$(printf '%s\n' "$checks" | jq -se --arg head "$head_sha" \
    --arg main "$main_sha" --argjson pr "$pr_number" --argjson repo "$REPO_ID" '
    [.[] | select(.name == "CodeQL" and .app.id == 57789 and
      .app.slug == "github-advanced-security" and .head_sha == $head and .status == "completed" and
      .conclusion == "success" and
      (.pull_requests | type == "array" and length == 1 and .[0].number == $pr and
        .[0].head.sha == $head and .[0].base.sha == $main and .[0].base.ref == "main" and
        .[0].base.repo.id == $repo))]
    | length
  ') || die "native CodeQL check is missing or stale for PR #${pr_number}"
  [[ "$match_count" == 1 ]] || die "native CodeQL check is missing, ambiguous, or stale for PR #${pr_number}"
}

verify_full_mode_inventory() { :; }
