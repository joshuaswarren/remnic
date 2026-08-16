#!/usr/bin/env bash
set -euo pipefail

# Wait for a PR head to finish all checks, reviewer activity, and review threads.
# Reviewer aliases mirror .github/workflows/review-round-dispatch.yml.
PR_NUMBER=""
TIMEOUT=1800
INTERVAL=30
JSON_OUTPUT=false
REPO="${REMNIC_REPO:-joshuaswarren/remnic}"

usage() {
  printf 'Usage: scripts/pr-wait-settled.sh <pr-number> [--timeout S] [--interval S] [--json]\n' >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi
PR_NUMBER="$1"
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout|--interval)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      [[ "$2" =~ ^[0-9]+([.][0-9]+)?$ ]] || { printf 'Invalid %s value: %s\n' "$1" "$2" >&2; exit 2; }
      if [[ "$1" == "--timeout" ]]; then TIMEOUT="$2"; else INTERVAL="$2"; fi
      shift 2
      ;;
    --json)
      JSON_OUTPUT=true
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
# These groups are the aliases configured by review-round-dispatch.yml. Kilo is
# not listed because this repository has no Kilo workflow or required group.
REVIEWER_GROUPS=(
  'cursor-bugbot[bot]|cursor[bot]|cursor-bugbot|cursor'
  'coderabbitai[bot]|coderabbitai'
  'chatgpt-codex-connector[bot]|chatgpt-codex-connector'
)

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

json_summary() {
  local status="$1" head="$2" outstanding_json="$3"
  jq -cn --arg status "$status" --arg head "$head" --argjson outstanding "$outstanding_json" \
    '{status: $status, head: $head, outstanding: $outstanding}'
}

append_item() {
  OUTSTANDING+=("$1")
}

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

is_current_sha() {
  local commit="$1"
  [[ -n "$commit" && ( "$HEAD_SHA" == "$commit"* || "$commit" == "$HEAD_SHA"* ) ]]
}

record_reviewer() {
  local login="$1"
  local group
  for group in "${REVIEWER_GROUPS[@]}"; do
    case "|${group}|" in
      *"|${login}|"*) REVIEWER_PRESENT["$group"]=1; return 0 ;;
    esac
  done
}

fetch_and_evaluate() {
  OUTSTANDING=()
  declare -A REVIEWER_PRESENT=()
  API_ERRORS=()
  LEDGER_COMPLETE=false
  HEAD_SHA=""
  if ! HEAD_SHA=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null); then
    API_ERRORS+=("head")
    append_item "api:head"
    return
  fi

  local checks_raw reviews_raw comments_raw issue_comments_raw check_runs_raw
  checks_raw="$(gh pr checks "$PR_NUMBER" --repo "$REPO" --required --json name,state 2>/dev/null || true)"
  if [[ -z "$checks_raw" ]]; then
    API_ERRORS+=("checks")
    append_item "api:checks"
  else
    while IFS=$'\t' read -r check_name check_state; do
      [[ -n "$check_name" ]] || continue
      case "${check_state^^}" in
        SUCCESS|NEUTRAL|SKIPPED) ;;
        *) append_item "check:${check_name}(${check_state:-unknown})" ;;
      esac
    done < <(jq -r '.[] | [.name, (.state // "unknown")] | @tsv' <<< "$checks_raw")
  fi

  if ! reviews_raw=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --paginate --jq '.[] | [.user.login, (.commit_id // "")] | @tsv' 2>/dev/null); then
    API_ERRORS+=("reviews")
    append_item "api:reviews"
  else
    while IFS=$'\t' read -r login commit; do
      is_current_sha "$commit" && record_reviewer "$login"
    done <<< "$reviews_raw"
  fi

  if ! comments_raw=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --paginate --jq '.[] | [.user.login, (.commit_id // "")] | @tsv' 2>/dev/null); then
    API_ERRORS+=("review-comments")
    append_item "api:review-comments"
  else
    while IFS=$'\t' read -r login commit; do
      is_current_sha "$commit" && record_reviewer "$login"
    done <<< "$comments_raw"
  fi

  if ! issue_comments_raw=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --paginate --jq '.[] | [.user.login, (.body // "" | gsub("[\r\n\t]"; " "))] | @tsv' 2>/dev/null); then
    API_ERRORS+=("issue-comments")
    append_item "api:issue-comments"
  else
    while IFS=$'\t' read -r login body; do
      if [[ "$login" == "github-actions[bot]" || "$login" == "github-actions" ]] &&
        [[ "$body" == *"remnic-review-round:v1"* &&
          "$body" == *"\"headSha\":\"${HEAD_SHA}\""* &&
          "$body" == *"\"status\":\"closed\""* &&
          "$body" == *"\"closeReason\":\"round-complete\""* ]]; then
        LEDGER_COMPLETE=true
      fi
      if [[ "$login" == "chatgpt-codex-connector[bot]" || "$login" == "chatgpt-codex-connector" ]]; then
        if [[ "$body" =~ [Rr]eviewed[[:space:]]+commit[^[:xdigit:]]+([[:xdigit:]]{7,40}) ]] &&
          is_current_sha "${BASH_REMATCH[1]}"; then
          record_reviewer "$login"
        fi
      fi
    done <<< "$issue_comments_raw"
  fi
  if ! check_runs_raw=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" --paginate --jq '.check_runs[] | [.name, (.app.slug // ""), (.status // ""), (.conclusion // ""), (.head_sha // "")] | @tsv' 2>/dev/null); then
    API_ERRORS+=("check-runs")
    append_item "api:check-runs"
  else
    while IFS=$'\t' read -r check_name app_slug run_status conclusion run_sha; do
      [[ "$run_sha" == "$HEAD_SHA" ]] || continue
      [[ "$run_status" == "completed" ]] || continue
      [[ -n "$conclusion" ]] || continue
      record_reviewer "$app_slug"
    done <<< "$check_runs_raw"
  fi

  if ! fetch_threads; then
    API_ERRORS+=("review-threads")
    append_item "api:review-threads"
  elif [[ "$THREAD_UNRESOLVED" -gt 0 ]]; then
    append_item "review-threads:${THREAD_UNRESOLVED}-unresolved"
  fi

  local group
  if [[ "$LEDGER_COMPLETE" != true ]]; then
    for group in "${REVIEWER_GROUPS[@]}"; do
      [[ "${REVIEWER_PRESENT[$group]:-0}" == 1 ]] || append_item "reviewer:${group%%|*}"
    done
  fi
}

start_time="$(date +%s.%N)"
while true; do
  fetch_and_evaluate
  if [[ ${#OUTSTANDING[@]} -eq 0 ]]; then
    if [[ "$JSON_OUTPUT" == true ]]; then
      json_summary settled "$HEAD_SHA" '[]'
    else
      printf 'settled: PR #%s head %s; checks terminal, reviewers reported, 0 unresolved threads\n' "$PR_NUMBER" "$HEAD_SHA"
    fi
    exit 0
  fi

  now="$(date +%s.%N)"
  elapsed="$(awk -v now="$now" -v start="$start_time" 'BEGIN { print now - start }')"
  if awk -v elapsed="$elapsed" -v timeout="$TIMEOUT" 'BEGIN { exit !(elapsed >= timeout) }'; then
    outstanding_json="$(printf '%s\n' "${OUTSTANDING[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
    json_summary timeout "$HEAD_SHA" "$outstanding_json"
    exit 1
  fi
  sleep "$INTERVAL"
done
