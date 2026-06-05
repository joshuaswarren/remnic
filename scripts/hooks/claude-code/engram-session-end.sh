#!/usr/bin/env bash
# Claude Code SessionEnd hook: final flush of remaining transcript messages into Engram.
#
# Fires when the session actually exits. Sends any messages not yet observed
# (since the last Stop cursor), then cleans up the private cursor file.
#
# Required env vars:
#   OPENCLAW_ENGRAM_ACCESS_TOKEN  — bearer token for the Engram REST API
#
# Optional env vars:
#   ENGRAM_HOST  — defaults to 127.0.0.1
#   ENGRAM_PORT  — defaults to 4318

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/observe"

LOG="${HOME}/.claude/logs/engram-session-store.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT"       | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")"
TRANSCRIPT_PATH="$(echo "$INPUT"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || echo "")"
CWD="$(echo "$INPUT"              | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

# Return immediately
echo '{}'

[ -z "$ENGRAM_TOKEN" ] && exit 0
case "$SESSION_ID" in
  ""|*[!A-Za-z0-9._-]*)
    log "session-end[$SESSION_ID]: invalid session id"
    exit 0
    ;;
esac
[ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ] && exit 0

STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"
STATE_DIR="${STATE_HOME}/remnic/hooks"

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
if ! python3 - "$STATE_DIR" <<'PYEOF'
import os
import stat
import sys

state_dir = sys.argv[1]
try:
    info = os.lstat(state_dir)
except OSError:
    sys.exit(1)

if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
    sys.exit(1)
if info.st_uid != os.getuid():
    sys.exit(1)
if info.st_mode & 0o077:
    os.chmod(state_dir, 0o700)
PYEOF
then
  log "session-end[$SESSION_ID]: unsafe state directory $STATE_DIR"
  exit 0
fi

CURSOR_FILE="${STATE_DIR}/engram-cursor-${SESSION_ID}"
LOCK_DIR="${STATE_DIR}/engram-lock-${SESSION_ID}.d"

validate_cursor_file() {
  python3 - "$CURSOR_FILE" <<'PYEOF'
import os
import stat
import sys

cursor_file = sys.argv[1]
try:
    info = os.lstat(cursor_file)
except FileNotFoundError:
    sys.exit(0)
except OSError:
    sys.exit(1)

if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
    sys.exit(1)
if info.st_uid != os.getuid():
    sys.exit(1)
PYEOF
}

read_cursor_file() {
  validate_cursor_file || {
    log "session-end[$SESSION_ID]: unsafe cursor file $CURSOR_FILE"
    return 1
  }
  [ -f "$CURSOR_FILE" ] && cat "$CURSOR_FILE" 2>/dev/null || echo 0
}

normalize_cursor_value() {
  RAW_CURSOR_VALUE="$1"
  case "$RAW_CURSOR_VALUE" in
    ""|*[!0-9]*)
      log "session-end[$SESSION_ID]: invalid cursor value; defaulting to 0"
      echo 0
      ;;
    *)
      echo "$RAW_CURSOR_VALUE"
      ;;
  esac
}

write_cursor_file() {
  NEW_CURSOR_VALUE="$1"
  validate_cursor_file || {
    log "session-end[$SESSION_ID]: refusing unsafe cursor file $CURSOR_FILE"
    return 1
  }
  TEMP_CURSOR="$(mktemp "${CURSOR_FILE}.tmp.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '%s\n' "$NEW_CURSOR_VALUE" > "$TEMP_CURSOR"; then
    rm -f "$TEMP_CURSOR"
    return 1
  fi
  chmod 600 "$TEMP_CURSOR" 2>/dev/null || true
  mv -f "$TEMP_CURSOR" "$CURSOR_FILE"
}

migrate_tmp_cursor_file() {
  TMP_CURSOR_FILE="/tmp/engram-cursor-${SESSION_ID}"
  [ ! -e "$TMP_CURSOR_FILE" ] && return 0
  TMP_CURSOR_VALUE="$(python3 - "$TMP_CURSOR_FILE" <<'PYEOF'
import os
import stat
import sys

cursor_file = sys.argv[1]
try:
    info = os.lstat(cursor_file)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        sys.exit(1)
    if info.st_uid != os.getuid():
        sys.exit(1)
    value = open(cursor_file, "r", encoding="utf-8").read().strip()
    if not value.isdigit():
        sys.exit(1)
    print(value, end="")
except OSError:
    sys.exit(1)
PYEOF
  )" || return 0
  CURRENT_CURSOR_VALUE=""
  if validate_cursor_file; then
    CURRENT_CURSOR_VALUE="$([ -f "$CURSOR_FILE" ] && cat "$CURSOR_FILE" 2>/dev/null || echo "")"
  fi
  case "$CURRENT_CURSOR_VALUE" in
    ""|*[!0-9]*) CURRENT_CURSOR_VALUE="-1" ;;
  esac
  if [ "$TMP_CURSOR_VALUE" -gt "$CURRENT_CURSOR_VALUE" ]; then
    write_cursor_file "$TMP_CURSOR_VALUE" || return 0
  fi
  rm -f "$TMP_CURSOR_FILE" 2>/dev/null
}

remove_stale_lock_dir() {
  python3 - "$LOCK_DIR" <<'PYEOF'
import os
import shutil
import stat
import sys
import time

lock_dir = sys.argv[1]
try:
    info = os.lstat(lock_dir)
except FileNotFoundError:
    sys.exit(0)
except OSError:
    sys.exit(1)
if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
    sys.exit(1)
if info.st_uid != os.getuid():
    sys.exit(1)
if time.time() - info.st_mtime < 10 * 60:
    sys.exit(0)
shutil.rmtree(lock_dir)
PYEOF
}

remove_cursor_file() {
  validate_cursor_file || {
    log "session-end[$SESSION_ID]: refusing unsafe cursor file $CURSOR_FILE"
    return 1
  }
  rm -f "$CURSOR_FILE"
}

(
  # Acquire exclusive lock to prevent races with any in-flight Stop observe job.
  # Uses mkdir atomicity (POSIX-portable; flock(1) is Linux-only).
  ACQUIRED=0
  for _i in $(seq 1 100); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then ACQUIRED=1; break; fi
    [ "$_i" -eq 1 ] && remove_stale_lock_dir >/dev/null 2>&1
    sleep 0.1
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT INT TERM
  [ "$ACQUIRED" -eq 0 ] && exit 0

  migrate_tmp_cursor_file

  LAST_COUNT=0
  LAST_COUNT="$(read_cursor_file)" || exit 0
  LAST_COUNT="$(normalize_cursor_value "$LAST_COUNT")"

  PAYLOAD="$(python3 - "$TRANSCRIPT_PATH" "$SESSION_ID" "$LAST_COUNT" <<'PYEOF'
import sys, json

transcript_path = sys.argv[1]
session_id      = sys.argv[2]
last_count      = int(sys.argv[3])

def extract_text(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text", "").strip()
                if t:
                    parts.append(t)
        return "\n".join(parts).strip()
    return ""

all_messages = []
try:
    with open(transcript_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") not in ("user", "assistant"):
                continue
            msg = entry.get("message", {})
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", "")
            if role not in ("user", "assistant"):
                continue
            text = extract_text(msg.get("content", ""))
            if text:
                all_messages.append({"role": role, "content": text})
except Exception as e:
    print(f"ERROR:{e}", file=sys.stderr)
    sys.exit(1)

total = len(all_messages)
new_messages = all_messages[last_count:]

if not new_messages:
    print(f"CURSOR:{total}")
    sys.exit(0)

print(json.dumps({"sessionKey": session_id, "messages": new_messages, "__new_count__": total}))
PYEOF
)"

  if [ -z "$PAYLOAD" ]; then
    log "session-end[$SESSION_ID]: parse failed"
    exit 0
  fi

  if echo "$PAYLOAD" | grep -q "^CURSOR:"; then
    log "session-end[$SESSION_ID]: no new messages at exit"
    remove_cursor_file
    exit 0
  fi

  NEW_COUNT="$(echo "$PAYLOAD" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('__new_count__',0))" 2>/dev/null || echo 0)"
  NEW_MSG_COUNT="$(echo "$PAYLOAD" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('messages',[])))" 2>/dev/null || echo "?")"

  CLEAN_PAYLOAD="$(echo "$PAYLOAD" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.pop('__new_count__', None)
print(json.dumps(d))
" 2>/dev/null)"

  [ -z "$CLEAN_PAYLOAD" ] && exit 0

  log "session-end[$SESSION_ID]: flushing $NEW_MSG_COUNT remaining messages (cursor $LAST_COUNT→$NEW_COUNT)"

  RAW="$(curl -s -w "\n%{http_code}" --max-time 120 \
    -X POST "$ENGRAM_URL" \
    -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$CLEAN_PAYLOAD" 2>/dev/null)"
  CURL_EXIT=$?
  HTTP_STATUS="$(echo "$RAW" | tail -1)"
  RESPONSE="$(echo "$RAW" | sed '$d')"

  if [ $CURL_EXIT -eq 0 ] && [[ "$HTTP_STATUS" =~ ^2 ]] && [ -n "$RESPONSE" ]; then
    RESULT="$(echo "$RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f\"accepted={d.get('accepted','?')} lcm={d.get('lcmArchived','?')} extraction={d.get('extractionQueued','?')}\")" 2>/dev/null || echo "$RESPONSE" | head -c 80)"
    log "session-end[$SESSION_ID]: flush OK — $RESULT"
    remove_cursor_file
  else
    log "session-end[$SESSION_ID]: flush failed (curl=$CURL_EXIT http=$HTTP_STATUS)"
  fi
) >> "$LOG" 2>&1 &

disown $!
exit 0
