#!/usr/bin/env node
/**
 * Preflight checks for running Remnic inside the public AMB harness.
 *
 * Defaults to the stricter public-BEAM-comparable setup. Set
 * REMNIC_AMB_RUN_PROFILE=codex-cli for current iteration runs that route
 * answer, judge, and Remnic internal calls through Codex CLI.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_BEAM_PROFILE = {
  name: "public-beam",
  description: "public-comparable BEAM",
  answerLlm: "gemini",
  answerModel: "gemini-3.1-pro-preview",
  judgeLlm: "gemini",
  judgeModel: "gemini-2.5-flash-lite",
  requireGeminiKey: true,
};
const CODEX_CLI_PROFILE = {
  name: "codex-cli",
  description: "Codex CLI BEAM iteration",
  answerLlm: "codex_cli",
  answerModel: "gpt-5.5",
  judgeLlm: "codex_cli",
  judgeModel: "gpt-5.5",
  codexReasoningEffort: "xhigh",
  internalProvider: "codex-cli",
  internalModel: "gpt-5.5",
  internalReasoningEffort: "xhigh",
  preserveRuntimeDefaults: "false",
  requireCodexCli: true,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const displayRepoRoot = process.cwd() === repoRoot ? process.cwd() : repoRoot;

function usage() {
  return [
    "Usage: node integrations/amb/check-remnic-run.mjs <agent-memory-benchmark-checkout>",
    "",
    "Checks the local setup for a BEAM run with Remnic.",
    "Set REMNIC_AMB_RUN_PROFILE=codex-cli for Codex CLI iteration runs.",
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
  const tempStoreDir = mkdtempSync(path.join(tmpdir(), "remnic-amb-preflight-"));
  let result;
  try {
    result = spawnSync(
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
          REMNIC_AMB_STORE_DIR: tempStoreDir,
          REMNIC_AMB_REPLAY_EXTRACTION_MODE: "skip",
          REMNIC_AMB_DRAIN_AFTER_INGEST: "false",
          REMNIC_AMB_SESSION_PREFIX: "beam",
        },
      },
    );
  } finally {
    rmSync(tempStoreDir, { recursive: true, force: true });
  }

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
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  if (expectedValues.includes(actual)) {
    return { ok: true, detail: `${name}=${actual}` };
  }
  const expectedLabel = expectedValues.join(" or ");
  return {
    ok: false,
    detail: actual
      ? `${name}=${actual}; expected ${expectedLabel}`
      : `${name} is not set; expected ${expectedLabel}`,
  };
}

function printCheck(status, name, detail) {
  const marker = status ? "PASS" : "FAIL";
  console.log(`[${marker}] ${name}${detail ? ` - ${detail}` : ""}`);
}

function normalizeRunProfile(value) {
  const normalized = String(value || "public-beam").trim().toLowerCase();
  if (["public", "public-beam", "public_comparable", "public-comparable"].includes(normalized)) {
    return PUBLIC_BEAM_PROFILE;
  }
  if (["codex", "codex-cli", "codex_cli"].includes(normalized)) {
    return CODEX_CLI_PROFILE;
  }
  return null;
}

function expectedEnvOverride(name, fallback) {
  const value = process.env[`REMNIC_AMB_EXPECTED_${name}`];
  return value && value.trim() ? value.trim() : fallback;
}

function internalLlmRoutingRequested() {
  return [
    "REMNIC_AMB_INTERNAL_PROVIDER",
    "REMNIC_AMB_INTERNAL_MODEL",
    "REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT",
    "REMNIC_AMB_EXPECTED_INTERNAL_PROVIDER",
    "REMNIC_AMB_EXPECTED_INTERNAL_MODEL",
    "REMNIC_AMB_EXPECTED_INTERNAL_CODEX_REASONING_EFFORT",
  ].some((name) => !!envValue(name));
}

function hasCodexCliLlmRegistryEntry(registry) {
  return /["']codex_cli["']\s*:\s*CodexCliLLM/.test(registry);
}

function expectedRunConfig(profile) {
  const checkInternalLlm = internalLlmRoutingRequested();
  return {
    ...profile,
    answerLlm: expectedEnvOverride("ANSWER_LLM", profile.answerLlm),
    answerModel: expectedEnvOverride("ANSWER_MODEL", profile.answerModel),
    judgeLlm: expectedEnvOverride("JUDGE_LLM", profile.judgeLlm),
    judgeModel: expectedEnvOverride("JUDGE_MODEL", profile.judgeModel),
    codexReasoningEffort: profile.codexReasoningEffort
      ? expectedEnvOverride("CODEX_REASONING_EFFORT", profile.codexReasoningEffort)
      : undefined,
    internalProvider: checkInternalLlm && profile.internalProvider
      ? expectedEnvOverride("INTERNAL_PROVIDER", profile.internalProvider)
      : undefined,
    internalModel: checkInternalLlm && profile.internalModel
      ? expectedEnvOverride("INTERNAL_MODEL", profile.internalModel)
      : undefined,
    internalReasoningEffort: checkInternalLlm && profile.internalReasoningEffort
      ? expectedEnvOverride("INTERNAL_CODEX_REASONING_EFFORT", profile.internalReasoningEffort)
      : undefined,
  };
}

function codexExecutable() {
  return envValue("OMB_CODEX_EXECUTABLE") || envValue("REMNIC_BENCH_CODEX_CLI_EXECUTABLE") || "codex";
}

function printRequiredExports(profile, remnicPath) {
  console.error(`Required ${profile.description} exports:`);
  console.error(`export REMNIC_REPO_PATH=${remnicPath}`);
  console.error(`export REMNIC_AMB_RUN_PROFILE=${profile.name}`);
  if (profile.requireGeminiKey) {
    console.error("export GEMINI_API_KEY=<key>  # or GOOGLE_API_KEY=<key>");
  }
  console.error(`export OMB_ANSWER_LLM=${profile.answerLlm}`);
  console.error(`export OMB_ANSWER_MODEL=${profile.answerModel}`);
  console.error(`export OMB_JUDGE_LLM=${profile.judgeLlm}`);
  console.error(`export OMB_JUDGE_MODEL=${profile.judgeModel}`);
  if (profile.codexReasoningEffort) {
    console.error(`export OMB_CODEX_REASONING_EFFORT=${profile.codexReasoningEffort}`);
  }
  if (profile.internalProvider) {
    console.error(`export REMNIC_AMB_INTERNAL_PROVIDER=${profile.internalProvider}`);
    console.error(`export REMNIC_AMB_INTERNAL_MODEL=${profile.internalModel}`);
    console.error(`export REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT=${profile.internalReasoningEffort}`);
  }
  if (profile.preserveRuntimeDefaults !== undefined) {
    console.error(`export REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS=${profile.preserveRuntimeDefaults}`);
  }
  console.error("export REMNIC_AMB_SESSION_PREFIX=beam");
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
const codexLlmPath = path.join(ambRoot, "src", "memory_bench", "llm", "codex_cli.py");
const llmRegistryPath = path.join(ambRoot, "src", "memory_bench", "llm", "__init__.py");
const modeRegistryPath = path.join(ambRoot, "src", "memory_bench", "modes", "__init__.py");
const profile = normalizeRunProfile(process.env.REMNIC_AMB_RUN_PROFILE);
const expectedProfile = profile ? expectedRunConfig(profile) : null;

add(
  "REMNIC_AMB_RUN_PROFILE is supported",
  expectedProfile !== null,
  process.env.REMNIC_AMB_RUN_PROFILE
    ? `REMNIC_AMB_RUN_PROFILE=${process.env.REMNIC_AMB_RUN_PROFILE}`
    : "default public-beam",
);

add("uv is available", commandExists("uv"), "required by the public AMB workflow");
add("pnpm is available", commandExists("pnpm"), "required to launch the Remnic bridge");
add("AMB checkout exists", existsSync(path.join(ambRoot, "pyproject.toml")), ambRoot);
add("AMB memory registry exists", existsSync(registryPath), registryPath);
add("AMB response mode registry exists", existsSync(modeRegistryPath), modeRegistryPath);
add("Remnic provider installed", existsSync(providerPath), providerPath);

if (existsSync(registryPath)) {
  const registry = readFileSync(registryPath, "utf8");
  add(
    "Remnic registered in AMB registry",
    registry.includes("RemnicMemoryProvider") && registry.includes('"remnic"'),
    registryPath,
  );
}

if (existsSync(modeRegistryPath)) {
  const registry = readFileSync(modeRegistryPath, "utf8");
  add(
    "AMB exposes current single-query mode",
    registry.includes('"rag"') && registry.includes("RAGMode"),
    "current AMB CLI uses --mode rag for the public single-query response flow",
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

if (expectedProfile?.requireGeminiKey) {
  add(
    "Gemini/Google key present",
    !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    "required by the official AMB CLI and BEAM judge",
  );
}

if (expectedProfile?.requireCodexCli) {
  const executable = codexExecutable();
  add(
    "Codex CLI is available",
    commandExists(executable),
    `${executable} is required for AMB codex_cli answer/judge runs`,
  );
  add("AMB LLM registry exists", existsSync(llmRegistryPath), llmRegistryPath);
  add("Codex CLI LLM provider installed", existsSync(codexLlmPath), codexLlmPath);
  if (existsSync(llmRegistryPath)) {
    const registry = readFileSync(llmRegistryPath, "utf8");
    add(
      "Codex CLI registered in AMB LLM registry",
      registry.includes("CodexCliLLM") && hasCodexCliLlmRegistryEntry(registry),
      llmRegistryPath,
    );
  }
}

if (expectedProfile) {
  const expectedEnv = [
    ["OMB_ANSWER_LLM", expectedProfile.answerLlm],
    ["OMB_ANSWER_MODEL", expectedProfile.answerModel],
    ["OMB_JUDGE_LLM", expectedProfile.judgeLlm],
    ["OMB_JUDGE_MODEL", expectedProfile.judgeModel],
    ["REMNIC_AMB_SESSION_PREFIX", "beam"],
  ];
  if (expectedProfile.codexReasoningEffort) {
    expectedEnv.push(["OMB_CODEX_REASONING_EFFORT", expectedProfile.codexReasoningEffort]);
  }
  if (expectedProfile.internalProvider) {
    expectedEnv.push(
      ["REMNIC_AMB_INTERNAL_PROVIDER", [expectedProfile.internalProvider, expectedProfile.internalProvider.replace("-", "_")]],
      ["REMNIC_AMB_INTERNAL_MODEL", expectedProfile.internalModel],
      ["REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT", expectedProfile.internalReasoningEffort],
    );
  }
  if (expectedProfile.preserveRuntimeDefaults !== undefined) {
    expectedEnv.push([
      "REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS",
      expectedProfile.preserveRuntimeDefaults,
    ]);
  }

  for (const [name, expected] of expectedEnv) {
    const check = requiredEnv(name, expected);
    add(name, check.ok, check.detail);
  }
}

for (const check of checks) {
  printCheck(check.ok, check.name, check.detail);
}

const failures = checks.filter((check) => !check.ok);
const label = expectedProfile?.description ?? "Remnic BEAM";
if (failures.length > 0) {
  console.error("");
  console.error(`Remnic AMB ${label} preflight failed (${failures.length} issue(s)).`);
  if (expectedProfile) {
    printRequiredExports(expectedProfile, displayRepoRoot);
  } else {
    console.error("Set REMNIC_AMB_RUN_PROFILE to public-beam or codex-cli.");
  }
  process.exit(1);
}

console.log("");
console.log(`Remnic AMB ${label} preflight passed.`);
