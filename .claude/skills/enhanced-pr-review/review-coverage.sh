#!/usr/bin/env bash
# review-coverage.sh <PR> — does the PR's CURRENT head SHA have review coverage?
#
# Coverage is SHA-bound evidence from a trusted reviewer. One of:
#   - a submitted PR review (APPROVED / CHANGES_REQUESTED / COMMENTED) whose commit_id is the
#     head SHA, by someone other than the PR author who is EITHER a human repo insider
#     (author_association OWNER or MEMBER) OR an allowlisted review bot — a bot
#     must be allowlisted even when it carries an insider association:
#     copilot-pull-request-reviewer[bot] plus any login in the default branch's
#     .claude/repo-config.json `.review_coverage.reviewer_bots`. A login on the default branch's
#     `.bots[]` roster (exact `.login`, or a case-insensitive `.match` substring) is a bot here
#     even when GitHub types it `User` (a machine-user account), so it needs the allowlist too.
#     A bot review that says it could not review the PR as a whole (Copilot's "wasn't able to
#     review any files") and left no inline finding, or whose body matches the roster entry's
#     `decline_pattern` / `ack_pattern`, does not count. Other bots do not count —
#     a code-scanning bot's review is an alert, not a review — and neither does a drive-by
#     account's review on a public repo. A COMMENTED review counts only when it has a body or
#     at least one top-level inline comment: GitHub files every thread reply as its own empty
#     COMMENTED review at the head of the moment, and a reply is not a review of that head.
#     A body of only format characters (zero-width space, word joiner) is no body;
#   - a first-party coverage record: a PR conversation comment with, on a line of its own,
#       <!-- cv-review-coverage: sha=<40-hex head SHA> reviewer=<login> suite=<skill> -->
#     posted BY <login> (the reviewer's identity is the poster's GitHub identity), a human
#     with author_association OWNER or MEMBER who is not the PR author. A bot, even an
#     allowlisted one, counts only through a submitted review. Nothing may follow the marker
#     on its line. An edited record
#     (updated_at != created_at) does not count: an edit keeps the original poster's identity,
#     and anyone with write access can edit anyone's comment.
# author_association is GitHub's relationship field, not a permission check. COLLABORATOR is
# left out because GitHub returns it for read and triage access too, the same rule as
# check-review-dispositions.sh; MEMBER is any org member.
# A review or record on an older SHA is reported as stale and does NOT count. Comments,
# check-runs and verdict posts that name no SHA do not count either.
#
# The allowlist and roster are read from the repository's DEFAULT branch, never the working
# tree or the PR's base ref (a writer can retarget a PR at a branch they made), so a PR cannot
# widen its own allowlist. No repo-config.json there = Copilot only.
#
# Prints one line, e.g.
#   #123 @abc1234 covered: copilot-pull-request-reviewer[bot] (COMMENTED)
#   #123 @abc1234 ZERO coverage; stale: alice@def5678
# Exit 0 = covered, 1 = zero coverage, 2 = could not check (UNKNOWN — never read as covered).
# Read-only: makes GET requests and nothing else.
#
# Test seam: CV_COVERAGE_FIXTURE=<file> holding {"pr":{...},"reviews":[...],"comments":[...],
# "review_comments":[...]?,"config":{...}?} in the REST shapes of pulls/<n>, pulls/<n>/reviews,
# issues/<n>/comments and pulls/<n>/comments.
# Fixture mode accepts only PR number 0, which no real PR has, and its output carries a
# "(fixture)" suffix, so a stray variable can never make a real PR read as covered.
set -uo pipefail

PR="${1:-}"
unknown() { echo "UNKNOWN: #${PR:-?}: $*" >&2; exit 2; }
case "$PR" in
  ''|*[!0-9]*) unknown "usage: review-coverage.sh <pr-number>" ;;
  *) ;;
esac
command -v jq >/dev/null 2>&1 || unknown "jq required"

suffix=""
if [[ -n "${CV_COVERAGE_FIXTURE:-}" ]]; then
  [[ "$PR" == 0 ]] || unknown "CV_COVERAGE_FIXTURE is set; fixture mode checks only PR 0"
  data=$(cat "$CV_COVERAGE_FIXTURE" 2>/dev/null) || unknown "fixture unreadable: $CV_COVERAGE_FIXTURE"
  suffix=" (fixture)"
else
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || unknown "cannot resolve repo"
  pr=$(gh api "repos/$repo/pulls/$PR") || unknown "cannot read PR #$PR"
  base=$(printf '%s' "$pr" | jq -r '.base.repo.default_branch // empty') || unknown "cannot read the default branch"
  [[ -n "$base" ]] || unknown "PR #$PR: no default branch in the PR's base repo"
  errf=$(mktemp) || unknown "cannot create a temp file"
  trap 'rm -f "$errf"' EXIT
  ref=$(jq -rn --arg b "$base" '$b | @uri')
  if cfg=$(gh api "repos/$repo/contents/.claude/repo-config.json?ref=$ref" --jq .content 2>"$errf"); then
    # Empty content (an empty file, or one over the API's 1 MB inline limit) is unreadable, not absent.
    config=$(printf '%s' "$cfg" | tr -d '\n' | base64 -d 2>/dev/null | jq -c . 2>/dev/null) \
      && [[ "$(jq -r type <<<"$config" 2>/dev/null)" == object ]] \
      || unknown "default-branch repo-config.json is empty, too large or not a JSON object"
  elif grep -q "Not Found (HTTP 404)" "$errf"; then
    config='{}'
  else
    unknown "cannot read default-branch repo-config.json"
  fi
  reviews=$(gh api --paginate --slurp "repos/$repo/pulls/$PR/reviews") || unknown "cannot read reviews"
  comments=$(gh api --paginate --slurp "repos/$repo/issues/$PR/comments") || unknown "cannot read comments"
  rcomments=$(gh api --paginate --slurp "repos/$repo/pulls/$PR/comments") || unknown "cannot read review comments"
  data=$(printf '%s\n%s\n%s\n%s\n%s\n' "$pr" "$reviews" "$comments" "$config" "$rcomments" \
    | jq -s '{pr: .[0], reviews: (.[1] | add // []), comments: (.[2] | add // []), config: .[3],
             review_comments: (.[4] | add // [])}') \
    || unknown "cannot assemble API responses"
fi

out=$(printf '%s' "$data" | jq -r --arg n "$PR" --arg sfx "$suffix" '
  (.pr.head.sha // "") as $h | (.pr.user.login // "") as $author |
  (["copilot-pull-request-reviewer[bot]"] + [(.config.review_coverage.reviewer_bots // [])[] | strings]) as $bots |
  def insider: (.author_association // "") | IN("OWNER", "MEMBER");
  [ (.config.bots // [])[]? | objects ] as $entries |
  def entries_for($l): ($l | ascii_downcase) as $ll
    | [ $entries[] | select(
          any(.login? | (if type == "array" then .[] else . end) | strings | ascii_downcase; . == $ll)
          or any(.match? | strings | ascii_downcase; . as $m | $m != "" and ($ll | contains($m)))) ];
  def trusted: (.user.login // "") as $l
    | $l != "" and $l != $author
      and (if (.user.type // "") == "Bot" or (entries_for($l) | length) > 0
           then ($bots | index($l)) != null else insider end);
  [ .review_comments[]? | select(.in_reply_to_id == null) | .pull_request_review_id ] as $roots |
  def rooted: .id as $i | $i != null and any($roots[]; . == $i);
  # A bot that says it could not review the PR as a whole, and left no inline finding, posted a
  # status notice. A partial notice ("unable to review the binary asset") on a real review counts,
  # and so does a human review that quotes the phrase. Roster patterns are case-insensitive, as
  # dev-lifecycle matches them.
  def refusal: (.body // "") as $b | (.user.login // "") as $l
    | (((.user.type // "") == "Bot" or (entries_for($l) | length) > 0) and (rooted | not)
       and ($b | test("((was not|wasn.t|were not|weren.t) able to|unable to) review (any files|this (pull request|PR)|these changes)"; "i")))
      or any(entries_for($l)[] | (.decline_pattern?, .ack_pattern?) | strings; . as $p | $b | test($p; "i"));
  # Format characters (zero-width space, word joiner, BOM) and blank-looking fillers are not a body.
  def substantive: .state != "COMMENTED"
    or ((.body // "") | gsub("[\\p{Cf}\\x{3164}\\x{2800}]"; "") | test("\\S")) or rooted;
  if ((.reviews | type) != "array" or (.comments | type) != "array"
      or ((.review_comments // []) | type) != "array" or ((.config.bots // []) | type) != "array" or $author == "") then "BADDATA"
  elif ($h | test("^[0-9a-f]{40}$") | not) then "BADSHA" else
  [ .reviews[]? | select(trusted and (.state | IN("APPROVED", "CHANGES_REQUESTED", "COMMENTED")) and substantive and (refusal | not)) ] as $trev
  | [ $trev[] | select(.commit_id == $h) | "\(.user.login) (\(.state))" ] as $rev
  # Records count from human posters only: an allowlisted bot covers a PR by submitting a
  # review, never by echoing a marker into a comment.
  | [ .comments[]? | select(trusted and (.user.type // "") != "Bot" and (entries_for(.user.login // "") | length) == 0
      and (.updated_at // "") == (.created_at // ""))
      | .user.login as $u
      | (.body // "") | capture("(^|\n)<!-- cv-review-coverage: sha=(?<sha>[0-9a-f]{40}) reviewer=(?<who>[A-Za-z0-9-]+) suite=(?<suite>[A-Za-z0-9/:._-]{1,64}) -->[ \t\r]*(?=\n|$)"; "g")
      | select(.who == $u) ] as $recs
  | [ $recs[] | select(.sha == $h) | "\(.who) (first-party \(.suite))" ] as $fp
  | ([ $trev[] | select(.commit_id != $h) | "\(.user.login)@\((.commit_id // "")[0:7])" ]
     + [ $recs[] | select(.sha != $h) | "\(.who)@\(.sha[0:7])" ]) | unique as $stale
  | ($rev + $fp | unique) as $all
  | "#\($n) @\($h[0:7]) "
    + if ($all | length) > 0 then "covered: " + ($all | join(", "))
      else "ZERO coverage" + (if ($stale | length) > 0 then "; stale: " + ($stale | join(", ")) else "" end)
      end
    + $sfx
  end') || unknown "cannot evaluate coverage for #$PR"

nl='
'
case "$out" in
  *"$nl"*|'') unknown "unexpected output for #$PR" ;;
  BADSHA) unknown "PR #$PR has no readable head SHA" ;;
  BADDATA) unknown "PR #$PR has no readable author, or its reviews, comments or roster are not arrays" ;;
  "#$PR @"*" covered: "*) echo "$out"; exit 0 ;;
  "#$PR @"*" ZERO coverage"*) echo "$out"; exit 1 ;;
  *) unknown "unexpected output for #$PR: $out" ;;
esac
