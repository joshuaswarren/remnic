#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = "packages/remnic-cli/src/index.ts";
const MODES = ["smoke", "pilot", "main", "resume", "utility", "analyze", "replay"];

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

function validatedStage(raw) {
  const stage = raw?.trim() || "base";
  if (stage !== "base" && stage !== "adaptive-r1" && stage !== "benign") {
    throw new Error("H5_STAGE must be base, adaptive-r1, or benign");
  }
  return stage;
}

export function buildH5SmokeCommand(mode, env = process.env) {
  if (!MODES.includes(mode)) {
    throw new Error(`usage: node scripts/h5-run.mjs ${MODES.join("|")}`);
  }
  const runDir = path.resolve(required(env, "H5_RUN_DIR"));
  if (insideRepo(runDir)) throw new Error("H5_RUN_DIR must be outside the checkout");
  if (mode === "analyze" || mode === "replay") {
    return {
      runDir,
      tokenName: null,
      args: [
        "scripts/pnpm.mjs",
        "exec",
        "tsx",
        CLI,
        "bench",
        "security",
        mode === "analyze" ? "injection-suite-analyze" : "injection-suite-replay",
        "--run",
        runDir,
      ],
    };
  }

  const baseUrl = required(env, "H5_BASE_URL");
  const model = required(env, "H5_MODEL");
  const profile = required(env, "H5_MODEL_PROFILE");
  const tokenName = credentialName(baseUrl);
  required(env, tokenName);
  const timeout = env.H5_REQUEST_TIMEOUT_MS?.trim() || "300000";
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1) {
    throw new Error("H5_REQUEST_TIMEOUT_MS must be a positive integer");
  }
  const stage = validatedStage(env.H5_STAGE);
  const runKind = mode === "smoke"
    ? "dev"
    : mode === "pilot"
      ? "pilot"
      : mode === "main"
        ? "main"
        : env.H5_RUN_KIND?.trim() || "dev";
  if (runKind !== "dev" && runKind !== "pilot" && runKind !== "main") {
    throw new Error("H5_RUN_KIND must be dev, pilot, or main");
  }
  const variantCount = env.H5_VARIANTS_PER_FAMILY?.trim() || (
    runKind === "main" ? stage === "benign" ? "10" : "100" : runKind === "pilot" ? "25" : "1"
  );
  if (!/^\d+$/.test(variantCount) || Number(variantCount) < 1) {
    throw new Error("H5_VARIANTS_PER_FAMILY must be a positive integer");
  }
  const frozenProfileArgs = [];
  if (runKind !== "dev") {
    frozenProfileArgs.push(
      "--model-digest",
      required(env, "H5_MODEL_DIGEST"),
      "--model-context-tokens",
      required(env, "H5_MODEL_CONTEXT_TOKENS"),
    );
  }
  const subcommand = mode === "utility" ? "injection-suite-utility" : "injection-suite";
  const args = [
    "scripts/pnpm.mjs",
    "exec",
    "tsx",
    CLI,
    "bench",
    "security",
    subcommand,
    "--seeds",
    "1",
    "--variants-per-family",
    variantCount,
    "--stage",
    stage,
    "--run-kind",
    runKind,
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
    ...frozenProfileArgs,
  ];
  if (mode === "smoke") args.push("--limit", "4");
  if (mode === "utility" && env.H5_LOCOMO_DATASET_DIR?.trim()) {
    args.push("--dataset-dir", env.H5_LOCOMO_DATASET_DIR.trim());
  }
  args.push(mode === "resume" ? "--run" : "--out", runDir);
  return { runDir, tokenName, args };
}

async function main() {
  const mode = process.argv[2];
  const command = buildH5SmokeCommand(mode);
  if (mode === "resume" || mode === "analyze" || mode === "replay") {
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
      console.error(`H5 ${mode} terminated by ${signal}`);
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
