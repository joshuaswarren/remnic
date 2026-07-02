#!/usr/bin/env node
// Runs tsup with deterministic heap headroom for its DTS worker.
// The DTS build sits near the default V8 heap cliff (see PR #1562):
// unrelated lockfile refreshes flipped it to ERR_WORKER_OUT_OF_MEMORY.
// A Node wrapper (not a NODE_OPTIONS= shell prefix) keeps the build
// script portable to Windows' cmd.exe script shell.
import { spawnSync } from "node:child_process";

const HEAP_DEFAULT = "--max-old-space-size=8192";
const existing = process.env.NODE_OPTIONS?.trim();
// Caller-supplied NODE_OPTIONS goes last so V8's last-wins parsing lets
// callers override the default heap limit.
const nodeOptions = existing ? `${HEAP_DEFAULT} ${existing}` : HEAP_DEFAULT;

const result = spawnSync("tsup", process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  // .bin shims are .cmd files on Windows and need a shell to execute.
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(`[build-with-heap] failed to launch tsup: ${result.error.message}`);
}
process.exit(result.status ?? 1);
