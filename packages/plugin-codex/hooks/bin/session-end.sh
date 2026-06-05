#!/usr/bin/env bash
# Remnic Stop hook for Codex.
# Performs final observe flush then cleans up cursor/lock files only after the
# pending transcript tail is observed or confirmed empty.

set -euo pipefail

ensure_migrated() {
  if [ -f "${HOME}/.remnic/.migrated-from-engram" ]; then
    return 0
  fi
  if [ ! -d "${HOME}/.engram" ] && [ ! -f "${HOME}/.config/engram/config.json" ]; then
    return 0
  fi
  if command -v remnic >/dev/null 2>&1; then
    remnic migrate >/dev/null 2>&1 || true
  elif command -v engram >/dev/null 2>&1; then
    engram migrate >/dev/null 2>&1 || true
  fi
}

ensure_migrated

REMNIC_HOST="${REMNIC_HOST:-${ENGRAM_HOST:-127.0.0.1}}"
REMNIC_PORT="${REMNIC_PORT:-${ENGRAM_PORT:-4318}}"
REMNIC_URL="http://${REMNIC_HOST}:${REMNIC_PORT}/engram/v1/observe"

LOG="${HOME}/.remnic/logs/remnic-codex-session-end.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [codex-stop] $*" >> "$LOG"; }

REMNIC_TOKEN=""
for TOKEN_FILE in "${HOME}/.remnic/tokens.json" "${HOME}/.engram/tokens.json"; do
  [ ! -f "$TOKEN_FILE" ] && continue
  REMNIC_TOKEN="$(node -e "
    const fs = require('fs');
    const tokenFile = process.argv[1];
    const store = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const tokens = store.tokens || [];
    const cxc = tokens.find(t => t.connector === 'codex-cli');
    const cx = tokens.find(t => t.connector === 'codex');
    const oc = tokens.find(t => t.connector === 'openclaw');
    let tok = (cxc && cxc.token) || (cx && cx.token) || (oc && oc.token) || '';
    if (!tok) { tok = store['codex-cli'] || store['codex'] || store['openclaw'] || ''; }
    process.stdout.write(tok);
  " "$TOKEN_FILE" 2>/dev/null || echo "")"
  [ -n "$REMNIC_TOKEN" ] && break
done
[ -z "$REMNIC_TOKEN" ] && REMNIC_TOKEN="${OPENCLAW_REMNIC_ACCESS_TOKEN:-${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}}"

INPUT="$(cat)"
SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
TRANSCRIPT_PATH="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.transcript_path||'')" "$INPUT" 2>/dev/null || echo "")"

echo '{"continue":true}'

SESSION_ID_SAFE=0
if [[ "$SESSION_ID" != "" && ! "$SESSION_ID" =~ [^A-Za-z0-9._-] ]]; then
  SESSION_ID_SAFE=1
  STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"
  STATE_DIR="${STATE_HOME}/remnic/hooks"
  CURSOR_FILE="${STATE_DIR}/remnic-cursor-${SESSION_ID}"
  LOCK_DIR="${STATE_DIR}/remnic-lock-${SESSION_ID}.d"
  LEGACY_CURSOR_FILE="${STATE_DIR}/engram-cursor-${SESSION_ID}"
  LEGACY_LOCK_DIR="${STATE_DIR}/engram-lock-${SESSION_ID}.d"

  mkdir -p "$STATE_DIR" 2>/dev/null || SESSION_ID_SAFE=0
  if [ "$SESSION_ID_SAFE" -eq 1 ]; then
    if ! node - "$STATE_DIR" <<'NODE'
const fs = require('fs');
const stateDir = process.argv[2];
try {
  const info = fs.lstatSync(stateDir);
  if (info.isSymbolicLink() || !info.isDirectory()) process.exit(1);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) process.exit(1);
  if ((info.mode & 0o077) !== 0) fs.chmodSync(stateDir, 0o700);
} catch {
  process.exit(1);
}
NODE
    then
      log "unsafe state directory $STATE_DIR"
      SESSION_ID_SAFE=0
    fi
  fi
  if [ "$SESSION_ID_SAFE" -eq 1 ] && [ ! -f "$CURSOR_FILE" ] && { [ -f "$LEGACY_CURSOR_FILE" ] || [ -d "$LEGACY_LOCK_DIR" ]; }; then
    CURSOR_FILE="$LEGACY_CURSOR_FILE"
    LOCK_DIR="$LEGACY_LOCK_DIR"
  fi
fi

validate_cursor_file() {
  node - "$CURSOR_FILE" <<'NODE'
const fs = require('fs');
const cursorFile = process.argv[2];
try {
  const info = fs.lstatSync(cursorFile);
  if (info.isSymbolicLink() || !info.isFile()) process.exit(1);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) process.exit(1);
} catch (error) {
  if (error && error.code === 'ENOENT') process.exit(0);
  process.exit(1);
}
NODE
}

read_cursor_file() {
  validate_cursor_file || {
    log "unsafe cursor file $CURSOR_FILE"
    return 1
  }
  [ -f "$CURSOR_FILE" ] && cat "$CURSOR_FILE" 2>/dev/null || echo 0
}

write_cursor_file() {
  NEW_CURSOR_VALUE="$1"
  validate_cursor_file || {
    log "refusing unsafe cursor file $CURSOR_FILE"
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
  for TMP_CURSOR_FILE in "/tmp/remnic-cursor-${SESSION_ID}" "/tmp/engram-cursor-${SESSION_ID}"; do
    [ ! -e "$TMP_CURSOR_FILE" ] && continue
    TMP_CURSOR_VALUE="$(node - "$TMP_CURSOR_FILE" <<'NODE'
const fs = require('fs');
const cursorFile = process.argv[2];
try {
  const info = fs.lstatSync(cursorFile);
  if (info.isSymbolicLink() || !info.isFile()) process.exit(1);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) process.exit(1);
  const value = fs.readFileSync(cursorFile, 'utf8').trim();
  if (!/^\d+$/.test(value)) process.exit(1);
  process.stdout.write(value);
} catch {
  process.exit(1);
}
NODE
    )" || continue
    CURRENT_CURSOR_VALUE=""
    if validate_cursor_file; then
      CURRENT_CURSOR_VALUE="$([ -f "$CURSOR_FILE" ] && cat "$CURSOR_FILE" 2>/dev/null || echo "")"
    fi
    case "$CURRENT_CURSOR_VALUE" in
      ""|*[!0-9]*) CURRENT_CURSOR_VALUE="-1" ;;
    esac
    if [ "$TMP_CURSOR_VALUE" -gt "$CURRENT_CURSOR_VALUE" ]; then
      write_cursor_file "$TMP_CURSOR_VALUE" || continue
    fi
    rm -f "$TMP_CURSOR_FILE" 2>/dev/null
  done
}

remove_cursor_file() {
  validate_cursor_file || {
    log "refusing unsafe cursor file $CURSOR_FILE"
    return 1
  }
  rm -f "$CURSOR_FILE"
}

# Final observe flush if we have transcript
REMOVE_CURSOR_AFTER_FLUSH=1
if [ -n "$REMNIC_TOKEN" ] && [ "$SESSION_ID_SAFE" -eq 1 ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  LAST_COUNT=0
  migrate_tmp_cursor_file
  if LAST_COUNT="$(read_cursor_file)"; then
    PAYLOAD=""
    if ! PAYLOAD="$(node -e "
      const fs = require('fs');
      const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean);
      const messages = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'user' && entry.type !== 'assistant') continue;
          const msg = entry.message;
          if (!msg || typeof msg !== 'object') continue;
          const role = msg.role;
          if (role !== 'user' && role !== 'assistant') continue;
          let text = typeof msg.content === 'string' ? msg.content.trim() :
            Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text' && b.text).map(b => b.text.trim()).join('\n').trim() : '';
          if (text) messages.push({ role, content: text });
        } catch {}
      }
      const newMessages = messages.slice(parseInt(process.argv[3], 10) || 0);
      if (newMessages.length) {
        process.stdout.write(JSON.stringify({ sessionKey: process.argv[2], messages: newMessages }));
      }
    " "$TRANSCRIPT_PATH" "$SESSION_ID" "$LAST_COUNT" 2>/dev/null)"; then
      log "final flush parse failed for $SESSION_ID; cursor retained for retry"
      REMOVE_CURSOR_AFTER_FLUSH=0
      PAYLOAD=""
    fi

    if [ -n "$PAYLOAD" ]; then
      log "final flush for $SESSION_ID"
      CURL_EXIT=0
      RAW="$(curl -s -w "\n%{http_code}" --max-time 30 \
        -X POST "$REMNIC_URL" \
        -H "Authorization: Bearer ${REMNIC_TOKEN}" \
        -H "Content-Type: application/json" \
        -H "X-Engram-Client-Id: codex" \
        -d "$PAYLOAD" 2>/dev/null)" || CURL_EXIT=$?
      HTTP_STATUS="$(printf '%s\n' "$RAW" | tail -1)"
      if [ "$CURL_EXIT" -eq 0 ] && [[ "$HTTP_STATUS" =~ ^2 ]]; then
        log "final flush OK for $SESSION_ID"
      else
        log "final flush failed for $SESSION_ID (curl=$CURL_EXIT http=${HTTP_STATUS:-unknown}); cursor retained for retry"
        REMOVE_CURSOR_AFTER_FLUSH=0
      fi
    fi
  else
    log "final flush skipped for $SESSION_ID due to unsafe cursor"
  fi
fi

# Cleanup
if [ "$SESSION_ID_SAFE" -eq 1 ]; then
  if [ "$REMOVE_CURSOR_AFTER_FLUSH" -eq 1 ]; then
    remove_cursor_file || true
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
  if [ "$CURSOR_FILE" != "$LEGACY_CURSOR_FILE" ] && [ -e "$LEGACY_CURSOR_FILE" ] && [ ! -L "$LEGACY_CURSOR_FILE" ]; then
    rm -f "$LEGACY_CURSOR_FILE" 2>/dev/null || true
  fi
  if [ "$LOCK_DIR" != "$LEGACY_LOCK_DIR" ]; then
    rmdir "$LEGACY_LOCK_DIR" 2>/dev/null || true
  fi
fi

# Codex-native memory materialization (#378). The script honors the
# `codexMaterializeMemories` config flag and the `.remnic-managed` sentinel,
# so it's safe to run unconditionally here.
#
# Entrypoint-resolution order (first hit wins):
#   1. $REMNIC_CODEX_MATERIALIZE_BIN — explicit override from the environment.
#      Set this to point at a custom Node wrapper if you need to short-circuit
#      the search order.
#   2. The packaged CJS wrapper shipped with @remnic/plugin-codex at
#      `packages/plugin-codex/bin/materialize.cjs`, resolved relative to this
#      hook's own filesystem location. This is the preferred path for
#      published installs — the wrapper imports `@remnic/core` directly and
#      has zero dependency on the source tree. We resolve the path via
#      `BASH_SOURCE[0]` + `cd -P` so symlinked checkouts (pnpm hoisted
#      installs, worktree copies) land on the real file.
#   3. Dev fallback: `scripts/codex-materialize.ts` at the repo root. Only
#      present in source checkouts — we use it when the packaged bin isn't
#      available, so local developers keep working without having to run a
#      build first. See PR #392 review thread PRRT_kwDORJXyws56TOVo for why
#      we can't rely on this in distributed installs.
#   4. If neither yielded a usable path, we log the miss and exit the block
#      without running the materializer. A verbose log line is strictly
#      better than a mysterious no-op when `codexMaterializeMemories=true`.
if [ "${REMNIC_CODEX_MATERIALIZE:-1}" != "0" ]; then
  HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || HOOK_DIR=""

  MATERIALIZE_BIN="${REMNIC_CODEX_MATERIALIZE_BIN:-}"
  if [ -z "$MATERIALIZE_BIN" ] && [ -n "$HOOK_DIR" ]; then
    # hooks/bin/session-end.sh → ../../bin/materialize.cjs lands at
    # packages/plugin-codex/bin/materialize.cjs.
    CANDIDATE_BIN="${HOOK_DIR}/../../bin/materialize.cjs"
    if [ -f "$CANDIDATE_BIN" ]; then
      MATERIALIZE_BIN="$(cd -P "$(dirname "$CANDIDATE_BIN")" 2>/dev/null && pwd)/$(basename "$CANDIDATE_BIN")" || MATERIALIZE_BIN=""
    fi
  fi

  REMNIC_REPO_ROOT="${REMNIC_REPO_ROOT:-}"
  if [ -z "$REMNIC_REPO_ROOT" ] && [ -n "$HOOK_DIR" ]; then
    CANDIDATE_ROOT="$(cd -P "${HOOK_DIR}/../../../.." 2>/dev/null && pwd)" || CANDIDATE_ROOT=""
    if [ -n "$CANDIDATE_ROOT" ] && [ -f "${CANDIDATE_ROOT}/scripts/codex-materialize.ts" ]; then
      REMNIC_REPO_ROOT="$CANDIDATE_ROOT"
    fi
  fi

  if [ -n "$MATERIALIZE_BIN" ] && [ -f "$MATERIALIZE_BIN" ]; then
    node "$MATERIALIZE_BIN" --reason session_end >> "$LOG" 2>&1 || \
      log "codex-materialize session_end failed (packaged bin=${MATERIALIZE_BIN})"
  elif [ -n "$REMNIC_REPO_ROOT" ] && [ -f "${REMNIC_REPO_ROOT}/scripts/codex-materialize.ts" ]; then
    (
      cd "$REMNIC_REPO_ROOT"
      npx --yes tsx scripts/codex-materialize.ts --reason session_end >> "$LOG" 2>&1 || \
        log "codex-materialize session_end failed (dev script)"
    )
  else
    log "codex-materialize skipped — could not resolve packaged bin or REMNIC_REPO_ROOT (hook_dir=${HOOK_DIR:-unset})"
  fi
fi

exit 0
