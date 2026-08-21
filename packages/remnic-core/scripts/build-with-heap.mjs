#!/usr/bin/env node
// Runs tsup with deterministic heap headroom for its DTS worker.
// The DTS build sits near the default V8 heap cliff (see PR #1562):
// unrelated lockfile refreshes flipped it to ERR_WORKER_OUT_OF_MEMORY.
// A Node wrapper (not a NODE_OPTIONS= shell prefix) keeps the build
// script portable to Windows' cmd.exe script shell.
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEAP_DEFAULT = "--max-old-space-size=12288";
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
if (result.status !== 0) process.exit(result.status ?? 1);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(packageRoot, "../../admin-console/public/what-helps-me");
const targetDir = path.resolve(packageRoot, "dist/admin-console/public/what-helps-me");
await rm(targetDir, { recursive: true, force: true });
await mkdir(path.dirname(targetDir), { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });
