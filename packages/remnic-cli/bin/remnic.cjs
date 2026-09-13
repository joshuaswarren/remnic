#!/usr/bin/env node
/**
 * remnic CLI binary entry point.
 *
 * Canonical wrapper for the built ESM CLI entry point.
 */
const { dirname, resolve } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { constants: osConstants } = require("node:os");

const cwd = __dirname;
const distEntry = resolve(cwd, "../dist/index.js");
const srcEntry = resolve(cwd, "../src/index.ts");

function exitCodeForSignal(signal) {
  const signalNumber = osConstants.signals?.[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function tsxPackageJsonCandidates(binDir = cwd) {
  return [
    resolve(binDir, "../node_modules/tsx/package.json"),
    resolve(binDir, "../../../node_modules/tsx/package.json"),
  ];
}

function resolveLocalTsx(
  binDir = cwd,
  exists = existsSync,
  readFile = readFileSync,
) {
  for (const pkgPath of tsxPackageJsonCandidates(binDir)) {
    if (!exists(pkgPath)) continue;
    let bin;
    try {
      const pkg = JSON.parse(readFile(pkgPath, "utf8"));
      bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin && pkg.bin.tsx;
    } catch {
      continue;
    }
    if (typeof bin !== "string" || bin.length === 0) continue;
    const cli = resolve(dirname(pkgPath), bin);
    if (exists(cli)) return cli;
  }
  return undefined;
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
  const tsxCli = hasSrcEntry ? resolveLocalTsx() : undefined;
  if (!tsxCli) {
    if (hasSrcEntry) {
      throw new Error(
        `tsx runtime is missing for source CLI entrypoint: ${srcEntry}. Install dependencies or rebuild @remnic/cli.`,
      );
    }
    throw new Error(
      `built CLI entrypoint is missing: ${distEntry}. Rebuild or reinstall @remnic/cli.`,
    );
  }
  execFileSync(process.execPath, [tsxCli, srcEntry, ...process.argv.slice(2)], {
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

module.exports = { tsxPackageJsonCandidates, resolveLocalTsx };
