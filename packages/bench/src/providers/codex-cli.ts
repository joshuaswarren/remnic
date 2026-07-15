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
  TokenUsage,
} from "./types.js";
import {
  StructuredJudgeError,
  isValidAssistantRubric,
  parseStructuredJudgeVerdict,
  type AssistantRubricRequest,
  type StructuredJudgeProvider,
  type StructuredJudgeVerdictResult,
  type StructuredVerdictRequest,
} from "./structured-judge.js";
import {
  CodexCreditAccountingError,
  CodexCreditDispatchError,
  parseCodexJsonlUsage,
  resolveCodexCreditBudgetConfig,
  runWithinCodexCreditBudget,
  type CodexCliNativeUsage,
} from "./codex-credit-budget.js";
import { resolveBenchmarkRunId } from "../run-identity.js";

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
  runCodexLoginStatus?: (
    executable: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>;
}

interface CodexCliDiagnosticRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  provider: "codex-cli";
  model: string;
  reasoningEffort: string;
  serviceTier: string;
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
  retry?: {
    attempt: number;
    maxAttempts: number;
    transientFailure?: boolean;
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

interface CodexCliDiagnosticOutcome {
  result?: CodexCliRunResult;
  error?: unknown;
  transientFailure?: boolean;
}

const DEFAULT_REASONING_EFFORT = "xhigh";
const DEFAULT_SERVICE_TIER = "default";
const CODEX_CLI_STDIO_LIMIT = 64_000;
const CODEX_CLI_PARENT_SIGNALS: NodeJS.Signals[] = [
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
];
const CODEX_CLI_FORCED_PARENT_EXIT_MS = 1_000;
const CODEX_CLI_DIAGNOSTICS_DIR_ENV = "REMNIC_BENCH_CODEX_CLI_DIAGNOSTICS_DIR";
const CODEX_CLI_DIAGNOSTICS_MODE_ENV = "REMNIC_BENCH_CODEX_CLI_DIAGNOSTICS_MODE";
const CODEX_CLI_EXECUTABLE_ENV = "REMNIC_BENCH_CODEX_CLI_EXECUTABLE";
const CODEX_CLI_VERSION_TIMEOUT_MS = 5_000;
const CODEX_CLI_RUNTIME_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CODEX_HOME",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROCESSOR_ARCHITECTURE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

const activeCodexCliChildPids = new Set<number>();
let codexCliParentCleanupInstalled = false;
const codexCliLoginStatusCache = new Map<string, Promise<void>>();
class CodexCliProvider implements StructuredJudgeProvider {
  readonly provider = "codex-cli" as const;
  readonly id: string;
  readonly name: string;

  private readonly config: CodexCliProviderConfig;
  private readonly runCodexCli: (request: CodexCliRunRequest) => Promise<CodexCliRunResult>;
  private readonly runCodexVersion: (
    executable: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ status: number | null; stderr: string }>;
  private readonly runCodexLoginStatus: (
    executable: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  private readonly requiresExactUsage: boolean;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: CodexCliProviderConfig, deps: CodexCliProviderDeps = {}) {
    this.config = config;
    this.runCodexCli = deps.runCodexCli ?? runCodexCliCommand;
    this.runCodexVersion = deps.runCodexVersion ?? runCodexVersionCommand;
    this.runCodexLoginStatus =
      deps.runCodexLoginStatus ?? runCodexLoginStatusCommand;
    this.requiresExactUsage = deps.runCodexCli === undefined;
    this.id = `codex-cli:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    const creditBudget = resolveCodexCreditBudgetConfig();
    if (creditBudget) {
      await this.assertChatGptCreditAuth();
    }

    const maxAttempts = normalizeCodexCliMaxAttempts(
      creditBudget ? 1 : this.config.retryOptions?.maxAttempts,
    );
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-cli-"));
      const workspacePath = path.join(tempDir, "workspace");
      const outputPath = path.join(tempDir, "last-message.txt");
      let diagnostics: CodexCliDiagnosticHandle | undefined;
      let diagnosticsFinished = false;
      const finishDiagnostics = async (outcome: CodexCliDiagnosticOutcome): Promise<void> => {
        if (diagnosticsFinished) {
          return;
        }
        diagnosticsFinished = true;
        await finishCodexCliDiagnostics(diagnostics, startedAt, outcome);
      };

      try {
        await mkdir(workspacePath, { recursive: true });
        const request = this.buildRunRequest(prompt, opts, workspacePath, outputPath);
        diagnostics = await startCodexCliDiagnostics({
          config: this.config,
          request,
          reasoningEffort: this.config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
          serviceTier: DEFAULT_SERVICE_TIER,
          retry: { attempt, maxAttempts },
        });
        const result = creditBudget
          ? await runWithinCodexCreditBudget({
              config: creditBudget,
              model: this.config.model,
              run: async () => {
                const value = await this.runCodexCli(request);
                const usage = parseCodexJsonlUsage(
                  `${value.stdout}\n${value.stderr}`,
                );
                if (!usage) {
                  throw new CodexCreditAccountingError(
                    `Codex CLI exited ${value.status ?? "without a status"} without exact ` +
                      "turn.completed usage; account balance must be reconciled before resuming.",
                  );
                }
                return { value, usage };
              },
            })
          : await this.runCodexCli(request);
        if (result.status !== 0) {
          const error = codexCliResultError(result);
          if (
            attempt < maxAttempts &&
            isRetryableCodexCliResult(result)
          ) {
            lastError = error;
            await finishDiagnostics({
              result,
              error,
              transientFailure: true,
            });
            await sleepBeforeCodexCliRetry(
              attempt,
              this.config.retryOptions?.baseBackoffMs,
              opts.signal,
            );
            continue;
          }
          await finishDiagnostics({ result, error });
          throw error;
        }

        const text = result.outputText.trim();
        if (text.length === 0) {
          const error = new Error(
            `Codex CLI completion returned no final message: ${summarizeProcessOutput(result.stderr, result.stdout)}`,
          );
          await finishDiagnostics({ result, error });
          throw error;
        }
        await finishDiagnostics({ result });
        const nativeUsage = this.requiresExactUsage
          ? requireCodexJsonlUsage(result)
          : readCodexUsage(result, text);
        const tokens = {
          input: nativeUsage.inputTokens,
          output: nativeUsage.outputTokens,
        };
        this.recordUsage(tokens.input, tokens.output);

        return {
          text,
          tokens,
          latencyMs: Math.round(performance.now() - startedAt),
          model: this.config.model,
        };
      } catch (error) {
        lastError = error;
        await finishDiagnostics({ error });
        throw error;
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async judge(request: StructuredVerdictRequest): Promise<StructuredJudgeVerdictResult> {
    const startedAt = performance.now();
    try {
      const completion = await this.complete(request.input, {
        systemPrompt: buildCodexStructuredJudgePrompt(request.rubric),
        temperature: 0,
        maxTokens: request.maxTokens ?? 256,
        signal: request.signal,
      });
      const telemetry = {
        model: completion.model,
        rubricVersion: request.rubricVersion,
        inputTokens: completion.tokens.input,
        outputTokens: completion.tokens.output,
        latencyMs: completion.latencyMs,
      };
      const verdict = parseStructuredJudgeVerdict(completion.text);
      if (!verdict) {
        return {
          ok: false,
          error: {
            code: "malformed_verdict",
            message: "Codex CLI returned a verdict that failed schema validation.",
            retryable: false,
          },
          telemetry: { ...telemetry, errorCode: "malformed_verdict" },
        };
      }
      return { ok: true, verdict, telemetry };
    } catch (error) {
      const aborted = isCodexStructuredJudgeAbort(error, request.signal);
      const errorCode = aborted ? "aborted" : "transport_error";
      return {
        ok: false,
        error: {
          code: errorCode,
          message: aborted
            ? "Codex CLI judging was aborted by the caller."
            : `Codex CLI judging failed (${structuredJudgeErrorName(error)}).`,
          retryable: false,
        },
        telemetry: {
          model: this.config.model,
          rubricVersion: request.rubricVersion,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Math.round(performance.now() - startedAt),
          errorCode,
        },
      };
    }
  }

  async evaluateAssistantRubric(request: AssistantRubricRequest): Promise<string> {
    const rubricVersion = `sealed:${request.rubricId}`;
    const completion = await this.complete(request.user, {
      systemPrompt: buildCodexAssistantRubricPrompt(request.system),
      temperature: 0,
      maxTokens: 512,
    });
    if (isValidAssistantRubric(completion.text)) {
      return completion.text;
    }
    throw new StructuredJudgeError({
      ok: false,
      error: {
        code: "malformed_verdict",
        message: "Codex CLI returned an invalid sealed assistant-rubric verdict.",
        retryable: false,
      },
      telemetry: {
        model: completion.model,
        rubricVersion,
        inputTokens: completion.tokens.input,
        outputTokens: completion.tokens.output,
        latencyMs: completion.latencyMs,
        errorCode: "malformed_verdict",
      },
    });
  }

  async discover(): Promise<DiscoveredModel[]> {
    const version = await this.runCodexVersion(
      resolveCodexCliExecutable(this.config),
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

  private async assertChatGptCreditAuth(): Promise<void> {
    const executable = resolveCodexCliExecutable(this.config);
    const env = buildIsolatedCodexEnv();
    const cacheKey = `${executable}\0${env.CODEX_HOME ?? env.HOME ?? ""}`;
    let check = codexCliLoginStatusCache.get(cacheKey);
    if (!check) {
      check = this.runCodexLoginStatus(executable, env).then((result) => {
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.status !== 0 || !/logged in using chatgpt/i.test(output)) {
          throw new Error(
            "Bounded Codex credit runs require ChatGPT-backed Codex CLI authentication; " +
              `\`codex login status\` reported: ${output || `exit ${result.status ?? "unknown"}`}`,
          );
        }
      });
      codexCliLoginStatusCache.set(cacheKey, check);
      check.catch(() => codexCliLoginStatusCache.delete(cacheKey));
    }
    await check;
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
      "hooks",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--cd",
      workspacePath,
      "--skip-git-repo-check",
      "--json",
      "--output-last-message",
      outputPath,
      "-",
    ];

    return {
      executable: resolveCodexCliExecutable(this.config),
      args,
      input: buildCodexCompletionPrompt(prompt, opts.systemPrompt),
      outputPath,
      workspacePath,
      timeoutMs: this.config.retryOptions?.timeoutMs,
      signal: opts.signal,
      env: buildIsolatedCodexEnv(),
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
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stderr = "";
    let timedOut = false;
    let killTimeout: NodeJS.Timeout | undefined;
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
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild("SIGTERM");
      killTimeout = setTimeout(() => {
        terminateChild("SIGKILL");
      }, 1_000);
      killTimeout.unref();
    }, CODEX_CLI_VERSION_TIMEOUT_MS);
    timeout.unref();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      resolve({
        status: timedOut ? status ?? 124 : status,
        stderr: timedOut
          ? appendBounded(
              stderr,
              `\nCodex CLI --version timed out after ${CODEX_CLI_VERSION_TIMEOUT_MS}ms.`,
            )
          : stderr,
      });
    });
  });
}

function runCodexLoginStatusCommand(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["login", "status"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let killTimeout: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child.
        }
      }
      child.kill(signal);
    };
    const timeout = setTimeout(() => {
      stderr = appendBounded(
        stderr,
        `\nCodex CLI login status timed out after ${CODEX_CLI_VERSION_TIMEOUT_MS}ms.`,
      );
      terminate("SIGTERM");
      killTimeout = setTimeout(() => terminate("SIGKILL"), 1_000);
      killTimeout.unref();
    }, CODEX_CLI_VERSION_TIMEOUT_MS);
    timeout.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function resolveCodexCliExecutable(config: CodexCliProviderConfig): string {
  const configured =
    config.executable ?? process.env[CODEX_CLI_EXECUTABLE_ENV];
  if (configured === undefined) {
    return "codex";
  }

  const trimmed = configured.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `${CODEX_CLI_EXECUTABLE_ENV} / codex-cli executable must not be empty`,
    );
  }
  return expandHomeRelativePath(trimmed);
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

function buildIsolatedCodexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isAllowedCodexRuntimeEnvKey(key)) {
      env[key] = value;
    }
  }

  return env;
}

function isAllowedCodexRuntimeEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return CODEX_CLI_RUNTIME_ENV_ALLOWLIST.has(normalized)
    || normalized.startsWith("LC_");
}

async function startCodexCliDiagnostics(args: {
  config: CodexCliProviderConfig;
  request: CodexCliRunRequest;
  reasoningEffort: string;
  serviceTier: string;
  retry: { attempt: number; maxAttempts: number };
}): Promise<CodexCliDiagnosticHandle | undefined> {
  const diagnosticsDir = resolveCodexCliDiagnosticsDir(args.config);
  if (!diagnosticsDir) {
    return undefined;
  }

  try {
    await mkdir(diagnosticsDir, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
    const promptStats = inspectCodexCompletionPrompt(args.request.input);
    const mode = resolveCodexCliDiagnosticsMode(args.config);
    const record: CodexCliDiagnosticRecord = {
      schemaVersion: 1,
      id,
      runId: resolveBenchmarkRunId(),
      startedAt: new Date().toISOString(),
      provider: "codex-cli",
      model: args.config.model,
      reasoningEffort: args.reasoningEffort,
      serviceTier: args.serviceTier,
      executable: path.basename(args.request.executable),
      ...(args.request.timeoutMs ? { timeoutMs: args.request.timeoutMs } : {}),
      workspaceBasename: path.basename(args.request.workspacePath),
      outputBasename: path.basename(args.request.outputPath),
      prompt: promptStats,
      command: {
        args: redactCodexCliArgs(args.request.args),
      },
      retry: args.retry,
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
  outcome: CodexCliDiagnosticOutcome,
): Promise<void> {
  if (!handle) {
    return;
  }

  const result = outcome.result;
  const error = outcome.error;
  const record: CodexCliDiagnosticRecord = {
    ...handle.record,
    ...(outcome.transientFailure
      ? {
          retry: {
            ...(handle.record.retry ?? { attempt: 1, maxAttempts: 1 }),
            transientFailure: true,
          },
        }
      : {}),
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
            stdoutTail: tailText(result.stdout, 2_000),
            stderrTail: tailText(result.stderr, 2_000),
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
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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
      reject(
        child.pid
          ? new CodexCreditAccountingError(
              `Codex CLI failed after its process started; account balance must be reconciled before resuming: ${safeErrorMessage(error)}`,
            )
          : new CodexCreditDispatchError(
              `Codex CLI could not start: ${safeErrorMessage(error)}`,
              { cause: error },
            ),
      );
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
        const outputText = await readCodexOutput(request.outputPath, status);
        resolve({ status, signal, stdout, stderr, outputText });
      } catch (error) {
        reject(
          new CodexCreditAccountingError(
            `${safeErrorMessage(error)} Account balance must be reconciled before resuming.`,
          ),
        );
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
  status: number | null,
): Promise<string> {
  try {
    return await readFile(outputPath, "utf8");
  } catch (error) {
    if (status === 0) {
      throw new Error(
        `Codex CLI exited successfully but did not write --output-last-message: ${safeErrorMessage(error)}`,
      );
    }
    return "";
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendBounded(existing: string, next: string): string {
  const combined = existing + next;
  if (combined.length <= CODEX_CLI_STDIO_LIMIT) {
    return combined;
  }
  return combined.slice(combined.length - CODEX_CLI_STDIO_LIMIT);
}

function tailText(value: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return "";
  }
  const normalizedMaxChars = Math.floor(maxChars);
  return value.length <= normalizedMaxChars
    ? value
    : value.slice(value.length - normalizedMaxChars);
}

function normalizeCodexCliMaxAttempts(value: number | undefined): number {
  if (value === undefined) {
    return 3;
  }
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(10, Math.floor(value));
}

function isRetryableCodexCliResult(result: CodexCliRunResult): boolean {
  if (!result.signal) {
    return false;
  }
  const stderr = result.stderr.toLowerCase();
  if (
    stderr.includes("timed out after") ||
    stderr.includes("aborted by benchmark timeout")
  ) {
    return false;
  }
  return true;
}

async function sleepBeforeCodexCliRetry(
  attempt: number,
  configuredBaseBackoffMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const baseBackoffMs =
    configuredBaseBackoffMs !== undefined &&
    Number.isFinite(configuredBaseBackoffMs) &&
    configuredBaseBackoffMs > 0
      ? configuredBaseBackoffMs
      : 1000;
  const delayMs = Math.min(baseBackoffMs * Math.pow(2, attempt - 1), 30_000);
  if (!signal) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    return;
  }
  if (signal.aborted) {
    throw codexCliAbortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(codexCliAbortError(signal));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function codexCliAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  if (signal.reason !== undefined) {
    return new Error(String(signal.reason));
  }
  return new DOMException("The operation was aborted.", "AbortError");
}

function summarizeProcessOutput(stderr: string, stdout: string): string {
  const summary = [stderr.trim(), stdout.trim()]
    .filter((value) => value.length > 0)
    .join("\n")
    .trim();
  return summary.length > 0 ? summary.slice(-1_000) : "no process output";
}

function requireCodexJsonlUsage(result: CodexCliRunResult): CodexCliNativeUsage {
  const usage = parseCodexJsonlUsage(`${result.stdout}\n${result.stderr}`);
  if (!usage) {
    throw new Error(
      `Codex CLI completion did not emit a valid turn.completed usage event: ${summarizeProcessOutput(result.stderr, result.stdout)}`,
    );
  }
  return usage;
}

function readCodexUsage(
  result: CodexCliRunResult,
  outputText: string,
): CodexCliNativeUsage {
  const exact = parseCodexJsonlUsage(`${result.stdout}\n${result.stderr}`);
  if (exact) return exact;
  const legacy = parseCodexTokenUsage(
    `${result.stderr}\n${result.stdout}`,
    outputText,
  );
  return {
    inputTokens: legacy.input,
    cachedInputTokens: 0,
    outputTokens: legacy.output,
    reasoningOutputTokens: 0,
  };
}

function parseCodexTokenUsage(
  output: string,
  outputText: string,
): { input: number; output: number } {
  const matches = [...output.matchAll(/\btokens used\s+([0-9][0-9,]*)\b/gi)];
  const raw = matches.at(-1)?.[1];
  if (!raw) return { input: 0, output: 0 };
  const totalTokens = Number(raw.replace(/,/g, ""));
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
    return { input: 0, output: 0 };
  }
  const outputTokens = Math.min(
    totalTokens,
    Math.max(1, Math.ceil(outputText.length / 4)),
  );
  return { input: totalTokens - outputTokens, output: outputTokens };
}

function codexCliResultError(result: CodexCliRunResult): Error {
  const exitLabel = result.signal
    ? `signal ${result.signal}`
    : `exit ${result.status ?? "unknown"}`;
  return new Error(
    `Codex CLI completion failed (${exitLabel}): ${summarizeProcessOutput(result.stderr, result.stdout)}`,
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexStructuredJudgePrompt(rubric: string): string {
  return [
    rubric,
    "Return raw JSON only, with exactly these keys:",
    '{"score":<number from 0 to 1>,"decision":"pass|partial|fail","reason":"non-empty concise reason"}',
    "Do not wrap the JSON in Markdown or add any other text.",
  ].join("\n\n");
}

function buildCodexAssistantRubricPrompt(systemPrompt: string): string {
  return [
    systemPrompt,
    "Return raw JSON only, with exactly these keys:",
    '{"identity_accuracy":<0-5>,"stance_coherence":<0-5>,"novelty":<0-5>,"calibration":<0-5>,"notes":"string"}',
    "Every numeric value must be finite and within the inclusive range 0 to 5.",
    "Do not wrap the JSON in Markdown or add any other text.",
  ].join("\n\n");
}

function isCodexStructuredJudgeAbort(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
}

function structuredJudgeErrorName(error: unknown): string {
  return error instanceof Error && error.name.trim().length > 0
    ? error.name
    : "unknown error";
}

export function createCodexCliProvider(
  config: CodexCliProviderConfig,
  deps?: CodexCliProviderDeps,
): StructuredJudgeProvider {
  return new CodexCliProvider(config, deps);
}

export const __codexCliProviderTestHooks = {
  buildCodexCompletionPrompt,
  buildIsolatedCodexEnv,
  clearCodexCliLoginStatusCache: () => codexCliLoginStatusCache.clear(),
  getActiveCodexCliChildCount: () => activeCodexCliChildPids.size,
  parseCodexJsonlUsage,
  parseCodexTokenUsage,
  resolveCodexCliDiagnosticsDir,
  resolveCodexCliExecutable,
  runCodexCliCommand,
  terminateActiveCodexCliChildren,
};
