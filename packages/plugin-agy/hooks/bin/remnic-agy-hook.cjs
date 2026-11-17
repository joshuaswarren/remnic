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
 *   - SessionEnd → final observe flush + cursor cleanup (local CLI sessions;
 *     cloud sessions may not fire SessionEnd).
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
// agy never writes <session_id>.json transcripts, resolveTranscriptPath
// returns "" and observation falls back to hook-payload text only.
// Resolution order:
//   1. $AGY_TRANSCRIPT_DIR/<session_id>.json  (explicit override)
//   2. $XDG_DATA_HOME/agy/cli/transcripts/<session_id>.json
//      (default ~/.local/share/agy/cli/transcripts on Linux)
//   3. ~/Library/Application Support/agy/cli/transcripts/<session_id>.json
//      (macOS app-support layout, if agy uses it there)
// The observe worker re-checks fs.existsSync, so returning a not-yet-written
// path is safe — it simply retries on the next hook event.
function resolveTranscriptPath(input) {
  const sessionId = input && input.session_id;
  if (!sessionId || /[^A-Za-z0-9._-]/.test(sessionId)) return "";
  const candidates = [];
  if (process.env.AGY_TRANSCRIPT_DIR) {
    candidates.push(path.join(process.env.AGY_TRANSCRIPT_DIR, `${sessionId}.json`));
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  candidates.push(path.join(xdgData, "agy", "cli", "transcripts", `${sessionId}.json`));
  if (process.platform === "darwin") {
    candidates.push(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "agy",
        "cli",
        "transcripts",
        `${sessionId}.json`,
      ),
    );
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  // Fall back to the XDG candidate even when absent: the transcript may be
  // created after this hook fires (SessionStart precedes the first step).
  return candidates[candidates.length - 1] || "";
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
  // No compaction hooks on agy (no PreCompact/PostCompaction event exists),
  // so the shared pre-compact handler is never registered here.
  enablePreCompact: false,
  enableMaterialize: false,
});
