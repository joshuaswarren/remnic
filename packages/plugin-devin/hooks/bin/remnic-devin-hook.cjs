#!/usr/bin/env node
/**
 * Remnic unified Devin CLI hook runner.
 *
 * Thin per-host config for the shared runner in remnic-hook-core.cjs (kept
 * byte-identical across host packages; canonical source:
 * scripts/hook-runner/remnic-hook-core.cjs — run `npm run sync:hook-runner`
 * after editing). The thin `.sh` (POSIX) and `.ps1` (Windows) wrappers exec
 * this file with the event name as argv[2]:
 *
 *   node remnic-devin-hook.cjs <event>
 *
 * Events: session-start | user-prompt-recall | post-tool-observe |
 *         session-end | pre-compact | post-compaction
 *
 * Devin-specific surfaces enabled here:
 *   - ATIF transcript parsing (`transcriptFormat: "atif"`): Devin CLI writes
 *     session transcripts to `<data>/devin/cli/transcripts/<session_id>.json`
 *     in the ATIF schema rather than the JSONL format Claude Code/Codex use,
 *     and does not pass transcript_path in hook payloads — the resolver
 *     below locates the file from session_id.
 *   - PostCompaction → the shared pre-compact drain+flush handler: Devin
 *     emits the event after compaction completes; draining the observe
 *     buffer and flushing LCM at that point is the same coordination the
 *     omp plugin performs at session_before_compact.
 *   - SessionEnd → final observe flush + cursor cleanup (local CLI/Desktop
 *     sessions only; cloud sessions do not fire SessionEnd).
 *   - Stop → post-tool-observe so each completed turn's transcript delta is
 *     observed even when no file-mutating tool ran.
 *
 * Fail-open everywhere: any unexpected error degrades to `{"continue":true}`.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { run } = require("./remnic-hook-core.cjs");

// Devin CLI session transcripts (ATIF JSON). Resolution order:
//   1. $DEVIN_TRANSCRIPT_DIR/<session_id>.json  (explicit override)
//   2. $XDG_DATA_HOME/devin/cli/transcripts/<session_id>.json
//      (default ~/.local/share/devin/cli/transcripts on Linux)
//   3. ~/Library/Application Support/devin/cli/transcripts/<session_id>.json
//      (macOS app-support layout, if Devin uses it there)
// The observe worker re-checks fs.existsSync, so returning a not-yet-written
// path is safe — it simply retries on the next hook event.
function resolveTranscriptPath(input) {
  const sessionId = input && input.session_id;
  if (!sessionId || /[^A-Za-z0-9._-]/.test(sessionId)) return "";
  const candidates = [];
  if (process.env.DEVIN_TRANSCRIPT_DIR) {
    candidates.push(path.join(process.env.DEVIN_TRANSCRIPT_DIR, `${sessionId}.json`));
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  candidates.push(path.join(xdgData, "devin", "cli", "transcripts", `${sessionId}.json`));
  if (process.platform === "darwin") {
    candidates.push(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "devin",
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
  client: "devin-cli",
  tokenConnectors: ["devin-cli", "devin", "openclaw"],
  connectorInstall: "devin-cli",
  progName: "remnic-devin-hook",
  defaultLogFile: "remnic-devin-hook.log",
  logFiles: {
    "session-start": "remnic-session-recall.log",
    "user-prompt-recall": "remnic-user-prompt-recall.log",
    "post-tool-observe": "remnic-post-tool-observe.log",
    "session-end": "remnic-devin-session-end.log",
    "pre-compact": "remnic-pre-compact.log",
    "post-compaction": "remnic-post-compaction.log",
  },
  logTags: {
    "session-start": "devin-session-start",
    "user-prompt-recall": "devin-user-prompt",
    "post-tool-observe": "devin-post-tool",
    "session-end": "devin-stop",
    "pre-compact": "devin-pre-compact",
    "post-compaction": "devin-post-compaction",
  },
  transcriptFormat: "atif",
  resolveTranscriptPath,
  projectDirEnv: "DEVIN_PROJECT_DIR",
  enablePreCompact: true,
  enableMaterialize: false,
});
