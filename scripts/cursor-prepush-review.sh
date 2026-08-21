#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${SKIP_CURSOR_PREPUSH:-0}" == "1" ]]; then
  echo "[cursor-review] skipped (SKIP_CURSOR_PREPUSH=1)"
  exit 0
fi

STRICT_MODE="${CURSOR_PREPUSH_STRICT:-0}"

CURSOR_BIN=""
if command -v agent >/dev/null 2>&1; then
  CURSOR_BIN="agent"
elif command -v cursor-agent >/dev/null 2>&1; then
  CURSOR_BIN="cursor-agent"
fi

if [[ -z "$CURSOR_BIN" ]]; then
  echo "[cursor-review] skipped (agent/cursor-agent not installed)"
  if [[ "$STRICT_MODE" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

BASE_REF="${CURSOR_PREPUSH_BASE_REF:-origin/main}"
if git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  BASE_SHA="$(git merge-base HEAD "$BASE_REF")"
else
  BASE_SHA="$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)"
fi

CHANGED_FILES="$(git diff --name-only "$BASE_SHA"...HEAD)"
if [[ -z "$CHANGED_FILES" ]]; then
  echo "[cursor-review] no changed files against $BASE_SHA; skipping"
  exit 0
fi

MAX_DIFF_CHARS_RAW="${CURSOR_PREPUSH_MAX_DIFF_CHARS:-120000}"
if [[ "$MAX_DIFF_CHARS_RAW" =~ ^[0-9]+$ ]] && [[ "$MAX_DIFF_CHARS_RAW" -gt 0 ]]; then
  MAX_DIFF_CHARS="$MAX_DIFF_CHARS_RAW"
else
  MAX_DIFF_CHARS="120000"
fi

DIFF_TEXT="$(git diff --no-color --unified=3 "$BASE_SHA"...HEAD)"
if [[ ${#DIFF_TEXT} -gt "$MAX_DIFF_CHARS" ]]; then
  DIFF_TEXT="${DIFF_TEXT:0:$MAX_DIFF_CHARS}"$'\n'"[diff truncated at ${MAX_DIFF_CHARS} chars]"
fi

PROMPT_FILE="$(mktemp)"
OUTPUT_FILE="$(mktemp)"
ERROR_FILE="$(mktemp)"
cleanup() {
  rm -f "$PROMPT_FILE" "$OUTPUT_FILE" "$ERROR_FILE"
}
trap cleanup EXIT

cat >"$PROMPT_FILE" <<EOF
You are reviewing a git diff for potential defects before push.

Repository: $(basename "$ROOT_DIR")
Base commit: $BASE_SHA
Head commit: $(git rev-parse HEAD)

Changed files:
$CHANGED_FILES

Unified diff:
$DIFF_TEXT

Focus on bug-finding only (logic errors, regressions, runtime failures, security issues, data loss, race conditions, broken assumptions).
Do not report style, naming, formatting, or optional refactors.
Do not run shell commands, tools, or ask follow-up questions; answer only from the provided diff/context.

Output format (strict):
- If no issues: output exactly "NO_ISSUES_FOUND"
- Otherwise output one finding per line with this format:
  SEVERITY|path:line|title|why it is a real bug
  where SEVERITY is one of CRITICAL,HIGH,MEDIUM,LOW
EOF

CURSOR_MODEL="${CURSOR_PREPUSH_MODEL:-auto}"
CURSOR_TIMEOUT_SECONDS_RAW="${CURSOR_PREPUSH_TIMEOUT_SECONDS:-300}"
if [[ "$CURSOR_TIMEOUT_SECONDS_RAW" =~ ^[0-9]+$ ]] && [[ "$CURSOR_TIMEOUT_SECONDS_RAW" -gt 0 ]]; then
  CURSOR_TIMEOUT_SECONDS="$CURSOR_TIMEOUT_SECONDS_RAW"
else
  CURSOR_TIMEOUT_SECONDS="300"
fi

timeout_cmd=()
if command -v timeout >/dev/null 2>&1; then
  timeout_cmd=(timeout "$CURSOR_TIMEOUT_SECONDS")
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_cmd=(gtimeout "$CURSOR_TIMEOUT_SECONDS")
fi

if [[ ${#timeout_cmd[@]} -gt 0 ]]; then
  echo "[cursor-review] running $CURSOR_BIN --model $CURSOR_MODEL (timeout=${CURSOR_TIMEOUT_SECONDS}s)"
else
  echo "[cursor-review] running $CURSOR_BIN --model $CURSOR_MODEL (no timeout command found)"
fi

if ! "${timeout_cmd[@]}" "$CURSOR_BIN" -p --trust --output-format text --model "$CURSOR_MODEL" "$(cat "$PROMPT_FILE")" >"$OUTPUT_FILE" 2>"$ERROR_FILE"; then
  rc=$?
  if [[ "$rc" == "124" ]] || [[ "$rc" == "137" ]]; then
    echo "[cursor-review] timed out after ${CURSOR_TIMEOUT_SECONDS}s; skipping"
    if [[ "$STRICT_MODE" == "1" ]]; then
      exit 1
    fi
    exit 0
  fi
  echo "[cursor-review] unavailable (command failed); skipping"
  if [[ -s "$ERROR_FILE" ]]; then
    sed 's/^/[cursor-review] /' "$ERROR_FILE"
  fi
  if [[ "$STRICT_MODE" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

if grep -Eq '^NO_ISSUES_FOUND$' "$OUTPUT_FILE"; then
  echo "[cursor-review] no issues found"
  exit 0
fi

if grep -Eq '^(CRITICAL|HIGH|MEDIUM|LOW)\|' "$OUTPUT_FILE"; then
  echo "[cursor-review] potential issues detected:"
  sed 's/^/[cursor-review] /' "$OUTPUT_FILE"
  echo "[cursor-review] block push; resolve issues or bypass with SKIP_CURSOR_PREPUSH=1"
  exit 1
fi

echo "[cursor-review] unparseable response; treating as advisory and continuing"
sed 's/^/[cursor-review] /' "$OUTPUT_FILE"
if [[ "$STRICT_MODE" == "1" ]]; then
  exit 1
fi
exit 0
