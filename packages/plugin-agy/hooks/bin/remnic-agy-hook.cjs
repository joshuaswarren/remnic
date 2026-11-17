#!/usr/bin/env node
/**
 * Remnic unified Antigravity CLI (agy) hook runner.
 *
 * Thin per-host config for the shared runner in remnic-hook-core.cjs (kept
 * byte-identical across host packages; canonical source:
 * scripts/hook-runner/remnic-hook-core.cjs — run `npm run sync:hook-runner`
 * after editing). The thin `.sh` (POSIX) and `.ps1` (Windows) wrappers exec
 * this file with the event name as argv[2]:
 *
 *   node remnic-agy-hook.cjs <event>
 *
 * Events: session-start | user-prompt-recall | post-tool-observe |
 *         session-end
 *
 * Antigravity-specific surfaces enabled here:
 *   - Transcript parsing: agy passes `transcriptPath` in the hook payload;
 *     when set, the shared runner parses it per `transcriptFormat`
 *     ("atif": ATIF JSON like Devin's transcripts; otherwise JSONL like
 *     Claude Code/Codex). When agy does not pass a path, the resolver below
 *     derives `<session_id>.json` from AGY_TRANSCRIPT_DIR or the XDG/macOS
 *     defaults. Observed reality (Linux 2026-11-17): conversation state lives
 *     in per-conversation SQLite files, with no per-session JSON transcript
 *     yet found — so ATIF parsing is provisional until a real transcriptPath
 *     is seen on an agy session.
 *   - Stop (wired to the shared session-end path) → final observe flush +
 *     cursor cleanup on local CLI sessions; cloud sessions may not fire Stop.
 *   - Stop → post-tool-observe so each completed turn's transcript delta is
 *     observed even when no file-mutating tool ran.
 *   - No compaction hooks: agy exposes no PreCompact/PostCompaction event, so
 *     the shared pre-compact drain+flush never fires here. The daemon-side
 *     extraction pipeline picks up buffered observations on its own schedule.
 *
 * Fail-open everywhere: any unexpected error degrades to `{"continue":true}`.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { run } = require("./remnic-hook-core.cjs");

// Conversation storage (measured on Linux 2026-11-17): per-conversation
// SQLite files at ~/.gemini/antigravity-cli/conversations/<id>.db (tables:
// trajectory_meta, steps with protobuf metadata blobs), plus a JSONL prompt
// history at ~/.gemini/antigravity-cli/history.jsonl. There is NO per-session
// JSON transcript file yet found, so ATIF parsing below is provisional: if
// Conversation storage (measured on Linux 2026-11-17): per-conversation
// SQLite files at ~/.gemini/antigravity-cli/conversations/<id>.db (tables:
// trajectory_meta, steps with protobuf payload blobs). There is NO
// per-session JSON transcript — 3449 shipped a JSON-only resolver, so the
// hook fired but observed nothing. Resolution order:
//   1. $AGY_TRANSCRIPT_DIR/<session_id>.db  (explicit override)
//   2. ~/.gemini/antigravity-cli/conversations/<session_id>.db (default)
//   3. $XDG_DATA_HOME/agy/cli/transcripts/<session_id>.json (legacy JSON,
//      parsed per transcriptFormat when present)
// A missing db is not an error — the observe worker simply retries on the
// next hook event. WAL/SHM sidecars are read by SQLite itself; never copy
// the db, always open read-only.
function agyConversationDb(input) {
  const sessionId = input && input.session_id;
  if (!sessionId || /[^A-Za-z0-9._-]/.test(sessionId)) return "";
  const candidates = [];
  if (process.env.AGY_TRANSCRIPT_DIR) {
    candidates.push(path.join(process.env.AGY_TRANSCRIPT_DIR, `${sessionId}.db`));
  }
  // HOME is overridden in tests; os.homedir() follows it.
  const homedir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  candidates.push(
    path.join(homedir, ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`),
  );
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  return "";
}

function resolveTranscriptPath(input) {
  // SQLite first: this is where agy really keeps conversations. JSON
  // second: explicit AGY_TRANSCRIPT_DIR overrides and the legacy XDG/macOS
  // layouts (the test harness writes ATIF JSON there; parseTranscript
  // handles JSON per transcriptFormat, parseAgySqlite only on .db paths).
  const db = agyConversationDb(input);
  if (db) return db;
  const sessionId = input && input.session_id;
  if (!sessionId || /[^A-Za-z0-9._-]/.test(sessionId)) return "";
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const candidates = [];
  if (process.env.AGY_TRANSCRIPT_DIR) {
    candidates.push(path.join(process.env.AGY_TRANSCRIPT_DIR, `${sessionId}.json`));
  }
  candidates.push(path.join(xdgData, "agy", "cli", "transcripts", `${sessionId}.json`));
  if (process.platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "agy", "cli", "transcripts", `${sessionId}.json`),
    );
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  return "";
}

// Decode an agy SQLite conversation db into the shared [{role, content}]
// message shape in stable idx order. Payloads are protobuf blobs; tool
// names, file paths, and message text are recovered as embedded printable
// strings (bounded). Steps that yield no text are skipped, so cursor
// counting stays aligned with what was actually observed.
const AGY_SQLITE_MESSAGE_CAP = 8000;
function parseAgySqlite(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT step_type, step_payload FROM steps ORDER BY idx")
      .all();
    const messages = [];
    for (const row of rows) {
      // node:sqlite returns BLOBs as non-Buffer view objects; coerce.
      const payload = Buffer.isBuffer(row.step_payload)
        ? row.step_payload
        : Buffer.from(row.step_payload);
      if (!payload || payload.length === 0) continue;
      // Preserve Unicode conversation text (mixed-language turns); drop
      // only binary framing and control/format characters.
      const text = payload
        .toString("utf8")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, " ")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join("\n")
        .trim();
      if (!text) continue;
      // Role follows verified payload markers, not the step code: every
      // sampled model row carries a `(bot-<id>` marker while the genuine
      // user row has none (only `no_tool_call_check`). Tool-call rows
      // (call_<id>, tool JSON) are agent activity. Unmarked rows default
      // to user — a fresh prompt with no marker is the observed user shape.
      const hasBotMarker = /\(bot-/.test(text);
      const hasToolCall = /call_\d|\{"[A-Z][a-zA-Z]*":/.test(text);
      messages.push({
        role: hasBotMarker || hasToolCall ? "assistant" : "user",
        content: text.slice(0, AGY_SQLITE_MESSAGE_CAP),
      });
    }
    return messages;
  } finally {
    db.close();
  }
}

run({
  client: "agy-cli",
  tokenConnectors: ["agy-cli", "agy", "openclaw"],
  connectorInstall: "agy-cli",
  progName: "remnic-agy-hook",
  defaultLogFile: "remnic-agy-hook.log",
  logFiles: {
    "session-start": "remnic-session-recall.log",
    "user-prompt-recall": "remnic-user-prompt-recall.log",
    "post-tool-observe": "remnic-post-tool-observe.log",
    "session-end": "remnic-agy-session-end.log",
  },
  logTags: {
    "session-start": "agy-session-start",
    "user-prompt-recall": "agy-user-prompt",
    "post-tool-observe": "agy-post-tool",
    "session-end": "agy-stop",
  },
  transcriptFormat: "atif",
  resolveTranscriptPath,
  parseTranscript: (transcriptPath) =>
    transcriptPath.endsWith(".db")
      ? parseAgySqlite(transcriptPath)
      : undefined, // fall through: core handles JSON per transcriptFormat
  projectDirEnv: "AGY_PROJECT_DIR",
  // No compaction hooks on agy (no PreCompact/PostCompaction event exists),
  // so the shared pre-compact handler is never registered here.
  enablePreCompact: false,
  enableMaterialize: false,
});
