#!/usr/bin/env node
/**
 * Remnic unified Claude Code hook runner (issues #1518, #2483).
 *
 * Thin per-host config for the shared runner in remnic-hook-core.cjs (kept
 * byte-identical across host packages; canonical source:
 * scripts/hook-runner/remnic-hook-core.cjs — run `npm run sync:hook-runner`
 * after editing). The thin `.sh` (POSIX) and `.ps1` (Windows) wrappers exec
 * this file with the event name as argv[2]:
 *
 *   node remnic-cc-hook.cjs <event>
 *
 * Events: session-start | user-prompt-recall | post-tool-observe | session-end
 *
 * NOTE: Claude Code does not currently emit a Stop/SessionEnd event. The
 * session-end handler runs only when invoked manually or once Claude Code
 * adds the event. It is kept so the final-flush + cursor-cleanup parity with
 * the Codex runner is in place from day one (issue #1518). Claude Code has
 * no PreCompact/materialization equivalent, so both stay disabled here — but
 * REMNIC_DAEMON_URL/HTTPS routing is inherited from the shared core.
 *
 * Fail-open everywhere: any unexpected error degrades to `{"continue":true}`.
 */

"use strict";

const { run } = require("./remnic-hook-core.cjs");

run({
  client: "claude-code",
  tokenConnectors: ["claude-code", "openclaw"],
  connectorInstall: "claude-code",
  progName: "remnic-cc-hook",
  defaultLogFile: "remnic-cc-hook.log",
  logFiles: {
    "session-start": "remnic-session-recall.log",
    "user-prompt-recall": "remnic-user-prompt-recall.log",
    "post-tool-observe": "remnic-post-tool-observe.log",
    "session-end": "remnic-cc-session-end.log",
  },
  logTags: {
    "session-start": "cc-session-start",
    "user-prompt-recall": "cc-user-prompt",
    "post-tool-observe": "cc-post-tool",
    "session-end": "cc-stop",
  },
  enablePreCompact: false,
  enableMaterialize: false,
});
