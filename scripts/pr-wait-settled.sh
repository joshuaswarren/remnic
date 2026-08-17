#!/usr/bin/env bash
set -euo pipefail

# Wait for a PR head to finish all checks, reviewer activity, and review threads.
# Reviewer aliases mirror .github/workflows/review-round-dispatch.yml.
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

strip_leading_non_json() {
  awk '
    !started {
      if ($0 ~ /^[[:space:]]*[\[{]/) started = 1
      else next
    }
    { print }
  '
}

GH_BIN="$(resolve_gh)"
gh() {
  "$GH_BIN" "$@" 2> >(strip_gh_banner >&2) | strip_gh_banner
}

PR_NUMBER=""
TIMEOUT=1800
INTERVAL=30
REVIEWER_TIMEOUT=""
REVIEWER_TIMER_HEAD=""
REVIEWER_WAIT_START=""
REPO="${REMNIC_REPO:-joshuaswarren/remnic}"
JSON_OUTPUT=false
usage() {
  printf 'Usage: scripts/pr-wait-settled.sh <pr-number> [--timeout S] [--interval S] [--reviewer-timeout S] [--json]\n' >&2
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
    --reviewer-timeout)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      [[ "$2" =~ ^[0-9]+([.][0-9]+)?$ ]] || { printf 'Invalid %s value: %s\n' "$1" "$2" >&2; exit 2; }
      REVIEWER_TIMEOUT="$2"
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
declare -A REVIEWER_NEUTRAL_EVIDENCE=()
declare -A REVIEWER_NEGATIVE_EVIDENCE=()

record_reviewer_neutral() {
  local login="$1" evidence="$2" group
  for group in "${REVIEWER_GROUPS[@]}"; do
    case "|${group}|" in
      *"|${login}|"*)
        REVIEWER_PRESENT["$group"]=1
        REVIEWER_NEUTRAL_EVIDENCE["$group"]="$evidence"
        REVIEWER_NEGATIVE_EVIDENCE["$group"]=""
        return 0
        ;;
    esac
  done
}

record_reviewer_negative() {
  local login="$1" verdict="$2" group
  for group in "${REVIEWER_GROUPS[@]}"; do
    case "|${group}|" in
      *"|${login}|"*)
        REVIEWER_PRESENT["$group"]=0
        REVIEWER_NEUTRAL_EVIDENCE["$group"]=""
        REVIEWER_NEGATIVE_EVIDENCE["$group"]="$verdict"
        return 0
        ;;
    esac
  done
}

reviewer_timeout_reached() {
  [[ -n "$REVIEWER_TIMEOUT" ]] || return 1
  local now elapsed start
  now="$(date +%s.%N)"
  start="${REVIEWER_WAIT_START:-$start_time}"
  elapsed="$(awk -v now="$now" -v start="$start" 'BEGIN { print now - start }')"
  awk -v elapsed="$elapsed" -v timeout="$REVIEWER_TIMEOUT" 'BEGIN { exit !(elapsed >= timeout) }'
}

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
print_reviewer_neutral_evidence() {
  local stream=1 group evidence
  [[ "${1:-}" == timeout || "$JSON_OUTPUT" == true ]] && stream=2
  for group in "${REVIEWER_GROUPS[@]}"; do
    evidence="${REVIEWER_NEUTRAL_EVIDENCE[$group]:-}"
    [[ -n "$evidence" ]] || continue
    if [[ "$evidence" == reviewer\ timeout\ after* ]]; then
      if [[ "$stream" == 2 ]]; then
        printf 'reviewer neutral (warning): %s; evidence: %s\n' "${group%%|*}" "$evidence" >&2
      else
        printf 'reviewer neutral (warning): %s; evidence: %s\n' "${group%%|*}" "$evidence"
      fi
    elif [[ "$stream" == 2 ]]; then
      printf 'reviewer neutral: %s; evidence: %s\n' "${group%%|*}" "$evidence" >&2
    else
      printf 'reviewer neutral: %s; evidence: %s\n' "${group%%|*}" "$evidence"
    fi
  done
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

is_fresh_reaction() {
  local created_at="$1"
  [[ -n "${HEAD_VISIBLE_AT:-}" && -n "$created_at" &&
    ( "$created_at" == "$HEAD_VISIBLE_AT" || "$created_at" > "$HEAD_VISIBLE_AT" ) ]]
}

record_reviewer() {
  local login="$1"
  local group
  for group in "${REVIEWER_GROUPS[@]}"; do
    case "|${group}|" in
      *"|${login}|"*)
        REVIEWER_PRESENT["$group"]=1
        REVIEWER_NEUTRAL_EVIDENCE["$group"]=""
        return 0
        ;;
    esac
  done
}

record_reviewer_approval() {
  local login="$1" group
  record_reviewer "$login"
  for group in "${REVIEWER_GROUPS[@]}"; do
    case "|${group}|" in
      *"|${login}|"*) REVIEWER_NEGATIVE_EVIDENCE["$group"]=""; return 0 ;;
    esac
  done
}

reset_reviewer() {
  local login="$1" group
  for group in "${REVIEWER_GROUPS[@]}"; do
    case "|${group}|" in
      *"|${login}|"*)
        REVIEWER_PRESENT["$group"]=0
        REVIEWER_NEUTRAL_EVIDENCE["$group"]=""
        return 0
        ;;
    esac
  done
}

fetch_and_evaluate() {
  OUTSTANDING=()
  declare -A REVIEWER_PRESENT=()
  REVIEWER_NEUTRAL_EVIDENCE=()
  REVIEWER_NEGATIVE_EVIDENCE=()
  API_ERRORS=()
  HEAD_VISIBLE_AT=""
  SKIP_CURSOR=false
  if ! HEAD_SHA=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null); then
    API_ERRORS+=("head")
    append_item "api:head"
    return
  fi
  if [[ "$REVIEWER_TIMER_HEAD" != "$HEAD_SHA" ]]; then
    REVIEWER_TIMER_HEAD="$HEAD_SHA"
    REVIEWER_WAIT_START="$(date +%s.%N)"
  fi
  local pr_meta
  if pr_meta=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json author,files --jq 'if (.author.login == "dependabot[bot]" and (.files | length) > 0 and all(.files[]; (.path // "" | split("/")[-1]) as $base | ["package.json", "package-lock.json", "pnpm-lock.yaml", "requirements.txt"] | index($base) != null)) then "true" else "false" end' 2>/dev/null); then
    if [[ "$pr_meta" == true ]]; then
      SKIP_CURSOR=true
    fi
  fi
  local checks_raw reviews_raw issue_comments_raw check_runs_raw

  local checks_status=0
  checks_raw="$(gh pr checks "$PR_NUMBER" --repo "$REPO" --required --json name,state --jq 'if length == 0 then "__NO_REQUIRED_CHECKS__" else .[] | [.name, (.state // "unknown")] | @tsv end' 2>&1)" || checks_status=$?
  if (( checks_status != 0 )); then
    if [[ "$checks_raw" == *"checks reported"* ]]; then
      checks_raw="__NO_REQUIRED_CHECKS__"
    elif [[ "$checks_raw" != *$'\t'* && "$checks_raw" != [\[]* ]]; then
      API_ERRORS+=("checks")
      append_item "api:checks"
      checks_raw="__CHECKS_API_ERROR__"
    fi
  fi
  if (( checks_status != 0 )) && [[ "$checks_raw" != *$'\t'* && "$checks_raw" == [\[]* ]] &&
    ! printf '%s\n' "$checks_raw" | strip_leading_non_json | jq -e 'type == "array"' >/dev/null 2>&1; then
    API_ERRORS+=("checks")
    append_item "api:checks"
    checks_raw="__CHECKS_API_ERROR__"
  fi
  if [[ "$checks_raw" == "__CHECKS_API_ERROR__" || "$checks_raw" == "__NO_REQUIRED_CHECKS__" || "$checks_raw" == "[]" ]]; then
    :
  elif [[ -z "$checks_raw" ]]; then
    API_ERRORS+=("checks")
    append_item "api:checks"
  else
    declare -A CHECK_STATES=()
    while IFS=$'\t' read -r check_name check_state; do
      [[ -n "$check_name" ]] || continue
      CHECK_STATES["$check_name"]+="${check_state^^}"$'\n'
    done < <(
      if [[ "$checks_raw" == *$'\t'* ]]; then
        printf '%s\n' "$checks_raw"
      elif [[ "$checks_raw" == [\[]* ]]; then
        printf '%s\n' "$checks_raw" | strip_leading_non_json | jq -r '.[] | [.name, (.state // "unknown")] | @tsv'
      else
        printf '%s\n' "$checks_raw"
      fi
    )
    for check_name in "${!CHECK_STATES[@]}"; do
      local has_pass=false first_state=""
      while IFS= read -r check_state; do
        [[ -n "$first_state" ]] || first_state="$check_state"
        case "$check_state" in
          SUCCESS|NEUTRAL|SKIPPED) has_pass=true ;;
        esac
      done <<< "${CHECK_STATES[$check_name]}"
      [[ "$has_pass" == true ]] || append_item "check:${check_name}(${first_state})"
    done
  fi

  if ! reviews_raw=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --paginate --jq '.[] | [.user.login, (.commit_id // ""), (.state // ""), (.body // "" | gsub("[\r\n\t]"; " "))] | @tsv' 2>/dev/null); then
    API_ERRORS+=("reviews")
    append_item "api:reviews"
  else
    while IFS=$'\t' read -r login commit state body; do
      if is_current_sha "$commit"; then
        if [[ "$state" == "APPROVED" ||
          ( "$state" == "COMMENTED" &&
            "$body" =~ [Nn]o[[:space:]]+(major[[:space:]]+)?issues|[Aa]pproved|[Ll]ooks[[:space:]]+good ) ]]; then
          record_reviewer_approval "$login"
        elif [[ "$state" == "CHANGES_REQUESTED" || "$state" == "DISMISSED" ]]; then
          record_reviewer_negative "$login" "$state"
        elif [[ "$state" == "COMMENTED" && -z "$body" ]]; then
          record_reviewer_neutral "$login" "empty review body"
        elif [[ "$state" == "COMMENTED" && "$body" == "Review rate limited" ]]; then
          record_reviewer_neutral "$login" "$body"
        elif [[ "$state" == "COMMENTED" ]]; then
          reset_reviewer "$login"
        fi
      fi
    done <<< "$reviews_raw"
  fi

  if ! issue_comments_raw=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --paginate --jq '.[] | [.user.login, (.body // "" | gsub("[\r\n\t]"; " "))] | @tsv' 2>/dev/null); then
    API_ERRORS+=("issue-comments")
    append_item "api:issue-comments"
  else
    while IFS=$'\t' read -r login body; do
      if [[ "$body" =~ [Rr]eviewed[[:space:]]+commit[^[:xdigit:]]+([[:xdigit:]]{7,40}) ]] &&
        is_current_sha "${BASH_REMATCH[1]}" &&
        [[ "$body" =~ [Dd]idn.t[[:space:]]+find|[Nn]o[[:space:]]+(major[[:space:]]+)?issues|[Aa]pproved|[Ll]ooks[[:space:]]+good ]]; then
        case "$login" in
          cursor[bot]|cursor-bugbot[bot]|cursor|cursor-bugbot|chatgpt-codex-connector[bot]|chatgpt-codex-connector)
            record_reviewer "$login"
            ;;
        esac
      fi
    done <<< "$issue_comments_raw"
  fi
  local check_suite_times reaction_raw
  if check_suite_times=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-suites" --paginate --jq '.check_suites[] | (.created_at // "")' 2>/dev/null); then
    while IFS= read -r created_at; do
      [[ -n "$created_at" ]] || continue
      if [[ -z "$HEAD_VISIBLE_AT" || "$created_at" < "$HEAD_VISIBLE_AT" ]]; then
        HEAD_VISIBLE_AT="$created_at"
      fi
    done <<< "$check_suite_times"
  fi
  if reaction_raw=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/reactions" --paginate --jq '.[] | [.user.login, .content, (.created_at // "")] | @tsv' 2>/dev/null); then
    while IFS=$'\t' read -r login content created_at; do
      if [[ "$login" == "chatgpt-codex-connector[bot]" || "$login" == "chatgpt-codex-connector" ]] &&
        [[ "$content" =~ ^(\+1|heart|hooray|rocket)$ ]] &&
        is_fresh_reaction "$created_at"; then
        record_reviewer "$login"
      fi
    done <<< "$reaction_raw"
  fi
  if ! check_runs_raw=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" --paginate --jq '.check_runs[] | [.name, (.app.slug // ""), (.status // ""), (.conclusion // ""), (.head_sha // "")] | @tsv' 2>/dev/null); then
    API_ERRORS+=("check-runs")
    append_item "api:check-runs"
  else
    while IFS=$'\t' read -r check_name app_slug run_status conclusion run_sha; do
      [[ "$run_sha" == "$HEAD_SHA" ]] || continue
      [[ "$run_status" == "completed" ]] || continue
      case "$conclusion" in
        success|neutral) record_reviewer "$app_slug" ;;
      esac
      if [[ "$check_name" == "ai-reviewers" && "$conclusion" == "failure" ]]; then
        record_reviewer_neutral "cursor" "ai-reviewers never posted"
        record_reviewer_neutral "coderabbitai" "ai-reviewers never posted"
      fi
    done <<< "$check_runs_raw"
  fi

  if ! fetch_threads; then
    API_ERRORS+=("review-threads")
    append_item "api:review-threads"
  elif [[ "$THREAD_UNRESOLVED" -gt 0 ]]; then
    append_item "review-threads:${THREAD_UNRESOLVED}-unresolved"
  fi

  local reviewer_timeout_expired=false group
  if reviewer_timeout_reached; then
    reviewer_timeout_expired=true
  fi
  for group in "${REVIEWER_GROUPS[@]}"; do
    [[ "$SKIP_CURSOR" == true && "$group" == "${REVIEWER_GROUPS[0]}" ]] && continue
    [[ "${REVIEWER_PRESENT[$group]:-0}" == 1 ]] && continue
    if [[ -n "${REVIEWER_NEGATIVE_EVIDENCE[$group]:-}" ]]; then
      append_item "reviewer:${group%%|*}(${REVIEWER_NEGATIVE_EVIDENCE[$group]})"
      continue
    fi
    if [[ "$reviewer_timeout_expired" == true ]]; then
      REVIEWER_PRESENT["$group"]=1
      REVIEWER_NEUTRAL_EVIDENCE["$group"]="reviewer timeout after ${REVIEWER_TIMEOUT}s"
    else
      append_item "reviewer:${group%%|*}"
    fi
  done
}

start_time="$(date +%s.%N)"
while true; do
  fetch_and_evaluate
  if [[ ${#OUTSTANDING[@]} -eq 0 ]]; then
    latest_head=""
    if ! latest_head=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null) ||
      [[ "$latest_head" != "$HEAD_SHA" ]]; then
      continue
    fi
    print_reviewer_neutral_evidence
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
    print_reviewer_neutral_evidence timeout
    json_summary timeout "$HEAD_SHA" "$outstanding_json"
    exit 1
  fi
  sleep "$INTERVAL"
done
