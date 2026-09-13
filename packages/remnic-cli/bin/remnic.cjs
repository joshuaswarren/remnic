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

function tsxShimNames(platform = process.platform) {
  return platform === "win32" ? ["tsx.cmd"] : ["tsx"];
}

function localTsxCandidates(binDir = cwd, platform = process.platform) {
  const names = tsxShimNames(platform);
  const roots = [
    resolve(binDir, "../node_modules/.bin"),
    resolve(binDir, "../../../node_modules/.bin"),
  ];
  const out = [];
  for (const root of roots) {
    for (const name of names) out.push(resolve(root, name));
  }
  return out;
}

function resolveLocalTsx(
  binDir = cwd,
  platform = process.platform,
  exists = existsSync,
) {
  return localTsxCandidates(binDir, platform).find((c) => exists(c));
}

function runCli() {
  if (existsSync(distEntry)) {
    execFileSync(process.execPath, [distEntry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, REMNIC_CLI_BIN: "1" },
    });
    return;
  }
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

if (require.main === module) {
  try {
    runCli();
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
}

module.exports = { tsxShimNames, localTsxCandidates, resolveLocalTsx };
