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

function exitCodeForSignal(signal) {
  const signalNumber = osConstants.signals?.[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function resolveLocalTsx() {
  const tsxCandidates = [
    resolve(cwd, "../node_modules/.bin/tsx"),
    resolve(cwd, "../../../node_modules/.bin/tsx"),
  ];
  return tsxCandidates.find((c) => existsSync(c));
}

try {
  if (existsSync(distEntry)) {
    execFileSync(process.execPath, [distEntry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, REMNIC_CLI_BIN: "1" },
    });
  } else {
    const hasSrcEntry = existsSync(srcEntry);
    const tsxCmd = hasSrcEntry ? resolveLocalTsx() : undefined;
    if (!tsxCmd) {
      if (hasSrcEntry) {
        throw new Error(
          `tsx runtime is missing for source CLI entrypoint: ${srcEntry}. Install dependencies or rebuild @remnic/cli.`,
        );
      }
      throw new Error(
        `built CLI entrypoint is missing: ${distEntry}. Rebuild or reinstall @remnic/cli.`,
      );
    }
    execFileSync(tsxCmd, [srcEntry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, REMNIC_CLI_BIN: "1" },
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
