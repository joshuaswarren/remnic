import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CodexCliProviderConfig,
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  LlmProvider,
  TokenUsage,
} from "./types.js";

interface CodexCliRunRequest {
  executable: string;
  args: string[];
  input: string;
  outputPath: string;
  workspacePath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}

interface CodexCliRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputText: string;
}

interface CodexCliProviderDeps {
  runCodexCli?: (request: CodexCliRunRequest) => Promise<CodexCliRunResult>;
  runCodexVersion?: (
    executable: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ status: number | null; stderr: string }>;
}

interface CodexCliDiagnosticRecord {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  provider: "codex-cli";
  model: string;
  reasoningEffort: string;
  executable: string;
  timeoutMs?: number;
  workspaceBasename: string;
  outputBasename: string;
  prompt: {
    sha256: string;
    chars: number;
    lines: number;
    systemPromptChars?: number;
    userPromptChars?: number;
  };
  command: {
    args: string[];
  };
  result?: {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdoutChars: number;
    stderrChars: number;
    outputChars: number;
    stdoutTail: string;
    stderrTail: string;
  };
  error?: string;
  fullPrompt?: string;
}

interface CodexCliDiagnosticHandle {
  path: string;
  record: CodexCliDiagnosticRecord;
}

const DEFAULT_REASONING_EFFORT = "xhigh";
const CODEX_CLI_STDIO_LIMIT = 64_000;
const CODEX_CLI_PARENT_SIGNALS: NodeJS.Signals[] = [
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
];
const CODEX_CLI_FORCED_PARENT_EXIT_MS = 1_000;
const CODEX_CLI_DIAGNOSTICS_DIR_ENV = "REMNIC_BENCH_CODEX_CLI_DIAGNOSTICS_DIR";
const CODEX_CLI_DIAGNOSTICS_MODE_ENV = "REMNIC_BENCH_CODEX_CLI_DIAGNOSTICS_MODE";

const activeCodexCliChildPids = new Set<number>();
let codexCliParentCleanupInstalled = false;

class CodexCliProvider implements LlmProvider {
  readonly provider = "codex-cli" as const;
  readonly id: string;
  readonly name: string;

  private readonly config: CodexCliProviderConfig;
  private readonly runCodexCli: (request: CodexCliRunRequest) => Promise<CodexCliRunResult>;
  private readonly runCodexVersion: (
    executable: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ status: number | null; stderr: string }>;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: CodexCliProviderConfig, deps: CodexCliProviderDeps = {}) {
    this.config = config;
    this.runCodexCli = deps.runCodexCli ?? runCodexCliCommand;
    this.runCodexVersion = deps.runCodexVersion ?? runCodexVersionCommand;
    this.id = `codex-cli:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-cli-"));
    const workspacePath = path.join(tempDir, "workspace");
    const outputPath = path.join(tempDir, "last-message.txt");
    let diagnostics: CodexCliDiagnosticHandle | undefined;

    try {
      await mkdir(workspacePath, { recursive: true });
      const request = this.buildRunRequest(prompt, opts, workspacePath, outputPath);
      diagnostics = await startCodexCliDiagnostics({
        config: this.config,
        request,
        reasoningEffort: this.config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      });
      const result = await this.runCodexCli(request);
      await finishCodexCliDiagnostics(diagnostics, startedAt, { result });
      if (result.status !== 0) {
        const exitLabel = result.signal
          ? `signal ${result.signal}`
          : `exit ${result.status ?? "unknown"}`;
        throw new Error(
          `Codex CLI completion failed (${exitLabel}): ${summarizeProcessOutput(result.stderr, result.stdout)}`,
        );
      }

      const text = result.outputText.trim();
      if (text.length === 0) {
        throw new Error(
          `Codex CLI completion returned no final message: ${summarizeProcessOutput(result.stderr, result.stdout)}`,
        );
      }
      const tokens = parseCodexTokenUsage(
        `${result.stderr}\n${result.stdout}`,
        text,
      );
      this.recordUsage(tokens.input, tokens.output);

      return {
        text,
        tokens,
        latencyMs: Math.round(performance.now() - startedAt),
        model: this.config.model,
      };
    } catch (error) {
      await finishCodexCliDiagnostics(diagnostics, startedAt, { error });
      throw error;
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }

  async discover(): Promise<DiscoveredModel[]> {
    const version = await this.runCodexVersion(
      this.config.executable ?? "codex",
      buildIsolatedCodexEnv(),
    );
    if (version.status !== 0) {
      throw new Error(
        `Codex CLI discovery failed: ${version.stderr.trim() || `exit ${version.status ?? "unknown"}`}`,
      );
    }

    return [
      {
        id: this.config.model,
        name: `${this.config.model} (Codex CLI)`,
        contextLength: 0,
        capabilities: ["completion"],
      },
    ];
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  resetUsage(): void {
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }

  private recordUsage(inputTokens: number, outputTokens: number): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + inputTokens,
      outputTokens: this.usage.outputTokens + outputTokens,
      totalTokens: this.usage.totalTokens + inputTokens + outputTokens,
    };
  }

  private buildRunRequest(
    prompt: string,
    opts: CompletionOpts,
    workspacePath: string,
    outputPath: string,
  ): CodexCliRunRequest {
    const reasoningEffort =
      this.config.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    const args = [
      "exec",
      "--model",
      this.config.model,
      "--config",
      `model_reasoning_effort=${tomlString(reasoningEffort)}`,
      "--config",
      'approval_policy="never"',
      "--disable",
      "codex_hooks",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--cd",
      workspacePath,
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      "-",
    ];

    return {
      executable: this.config.executable ?? "codex",
      args,
      input: buildCodexCompletionPrompt(prompt, opts.systemPrompt),
      outputPath,
      workspacePath,
      timeoutMs: this.config.retryOptions?.timeoutMs,
      signal: opts.signal,
      env: buildIsolatedCodexEnv(this.config.apiKey),
    };
  }
}

function runCodexVersionCommand(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stderr });
    });
  });
}

function buildCodexCompletionPrompt(
  userPrompt: string,
  systemPrompt: string | undefined,
): string {
  const payload = {
    systemPrompt: systemPrompt ?? "",
    userPrompt,
  };

  return [
    "You are acting as a benchmark LLM completion endpoint, not as a coding agent.",
    "Use only the explicit JSON payload below.",
    "Treat systemPrompt as the higher-priority instruction text and userPrompt as the request to answer.",
    "Do not inspect files, run commands, browse, use tools, or use persisted memory.",
    "Return only the final answer text. If the request asks for JSON, return raw JSON only.",
    "",
    "BENCHMARK_REQUEST_JSON:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function buildIsolatedCodexEnv(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("REMNIC_") ||
      key.startsWith("ENGRAM_") ||
      key.startsWith("OPENCLAW_") ||
      key === "QMD_CONFIG_DIR"
    ) {
      delete env[key];
    }
  }
  if (apiKey) {
    env.OPENAI_API_KEY = apiKey;
  }
  return env;
}

async function startCodexCliDiagnostics(args: {
  config: CodexCliProviderConfig;
  request: CodexCliRunRequest;
  reasoningEffort: string;
}): Promise<CodexCliDiagnosticHandle | undefined> {
  const diagnosticsDir = resolveCodexCliDiagnosticsDir(args.config);
  if (!diagnosticsDir) {
    return undefined;
  }

  try {
    await mkdir(diagnosticsDir, { recursive: true });
    const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
    const promptStats = inspectCodexCompletionPrompt(args.request.input);
    const mode = resolveCodexCliDiagnosticsMode(args.config);
    const record: CodexCliDiagnosticRecord = {
      schemaVersion: 1,
      id,
      startedAt: new Date().toISOString(),
      provider: "codex-cli",
      model: args.config.model,
      reasoningEffort: args.reasoningEffort,
      executable: path.basename(args.request.executable),
      ...(args.request.timeoutMs ? { timeoutMs: args.request.timeoutMs } : {}),
      workspaceBasename: path.basename(args.request.workspacePath),
      outputBasename: path.basename(args.request.outputPath),
      prompt: promptStats,
      command: {
        args: redactCodexCliArgs(args.request.args),
      },
      ...(mode === "full" ? { fullPrompt: args.request.input } : {}),
    };
    const filePath = path.join(diagnosticsDir, `${id}.json`);
    await writeCodexCliDiagnosticRecord(filePath, record);
    return { path: filePath, record };
  } catch {
    return undefined;
  }
}

async function finishCodexCliDiagnostics(
  handle: CodexCliDiagnosticHandle | undefined,
  startedAt: number,
  outcome: { result?: CodexCliRunResult; error?: unknown },
): Promise<void> {
  if (!handle) {
    return;
  }

  const result = outcome.result;
  const error = outcome.error;
  const record: CodexCliDiagnosticRecord = {
    ...handle.record,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
    ...(result
      ? {
          result: {
            status: result.status,
            signal: result.signal,
            stdoutChars: result.stdout.length,
            stderrChars: result.stderr.length,
            outputChars: result.outputText.length,
            stdoutTail: result.stdout.slice(-2_000),
            stderrTail: result.stderr.slice(-2_000),
          },
        }
      : {}),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  };
  handle.record = record;

  try {
    await writeCodexCliDiagnosticRecord(handle.path, record);
  } catch {
    // Diagnostics must never change benchmark behavior.
  }
}

async function writeCodexCliDiagnosticRecord(
  filePath: string,
  record: CodexCliDiagnosticRecord,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function resolveCodexCliDiagnosticsDir(
  config: CodexCliProviderConfig,
): string | undefined {
  const dir = config.diagnosticsDir ?? process.env[CODEX_CLI_DIAGNOSTICS_DIR_ENV];
  const trimmed = typeof dir === "string" ? dir.trim() : "";
  return trimmed.length > 0
    ? path.resolve(expandHomeRelativePath(trimmed))
    : undefined;
}

function expandHomeRelativePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveCodexCliDiagnosticsMode(
  config: CodexCliProviderConfig,
): "metadata" | "full" {
  const raw = config.diagnosticsMode ?? process.env[CODEX_CLI_DIAGNOSTICS_MODE_ENV];
  return raw === "full" ? "full" : "metadata";
}

function inspectCodexCompletionPrompt(
  prompt: string,
): CodexCliDiagnosticRecord["prompt"] {
  const stats: CodexCliDiagnosticRecord["prompt"] = {
    sha256: createHash("sha256").update(prompt).digest("hex"),
    chars: prompt.length,
    lines: prompt.length === 0 ? 0 : prompt.split("\n").length,
  };
  const marker = "BENCHMARK_REQUEST_JSON:";
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex < 0) {
    return stats;
  }

  try {
    const parsed = JSON.parse(prompt.slice(markerIndex + marker.length).trim()) as {
      systemPrompt?: unknown;
      userPrompt?: unknown;
    };
    return {
      ...stats,
      ...(typeof parsed.systemPrompt === "string"
        ? { systemPromptChars: parsed.systemPrompt.length }
        : {}),
      ...(typeof parsed.userPrompt === "string"
        ? { userPromptChars: parsed.userPrompt.length }
        : {}),
    };
  } catch {
    return stats;
  }
}

function redactCodexCliArgs(args: string[]): string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    const value = redacted[index];
    const lowered = value.toLowerCase();
    if (value === "--cd" || value === "--output-last-message") {
      if (index + 1 < redacted.length) {
        redacted[index + 1] = "[redacted]";
      }
      continue;
    }
    if (
      lowered.includes("api_key") ||
      lowered.includes("apikey") ||
      lowered.includes("token") ||
      lowered.includes("secret")
    ) {
      redacted[index] = "[redacted]";
    }
  }
  return redacted;
}

function runCodexCliCommand(request: CodexCliRunRequest): Promise<CodexCliRunResult> {
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      resolve({
        status: 124,
        signal: null,
        stdout: "",
        stderr: "Codex CLI aborted before start.",
        outputText: "",
      });
      return;
    }

    const child = spawn(request.executable, request.args, {
      cwd: request.workspacePath,
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    if (child.pid) {
      registerActiveCodexCliChild(child.pid);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killTimeout: NodeJS.Timeout | undefined;
    const clearKillTimeout = (): void => {
      if (killTimeout) {
        clearTimeout(killTimeout);
        killTimeout = undefined;
      }
    };
    const terminateChild = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to killing the direct child below.
        }
      }
      child.kill(signal);
    };
    const scheduleForcedKill = (): void => {
      clearKillTimeout();
      killTimeout = setTimeout(() => {
        terminateChild("SIGKILL");
      }, 1_000);
      killTimeout.unref();
    };
    const onAbort = (): void => {
      if (aborted) {
        return;
      }
      aborted = true;
      stderr = appendBounded(stderr, "\nCodex CLI aborted by benchmark timeout.");
      terminateChild("SIGTERM");
      scheduleForcedKill();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
    }
    const timeout = request.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminateChild("SIGTERM");
          scheduleForcedKill();
        }, request.timeoutMs)
      : undefined;
    timeout?.unref();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      stderr = appendBounded(
        stderr,
        `\nCodex CLI stdin error: ${error.code ?? error.message}`,
      );
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      clearKillTimeout();
      if (child.pid) {
        unregisterActiveCodexCliChild(child.pid);
      }
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", async (status, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      clearKillTimeout();
      if (child.pid) {
        unregisterActiveCodexCliChild(child.pid);
      }
      request.signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        resolve({
          status: status ?? 124,
          signal,
          stdout,
          stderr: appendBounded(
            stderr,
            `\nCodex CLI timed out after ${request.timeoutMs}ms.`,
          ),
          outputText: "",
        });
        return;
      }
      if (aborted) {
        resolve({
          status: status ?? 124,
          signal,
          stdout,
          stderr,
          outputText: "",
        });
        return;
      }

      try {
        const outputText = await readCodexOutput(request.outputPath, stdout);
        resolve({ status, signal, stdout, stderr, outputText });
      } catch (error) {
        reject(error);
      }
    });
    try {
      child.stdin?.end(request.input);
    } catch (error) {
      stderr = appendBounded(
        stderr,
        `\nCodex CLI stdin error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function registerActiveCodexCliChild(pid: number): void {
  installCodexCliParentCleanup();
  activeCodexCliChildPids.add(pid);
}

function unregisterActiveCodexCliChild(pid: number): void {
  activeCodexCliChildPids.delete(pid);
}

function installCodexCliParentCleanup(): void {
  if (codexCliParentCleanupInstalled) {
    return;
  }
  codexCliParentCleanupInstalled = true;

  process.once("exit", () => {
    terminateActiveCodexCliChildren("SIGTERM");
  });

  for (const signal of CODEX_CLI_PARENT_SIGNALS) {
    process.once(signal, () => {
      const activeChildren = activeCodexCliChildPids.size;
      terminateActiveCodexCliChildren(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
      process.exitCode = signalExitCode(signal);

      setTimeout(
        () => {
          terminateActiveCodexCliChildren("SIGKILL");
          process.exit(signalExitCode(signal));
        },
        activeChildren > 0 ? CODEX_CLI_FORCED_PARENT_EXIT_MS : 0,
      );
    });
  }
}

function terminateActiveCodexCliChildren(signal: NodeJS.Signals): void {
  for (const pid of activeCodexCliChildPids) {
    terminateCodexCliChildPid(pid, signal);
  }
}

function terminateCodexCliChildPid(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // The child may already have exited.
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

async function readCodexOutput(
  outputPath: string,
  stdout: string,
): Promise<string> {
  try {
    return await readFile(outputPath, "utf8");
  } catch {
    return stdout;
  }
}

function appendBounded(existing: string, next: string): string {
  const combined = existing + next;
  if (combined.length <= CODEX_CLI_STDIO_LIMIT) {
    return combined;
  }
  return combined.slice(combined.length - CODEX_CLI_STDIO_LIMIT);
}

function summarizeProcessOutput(stderr: string, stdout: string): string {
  const summary = [stderr.trim(), stdout.trim()]
    .filter((value) => value.length > 0)
    .join("\n")
    .trim();
  return summary.length > 0 ? summary.slice(-1_000) : "no process output";
}

function parseCodexTokenUsage(
  stderr: string,
  outputText: string,
): { input: number; output: number } {
  const totalTokens = parseCodexTotalTokens(stderr);
  if (totalTokens === undefined) {
    return { input: 0, output: 0 };
  }

  const estimatedOutputTokens = Math.min(
    totalTokens,
    Math.max(1, Math.ceil(outputText.length / 4)),
  );
  return {
    input: totalTokens - estimatedOutputTokens,
    output: estimatedOutputTokens,
  };
}

function parseCodexTotalTokens(stderr: string): number | undefined {
  const matches = [...stderr.matchAll(/\btokens used\s+([0-9][0-9,]*)\b/gi)];
  const raw = matches.at(-1)?.[1];
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function createCodexCliProvider(
  config: CodexCliProviderConfig,
  deps?: CodexCliProviderDeps,
): LlmProvider {
  return new CodexCliProvider(config, deps);
}

export const __codexCliProviderTestHooks = {
  buildCodexCompletionPrompt,
  buildIsolatedCodexEnv,
  getActiveCodexCliChildCount: () => activeCodexCliChildPids.size,
  parseCodexTokenUsage,
  resolveCodexCliDiagnosticsDir,
  runCodexCliCommand,
  terminateActiveCodexCliChildren,
};
