#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = "packages/remnic-cli/src/index.ts";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function credentialName(baseUrl) {
  const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "integrate.api.nvidia.com") return "NVIDIA_API_KEY";
  if (host === "router.huggingface.co") return "HF_TOKEN";
  return "REMNIC_OPENAI_COMPAT_API_KEY";
}

function insideRepo(candidate) {
  const relative = path.relative(REPO_ROOT, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function buildH5SmokeCommand(mode, env = process.env) {
  if (mode !== "smoke" && mode !== "resume") {
    throw new Error("usage: node scripts/h5-run.mjs smoke|resume");
  }
  const baseUrl = required(env, "H5_BASE_URL");
  const model = required(env, "H5_MODEL");
  const profile = required(env, "H5_MODEL_PROFILE");
  const runDir = path.resolve(required(env, "H5_RUN_DIR"));
  const tokenName = credentialName(baseUrl);
  required(env, tokenName);
  if (insideRepo(runDir)) throw new Error("H5_RUN_DIR must be outside the checkout");

  const timeout = env.H5_REQUEST_TIMEOUT_MS?.trim() || "300000";
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1) {
    throw new Error("H5_REQUEST_TIMEOUT_MS must be a positive integer");
  }

  return {
    runDir,
    tokenName,
    args: [
      "scripts/pnpm.mjs",
      "exec",
      "tsx",
      CLI,
      "bench",
      "security",
      "injection-suite",
      "--seeds",
      "1",
      "--variants-per-family",
      "1",
      "--limit",
      "4",
      "--executor",
      "openai-compat",
      "--base-url",
      baseUrl,
      "--model",
      model,
      "--model-profile",
      profile,
      "--request-timeout-ms",
      timeout,
      mode === "resume" ? "--run" : "--out",
      runDir,
    ],
  };
}

async function main() {
  const mode = process.argv[2];
  const command = buildH5SmokeCommand(mode);
  if (mode === "resume") {
    await access(path.join(command.runDir, "run.json"));
  }
  const sourceCondition = "--conditions=remnic-source";
  const nodeOptions = process.env.NODE_OPTIONS?.includes(sourceCondition)
    ? process.env.NODE_OPTIONS
    : `${process.env.NODE_OPTIONS ?? ""} ${sourceCondition}`.trim();
  const child = spawn(process.execPath, command.args, {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`H5 smoke terminated by ${signal}`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
