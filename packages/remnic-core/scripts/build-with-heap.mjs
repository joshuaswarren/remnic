#!/usr/bin/env node
// Builds @remnic/core: JS bundle via tsup, declarations via tsc.
//
// History: tsup emitted declarations through rollup-plugin-dts, which runs ONE
// type rollup per entry point. This package declares 438 entries over a
// ~375k-line type graph, so that is 438 rollups sharing a program inside a
// single worker thread. It sat on the V8 heap cliff from PR #1562 onward and
// was kept alive by raising --max-old-space-size (4096 -> 8192 -> 12288);
// unrelated lockfile refreshes were enough to flip it to
// ERR_WORKER_OUT_OF_MEMORY, and it stopped completing at any heap size.
//
// `tsc --emitDeclarationOnly` builds the program once and writes one .d.ts per
// source file. Measured on the same tree:
//
//   rollup-plugin-dts @ 8192 MB   -> OOM after ~170s
//   rollup-plugin-dts @ 12288 MB  -> OOM / dts error
//   tsc --emitDeclarationOnly     -> 0 errors, 1096 files, ~19s, DEFAULT heap
//
// Per-file output is also the shape this package's `exports` map already wants
// (`./foo` -> `./dist/foo.js`), so the rollup was doing bundling work that no
// consumer reads. No heap flag is needed for either step now.
//
// A Node wrapper (not a NODE_OPTIONS= shell prefix) keeps this portable to
// Windows' cmd.exe script shell.
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .bin shims are .cmd files on Windows and need a shell to execute.
const useShell = process.platform === "win32";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: useShell });
  if (result.error) {
    console.error(`[build] failed to launch ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 1. JS bundle. tsup's own dts is off (see tsup.config.ts).
run("tsup", process.argv.slice(2));

// 2. Declarations. Skipped for the runtime-only container image, which ships
//    no types — same condition tsup's dts flag used.
if (process.env.REMNIC_DOCKER_RUNTIME_BUILD !== "1") {
  run("tsc", ["-p", "tsconfig.dts.json"]);
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(packageRoot, "../../admin-console/public/what-helps-me");
const targetDir = path.resolve(packageRoot, "dist/admin-console/public/what-helps-me");
await rm(targetDir, { recursive: true, force: true });
await mkdir(path.dirname(targetDir), { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });
