#!/usr/bin/env bash
# SC2015: `cond && ok … || bad …` is safe here because ok() always returns 0.
# SC2016: backticks in single quotes are literal Markdown, not expansions.
# shellcheck disable=SC2015,SC2016
#
# Regression test for .github/workflows/npm-lockfile-flush.yml (#217).
#
# The workflow runs only on its weekly cron, so a broken step looks the same as
# "nothing to update". This test EXTRACTS the real `run:` blocks and executes
# them against a stub npm in throwaway repositories, so it cannot drift from
# what CI runs. It also locks the job split: no write credential shares a job
# with the package refresh, and the job that holds the App key runs no npm.
#
# awk, not PyYAML: this must run on a host without PyYAML.

set -uo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_COMMON_DIR GIT_PREFIX GIT_CONFIG_PARAMETERS 2>/dev/null || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/npm-lockfile-flush.yml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export NPM_STUB_GLOBAL_ROOT
NPM_STUB_GLOBAL_ROOT="$(npm root -g)" || exit 1

pass=0
fail=0
ok()  { echo "ok:   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL: $1"; [ -n "${2:-}" ] && printf '    %s\n' "${2//$'\n'/$'\n'    }"; fail=$((fail + 1)); }

# ── extract a step's shell verbatim ─────────────────────────────────────────
extract_step() { # $1 = step name, $2 = output file
  {
    printf '#!/usr/bin/env bash\n'
    awk -v want="      - name: $1" '
      $0 == want                                  { instep = 1; next }
      instep && /^        run: \|[[:space:]]*$/   { inrun = 1; next }
      inrun {
        if ($0 == "")           { print ""; next }
        if ($0 ~ /^          /) { sub(/^          /, ""); print; next }
        exit
      }
    ' "$WORKFLOW"
  } > "$2"
  [ "$(wc -l < "$2")" -gt 3 ]
}

extract_step 'Refresh the desktop lockfile within existing ranges' "$WORK/refresh.sh" \
  && ok "extracted the refresh step" || { bad "could not extract the refresh step"; exit 1; }
extract_step 'Contention guard — defer if open Dependabot npm PRs touch the desktop lockfile' "$WORK/guard.sh" \
  && ok "extracted the guard step" || { bad "could not extract the guard step"; exit 1; }
extract_step 'Render PR body' "$WORK/render.sh" \
  && ok "extracted the render step" || { bad "could not extract the render step"; exit 1; }
for s in guard refresh render; do
  bash -n "$WORK/$s.sh" 2>"$WORK/syntax.err" && ok "$s step is valid bash" \
    || bad "$s step has a bash syntax error" "$(cat "$WORK/syntax.err")"
done

# ── harness: a repo with desktop/ and a stub npm ────────────────────────────
lock() { # $1 = version of node_modules/dep; [$2 = extra entries, "path:version" separated by spaces]
  local e out
  out=$(printf '{"name":"r","lockfileVersion":3,"packages":{"":{"name":"r"},"node_modules/dep":{"version":"%s"}}}' "$1")
  for e in ${2:-}; do out=$(jq -c --arg k "${e%%:*}" --arg v "${e#*:}" '.packages[$k] = {version: $v}' <<<"$out"); done
  echo "$out"
}
make_repo() { # [$1 = extra base entries, as for lock]; prints the repo path
  local dir; dir="$(mktemp -d "$WORK/repo.XXXXXX")"
  mkdir -p "$dir/desktop" "$dir/.github/scripts"
  cp "$REPO_ROOT/.github/scripts/check-lockfile-compat.cjs" "$dir/.github/scripts/"
  printf '{"name":"r","devDependencies":{"dep":"^1.0.0"}}\n' > "$dir/desktop/package.json"
  lock 1.0.0 "${1:-}" > "$dir/desktop/package-lock.json"
  ( cd "$dir" && git init -q . && git config user.email t@t.t && git config user.name t \
      && git add -A && git commit -qm base )
  echo "$dir"
}
# The stub records its arguments and the env it saw, then does $NPM_STUB_MODE.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/npm" <<'STUB'
#!/usr/bin/env bash
if [ "$1 $2" = "config ls" ]; then
  [ "${NPM_STUB_KNOWS_AGE:-1}" = 1 ] && echo 'min-release-age = null'
  [ -n "${npm_config_min_release_age:-}" ] && echo "min-release-age = $npm_config_min_release_age"
  exit 0
fi
[ "$1" = "--version" ] && { echo 0.0.0-stub; exit 0; }
[ "$1 $2" = "root -g" ] && { printf '%s\n' "$NPM_STUB_GLOBAL_ROOT"; exit 0; }
echo "$PWD|$*|ignore=${npm_config_ignore_scripts:-}|age=${npm_config_min_release_age:-}" >> "$NPM_STUB_LOG"
L='{"name":"r","lockfileVersion":3,"packages":{"":{"name":"r"},'
case "$NPM_STUB_MODE" in
  bump)      printf '%s"node_modules/dep":{"version":"1.2.0"}}}\n' "$L" > package-lock.json ;;
  manifest)  printf '{"name":"r","devDependencies":{"dep":"^1.2.0"}}\n' > package.json ;;
  stray)     touch ../stray.txt ;;
  downgrade) printf '%s"node_modules/dep":{"version":"1.0.0"}}}\n' "$L" > package-lock.json ;;
  rehoist)   printf '%s"node_modules/dep":{"version":"1.0.0"},"node_modules/x":{"version":"3.1.0"},"node_modules/b/node_modules/x":{"version":"2.0.0"}}}\n' "$L" > package-lock.json ;;
  zero)      printf '%s"node_modules/dep":{"version":"1.0.0"},"node_modules/s":{"version":"0.27.0"}}}\n' "$L" > package-lock.json ;;
  hoist)     printf '%s"node_modules/dep":{"version":"1.0.0"},"node_modules/x":{"version":"2.1.0"}}}\n' "$L" > package-lock.json ;;
  rc)        printf '%s"node_modules/dep":{"version":"1.0.0"},"node_modules/x":{"version":"3.0.0-rc.9"}}}\n' "$L" > package-lock.json ;;
  adapter)   printf '%s"node_modules/dep":{"version":"1.2.0"},"node_modules/g":{"version":"1.0.0","resolved":"file:tools/g-compat"}}}\n' "$L" > package-lock.json ;;
  legacy-kept|legacy-linked)
    cat > package-lock.json <<'JSON'
{"name":"r","lockfileVersion":3,"packages":{"":{"name":"r"},"node_modules/dep":{"version":"1.2.0"},"node_modules/minimatch":{"name":"@concordvoice/minimatch-compat","version":"1.0.0","resolved":"file:tools/minimatch-compat"},"node_modules/app-builder-lib/node_modules/minimatch":{"version":"11.0.3","resolved":"https://registry.npmjs.org/minimatch/-/minimatch-11.0.3.tgz"},"node_modules/app-builder-lib/node_modules/@electron/asar":{"version":"3.4.1","dependencies":{"minimatch":"^3.0.4"}},"node_modules/app-builder-lib/node_modules/@electron/asar/node_modules/minimatch":{"name":"@concordvoice/minimatch-compat","version":"1.0.0","resolved":"file:tools/minimatch-compat"}}}
JSON
    if [ "$NPM_STUB_MODE" = legacy-linked ]; then
      jq '.packages["node_modules/app-builder-lib/node_modules/@electron/asar/node_modules/minimatch"].link = true' \
        package-lock.json > linked.json && mv linked.json package-lock.json || exit 1
    fi
    ;;
  legacy-partial)
    cat > package-lock.json <<'JSON'
{"name":"r","lockfileVersion":3,"packages":{"":{"name":"r"},"node_modules/dep":{"version":"1.2.0"},"node_modules/minimatch":{"name":"@concordvoice/minimatch-compat","version":"1.0.0","resolved":"file:tools/minimatch-compat"},"node_modules/app-builder-lib/node_modules/minimatch":{"version":"11.0.3","resolved":"https://registry.npmjs.org/minimatch/-/minimatch-11.0.3.tgz"},"node_modules/app-builder-lib/node_modules/@electron/asar":{"version":"3.4.1","dependencies":{"minimatch":"^3.0.4"}}}}
JSON
    ;;
  none)      ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/npm"

run_refresh() { # $1 = mode, [$2 = knows-age 0/1], [$3 = extra base entry]; sets OUT, RC, REPO, OUTPUTS
  REPO=$(make_repo "${3:-}")
  : > "$WORK/npm.log"; : > "$WORK/gh_output"
  OUT=$(cd "$REPO" && PATH="$WORK/bin:$PATH" NPM_STUB_MODE="$1" NPM_STUB_KNOWS_AGE="${2:-1}" \
        NPM_STUB_LOG="$WORK/npm.log" GITHUB_OUTPUT="$WORK/gh_output" \
        npm_config_ignore_scripts=true npm_config_min_release_age=7 \
        bash "$WORK/refresh.sh" 2>&1); RC=$?
  OUTPUTS=$(cat "$WORK/gh_output")
}

# ── refresh step behaviour ──────────────────────────────────────────────────
run_refresh bump
[ "$RC" -eq 0 ] && [ "$OUTPUTS" = "has_changes=true" ] \
  && ok "a lockfile-only change reports has_changes=true" \
  || bad "a lockfile-only change should pass with has_changes=true" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"
[ "$(cat "$WORK/npm.log")" = "$REPO/desktop|update --package-lock-only --ignore-scripts --min-release-age=7 --no-audit --no-fund|ignore=true|age=7" ] \
  && ok "npm update runs once, in desktop/, lockfile-only, scripts off, 7-day window" \
  || bad "npm update was not run as required in desktop/" "$(cat "$WORK/npm.log")"

run_refresh none
[ "$RC" -eq 0 ] && [ "$OUTPUTS" = "has_changes=false" ] \
  && ok "no change reports has_changes=false (no PR)" \
  || bad "no change should pass with has_changes=false" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"

run_refresh manifest
[ "$RC" -ne 0 ] && [ -z "$OUTPUTS" ] && grep -q 'desktop/package.json' <<<"$OUT" \
  && ok "a package.json change fails the run and names the file" \
  || bad "a package.json change must fail the run" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"

run_refresh stray
[ "$RC" -ne 0 ] && grep -q 'stray.txt' <<<"$OUT" \
  && ok "any other new file fails the run" \
  || bad "an untracked file must fail the run" "rc=$RC"$'\n'"$OUT"

run_refresh downgrade "" 'node_modules/dep:1.0.5'
[ "$RC" -ne 0 ] && [ -z "$OUTPUTS" ] && grep -q 'desktop/package-lock.json: dep@1 1.0.5 -> 1.0.0' <<<"$OUT" \
  && ok "a downgrade fails the run and names the lockfile, package and versions" \
  || bad "a downgrade must fail the run" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"

# A hoist: the newer nested copy goes away and an older copy lands at another path.
run_refresh hoist "" 'node_modules/dep/node_modules/x:2.1.1'
[ "$RC" -ne 0 ] && grep -q 'desktop/package-lock.json: x@2 2.1.1 -> 2.1.0' <<<"$OUT" \
  && ok "a downgrade that moves the package to another path fails the run" \
  || bad "a hoisted downgrade must fail the run" "rc=$RC"$'\n'"$OUT"

run_refresh rc "" 'node_modules/x:3.0.0-rc.10'
[ "$RC" -ne 0 ] && grep -q 'x@3 3.0.0-rc.10 -> 3.0.0-rc.9' <<<"$OUT" \
  && ok "prerelease numbers compare as numbers (rc.10 -> rc.9 is a downgrade)" \
  || bad "rc.10 -> rc.9 must fail the run" "rc=$RC"$'\n'"$OUT"

# A re-hoist, as real npm does: the top-level copy changes major and the newer
# copy moves to a nested path. Nothing went down, so it must pass.
run_refresh rehoist "" 'node_modules/x:2.0.0 node_modules/a/node_modules/x:3.1.0'
[ "$RC" -eq 0 ] && [ "$OUTPUTS" = "has_changes=true" ] \
  && ok "a re-hoist that moves the newer copy to another path passes" \
  || bad "a pure re-hoist must not count as a downgrade" "rc=$RC"$'\n'"$OUT"

# 0.x: a minor is a major under ^, so 0.28 -> 0.27 at one path is a line
# change, not a downgrade within a line.
run_refresh zero "" 'node_modules/s:0.28.0'
[ "$RC" -eq 0 ] && ok "a 0.x minor counts as its own line" || bad "0.28 -> 0.27 must compare as two lines" "rc=$RC"$'\n'"$OUT"

# A `file:` override (a desktop/tools adapter) must survive the refresh: npm can
# swap it for a registry copy when a newer major is hoisted.
run_adapter() { # $1 = mode; base package.json overrides g@<2 with a local adapter
  REPO=$(make_repo)
  ( cd "$REPO/desktop" \
      && jq -c '.overrides = {"g@<2": "file:./tools/g-compat"}' package.json > p && mv p package.json \
      && jq -c '.packages["node_modules/g"] = {version: "1.0.0", resolved: "file:tools/g-compat"}' package-lock.json > l && mv l package-lock.json \
      && git commit -qam overrides )
  : > "$WORK/npm.log"; : > "$WORK/gh_output"
  OUT=$(cd "$REPO" && PATH="$WORK/bin:$PATH" NPM_STUB_MODE="$1" NPM_STUB_LOG="$WORK/npm.log" \
        GITHUB_OUTPUT="$WORK/gh_output" npm_config_ignore_scripts=true npm_config_min_release_age=7 \
        bash "$WORK/refresh.sh" 2>&1); RC=$?
  OUTPUTS=$(cat "$WORK/gh_output")
}
run_adapter bump
[ "$RC" -ne 0 ] && [ -z "$OUTPUTS" ] && grep -q 'dropped these file: overrides' <<<"$OUT" && grep -qx 'file:tools/g-compat' <<<"$OUT" \
  && ok "a refresh that drops a file: override adapter fails the run and names it" \
  || bad "a dropped file: override must fail the run" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"
run_adapter adapter
[ "$RC" -eq 0 ] && [ "$OUTPUTS" = "has_changes=true" ] \
  && ok "a refresh that keeps the file: override adapter passes" \
  || bad "a kept file: override must pass" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"

# A root compat adapter cannot prove that every legacy consumer sees it. npm
# may re-hoist a registry minimatch under app-builder-lib while preserving the
# root file: entry. The refresh must reject that before it can open a PR.
run_legacy_adapter() {
  REPO=$(make_repo)
  ( cd "$REPO/desktop" \
      && jq -c '.overrides = {"minimatch@<6": "file:./tools/minimatch-compat"}' package.json > p && mv p package.json \
      && git commit -qam overrides )
  : > "$WORK/npm.log"; : > "$WORK/gh_output"
  OUT=$(cd "$REPO" && PATH="$WORK/bin:$PATH" NPM_STUB_MODE="$1" NPM_STUB_LOG="$WORK/npm.log" \
        GITHUB_OUTPUT="$WORK/gh_output" npm_config_ignore_scripts=true npm_config_min_release_age=7 \
        bash "$WORK/refresh.sh" 2>&1); RC=$?
  OUTPUTS=$(cat "$WORK/gh_output")
}
run_legacy_adapter legacy-kept
[ "$RC" -eq 0 ] && [ "$OUTPUTS" = "has_changes=true" ] \
  && ok "a legacy consumer with its nearest compat adapter passes" \
  || bad "a legacy consumer must retain its nearest compat adapter" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"
run_legacy_adapter legacy-linked
[ "$RC" -ne 0 ] && [ -z "$OUTPUTS" ] && grep -q "Legacy adapter mismatch" <<<"$OUT" \
  && ok "a linked legacy adapter is rejected before opening a PR" \
  || bad "the resolved legacy adapter must be a packed install" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"
run_legacy_adapter legacy-partial
[ "$RC" -ne 0 ] && [ -z "$OUTPUTS" ] \
  && grep -q "app-builder-lib/node_modules/@electron/asar -> minimatch" <<<"$OUT" \
  && grep -q "app-builder-lib/node_modules/minimatch" <<<"$OUT" \
  && ok "a surviving root adapter cannot mask a nearer registry package" \
  || bad "a partial legacy adapter loss must fail before opening a PR" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"

run_refresh bump 0
[ "$RC" -ne 0 ] && [ ! -s "$WORK/npm.log" ] && grep -q 'no min-release-age' <<<"$OUT" \
  && ok "an npm without min-release-age fails before any update, even with the env set" \
  || bad "an npm without min-release-age must fail before updating" "rc=$RC"$'\n'"$OUT"

# ── guard step: which open PRs defer the run ────────────────────────────────
# The stub gh applies the step's own --jq filter to fixture PR JSON, so the
# filter itself is what is tested.
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  pr)
    if [ "$2" = list ]; then
      while [ $# -gt 0 ]; do [ "$1" = --jq ] && { jq -r "$2" "$GH_STUB_PRS"; exit; }; shift; done
      exit 1
    fi
    [ "$2" = comment ] && echo "comment $3" >> "$GH_STUB_LOG" ;;
  api) [ -z "${GH_STUB_RECENT:-}" ] || printf '101\n102\n' ;;  # ids of matching comments, one per line
esac
STUB
chmod +x "$WORK/bin/gh"
run_guard() { # $1 = fixture PR JSON; sets OUT, RC, OUTPUTS
  printf '%s' "$1" > "$WORK/prs.json"; : > "$WORK/gh.log"; : > "$WORK/gh_output"
  OUT=$(PATH="$WORK/bin:$PATH" GH_STUB_PRS="$WORK/prs.json" GH_STUB_LOG="$WORK/gh.log" \
        GITHUB_OUTPUT="$WORK/gh_output" GITHUB_SERVER_URL=https://github.invalid \
        GITHUB_REPOSITORY=o/r GITHUB_RUN_ID=1 bash "$WORK/guard.sh" 2>&1); RC=$?
  OUTPUTS=$(cat "$WORK/gh_output")
}
DEP='"author":{"login":"app/dependabot"},"isCrossRepository":false'
run_guard "[{\"number\":1,\"headRefName\":\"dependabot/npm_and_yarn/desktop/jose-6.2.15\",$DEP},
  {\"number\":2,\"headRefName\":\"dependabot/npm_and_yarn/desktop/tools/glob-compat/glob-13.0.0\",$DEP},
  {\"number\":3,\"headRefName\":\"dependabot/npm_and_yarn/tools/concord-bridge/hono-4.13.18\",$DEP},
  {\"number\":4,\"headRefName\":\"dependabot/npm_and_yarn/desktop/evil\",\"author\":{\"login\":\"app/dependabot\"},\"isCrossRepository\":true},
  {\"number\":5,\"headRefName\":\"dependabot/npm_and_yarn/desktop/evil\",\"author\":{\"login\":\"mallory\"},\"isCrossRepository\":false},
  {\"number\":6,\"headRefName\":\"dependabot/github_actions/actions-1\",$DEP}]"
[ "$RC" -eq 0 ] && [ "$OUTPUTS" = "deferred=true" ] && [ "$(cat "$WORK/gh.log")" = $'comment 1\ncomment 2' ] \
  && ok "the guard defers on same-repo Dependabot desktop npm PRs and comments on those only" \
  || bad "the guard must count only PRs 1 and 2 (not concord-bridge, fork, other author or Actions)" "rc=$RC outputs=$OUTPUTS log=$(cat "$WORK/gh.log")"$'\n'"$OUT"
GH_STUB_RECENT=1 run_guard "[{\"number\":1,\"headRefName\":\"dependabot/npm_and_yarn/desktop/jose-6.2.15\",$DEP}]"
[ "$RC" -eq 0 ] && [ "$OUTPUTS" = "deferred=true" ] && [ ! -s "$WORK/gh.log" ] && grep -q 'already has a recent deferral comment' <<<"$OUT" \
  && ok "a PR with a recent deferral comment (any page) gets no second one" \
  || bad "a recent deferral comment must suppress another" "rc=$RC log=$(cat "$WORK/gh.log")"$'\n'"$OUT"
run_guard "[{\"number\":4,\"headRefName\":\"dependabot/npm_and_yarn/desktop/evil\",\"author\":{\"login\":\"mallory\"},\"isCrossRepository\":true}]"
[ "$RC" -eq 0 ] && [ "$OUTPUTS" = "deferred=false" ] && [ ! -s "$WORK/gh.log" ] \
  && ok "a spoofed dependabot/... branch does not defer the run" \
  || bad "a spoofed branch must not defer the run" "rc=$RC outputs=$OUTPUTS"$'\n'"$OUT"

# ── render step: the changed-entry count ────────────────────────────────────
REPO=$(make_repo)
printf '{"name":"r","lockfileVersion":3,"packages":{"":{"name":"r"},"node_modules/dep":{"version":"1.0.1"},"node_modules/new":{"version":"2.0.0"}}}\n' \
  > "$REPO/desktop/package-lock.json"
rm -f /tmp/pr-body.md
OUT=$(cd "$REPO" && TRIGGER=schedule bash "$WORK/render.sh" 2>&1); RC=$?
BODY=$(cat /tmp/pr-body.md 2>/dev/null || true)
[ "$RC" -eq 0 ] && grep -qF '`main`. 2 lockfile entries changed.' <<<"$BODY" && grep -qF 'trigger: `schedule`' <<<"$BODY" \
  && ok "the PR body counts the changed lockfile entries" \
  || bad "the PR body is wrong" "rc=$RC"$'\n'"$OUT"$'\n'"$BODY"

# ── static: the job split is a credential boundary ──────────────────────────
job_block() { # $1 = job id; that job's lines, comment lines dropped
  awk -v j="  $1:" '
    $0 == j                { p = 1; next }
    p && /^  [^ #]/        { exit }
    p && !/^[[:space:]]*#/ { print }
  ' "$WORKFLOW"
}
GUARD_JOB=$(job_block guard)
REFRESH_JOB=$(job_block refresh)
OPEN_JOB=$(job_block open-pr)
# npm or npx in command position (line start, or after && | ; or a subshell
# paren), so prose such as a PR title that says "npm lockfile" does not count.
NPM_TOOLING='setup-node|(^[[:space:]]*|&&[[:space:]]*|[|;(][[:space:]]*)(npm|npx) '

job_ids=$(awk '/^jobs:/ { p = 1; next } p && /^  [^ #]/ { sub(/:.*/, ""); sub(/^  /, ""); printf "%s ", $0 }' "$WORKFLOW")
[ "$job_ids" = "guard refresh open-pr " ] \
  && ok "the workflow has exactly the jobs guard, refresh and open-pr" \
  || bad "the job set changed; every job needs a credential assertion here" "jobs: $job_ids"

grep -qF 'npm update' <<<"$REFRESH_JOB" \
  && ! grep -qE 'secrets|github\.token|PUBLIC_MIRROR_APP_|create-github-app-token|create-pull-request|write' <<<"$REFRESH_JOB" \
  && ok "the refresh job resolves packages and holds no secret and no write scope" \
  || bad "the refresh job is missing, or references a secret, a token or a write scope"

grep -qE '^    needs: guard$' <<<"$REFRESH_JOB" \
  && grep -qxF "    if: needs.guard.outputs.deferred != 'true'" <<<"$REFRESH_JOB" \
  && [ -n "$GUARD_JOB" ] && ! grep -qE "$NPM_TOOLING|PUBLIC_MIRROR_APP_|create-github-app-token" <<<"$GUARD_JOB" \
  && ok "the guard job gates refresh and runs no npm and no App credential" \
  || bad "the guard job is missing, does not gate refresh, or does more than query pull requests"

# shellcheck disable=SC2016  # literal GitHub expression, not a shell expansion
grep -qF 'has_changes: ${{ steps.refresh.outputs.has_changes }}' <<<"$REFRESH_JOB" \
  && grep -qE '^    needs: refresh$' <<<"$OPEN_JOB" \
  && grep -qxF "    if: needs.refresh.outputs.has_changes == 'true'" <<<"$OPEN_JOB" \
  && ok "the open-pr job runs only when the refresh job reports a change" \
  || bad "the open-pr job is not gated on the refresh job's has_changes output"

[ -n "$OPEN_JOB" ] && ! grep -qE "$NPM_TOOLING" <<<"$OPEN_JOB" \
  && ok "the open-pr job runs no npm" \
  || bad "the job that holds the App key must not run npm"

grep -qF -- '--author app/dependabot' <<<"$GUARD_JOB" \
  && grep -qF '.author.login == "app/dependabot" and .isCrossRepository == false' <<<"$GUARD_JOB" \
  && ok "the contention guard counts only Dependabot's own same-repository PRs" \
  || bad "the contention guard must ignore PRs not opened by Dependabot from this repository"

for job in guard refresh open-pr; do
  if job_block "$job" | grep -qE '^    permissions:$' && job_block "$job" | grep -qxF '      contents: read'; then
    ok "the $job job declares contents: read"
  else
    bad "the $job job must declare its own permissions with contents: read"
  fi
done
[ "$(job_block refresh | grep -cE '^      [a-z-]+: (read|write)$')" -eq 1 ] && [ "$(job_block open-pr | grep -cE '^      [a-z-]+: (read|write)$')" -eq 1 ] \
  && ok "refresh and open-pr hold no GITHUB_TOKEN scope beyond contents: read" \
  || bad "refresh and open-pr must hold only contents: read"

# The PR may carry the desktop lockfile and nothing else.
add_paths=$(awk '/^          add-paths: \|/ { p = 1; next } p && /^            / { sub(/^ +/, ""); print; next } p { exit }' <<<"$OPEN_JOB" | tr '\n' ' ')
[ "$add_paths" = "desktop/package-lock.json " ] \
  && ok "add-paths is exactly desktop/package-lock.json" \
  || bad "add-paths must list exactly desktop/package-lock.json" "got: $add_paths"

# shellcheck disable=SC2016  # literal GitHub expressions, not shell expansions
[ "$(grep -cxF '          name: npm-lockfile-flush' <<<"$REFRESH_JOB")" -eq 1 ] \
  && [ "$(grep -cxF '          name: npm-lockfile-flush' <<<"$OPEN_JOB")" -eq 1 ] \
  && [ "$(grep -cxF '          path: ${{ runner.temp }}/flush' <<<"$REFRESH_JOB")" -eq 1 ] \
  && [ "$(grep -cxF '          path: ${{ runner.temp }}/flush' <<<"$OPEN_JOB")" -eq 1 ] \
  && grep -qxF '          body-path: ${{ runner.temp }}/flush/pr-body.md' <<<"$OPEN_JOB" \
  && ok "the payload artifact is uploaded and consumed under one name and path" \
  || bad "the artifact name, its path or body-path no longer agree between the jobs"

echo "─────────────────────────────────"
echo "npm-lockfile-flush test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
