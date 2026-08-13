import { lstat, mkdir, open, rm, rmdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_HTTP_TIMEOUT_MS = 45_000;
const DEFAULT_MODEL_ROUTE_TIMEOUT_MS = 30_000;
const MODEL_HTTP_MARGIN_MS = 15_000;
export const DEMO_ENVIRONMENT_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "REMNIC_CONFIG_PATH",
  "ENGRAM_CONFIG_PATH",
  "REMNIC_MEMORY_DIR",
  "ENGRAM_MEMORY_DIR",
  "REMNIC_PORT",
  "ENGRAM_PORT",
  "REMNIC_HOST",
  "ENGRAM_HOST",
  "REMNIC_AUTH_TOKEN",
  "ENGRAM_AUTH_TOKEN",
  "REMNIC_ADMIN_CONSOLE_ENABLED",
  "ENGRAM_ADMIN_CONSOLE_ENABLED",
  "REMNIC_ADMIN_CONSOLE_PUBLIC_DIR",
  "ENGRAM_ADMIN_CONSOLE_PUBLIC_DIR",
  "REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN",
  "ENGRAM_ADMIN_CONSOLE_PREFILL_TOKEN",
  "REMNIC_READY_OVERRIDE",
  "REMNIC_READY_DEGRADED_AFTER_ATTEMPTS",
  "ENGRAM_READY_DEGRADED_AFTER_ATTEMPTS",
  "REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS",
  "ENGRAM_WRITE_RATE_LIMIT_MAX_REQUESTS",
  "REMNIC_WRITE_RATE_LIMIT_WINDOW_MS",
  "ENGRAM_WRITE_RATE_LIMIT_WINDOW_MS",
  "REMNIC_OAUTH_ENABLED",
  "REMNIC_OAUTH_ISSUER_URL",
  "REMNIC_OAUTH_CLIENT_ID",
  "REMNIC_OAUTH_CLIENT_SECRET",
  "REMNIC_OAUTH_TOKEN_AUTH_METHOD",
  "REMNIC_OAUTH_REDIRECT_URIS",
  "REMNIC_OAUTH_APPROVAL_TTL_SECONDS",
];
const DEMO_MODEL_CONFIG_KEYS = [
  "openaiApiKey",
  "openaiBaseUrl",
  "model",
  "modelSource",
  "gatewayAgentId",
  "taskModelChain",
  "gatewayConfig",
  "localLlmEnabled",
  "localLlmUrl",
  "localLlmModel",
  "localLlmApiKey",
  "localLlmHeaders",
  "localLlmAuthHeader",
  "localLlmFallback",
  "localLlmHomeDir",
  "localLmsCliPath",
  "localLmsBinDir",
  "localLlmTimeoutMs",
  "localLlmMaxContext",
  "localLlmRetry5xxCount",
  "localLlmRetryBackoffMs",
  "localLlm400TripThreshold",
  "localLlm400CooldownMs",
  "localLlmReasoningEffort",
  "localLlmThinkingThresholdChars",
  "localLlmDisableThinking",
];

export function isolateDemoRemnicConfig(sourceConfig, memoryDir, resolveConfigValue = (value) => value) {
  const modelConfig = {};
  for (const key of DEMO_MODEL_CONFIG_KEYS) {
    if (!Object.hasOwn(sourceConfig, key)) continue;
    const value = sourceConfig[key];
    modelConfig[key] =
      ["openaiApiKey", "openaiBaseUrl", "localLlmApiKey"].includes(key) && typeof value === "string"
        ? resolveConfigValue(value)
        : value;
  }
  if (!Object.hasOwn(modelConfig, "openaiApiKey")) modelConfig.openaiApiKey = false;
  return {
    ...modelConfig,
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    qmdDaemonEnabled: false,
    searchBackend: "noop",
    namespacesEnabled: false,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    supportPassport: { enabled: true },
  };
}

export function modelRequestTimeoutMs(routePlan, localLlmTimeoutMs) {
  const routeBudgetMs = routePlan.reduce(
    (total, route) => total + (route === "local" ? localLlmTimeoutMs : DEFAULT_MODEL_ROUTE_TIMEOUT_MS),
    0
  );
  return Math.max(DEFAULT_HTTP_TIMEOUT_MS, routeBudgetMs + MODEL_HTTP_MARGIN_MS);
}

export function isolateEnvironmentVariables(names) {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) Reflect.deleteProperty(process.env, name);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}

export function prepareDemoRuntime(sourceConfig, memoryDir, resolveConfigValue = (value) => value) {
  const remnicConfig = isolateDemoRemnicConfig(sourceConfig, memoryDir, resolveConfigValue);
  const restoreEnvironment = isolateEnvironmentVariables(DEMO_ENVIRONMENT_KEYS);
  return { remnicConfig, restoreEnvironment };
}

function listCreatedDirectories(outputDir, firstCreatedDirectory) {
  if (!firstCreatedDirectory) return [];
  const directories = [];
  let current = outputDir;
  for (;;) {
    directories.push(current);
    if (current === firstCreatedDirectory) return directories;
    const parent = path.dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}

async function removeCreatedDirectories(directories) {
  for (const directory of directories) {
    await rmdir(directory).catch(() => undefined);
  }
}

async function reserveOutput(outputDir) {
  let createdDirectories = [];
  let receiptHandle;
  const receiptPath = path.join(outputDir, "receipt.json");

  try {
    let firstCreatedDirectory;
    try {
      firstCreatedDirectory = await mkdir(outputDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const metadata = await lstat(outputDir);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("The output path must be a directory.");
      }
      throw error;
    }
    createdDirectories = listCreatedDirectories(outputDir, firstCreatedDirectory);
    const metadata = await lstat(outputDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("The output path must be a directory.");
    }
    try {
      receiptHandle = await open(receiptPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("The output directory already contains receipt.json.");
      }
      throw error;
    }
  } catch (error) {
    if (receiptHandle) await receiptHandle.close().catch(() => undefined);
    await removeCreatedDirectories(createdDirectories);
    throw error;
  }

  let retentionRequested = false;
  let closed = false;
  return {
    outputDir,
    receiptPath,
    async writeReceipt(content) {
      await receiptHandle.truncate(0);
      await receiptHandle.writeFile(content, { encoding: "utf8" });
      await receiptHandle.sync();
    },
    async retainReceipt() {
      await receiptHandle.close();
      closed = true;
      retentionRequested = true;
    },
    async release({ commitReceipt = false } = {}) {
      const retain = retentionRequested && commitReceipt;
      const cleanupError = await runCleanupSteps([
        async () => {
          if (!closed) await receiptHandle.close();
        },
        async () => {
          if (!retain) await rm(receiptPath, { force: true });
        },
        async () => {
          if (!retain) await removeCreatedDirectories(createdDirectories);
        },
      ]);
      if (cleanupError) throw cleanupError;
    },
  };
}

export async function runWithReservedOutput(outputDir, task, signalSource = process) {
  const reservation = await reserveOutput(outputDir);
  const controller = new AbortController();
  let interruptedBy;
  const onSignal = (signal) => {
    if (interruptedBy) return;
    interruptedBy = signal;
    controller.abort(Object.assign(new Error(`Live demo stopped by ${signal}.`), { signal }));
  };
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");
  signalSource.once("SIGINT", onInterrupt);
  signalSource.once("SIGTERM", onTerminate);
  let taskFailed = false;
  let taskError;
  let result;
  try {
    result = await task(reservation, controller.signal);
  } catch (error) {
    taskFailed = true;
    taskError = error;
  } finally {
    signalSource.off("SIGINT", onInterrupt);
    signalSource.off("SIGTERM", onTerminate);
  }
  if (interruptedBy && !taskFailed) {
    taskFailed = true;
    taskError = controller.signal.reason;
  }
  let cleanupError;
  try {
    await reservation.release({ commitReceipt: !taskFailed });
  } catch (error) {
    cleanupError = error;
  }
  if (taskFailed) throw taskError;
  if (cleanupError) throw cleanupError;
  return result;
}

export async function waitForResult(
  read,
  {
    timeoutMs = 10_000,
    pollIntervalMs = 25,
    now = Date.now,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}
) {
  const deadline = now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw lastError;
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}

export async function runCleanupSteps(steps) {
  let firstError;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

export async function readCleanCommitSha(repoRoot, runGit) {
  let status;
  let commit;
  try {
    status = await runGit(["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot });
    commit = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
  } catch {
    throw new Error("Git could not identify the demo commit.");
  }
  if (status.stdout.trim()) throw new Error("Commit all tracked changes before creating a live receipt.");
  const sha = commit.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Git returned an invalid commit SHA.");
  return sha;
}
