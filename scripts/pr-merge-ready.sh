#!/usr/bin/env bash
set -euo pipefail

# Merge a review-settled PR end to end, then delete its branch (issue #2440).
#
# Usage: scripts/pr-merge-ready.sh <pr-number> [--check] [--interval S] [--timeout S]
#
# 1. Verify gates on the head SHA: every check run on the head completed with a
#    green conclusion (success/neutral/skipped), no CHANGES_REQUESTED review
#    targets the current head, and the GraphQL unresolved-thread count is 0.
#    Prints an evidence block (head SHA, per-gate conclusion, thread count).
# 2. Dismiss CHANGES_REQUESTED reviews whose commit is not the head SHA, with
#    a reason string, via the GraphQL dismissPullRequestReview mutation.
# 3. Attempt `gh pr merge <n> --squash`. If GitHub refuses while every verified
#    precondition still held (head unchanged), retry once with `--admin` and
#    log why: GitHub can leave mergeStateStatus BLOCKED after a dismissal even
#    with head checks green and threads at zero.
# 4. Poll the PR state until MERGED, and only then run
#    `git push origin --delete <branch>` — deleting before the merge confirms
#    auto-closes the PR (hit on #2434).
#
# `--check` prints the plan (evidence + intended actions) without acting.
# Exit 0 on success, 1 when a gate or merge step blocks, 2 on usage errors.

# Resolve the real gh binary when a tool-manager wrapper appears first on PATH.
resolve_mise_gh() {
  local candidate
  command -v mise >/dev/null 2>&1 || return 1
  candidate="$(mise which gh 2>/dev/null || true)"
  [[ -x "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

resolve_gh() {
  if [[ -n "${REMNIC_GH_BIN:-}" ]]; then
    printf '%s\n' "$REMNIC_GH_BIN"
    return
  fi
  local candidate kind source
  while IFS= read -r candidate; do
    [[ -x "$candidate" ]] || continue
    case "$candidate" in
      */shims/gh)
        resolve_mise_gh && return
        continue
        ;;
    esac
    kind="$(file -b "$candidate" 2>/dev/null || true)"
    if [[ "$kind" == *script* || "$kind" == *text* ]]; then
      source="$(sed -n '1,8p' "$candidate" 2>/dev/null || true)"
      if [[ "$source" == *mise* ]]; then
        resolve_mise_gh && return
        continue
      fi
    fi
    printf '%s\n' "$candidate"
    return
  done < <(type -P -a gh 2>/dev/null | awk '!seen[$0]++')
  command -v gh
}

strip_gh_banner() {
  awk '
    !started && $0 ~ /^[[:space:]]*mise[[:space:]].*config[.]toml[[:space:]]+tools:[[:space:]]+gh@[^[:space:]]+[[:space:]]*$/ { next }
    { started = 1; print }
  '
}

GH_BIN="$(resolve_gh)"
gh() {
  # Synchronous stderr filtering (round-1 review): an async process
  # substitution `2> >(strip_gh_banner >&2)` can outlive the command
  # substitution capturing this function's output, racing away failure text
  # the merge path matches on ("already merged"). Capture stderr to a temp
  # file, strip after gh exits, and preserve its status via pipefail.
  local err_file status=0
  err_file="$(mktemp)"
  "$GH_BIN" "$@" 2>"$err_file" | strip_gh_banner || status=$?
  strip_gh_banner <"$err_file" >&2
  rm -f "$err_file"
  return "$status"
}

resolve_git() {
  if [[ -n "${REMNIC_GIT_BIN:-}" ]]; then
    printf '%s\n' "$REMNIC_GIT_BIN"
    return
  fi
  command -v git
}
GIT_BIN="$(resolve_git)"

PR_NUMBER=""
DRY_RUN=false
INTERVAL=5
TIMEOUT=300
REPO="${REMNIC_REPO:-joshuaswarren/remnic}"

usage() {
  printf 'Usage: scripts/pr-merge-ready.sh <pr-number> [--check] [--interval S] [--timeout S]\n' >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi
PR_NUMBER="$1"
[[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { usage; exit 2; }
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      DRY_RUN=true
      shift
      ;;
    --interval)
      # Fractional OK: only `sleep` consumes it.
      [[ $# -ge 2 ]] || { usage; exit 2; }
      [[ "$2" =~ ^[0-9]+([.][0-9]+)?$ ]] || { printf 'Invalid --interval value: %s\n' "$2" >&2; exit 2; }
      INTERVAL="$2"
      shift 2
      ;;
    --timeout)
      # Integer only (round-1 review): the merge-poll deadline uses bash
      # integer arithmetic; a fractional value would abort after a
      # successful merge and skip the branch delete.
      [[ $# -ge 2 ]] || { usage; exit 2; }
      [[ "$2" =~ ^[0-9]+$ ]] || { printf 'Invalid --timeout value (integer seconds): %s\n' "$2" >&2; exit 2; }
      TIMEOUT="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

REVIEW_THREADS_QUERY='query($owner: String!, $name: String!, $pr: Int!, $after: String = null) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { isResolved }
      }
    }
  }
}'

DISMISS_MUTATION='mutation($id: ID!, $message: String!) {
  dismissPullRequestReview(input: {pullRequestReviewId: $id, message: $message}) {
    pullRequestReview { state }
  }
}'

DISMISS_REASON="Stale CHANGES_REQUESTED on a superseded commit (does not target the current head); head checks are green and review threads are resolved. Dismissed by scripts/pr-merge-ready.sh (issue #2440)."

fetch_threads() {
  local after="" page total unresolved has_next end_cursor
  THREAD_TOTAL=0
  THREAD_UNRESOLVED=0
  while true; do
    local args=(api graphql -f query="$REVIEW_THREADS_QUERY" -f owner="$OWNER" -f name="$NAME" -F pr="$PR_NUMBER")
    [[ -n "$after" ]] && args+=(-f after="$after")
    if ! page=$(gh "${args[@]}" --jq '.data.repository.pullRequest.reviewThreads as $threads | [($threads.totalCount // 0), ([($threads.nodes // [])[] | select(.isResolved == false)] | length), ($threads.pageInfo.hasNextPage // false), ($threads.pageInfo.endCursor // "")] | @tsv' 2>/dev/null); then
      return 1
    fi
    if [[ "$page" != *$'\n'* ]]; then
      IFS=$'\t' read -r total unresolved has_next end_cursor <<< "$page"
      if [[ "$total" =~ ^[0-9]+$ && "$unresolved" =~ ^[0-9]+$ && "$has_next" =~ ^(true|false)$ ]]; then
        [[ "$THREAD_TOTAL" -gt 0 ]] || THREAD_TOTAL="$total"
        THREAD_UNRESOLVED=$((THREAD_UNRESOLVED + unresolved))
        [[ "$has_next" == "true" ]] || return 0
        [[ -n "$end_cursor" && "$end_cursor" != "$after" ]] || return 1
        after="$end_cursor"
        continue
      fi
    fi
    return 1
  done
}

# ---- step 1: verify gates on the head SHA and print the evidence block ----

if ! pr_meta=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid,headRefName,state,mergeStateStatus --jq '[.headRefOid, .headRefName, .state, (.mergeStateStatus // "")] | @tsv' 2>/dev/null); then
  printf '[pr-merge] FAIL: cannot read PR #%s metadata from %s.\n' "$PR_NUMBER" "$REPO" >&2
  exit 1
fi
IFS=$'\t' read -r HEAD_SHA BRANCH PR_STATE MERGE_STATE <<< "$pr_meta"
GATE_FAILURES=()
GATE_LINES=""
GATE_NAMES=0
if ! check_runs_raw=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" --paginate --jq '.check_runs[] | [.name, (.status // "-"), (.conclusion // "-"), (.head_sha // "-")] | @tsv' 2>/dev/null); then
  GATE_FAILURES+=("api:check-runs")
else
  # Per-name aggregation (round-1 review): a re-run leaves superseded rows on
  # the same SHA, and branch protection honors the latest run per check name.
  # A name is green when ANY of its runs completed green — the same semantics
  # as scripts/pr-wait-settled.sh. Display shows the first (non-green) state
  # only when no run for that name is green.
  declare -A CHECK_STATE_LINES=()
  while IFS=$'\t' read -r gate_name run_status conclusion run_sha; do
    [[ -n "$gate_name" ]] || continue
    [[ "$run_sha" == "$HEAD_SHA" ]] || continue
    CHECK_STATE_LINES["$gate_name"]+="${run_status}/${conclusion}"$'\n'
  done <<< "$check_runs_raw"
  for gate_name in "${!CHECK_STATE_LINES[@]}"; do
    GATE_NAMES=$((GATE_NAMES + 1))
    gate_green=""
    gate_first=""
    while IFS= read -r state_line; do
      [[ -n "$state_line" ]] || continue
      [[ -n "$gate_first" ]] || gate_first="$state_line"
      case "$state_line" in
        completed/success|completed/neutral|completed/skipped) gate_green="${state_line#completed/}" ;;
      esac
    done <<< "${CHECK_STATE_LINES[$gate_name]}"
    if [[ -n "$gate_green" ]]; then
      GATE_LINES+="  ${gate_name}: ${gate_green}"$'\n'
    else
      GATE_FAILURES+=("check:${gate_name}(${gate_first:-none})")
      GATE_LINES+="  ${gate_name}: ${gate_first:-unknown} (RED)"$'\n'
    fi
  done
fi
if [[ "$GATE_NAMES" -eq 0 && ${#GATE_FAILURES[@]} -eq 0 ]]; then
  GATE_FAILURES+=("check-runs:none-reported-on-head")
fi

THREAD_TOTAL=0
THREAD_UNRESOLVED=0
THREADS_READ_FAILED=false
if ! fetch_threads; then
  THREADS_READ_FAILED=true
  GATE_FAILURES+=("api:review-threads")
fi

# CHANGES_REQUESTED verdicts: stale ones (commit != head) are dismissable; a
# verdict on the CURRENT head is a live rejection and must block the merge —
# otherwise the --admin fallback could bulldoze a standing review verdict.
CURRENT_HEAD_BLOCKING=0
STALE_REVIEWS=()
if ! reviews_raw=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --paginate --jq '.[] | select(.state == "CHANGES_REQUESTED") | [(.node_id // "-"), (.user.login // "-"), (.commit_id // "-")] | @tsv' 2>/dev/null); then
  GATE_FAILURES+=("api:reviews")
  reviews_raw=""
else
  while IFS=$'\t' read -r node_id login commit; do
    [[ -n "$node_id" ]] || continue
    if [[ "$commit" == "$HEAD_SHA" ]]; then
      CURRENT_HEAD_BLOCKING=$((CURRENT_HEAD_BLOCKING + 1))
    else
      STALE_REVIEWS+=("${node_id}"$'\t'"${login}"$'\t'"${commit}")
    fi
  done <<< "$reviews_raw"
fi
[[ "$CURRENT_HEAD_BLOCKING" -eq 0 ]] || GATE_FAILURES+=("review-verdicts:${CURRENT_HEAD_BLOCKING}-current-head-CHANGES_REQUESTED")
[[ "$PR_STATE" == "OPEN" ]] || GATE_FAILURES+=("state:${PR_STATE}")

GATES_OK=true
[[ ${#GATE_FAILURES[@]} -eq 0 && "$THREAD_UNRESOLVED" -eq 0 && "$THREADS_READ_FAILED" == false ]] || GATES_OK=false

printf '== pr-merge-ready #%s (%s) ==\n' "$PR_NUMBER" "$REPO"
printf 'head:            %s\n' "$HEAD_SHA"
printf 'branch:          %s\n' "$BRANCH"
printf 'state:           %s (mergeStateStatus: %s)\n' "$PR_STATE" "${MERGE_STATE:-unknown}"
if [[ "$THREADS_READ_FAILED" == true ]]; then
  printf 'threads:         READ FAILED\n'
else
  printf 'threads:         %s unresolved / %s total\n' "$THREAD_UNRESOLVED" "$THREAD_TOTAL"
fi
printf 'gates (%s distinct check names on head):\n' "$GATE_NAMES"
if [[ -n "$GATE_LINES" ]]; then
  printf '%s' "$GATE_LINES"
else
  printf '  (none)\n'
fi
printf 'review verdicts: %s current-head CHANGES_REQUESTED (blocking), %s stale (dismissable)\n' \
  "$CURRENT_HEAD_BLOCKING" "${#STALE_REVIEWS[@]}"
if [[ ${#GATE_FAILURES[@]} -gt 0 ]]; then
  printf 'failures:\n'
  for failure in "${GATE_FAILURES[@]}"; do
    printf '  - %s\n' "$failure"
  done
fi
if [[ "$GATES_OK" == true ]]; then
  printf 'verdict:         READY\n'
else
  printf 'verdict:         BLOCKED\n'
fi

if [[ "$DRY_RUN" == true ]]; then
  printf 'plan (--check, no actions taken):\n'
  printf '  1. dismiss %s stale CHANGES_REQUESTED review(s) via GraphQL with reason:\n' "${#STALE_REVIEWS[@]}"
  for stale in "${STALE_REVIEWS[@]}"; do
    IFS=$'\t' read -r node_id login commit <<< "$stale"
    printf '     - %s (%s, commit %s != head %s)\n' "$node_id" "$login" "${commit:0:7}" "${HEAD_SHA:0:7}"
  done
  printf '  2. gh pr merge %s --repo %s --squash --match-head-commit %s\n' "$PR_NUMBER" "$REPO" "$HEAD_SHA"
  printf '     (retry once with --admin ONLY if refused while every verified precondition held and the head is unchanged)\n'
  printf '  3. poll state until MERGED, then git push origin --delete %s\n' "$BRANCH"
  if [[ "$GATES_OK" == true ]]; then
    exit 0
  fi
  exit 1
fi

if [[ "$GATES_OK" != true ]]; then
  printf '[pr-merge] FAIL: gates not satisfied; refusing to dismiss, merge, or delete.\n' >&2
  exit 1
fi

# ---- step 2: dismiss stale CHANGES_REQUESTED reviews ----

for stale in "${STALE_REVIEWS[@]}"; do
  IFS=$'\t' read -r node_id login commit <<< "$stale"
  printf '[pr-merge] dismissing stale CHANGES_REQUESTED from %s (commit %s != head %s)...\n' \
    "$login" "${commit:0:7}" "${HEAD_SHA:0:7}"
  if ! dismiss_out=$(gh api graphql -f query="$DISMISS_MUTATION" -f id="$node_id" -f message="$DISMISS_REASON" 2>&1); then
    printf '[pr-merge] FAIL: dismissal of %s failed: %s\n' "$node_id" "$dismiss_out" >&2
    exit 1
  fi
done

# ---- step 3: merge (squash), one logged --admin retry ----

printf '[pr-merge] merging PR #%s (squash)...\n' "$PR_NUMBER"
merge_ok=false
already_merged=false
if merge_out=$(gh pr merge "$PR_NUMBER" --repo "$REPO" --squash --match-head-commit "$HEAD_SHA" 2>&1); then
  merge_ok=true
elif [[ "$merge_out" == *"already been merged"* || "$merge_out" == *"already merged"* ]]; then
  already_merged=true
fi
if [[ "$merge_ok" != true && "$already_merged" != true ]]; then
  current_head="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null || true)"
  if [[ "$current_head" != "$HEAD_SHA" ]]; then
    printf '[pr-merge] FAIL: head moved after verification (%s != %s); refusing --admin retry.\n' \
      "${current_head:-unreadable}" "${HEAD_SHA:0:7}" >&2
    exit 1
  fi
  # Round-1 review: a CHANGES_REQUESTED posted on this same head AFTER the
  # initial gate pass is a live rejection -- re-check before --admin so the
  # fallback can never bulldoze a standing verdict.
  late_blockers=0
  if ! late_reviews_raw=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --paginate --jq '.[] | select(.state == "CHANGES_REQUESTED") | [(.node_id // "-"), (.commit_id // "-")] | @tsv' 2>/dev/null); then
    printf '[pr-merge] FAIL: cannot re-read reviews before --admin retry; refusing.\n' >&2
    exit 1
  fi
  while IFS=$'\t' read -r late_node late_commit; do
    [[ -n "$late_node" ]] || continue
    [[ "$late_commit" == "$HEAD_SHA" ]] && late_blockers=$((late_blockers + 1))
  done <<< "$late_reviews_raw"
  if [[ "$late_blockers" -gt 0 ]]; then
    printf '[pr-merge] FAIL: %s CHANGES_REQUESTED review(s) now target the current head; refusing --admin retry.\n' \
      "$late_blockers" >&2
    exit 1
  fi
  printf '[pr-merge] plain merge refused: %s\n' "$merge_out"
  printf '[pr-merge] retrying ONCE with --admin. WHY: every verified precondition held (head %s check runs green, %s unresolved threads, %s stale verdict(s) dismissed, head unchanged at %s) and GitHub still refuses — known mergeStateStatus BLOCKED-after-dismissal behavior (issue #2440).\n' \
    "$GATE_NAMES" "$THREAD_UNRESOLVED" "${#STALE_REVIEWS[@]}" "$HEAD_SHA"
  if ! merge_out=$(gh pr merge "$PR_NUMBER" --repo "$REPO" --squash --admin --match-head-commit "$HEAD_SHA" 2>&1); then
    printf '[pr-merge] FAIL: --admin merge also refused: %s\n' "$merge_out" >&2
    exit 1
  fi
fi

# ---- step 4: poll until MERGED, only then delete the branch ----

printf '[pr-merge] waiting for PR #%s to reach MERGED (timeout %ss)...\n' "$PR_NUMBER" "$TIMEOUT"
deadline=$(( $(date +%s) + TIMEOUT ))
while true; do
  state="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state --jq .state 2>/dev/null || true)"
  if [[ "$state" == "MERGED" ]]; then
    break
  fi
  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    printf '[pr-merge] FAIL: PR #%s did not reach MERGED within %ss (last state: %s). Branch %s NOT deleted — deleting before merge confirmation auto-closes the PR (#2434).\n' \
      "$PR_NUMBER" "$TIMEOUT" "${state:-unreadable}" "$BRANCH" >&2
    exit 1
  fi
  sleep "$INTERVAL"
done

printf '[pr-merge] PR #%s is MERGED; deleting remote branch %s.\n' "$PR_NUMBER" "$BRANCH"
if ! delete_out=$("$GIT_BIN" push origin --delete "$BRANCH" 2>&1); then
  printf '[pr-merge] FAIL: branch deletion failed: %s\n' "$delete_out" >&2
  exit 1
fi
printf '[pr-merge] done: merged and branch deleted.\n'
