#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const skipBuild = process.argv.includes("--skip-build");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--keep" && arg !== "--skip-build");

if (unknownArgs.length > 0) {
  throw new Error(`unknown option(s): ${unknownArgs.join(", ")}`);
}

const packageDirs = [
  "packages/remnic-core",
  "packages/remnic-server",
  "packages/plugin-pi",
  "packages/coding-graph",
  "packages/bench",
  "packages/remnic-cli",
];

const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), "remnic-build-week-sandbox-"));
const packDir = path.join(sandboxRoot, "packs");
const prefixDir = path.join(sandboxRoot, "prefix");
const homeDir = path.join(sandboxRoot, "home");
const workDir = path.join(sandboxRoot, "work");
const npmCacheDir = path.join(sandboxRoot, "npm-cache");
const longMemResultsDir = path.join(workDir, "longmemeval-results");
const mcpResultsDir = path.join(workDir, "mcp-results");
const reportPath = path.join(workDir, "memcorrect-report-card.html");

for (const dir of [packDir, prefixDir, homeDir, workDir, npmCacheDir]) {
  mkdirSync(dir, { recursive: true });
}

const coldEnv = {
  ...process.env,
  HOME: homeDir,
  npm_config_cache: npmCacheDir,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  REMNIC_BENCH_GIT_SHA: process.env.REMNIC_BENCH_GIT_SHA ?? "packaged-sandbox",
};

for (const key of Object.keys(coldEnv)) {
  if (
    /(?:^|_)(?:API_KEY|AUTH_TOKEN|BEARER_TOKEN)$/i.test(key) ||
    /^(?:CLAUDE_CODE_OAUTH_TOKEN|OPENAI_ACCESS_TOKEN|CODEX_API_KEY)$/i.test(key)
  ) {
    delete coldEnv[key];
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function manifestArtifactIdentity(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    run: {
      id: manifest.run.id,
      ...(manifest.run.mode ? { mode: manifest.run.mode } : {}),
      selectedBenchmarks: manifest.run.selectedBenchmarks,
      runtimeProfiles: manifest.run.runtimeProfiles,
      selectedWorkItems: manifest.run.selectedWorkItems,
      ...(manifest.run.limit !== undefined ? { limit: manifest.run.limit } : {}),
      ...(manifest.run.seed !== undefined ? { seed: manifest.run.seed } : {}),
    },
    git: {
      commit: manifest.git.commit,
      shortCommit: manifest.git.shortCommit,
    },
    command: {
      argv: manifest.command.argv,
      envKeys: manifest.command.envKeys,
    },
    environment: {
      platform: manifest.environment.platform,
      arch: manifest.environment.arch,
      nodeVersion: manifest.environment.nodeVersion,
      ...(manifest.environment.packageManager
        ? { packageManager: manifest.environment.packageManager }
        : {}),
    },
    ...(manifest.qmd ? { qmd: manifest.qmd } : {}),
    configFiles: manifest.configFiles,
    datasets: manifest.datasets,
    results: manifest.results,
    ...(manifest.codexCredit ? { codexCredit: manifest.codexCredit } : {}),
  };
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function printCommand(command, args, cwd) {
  console.log(`\n$ (cd ${shellQuote(cwd)} && ${[command, ...args].map(shellQuote).join(" ")})`);
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  printCommand(command, args, cwd);
  const result = spawnSync(command, args, {
    cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    if (options.capture) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
  return result;
}

function packageMetadata(packageDir) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, packageDir, "package.json"), "utf8"));
  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    throw new Error(`${packageDir}/package.json is missing name or version`);
  }
  return packageJson;
}

function expectedTarball(packageDir) {
  const { name, version } = packageMetadata(packageDir);
  const filename = `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
  return path.join(packDir, filename);
}

function installTarballs(tarballs) {
  run("npm", ["install", "-g", "--prefix", prefixDir, ...tarballs], {
    cwd: workDir,
    env: coldEnv,
  });
}

function remnic(args, options = {}) {
  const executable = process.platform === "win32"
    ? path.join(prefixDir, "remnic.cmd")
    : path.join(prefixDir, "bin", "remnic");
  if (!existsSync(executable)) {
    throw new Error(`packed CLI did not install ${executable}`);
  }
  return run(executable, args, {
    cwd: workDir,
    env: coldEnv,
    ...options,
  });
}

function resultArtifact(resultsDir, benchmark) {
  const candidates = readdirSync(resultsDir)
    .filter((name) => name.endsWith(".json") && name !== "MANIFEST.json" && !name.startsWith("bench-status-"))
    .map((name) => path.join(resultsDir, name));
  if (candidates.length !== 1) {
    throw new Error(`expected one ${benchmark} result artifact, found ${candidates.length}`);
  }
  const parsed = JSON.parse(readFileSync(candidates[0], "utf8"));
  if (parsed?.meta?.benchmark !== benchmark) {
    throw new Error(`expected ${benchmark} artifact, found ${String(parsed?.meta?.benchmark)}`);
  }
  return { path: candidates[0], result: parsed };
}

function assertNonEmptyFile(filePath, label) {
  if (!existsSync(filePath) || statSync(filePath).size === 0) {
    throw new Error(`${label} was not written: ${filePath}`);
  }
}

try {
  console.log("Remnic Build Week packaged sandbox verification");
  console.log(`Repository: ${repoRoot}`);
  console.log(`Cold sandbox: ${sandboxRoot}`);

  if (!skipBuild) {
    for (const packageDir of packageDirs) {
      run("pnpm", ["--dir", path.join(repoRoot, packageDir), "run", "build"]);
    }
  }

  for (const packageDir of packageDirs) {
    run("pnpm", ["--dir", path.join(repoRoot, packageDir), "pack", "--pack-destination", packDir, "--json"], {
      capture: true,
    });
    assertNonEmptyFile(expectedTarball(packageDir), `${packageMetadata(packageDir).name} tarball`);
  }

  const tarballs = Object.fromEntries(
    packageDirs.map((packageDir) => [packageMetadata(packageDir).name, expectedTarball(packageDir)]),
  );

  // Prove the CLI stays à la carte before installing the optional bench package.
  installTarballs([
    tarballs["@remnic/core"],
    tarballs["@remnic/server"],
    tarballs["@remnic/plugin-pi"],
    tarballs["@remnic/cli"],
  ]);
  const missingBench = remnic(
    ["bench", "export", "missing-run", "--format", "html"],
    { capture: true, allowFailure: true },
  );
  const missingOutput = `${missingBench.stdout ?? ""}${missingBench.stderr ?? ""}`;
  process.stdout.write(missingOutput);
  if (missingBench.status === 0) {
    throw new Error("bench command unexpectedly succeeded without @remnic/bench");
  }
  if (!missingOutput.includes("npm install -g @remnic/bench") || missingOutput.includes("MODULE_NOT_FOUND")) {
    throw new Error("missing optional bench command did not print the clean install hint");
  }

  installTarballs([
    tarballs["@remnic/core"],
    tarballs["@remnic/coding-graph"],
    tarballs["@remnic/bench"],
  ]);

  // Preserve the issue's original zero-dataset smoke contract.
  remnic(["bench", "run", "--quick", "longmemeval", "--results-dir", longMemResultsDir]);
  resultArtifact(longMemResultsDir, "longmemeval");
  assertNonEmptyFile(path.join(longMemResultsDir, "MANIFEST.json"), "LongMemEval manifest");

  // Exercise the actual Build Week feature: a packaged MCP memory server.
  remnic([
    "bench",
    "run",
    "--quick",
    "memcorrect-v1",
    "--adapter",
    "mcp",
    "--mcp-demo",
    "--results-dir",
    mcpResultsDir,
  ]);
  const mcpArtifact = resultArtifact(mcpResultsDir, "memcorrect-v1");
  if (mcpArtifact.result?.config?.adapterMode !== "mcp") {
    throw new Error("MemCorrect packaged smoke did not record adapterMode=mcp");
  }
  if (mcpArtifact.result?.results?.tasks?.length !== 1) {
    throw new Error("MemCorrect packaged smoke did not persist its quick task");
  }
  if (mcpArtifact.result?.results?.aggregates?.uptake_at_next?.mean !== 1) {
    throw new Error("MemCorrect packaged demo did not accept the correction at the next turn");
  }
  if (mcpArtifact.result?.results?.aggregates?.non_resurrection?.mean !== 0) {
    throw new Error("MemCorrect packaged demo did not reproduce the expected stale-memory resurrection");
  }
  const manifestPath = path.join(mcpResultsDir, "MANIFEST.json");
  assertNonEmptyFile(manifestPath, "MemCorrect manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestResult = manifest?.results?.find(
    (entry) => entry?.resultId === mcpArtifact.result.meta.id,
  );
  if (!manifestResult || manifestResult.judge !== null) {
    throw new Error("MemCorrect packaged smoke did not prove a keyless, no-judge run");
  }
  const expectedResultPath = path.relative(mcpResultsDir, mcpArtifact.path).split(path.sep).join("/");
  const resultBytes = readFileSync(mcpArtifact.path);
  if (
    manifestResult.path !== expectedResultPath ||
    manifestResult.benchmark !== "memcorrect-v1" ||
    manifestResult.mode !== mcpArtifact.result.meta.mode ||
    manifestResult.sizeBytes !== resultBytes.length ||
    manifestResult.sha256 !== sha256(resultBytes)
  ) {
    throw new Error("MemCorrect manifest is not bound to the packaged result artifact");
  }
  const expectedArtifactHash = sha256(stableStringify(manifestArtifactIdentity(manifest)));
  if (manifest.artifactHash !== expectedArtifactHash) {
    throw new Error("MemCorrect manifest artifactHash does not match its canonical contents");
  }
  const manifestDataset = manifest?.datasets?.find(
    (entry) => entry?.benchmark === "memcorrect-v1",
  );
  if (
    !manifestDataset ||
    manifestDataset.status !== "not-provided" ||
    manifestDataset.fileCount !== 0
  ) {
    throw new Error("MemCorrect packaged smoke unexpectedly depended on dataset files");
  }

  const listed = remnic(["bench", "runs", "list", "--results-dir", mcpResultsDir, "--json"], {
    capture: true,
  });
  process.stdout.write(listed.stdout ?? "");
  const runs = JSON.parse(listed.stdout ?? "[]");
  const listedRun = runs.find((entry) => entry?.id === mcpArtifact.result.meta.id);
  if (!listedRun) {
    throw new Error(`runs list did not include ${mcpArtifact.result.meta.id}`);
  }

  remnic([
    "bench",
    "export",
    mcpArtifact.result.meta.id,
    "--format",
    "html",
    "--output",
    reportPath,
    "--results-dir",
    mcpResultsDir,
  ]);
  assertNonEmptyFile(reportPath, "HTML report card");
  const report = readFileSync(reportPath, "utf8");
  if (!report.includes("Correction ledger") || !report.includes("Provenance")) {
    throw new Error("HTML export is not the Build Week memory report card");
  }
  if (
    /\b(?:src|href|data)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(report) ||
    /@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//i.test(report) ||
    /url\(\s*["']?\s*(?:https?:)?\/\//i.test(report)
  ) {
    throw new Error("HTML report card is not self-contained");
  }
  if (!report.includes(manifest.artifactHash)) {
    throw new Error("HTML report card does not identify the verified manifest artifact hash");
  }

  const installed = run("npm", ["ls", "-g", "--prefix", prefixDir, "--depth=0"], {
    cwd: workDir,
    env: coldEnv,
    capture: true,
  });
  process.stdout.write(installed.stdout ?? "");

  console.log("\nPACKAGED_SANDBOX_OK");
  console.log(`RUN_ID=${mcpArtifact.result.meta.id}`);
  console.log(`RESULT=${mcpArtifact.path}`);
  console.log(`REPORT=${reportPath}`);
  console.log(`REPORT_BYTES=${statSync(reportPath).size}`);
} finally {
  if (keep) {
    console.log(`Sandbox preserved: ${sandboxRoot}`);
  } else {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}
