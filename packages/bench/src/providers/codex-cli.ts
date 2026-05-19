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
import { retryFetch } from "./retry-fetch.js";
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
}

interface ResponsesApiResponse {
  model?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

type ResponsesApiServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

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
const DEFAULT_SERVICE_TIER = "fast";
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
const CODEX_CLI_TRANSPORT_ENV = "REMNIC_BENCH_CODEX_CLI_TRANSPORT";
const CODEX_CLI_VERSION_TIMEOUT_MS = 5_000;
const CODEX_CLI_HEALTH_CACHE_TTL_MS = 30_000;
const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";
const OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";
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
  OPENAI_BASE_URL_ENV,
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
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
const codexCliHealthCache = new Map<
  string,
  { checkedAt: number; promise: Promise<boolean> }
>();

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
  private readonly shouldProbeCliHealth: boolean;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: CodexCliProviderConfig, deps: CodexCliProviderDeps = {}) {
    this.config = config;
    this.runCodexCli = deps.runCodexCli ?? runCodexCliCommand;
    this.runCodexVersion = deps.runCodexVersion ?? runCodexVersionCommand;
    this.shouldProbeCliHealth = deps.runCodexCli === undefined;
    this.id = `codex-cli:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    if (await this.shouldUseResponsesFallback()) {
      return this.completeViaResponsesApi(prompt, opts, startedAt);
    }

    const maxAttempts = normalizeCodexCliMaxAttempts(
      this.config.retryOptions?.maxAttempts,
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
        const result = await this.runCodexCli(request);
        if (result.status !== 0) {
          const exitLabel = result.signal
            ? `signal ${result.signal}`
            : `exit ${result.status ?? "unknown"}`;
          const error = new Error(
            `Codex CLI completion failed (${exitLabel}): ${summarizeProcessOutput(result.stderr, result.stdout)}`,
          );
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
        lastError = error;
        await finishDiagnostics({ error });
        throw error;
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

  private recordUsage(inputTokens: number, outputTokens: number): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + inputTokens,
      outputTokens: this.usage.outputTokens + outputTokens,
      totalTokens: this.usage.totalTokens + inputTokens + outputTokens,
    };
  }

  private async shouldUseResponsesFallback(): Promise<boolean> {
    const transport = process.env[CODEX_CLI_TRANSPORT_ENV]?.trim().toLowerCase();
    if (transport === "cli") {
      return false;
    }
    if (transport === "responses") {
      return true;
    }
    if (!this.shouldProbeCliHealth || this.resolveOpenAiApiKey().length === 0) {
      return false;
    }

    return !(await this.isCliHealthy());
  }

  private async isCliHealthy(): Promise<boolean> {
    const executable = resolveCodexCliExecutable(this.config);
    const env = buildIsolatedCodexEnv(this.config.apiKey);
    if (this.runCodexVersion !== runCodexVersionCommand) {
      return this.probeCliHealth(executable, env);
    }

    const cacheKey = `${executable}\0${env.PATH ?? ""}`;
    const cached = codexCliHealthCache.get(cacheKey);
    if (
      cached &&
      Date.now() - cached.checkedAt < CODEX_CLI_HEALTH_CACHE_TTL_MS
    ) {
      return cached.promise;
    }
    if (cached) {
      codexCliHealthCache.delete(cacheKey);
    }

    const promise = this.probeCliHealth(executable, env).then((healthy) => {
      if (!healthy) {
        codexCliHealthCache.delete(cacheKey);
      }
      return healthy;
    });
    codexCliHealthCache.set(cacheKey, { checkedAt: Date.now(), promise });
    return promise;
  }

  private async probeCliHealth(
    executable: string,
    env: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    try {
      const version = await this.runCodexVersion(executable, env);
      return version.status === 0;
    } catch {
      return false;
    }
  }

  private resolveOpenAiApiKey(): string {
    return (this.config.apiKey ?? process.env[OPENAI_API_KEY_ENV] ?? "").trim();
  }

  private async completeViaResponsesApi(
    prompt: string,
    opts: CompletionOpts,
    startedAt: number,
  ): Promise<CompletionResult> {
    const apiKey = this.resolveOpenAiApiKey();
    if (apiKey.length === 0) {
      throw new Error(
        `Codex CLI fallback requires ${OPENAI_API_KEY_ENV} or codex-cli apiKey.`,
      );
    }

    const serviceTier = responsesApiServiceTier(DEFAULT_SERVICE_TIER);
    const body: Record<string, unknown> = {
      model: this.config.model,
      instructions: buildResponsesInstructions(opts.systemPrompt),
      input: prompt,
      reasoning: {
        effort: this.config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      },
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      max_output_tokens: Math.max(1, Math.floor(opts.maxTokens ?? 1024)),
      store: false,
    };

    const response = await retryFetch(
      this.responsesApiUrl(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        signal: opts.signal,
        body: JSON.stringify(body),
      },
      this.config.retryOptions,
    );

    if (!response.ok) {
      throw new Error(
        `Codex CLI Responses API fallback failed: ${response.status} ${response.statusText}${await readResponseErrorBody(response)}`,
      );
    }

    const payload = (await response.json()) as ResponsesApiResponse;
    const text = extractResponsesOutputText(payload).trim();
    if (text.length === 0) {
      throw new Error("Codex CLI Responses API fallback returned no text.");
    }

    const inputTokens = payload.usage?.input_tokens ?? 0;
    const outputTokens = payload.usage?.output_tokens ?? 0;
    this.recordUsage(inputTokens, outputTokens);

    return {
      text,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs: Math.round(performance.now() - startedAt),
      model: payload.model ?? this.config.model,
    };
  }

  private responsesApiUrl(): string {
    const baseUrl = (this.config.baseUrl ?? OPENAI_RESPONSES_BASE_URL).replace(
      /\/$/,
      "",
    );
    return baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
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
      `service_tier=${tomlString(DEFAULT_SERVICE_TIER)}`,
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
      executable: resolveCodexCliExecutable(this.config),
      args,
      input: buildCodexCompletionPrompt(prompt, opts.systemPrompt),
      outputPath,
      workspacePath,
      timeoutMs: this.config.retryOptions?.timeoutMs,
      signal: opts.signal,
      env: buildIsolatedCodexEnv(this.config.apiKey, this.config.baseUrl),
    };
  }
}

function responsesApiServiceTier(
  serviceTier: string,
): ResponsesApiServiceTier | undefined {
  if (
    serviceTier === "auto" ||
    serviceTier === "default" ||
    serviceTier === "flex" ||
    serviceTier === "scale" ||
    serviceTier === "priority"
  ) {
    return serviceTier;
  }
  return undefined;
}

function buildResponsesInstructions(systemPrompt: string | undefined): string {
  return [
    "You are acting as a benchmark LLM completion endpoint, not as a coding agent.",
    "Use only the user input and the benchmark system instructions.",
    "Do not inspect files, run commands, browse, use tools, or use persisted memory.",
    "Return only the final answer text. If the request asks for JSON, return raw JSON only.",
    ...(systemPrompt?.trim() ? ["", systemPrompt.trim()] : []),
  ].join("\n");
}

async function readResponseErrorBody(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.trim().length > 0 ? ` — ${body.slice(0, 1_000)}` : "";
  } catch {
    return "";
  }
}

function extractResponsesOutputText(payload: ResponsesApiResponse): string {
  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }

  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    if (typeof item.text === "string" && item.text.length > 0) {
      parts.push(item.text);
    }
    for (const content of item.content ?? []) {
      if (
        typeof content.text === "string" &&
        content.text.length > 0 &&
        (content.type === undefined || content.type.endsWith("_text"))
      ) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n");
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

function buildIsolatedCodexEnv(
  apiKey?: string,
  baseUrl?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isAllowedCodexRuntimeEnvKey(key)) {
      env[key] = value;
    }
  }

  const resolvedApiKey = (apiKey ?? process.env[OPENAI_API_KEY_ENV] ?? "").trim();
  if (resolvedApiKey.length > 0) {
    env[OPENAI_API_KEY_ENV] = resolvedApiKey;
  }
  const resolvedBaseUrl = (baseUrl ?? process.env[OPENAI_BASE_URL_ENV] ?? "").trim();
  if (resolvedBaseUrl.length > 0) {
    env[OPENAI_BASE_URL_ENV] = resolvedBaseUrl;
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
    await mkdir(diagnosticsDir, { recursive: true });
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
  clearCodexCliHealthCache: () => codexCliHealthCache.clear(),
  getActiveCodexCliChildCount: () => activeCodexCliChildPids.size,
  parseCodexTokenUsage,
  resolveCodexCliDiagnosticsDir,
  resolveCodexCliExecutable,
  runCodexCliCommand,
  terminateActiveCodexCliChildren,
};
