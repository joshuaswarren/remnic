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
# Reviewer activity is detected via PR reviews, PR comments, completed check
# runs (Cursor Bugbot and Kilo Code Review run as GitHub App checks), and an
# approving reaction on the PR body. Codex (chatgpt-codex-connector[bot]) often
# signs off on a clean PR by leaving a thumbs-up (+1) reaction on the PR
# description rather than posting a review or comment — without reaction
# detection those PRs block forever even though the reviewer approved.

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

# `pulls/{n}/comments` returns only inline REVIEW comments. When Codex finds
# no issues it posts its verdict ("Didn't find any major issues") as an ISSUE
# comment, which lives on `issues/{n}/comments` — without this, clean-verdict
# PRs are blocked forever even though the reviewer explicitly signed off.
# Body newlines/tabs are flattened so each comment stays one TSV row.
if ! ISSUE_COMMENTS_RAW=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --paginate --jq '.[] | [.user.login, (.body // "" | gsub("[\r\n\t]"; " "))] | @tsv' 2>/dev/null); then
  echo "[pre-merge] BLOCKED: Failed to read PR issue comments from GitHub."
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
HEAD_COMMIT_DATE=""
if [[ -n "$HEAD_SHA" ]]; then
  if ! CHECK_RUNS=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" \
    --jq '.check_runs[] | select(.conclusion == "success" or .conclusion == "failure" or .conclusion == "neutral") | [.app.slug, .name] | @tsv' \
    2>/dev/null); then
    echo "[pre-merge] BLOCKED: Failed to read PR check runs from GitHub."
    exit 1
  fi
  # Committer date of the head commit, used to reject stale reaction sign-offs
  # (see the reactions block). committedDate is rewritten on rebase, so a
  # pre-rebase reaction correctly stops counting — fail closed.
  HEAD_COMMIT_DATE=$(gh api "repos/${REPO}/commits/${HEAD_SHA}" \
    --jq '.commit.committer.date // empty' 2>/dev/null || true)
fi

# Reviewer approval via a reaction on the PR body. Codex signs off on clean PRs
# with a thumbs-up (+1) reaction on the PR description instead of a review or
# comment. Only count explicitly POSITIVE reactions as a sign-off — a "-1" or
# "confused" reaction is the opposite of approval, and "eyes" means "still
# looking", so none of those count.
#
# CURRENT-HEAD BINDING: a reaction carries no commit SHA and GitHub does NOT
# dismiss it when new commits are pushed, so a bare reaction would let a +1 left
# on an earlier revision satisfy the reviewer for a newer diff it never saw.
# Reactions cannot be SHA-pinned like issue-comment verdicts, so we bind by
# time: a reaction only counts when it was created at/after the head commit's
# committer date. A commit pushed after the +1 has a newer committer date and
# invalidates the stale reaction; a rebase rewrites committer dates and does the
# same — both fail closed, forcing a fresh sign-off. (Residual: cherry-picking a
# commit with an OLD committer date as the new head could re-admit a reaction in
# that window; the SHA-pinned issue-comment path remains the strong signal.)
# If the head commit date is unknown, no reaction can be validated → none count.
# A read failure here is non-fatal: reactions are a supplementary signal, so we
# fall back to the other detection paths rather than blocking the whole gate.
# Byte-wise "is $1 strictly before $2" for two GitHub ISO-8601 UTC (…Z)
# timestamps. Runs in a subshell so LC_ALL=C stays scoped; the fixed-width
# format makes a byte comparison chronological.
iso_before() ( LC_ALL=C; [[ "$1" < "$2" ]] )

POSITIVE_REACTIONS_RE='^(\+1|heart|hooray|rocket)$'
POSITIVE_REACTORS=""
if [[ -z "$HEAD_COMMIT_DATE" ]]; then
  echo "[pre-merge] NOTE: Head commit date unknown; PR-body reactions will not count as sign-off."
elif BODY_REACTIONS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/reactions" --paginate \
  -H "Accept: application/vnd.github+json" \
  --jq '.[] | [.user.login, .content, .created_at] | @tsv' 2>/dev/null); then
  while IFS=$'\t' read -r rx_login rx_content rx_created; do
    [[ -n "$rx_login" ]] || continue
    [[ "$rx_content" =~ $POSITIVE_REACTIONS_RE ]] || continue
    # Reject reactions predating the head commit (stale sign-off on an older rev).
    [[ -n "$rx_created" ]] || continue
    if iso_before "$rx_created" "$HEAD_COMMIT_DATE"; then
      continue
    fi
    POSITIVE_REACTORS+="${rx_login}"$'\n'
  done <<< "$BODY_REACTIONS"
else
  echo "[pre-merge] NOTE: Could not read PR body reactions; relying on reviews/comments/checks."
fi

# Issue comments are PR-wide, not head-scoped, and this gate reads them for
# exactly one reason: Codex posts its clean verdict ("Didn't find any major
# issues … **Reviewed commit:** \`<short sha>\`") as an issue comment. Count
# ONLY those, and only when the SHA embedded after the "Reviewed commit"
# label is a prefix (>= 7 hex chars, git's short-SHA floor) of the CURRENT
# head. Timestamps cannot prove a verdict reviewed this SHA (committer dates
# survive cherry-picks and rebases); the extracted SHA pin can. Every other
# issue comment is conversation, never reviewer activity.
ISSUE_COMMENTERS=""
while IFS=$'\t' read -r ic_login ic_body; do
  [[ "$ic_login" == "chatgpt-codex-connector[bot]" ]] || continue
  grep -qiE "find any major issues|no major issues" <<< "$ic_body" || continue
  # Extract the hex run following the "Reviewed commit" label, tolerating
  # markdown decoration (bold markers, backticks, colon) between the two.
  # `|| true` keeps errexit/pipefail from aborting the gate on comments with
  # no label (legacy unpinned verdicts) — those are simply never counted.
  ic_sha=$(grep -oiE "reviewed commit[^0-9a-fA-F]*[0-9a-fA-F]{7,40}" <<< "$ic_body" \
    | grep -oE "[0-9a-fA-F]{7,40}" | head -n 1 | tr '[:upper:]' '[:lower:]' || true)
  if [[ -n "$ic_sha" && -n "$HEAD_SHA" && "$HEAD_SHA" == "$ic_sha"* ]]; then
    ISSUE_COMMENTERS+="${ic_login}"$'\n'
  fi
done <<< "$ISSUE_COMMENTS_RAW"

ALL_REVIEWERS=$(printf '%s\n%s\n%s\n' "$REVIEWS" "$COMMENTS" "$ISSUE_COMMENTERS" | sort -u)

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

# A required reviewer counts as having signed off if they left a positive
# reaction on the PR body (exact, case-insensitive login match).
has_reviewer_positive_reaction() {
  local reviewer="$1"
  [[ -n "$POSITIVE_REACTORS" ]] || return 1
  grep -qxiF "$reviewer" <<< "$POSITIVE_REACTORS"
}

MISSING_REVIEWERS=()
for reviewer in "${REQUIRED_REVIEWERS[@]}"; do
  # Use exact line match (-x) to avoid substring false positives.
  if ! echo "$ALL_REVIEWERS" | grep -qxiF "$reviewer" && \
     ! has_reviewer_check_run "$reviewer" && \
     ! has_reviewer_positive_reaction "$reviewer"; then
    MISSING_REVIEWERS+=("$reviewer")
  fi
done

if [[ ${#MISSING_REVIEWERS[@]} -gt 0 ]]; then
  echo "[pre-merge] BLOCKED: Missing reviews from: ${MISSING_REVIEWERS[*]}"
  echo "[pre-merge] AI reviewers need time to analyze the diff. Wait 2-5 minutes after PR creation."
  exit 1
fi

echo "[pre-merge] OK: All reviewers posted, 0 unresolved threads. Safe to merge."
