#!/usr/bin/env node
/**
 * remnic CLI binary entry point.
 *
 * Canonical wrapper for the built ESM CLI entry point.
 */
const { resolve } = require("node:path");
const { existsSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { constants: osConstants } = require("node:os");

const cwd = __dirname;
const distEntry = resolve(cwd, "../dist/index.js");
const srcEntry = resolve(cwd, "../src/index.ts");

const colorEnv = {};
if (!process.env.NO_COLOR && process.env.FORCE_COLOR === undefined) {
  colorEnv.FORCE_COLOR = "1";
}

function exitCodeForSignal(signal) {
  const signalNumber = osConstants.signals?.[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

try {
  if (existsSync(distEntry)) {
    execFileSync(process.execPath, [distEntry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, REMNIC_CLI_BIN: "1", ...colorEnv },
    });
  } else {
    const tsxCandidates = [
      resolve(cwd, "../node_modules/.bin/tsx"),
      resolve(cwd, "../../../node_modules/.bin/tsx"),
    ];
    const tsxCmd = tsxCandidates.find((c) => existsSync(c)) || "tsx";
    execFileSync(tsxCmd, [srcEntry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, REMNIC_CLI_BIN: "1", ...colorEnv },
    });
  }
} catch (err) {
  if (err.status != null) {
    process.exitCode = err.status;
  } else if (err.signal) {
    process.exitCode = exitCodeForSignal(err.signal);
    process.kill(process.pid, err.signal);
  } else {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exitCode = 1;
  }
}
