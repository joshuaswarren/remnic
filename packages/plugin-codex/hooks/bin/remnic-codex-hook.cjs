#!/usr/bin/env node
/**
 * Remnic unified Codex hook runner (issues #1440, #2483).
 *
 * Thin per-host config for the shared runner in remnic-hook-core.cjs (kept
 * byte-identical across host packages; canonical source:
 * scripts/hook-runner/remnic-hook-core.cjs — run `npm run sync:hook-runner`
 * after editing). The thin `.sh` (POSIX) and `.ps1` (Windows) wrappers exec
 * this file with the event name as argv[2]:
 *
 *   node remnic-codex-hook.cjs <event>
 *
 * Events: session-start | user-prompt-recall | post-tool-observe |
 *         session-end | pre-compact
 *
 * Codex-only surfaces enabled here: the PreCompact drain+flush (#1571) and
 * the session-end Codex-native memory materialization (#378).
 *
 * Fail-open everywhere: any unexpected error degrades to `{"continue":true}`.
 */

"use strict";

const { run } = require("./remnic-hook-core.cjs");

run({
  client: "codex",
  tokenConnectors: ["codex-cli", "codex", "openclaw"],
  connectorInstall: "codex-cli",
  progName: "remnic-codex-hook",
  defaultLogFile: "remnic-codex-hook.log",
  logFiles: {
    "session-start": "remnic-session-recall.log",
    "user-prompt-recall": "remnic-user-prompt-recall.log",
    "post-tool-observe": "remnic-post-tool-observe.log",
    "session-end": "remnic-codex-session-end.log",
    "pre-compact": "remnic-pre-compact.log",
  },
  logTags: {
    "session-start": "codex-session-start",
    "user-prompt-recall": "codex-user-prompt",
    "post-tool-observe": "codex-post-tool",
    "session-end": "codex-stop",
    "pre-compact": "codex-pre-compact",
  },
  enablePreCompact: true,
  enableMaterialize: true,
});
