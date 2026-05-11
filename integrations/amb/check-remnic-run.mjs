#!/usr/bin/env node
/**
 * Preflight checks for running Remnic inside the public AMB harness.
 *
 * This intentionally checks the stricter public-BEAM-comparable setup, not
 * merely whether a diagnostic local run can start.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_ANSWER_LLM = "gemini";
const REQUIRED_ANSWER_MODEL = "gemini-3.1-pro-preview";
const REQUIRED_JUDGE_LLM = "gemini";
const REQUIRED_JUDGE_MODEL = "gemini-2.5-flash-lite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const displayRepoRoot = process.cwd() === repoRoot ? process.cwd() : repoRoot;

function usage() {
  return [
    "Usage: node integrations/amb/check-remnic-run.mjs <agent-memory-benchmark-checkout>",
    "",
    "Checks the local setup for a public-comparable BEAM run with Remnic.",
  ].join("\n");
}

function commandExists(command) {
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function checkBridgeStarts(bridgePath, remnicRepoPath) {
  const result = spawnSync(
    "pnpm",
    ["exec", "tsx", bridgePath],
    {
      cwd: remnicRepoPath,
      encoding: "utf8",
      input: `${JSON.stringify({ id: 1, method: "reset", params: {} })}\n`,
      timeout: 20_000,
      env: {
        ...process.env,
        REMNIC_REPO_PATH: remnicRepoPath,
        REMNIC_AMB_REPLAY_EXTRACTION_MODE: "skip",
        REMNIC_AMB_DRAIN_AFTER_INGEST: "false",
        REMNIC_AMB_SESSION_PREFIX: "beam",
      },
    },
  );

  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
    };
  }

  const line = result.stdout.trim().split(/\r?\n/).find((entry) => entry.trim());
  if (!line) {
    return { ok: false, detail: "bridge produced no JSONL response" };
  }

  try {
    const response = JSON.parse(line);
    return response.ok === true
      ? { ok: true, detail: "bridge reset request returned ok=true" }
      : { ok: false, detail: response.error || "bridge returned ok=false" };
  } catch (error) {
    return { ok: false, detail: `invalid bridge JSON response: ${error.message}` };
  }
}

function envValue(name) {
  return process.env[name] || "";
}

function requiredEnv(name, expected) {
  const actual = envValue(name);
  if (actual === expected) {
    return { ok: true, detail: `${name}=${actual}` };
  }
  return {
    ok: false,
    detail: actual
      ? `${name}=${actual}; expected ${expected}`
      : `${name} is not set; expected ${expected}`,
  };
}

function printCheck(status, name, detail) {
  const marker = status ? "PASS" : "FAIL";
  console.log(`[${marker}] ${name}${detail ? ` - ${detail}` : ""}`);
}

const ambCheckout = process.argv[2];
if (!ambCheckout || ambCheckout === "--help" || ambCheckout === "-h") {
  console.error(usage());
  process.exit(ambCheckout ? 0 : 2);
}

const checks = [];
function add(name, ok, detail = "") {
  checks.push({ name, ok, detail });
}

const ambRoot = path.resolve(ambCheckout);
const remnicRepoPath = path.resolve(process.env.REMNIC_REPO_PATH || repoRoot);
const bridgePath = path.join(remnicRepoPath, "integrations", "amb", "remnic-bridge.mjs");
const providerPath = path.join(ambRoot, "src", "memory_bench", "memory", "remnic.py");
const registryPath = path.join(ambRoot, "src", "memory_bench", "memory", "__init__.py");

add("uv is available", commandExists("uv"), "required by the public AMB workflow");
add("pnpm is available", commandExists("pnpm"), "required to launch the Remnic bridge");
add("AMB checkout exists", existsSync(path.join(ambRoot, "pyproject.toml")), ambRoot);
add("AMB memory registry exists", existsSync(registryPath), registryPath);
add("Remnic provider installed", existsSync(providerPath), providerPath);

if (existsSync(registryPath)) {
  const registry = readFileSync(registryPath, "utf8");
  add(
    "Remnic registered in AMB registry",
    registry.includes("RemnicMemoryProvider") && registry.includes('"remnic"'),
    registryPath,
  );
}

add("REMNIC_REPO_PATH points at this checkout", (() => {
  if (!process.env.REMNIC_REPO_PATH) return false;
  try {
    return realpathSync(process.env.REMNIC_REPO_PATH) === realpathSync(repoRoot);
  } catch {
    return false;
  }
})(), `expected export REMNIC_REPO_PATH=${displayRepoRoot}`);
add("Remnic bridge exists", existsSync(bridgePath), bridgePath);

if (existsSync(bridgePath) && commandExists("pnpm")) {
  const bridge = checkBridgeStarts(bridgePath, remnicRepoPath);
  add("Remnic bridge starts", bridge.ok, bridge.detail);
}

add(
  "Gemini/Google key present",
  !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  "required by the official AMB CLI and BEAM judge",
);

for (const [name, expected] of [
  ["OMB_ANSWER_LLM", REQUIRED_ANSWER_LLM],
  ["OMB_ANSWER_MODEL", REQUIRED_ANSWER_MODEL],
  ["OMB_JUDGE_LLM", REQUIRED_JUDGE_LLM],
  ["OMB_JUDGE_MODEL", REQUIRED_JUDGE_MODEL],
  ["REMNIC_AMB_SESSION_PREFIX", "beam"],
]) {
  const check = requiredEnv(name, expected);
  add(name, check.ok, check.detail);
}

for (const check of checks) {
  printCheck(check.ok, check.name, check.detail);
}

const failures = checks.filter((check) => !check.ok);
if (failures.length > 0) {
  console.error("");
  console.error(`Remnic AMB public-BEAM preflight failed (${failures.length} issue(s)).`);
  console.error("Required comparable BEAM exports:");
  console.error(`export REMNIC_REPO_PATH=${displayRepoRoot}`);
  console.error("export GEMINI_API_KEY=<key>  # or GOOGLE_API_KEY=<key>");
  console.error(`export OMB_ANSWER_LLM=${REQUIRED_ANSWER_LLM}`);
  console.error(`export OMB_ANSWER_MODEL=${REQUIRED_ANSWER_MODEL}`);
  console.error(`export OMB_JUDGE_LLM=${REQUIRED_JUDGE_LLM}`);
  console.error(`export OMB_JUDGE_MODEL=${REQUIRED_JUDGE_MODEL}`);
  console.error("export REMNIC_AMB_SESSION_PREFIX=beam");
  process.exit(1);
}

console.log("");
console.log("Remnic AMB public-BEAM preflight passed.");
