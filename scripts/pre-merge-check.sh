#!/usr/bin/env bash
set -euo pipefail

# Pre-merge guard: ensures AI reviewers have posted and all threads are resolved.
#
# Usage: scripts/pre-merge-check.sh <PR_NUMBER>
#
# Why this exists: PRs were being merged seconds after creation, before
# AI reviewers had time to post reviews. This script blocks merging until
# reviewers have weighed in and all threads are resolved.
#
# Reviewer activity is detected via PR reviews, PR comments, and completed
# check runs (Cursor Bugbot and Kilo Code Review run as GitHub App checks).

PR_NUMBER="${1:?Usage: scripts/pre-merge-check.sh <PR_NUMBER>}"
REPO="${REMNIC_REPO:-joshuaswarren/remnic}"
MIN_REVIEW_THREADS="${MIN_REVIEW_THREADS:-0}"
REQUIRED_REVIEWERS=("cursor[bot]" "chatgpt-codex-connector[bot]")

echo "[pre-merge] Checking PR #${PR_NUMBER} on ${REPO}..."

# 1. Check for unresolved review threads
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
REVIEW_THREADS_QUERY='query($owner: String!, $name: String!, $pr: Int!, $after: String = null) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $after) {
          totalCount
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            isResolved
          }
        }
      }
    }
  }'

UNRESOLVED=0
TOTAL_THREADS=0
AFTER=""
PAGE_INDEX=0
while true; do
  THREAD_ARGS=(
    api graphql
    -f query="$REVIEW_THREADS_QUERY"
    -f owner="$OWNER"
    -f name="$NAME"
    -F pr="$PR_NUMBER"
    --jq '.data.repository.pullRequest.reviewThreads as $threads | [($threads.totalCount // 0), ([($threads.nodes // [])[] | select(.isResolved == false)] | length), ($threads.pageInfo.hasNextPage // false), ($threads.pageInfo.endCursor // "")] | @tsv'
  )
  if [[ -n "$AFTER" ]]; then
    THREAD_ARGS+=(-f after="$AFTER")
  fi

  if ! THREAD_PAGE=$(gh "${THREAD_ARGS[@]}" 2>/dev/null); then
    echo "[pre-merge] BLOCKED: Failed to read review threads from GitHub."
    exit 1
  fi

  if [[ "$THREAD_PAGE" == *$'\n'* ]]; then
    echo "[pre-merge] BLOCKED: GitHub returned malformed review thread data."
    exit 1
  fi

  IFS=$'\t' read -r PAGE_TOTAL PAGE_UNRESOLVED HAS_NEXT END_CURSOR EXTRA_FIELD <<< "$THREAD_PAGE"
  if [[ -n "${EXTRA_FIELD:-}" || ! "$PAGE_TOTAL" =~ ^[0-9]+$ || ! "$PAGE_UNRESOLVED" =~ ^[0-9]+$ || ! "$HAS_NEXT" =~ ^(true|false)$ ]]; then
    echo "[pre-merge] BLOCKED: GitHub returned malformed review thread data."
    exit 1
  fi

  if [[ "$PAGE_INDEX" -eq 0 ]]; then
    TOTAL_THREADS="$PAGE_TOTAL"
  fi
  PAGE_INDEX=$((PAGE_INDEX + 1))
  UNRESOLVED=$((UNRESOLVED + PAGE_UNRESOLVED))
  if [[ "$HAS_NEXT" != "true" ]]; then
    break
  fi
  if [[ -z "$END_CURSOR" ]]; then
    echo "[pre-merge] BLOCKED: GitHub review thread pagination was incomplete."
    exit 1
  fi
  if [[ "$END_CURSOR" == "$AFTER" ]]; then
    echo "[pre-merge] BLOCKED: GitHub review thread pagination did not advance."
    exit 1
  fi
  AFTER="$END_CURSOR"
done

echo "[pre-merge] Review threads: ${TOTAL_THREADS} total, ${UNRESOLVED} unresolved"

if [[ "$UNRESOLVED" -gt 0 ]]; then
  echo "[pre-merge] BLOCKED: ${UNRESOLVED} unresolved review thread(s). Resolve before merging."
  exit 1
fi

# 2. Check that AI reviewers have actually posted (via reviews, comments, or check runs)
if ! REVIEWS=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --jq '.[].user.login' 2>/dev/null); then
  echo "[pre-merge] BLOCKED: Failed to read PR reviews from GitHub."
  exit 1
fi
if ! COMMENTS=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --paginate --jq '.[].user.login' 2>/dev/null); then
  echo "[pre-merge] BLOCKED: Failed to read PR comments from GitHub."
  exit 1
fi

# Some bots (Cursor Bugbot, Kilo Code Review) post as check runs via GitHub
# Apps rather than as PR comments. A completed check run counts as reviewer
# activity. The app.slug field maps to reviewer aliases (e.g. "cursor" matches
# cursor[bot]).
if ! HEAD_SHA=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null); then
  echo "[pre-merge] BLOCKED: Failed to read PR head SHA from GitHub."
  exit 1
fi
CHECK_RUNS=""
if [[ -n "$HEAD_SHA" ]]; then
  if ! CHECK_RUNS=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" \
    --jq '.check_runs[] | select(.conclusion == "success" or .conclusion == "failure" or .conclusion == "neutral") | [.app.slug, .name] | @tsv' \
    2>/dev/null); then
    echo "[pre-merge] BLOCKED: Failed to read PR check runs from GitHub."
    exit 1
  fi
fi

ALL_REVIEWERS=$(printf '%s\n%s\n' "$REVIEWS" "$COMMENTS" | sort -u)

has_reviewer_check_run() {
  local reviewer="$1"
  local expected_slug=""
  local expected_name=""

  case "$reviewer" in
    "cursor[bot]")
      expected_slug="cursor"
      expected_name="Cursor Bugbot"
      ;;
    "chatgpt-codex-connector[bot]")
      expected_slug="chatgpt-codex-connector"
      ;;
    *)
      return 1
      ;;
  esac

  while IFS=$'\t' read -r app_slug check_name _; do
    if [[ "$app_slug" == "$expected_slug" && ( -z "$expected_name" || "$check_name" == "$expected_name" ) ]]; then
      return 0
    fi
  done <<< "$CHECK_RUNS"

  return 1
}

MISSING_REVIEWERS=()
for reviewer in "${REQUIRED_REVIEWERS[@]}"; do
  # Use exact line match (-x) to avoid substring false positives.
  if ! echo "$ALL_REVIEWERS" | grep -qxiF "$reviewer" && \
     ! has_reviewer_check_run "$reviewer"; then
    MISSING_REVIEWERS+=("$reviewer")
  fi
done

if [[ ${#MISSING_REVIEWERS[@]} -gt 0 ]]; then
  echo "[pre-merge] BLOCKED: Missing reviews from: ${MISSING_REVIEWERS[*]}"
  echo "[pre-merge] AI reviewers need time to analyze the diff. Wait 2-5 minutes after PR creation."
  exit 1
fi

echo "[pre-merge] OK: All reviewers posted, 0 unresolved threads. Safe to merge."
