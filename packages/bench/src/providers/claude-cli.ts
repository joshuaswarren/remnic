/**
 * `claude-cli` bench provider — shells out to Claude Code headless
 * (`claude -p`) as an isolated benchmark responder/judge target.
 *
 * Sibling to `codex-cli.ts`. Mirrors its isolation contract (issue #1728):
 * every completion runs from an **isolated empty temp workspace with tools
 * disabled** so Claude Code cannot inherit `~/.claude/CLAUDE.md`, project
 * settings, persisted memory, or tool output — all of which would silently
 * contaminate a benchmark answer.
 *
 * Honest-labeling invariant (issue #1728): a number produced through this
 * provider is "Opus via Claude Code", NOT an independent `tier: "frontier"`
 * / API-sourced number. Claude Code adds system-prompt scaffolding + model
 * alias routing that a reviewer cannot reproduce from a raw API call, so it
 * must never be published as the trusted leaderboard figure. The provider
 * records `provider: "claude-cli"` on diagnostics so consumers can label it.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ClaudeCliProviderConfig,
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  LlmProvider,
  TokenUsage,
} from "./types.js";
import { resolveBenchmarkRunId } from "../run-identity.js";

interface ClaudeCliRunRequest {
  executable: string;
  args: string[];
  input: string;
  /** The benchmark prompt text (also passed as the final positional CLI arg). */
  promptText: string;
  workspacePath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}

interface ClaudeCliRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ClaudeCliProviderDeps {
  runClaudeCli?: (request: ClaudeCliRunRequest) => Promise<ClaudeCliRunResult>;
  runClaudeVersion?: (
    executable: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ status: number | null; stderr: string }>;
}

/**
 * Shape of the `claude -p --output-format json` result envelope. Only the
 * fields the provider consumes are declared; everything else is ignored.
 * Parsed from untrusted subprocess stdout, so consumers must go through
 * {@link parseClaudeResultEnvelope} which validates via type guards.
 */
interface ClaudeResultEnvelope {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  model?: unknown;
  usage?: unknown;
  total_cost_usd?: unknown;
}

interface ClaudeCliDiagnosticRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  provider: "claude-cli";
  model: string;
  reasoningEffort: string;
  executable: string;
  timeoutMs?: number;
  workspaceBasename: string;
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
    stdoutTail: string;
    stderrTail: string;
  };
  error?: string;
  fullPrompt?: string;
}

interface ClaudeCliDiagnosticHandle {
  path: string;
  record: ClaudeCliDiagnosticRecord;
}

interface ClaudeCliDiagnosticOutcome {
  result?: ClaudeCliRunResult;
  error?: unknown;
  transientFailure?: boolean;
}

const DEFAULT_REASONING_EFFORT = "xhigh";
const CLAUDE_CLI_STDIO_LIMIT = 256_000;
const CLAUDE_CLI_PARENT_SIGNALS: NodeJS.Signals[] = [
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
];
const CLAUDE_CLI_FORCED_PARENT_EXIT_MS = 1_000;
const CLAUDE_CLI_DIAGNOSTICS_DIR_ENV = "REMNIC_BENCH_CLAUDE_CLI_DIAGNOSTICS_DIR";
const CLAUDE_CLI_DIAGNOSTICS_MODE_ENV = "REMNIC_BENCH_CLAUDE_CLI_DIAGNOSTICS_MODE";
const CLAUDE_CLI_EXECUTABLE_ENV = "REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE";
const CLAUDE_CLI_VERSION_TIMEOUT_MS = 5_000;
const CLAUDE_CLI_HEALTH_CACHE_TTL_MS = 30_000;

/**
 * Env keys the Claude Code child is allowed to inherit. Mirrors the codex-cli
 * allowlist: locale/path/proxy/shell keys plus `ANTHROPIC_API_KEY` (the one
 * credential Claude Code headless reads in `--bare` mode). Remnic/engram
 * memory dirs and unrelated secrets are deliberately excluded so a benchmark
 * completion can never read or write persisted memory.
 */
const CLAUDE_CLI_RUNTIME_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "APPDATA",
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

const BENCHMARK_ENDPOINT_SYSTEM_PROMPT = [
  "You are acting as a benchmark LLM completion endpoint, not as a coding agent.",
  "Use only the explicit JSON payload below.",
  "Treat systemPrompt as the higher-priority instruction text and userPrompt as the request to answer.",
  "Do not inspect files, run commands, browse, use tools, or use persisted memory.",
  "Return only the final answer text. If the request asks for JSON, return raw JSON only.",
].join(" ");

const activeClaudeCliChildPids = new Set<number>();
let claudeCliParentCleanupInstalled = false;

class ClaudeCliProvider implements LlmProvider {
  readonly provider = "claude-cli" as const;
  readonly id: string;
  readonly name: string;

  private readonly config: ClaudeCliProviderConfig;
  private readonly runClaudeCli: (request: ClaudeCliRunRequest) => Promise<ClaudeCliRunResult>;
  private readonly runClaudeVersion: (
    executable: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ status: number | null; stderr: string }>;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: ClaudeCliProviderConfig, deps: ClaudeCliProviderDeps = {}) {
    this.config = config;
    this.runClaudeCli = deps.runClaudeCli ?? runClaudeCliCommand;
    this.runClaudeVersion = deps.runClaudeVersion ?? runClaudeVersionCommand;
    this.id = `claude-cli:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    const maxAttempts = normalizeClaudeCliMaxAttempts(
      this.config.retryOptions?.maxAttempts,
    );
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-claude-cli-"));
      const workspacePath = path.join(tempDir, "workspace");
      let diagnostics: ClaudeCliDiagnosticHandle | undefined;
      let diagnosticsFinished = false;
      const finishDiagnostics = async (
        outcome: ClaudeCliDiagnosticOutcome,
      ): Promise<void> => {
        if (diagnosticsFinished) {
          return;
        }
        diagnosticsFinished = true;
        await finishClaudeCliDiagnostics(diagnostics, startedAt, outcome);
      };

      try {
        await mkdir(workspacePath, { recursive: true });
        const request = this.buildRunRequest(prompt, opts, workspacePath);
        diagnostics = await startClaudeCliDiagnostics({
          config: this.config,
          request,
          reasoningEffort: this.config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
          retry: { attempt, maxAttempts },
        });
        const result = await this.runClaudeCli(request);

        // Exit 0 + a parseable JSON envelope with is_error !== true is the
        // only success path. A non-zero exit OR is_error === true is a
        // failure — `claude -p` returns is_error:true (e.g. "Not logged in")
        // with a JSON body on stdout, so both signals must be checked.
        const envelope = parseClaudeResultEnvelope(result.stdout);
        const authOrRuntimeError = envelope !== undefined && envelope.isError === true;
        if (result.status !== 0 || authOrRuntimeError) {
          const exitLabel = result.signal
            ? `signal ${result.signal}`
            : `exit ${result.status ?? "unknown"}`;
          const detail = authOrRuntimeError
            ? String(envelope?.result ?? "").trim() || "claude -p reported is_error"
            : summarizeProcessOutput(result.stderr, result.stdout);
          const error = new Error(
            `Claude CLI completion failed (${exitLabel}): ${detail}`,
          );
          // Auth/login errors are not transient — do not retry (they burn
          // Claude Max session budget re-asking). Only retry genuine
          // transient subprocess signals.
          if (
            attempt < maxAttempts &&
            !authOrRuntimeError &&
            isRetryableClaudeCliResult(result)
          ) {
            lastError = error;
            await finishDiagnostics({
              result,
              error,
              transientFailure: true,
            });
            await sleepBeforeClaudeCliRetry(
              attempt,
              this.config.retryOptions?.baseBackoffMs,
              opts.signal,
            );
            continue;
          }
          await finishDiagnostics({ result, error });
          throw error;
        }

        const text = (envelope?.result ?? "").trim();
        if (text.length === 0) {
          const error = new Error(
            `Claude CLI completion returned no result text: ${summarizeProcessOutput(result.stderr, result.stdout)}`,
          );
          await finishDiagnostics({ result, error });
          throw error;
        }
        await finishDiagnostics({ result });
        const tokens = extractClaudeUsage(envelope?.usage, text);
        this.recordUsage(tokens.input, tokens.output);

        return {
          text,
          tokens,
          latencyMs: Math.round(performance.now() - startedAt),
          model: envelope?.model ?? this.config.model,
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
    const version = await this.runClaudeVersion(
      resolveClaudeCliExecutable(this.config),
      buildIsolatedClaudeEnv(),
    );
    if (version.status !== 0) {
      throw new Error(
        `Claude CLI discovery failed: ${version.stderr.trim() || `exit ${version.status ?? "unknown"}`}`,
      );
    }

    return [
      {
        id: this.config.model,
        name: `${this.config.model} (Claude Code)`,
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

  /**
   * `claude -p` reads from stdin (the prompt argument) and writes the result
   * JSON envelope to stdout. Unlike codex-cli we do not use an
   * `--output-last-message` file; the JSON `result` field IS the answer.
   */
  private buildRunRequest(
    prompt: string,
    opts: CompletionOpts,
    workspacePath: string,
  ): ClaudeCliRunRequest {
    const reasoningEffort =
      this.config.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    const promptText = buildClaudeCompletionPrompt(prompt, opts.systemPrompt);
    const args = [
      "-p",
      "--bare",
      "--tools",
      "",
      "--model",
      this.config.model,
      "--effort",
      reasoningEffort,
      "--output-format",
      "json",
      "--no-session-persistence",
      "--system-prompt",
      BENCHMARK_ENDPOINT_SYSTEM_PROMPT,
      promptText,
    ];

    return {
      executable: resolveClaudeCliExecutable(this.config),
      args,
      input: "",
      promptText,
      workspacePath,
      timeoutMs: this.config.retryOptions?.timeoutMs,
      signal: opts.signal,
      env: buildIsolatedClaudeEnv(this.config.apiKey, this.config.baseUrl),
    };
  }
}

// ----------------------------------------------------------------------------
// JSON envelope parsing (untrusted subprocess stdout → typed values)
// ----------------------------------------------------------------------------

interface ParsedClaudeEnvelope {
  isError?: boolean;
  result?: string;
  model?: string;
  usage?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaudeResultEnvelope(stdout: string): ParsedClaudeEnvelope | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const envelope = parsed as ClaudeResultEnvelope;
  const isError =
    typeof envelope.is_error === "boolean" ? envelope.is_error : undefined;
  const result =
    typeof envelope.result === "string" ? envelope.result : undefined;
  const model =
    typeof envelope.model === "string" && envelope.model.length > 0
      ? envelope.model
      : undefined;
  return {
    ...(isError !== undefined ? { isError } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(envelope.usage !== undefined ? { usage: envelope.usage } : {}),
  };
}

function extractClaudeUsage(
  usage: unknown,
  outputText: string,
): { input: number; output: number } {
  if (!isPlainObject(usage)) {
    return { input: 0, output: 0 };
  }
  const input = readNonNegativeInt(usage.input_tokens);
  const output = readNonNegativeInt(usage.output_tokens);
  if (input !== undefined && output !== undefined) {
    return { input, output };
  }
  if (input !== undefined) {
    // Output tokens sometimes absent in early-exit envelopes; estimate.
    return {
      input,
      output: Math.max(0, Math.min(input, Math.ceil(outputText.length / 4))),
    };
  }
  return { input: 0, output: 0 };
}

function readNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

// ----------------------------------------------------------------------------
// Subprocess execution
// ----------------------------------------------------------------------------

function runClaudeVersionCommand(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    status: number | null;
    stderr: string;
  }>();
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
  }, CLAUDE_CLI_VERSION_TIMEOUT_MS);
  timeout.unref();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.on("error", (error) => {
    clearTimeout(timeout);
    clearTimeout(killTimeout);
    resolve({ status: 1, stderr: error.message });
  });
  child.on("close", (status) => {
    clearTimeout(timeout);
    clearTimeout(killTimeout);
    resolve({
      status: timedOut ? status ?? 124 : status,
      stderr: timedOut
        ? appendBounded(
            stderr,
            `\nClaude CLI --version timed out after ${CLAUDE_CLI_VERSION_TIMEOUT_MS}ms.`,
          )
        : stderr,
    });
  });
  return promise;
}

function runClaudeCliCommand(request: ClaudeCliRunRequest): Promise<ClaudeCliRunResult> {
  const { promise, resolve } = Promise.withResolvers<ClaudeCliRunResult>();
  if (request.signal?.aborted) {
    resolve({
      status: 124,
      signal: null,
      stdout: "",
      stderr: "Claude CLI aborted before start.",
    });
    return promise;
  }

  const child = spawn(request.executable, request.args, {
    cwd: request.workspacePath,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (child.pid) {
    registerActiveClaudeCliChild(child.pid);
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
    stderr = appendBounded(stderr, "\nClaude CLI aborted by benchmark timeout.");
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
      `\nClaude CLI stdin error: ${error.code ?? error.message}`,
    );
  });
  child.on("error", (error) => {
    clearTimeout(timeout);
    clearKillTimeout();
    if (child.pid) {
      unregisterActiveClaudeCliChild(child.pid);
    }
    request.signal?.removeEventListener("abort", onAbort);
    resolve({
      status: 1,
      signal: null,
      stdout,
      stderr: appendBounded(stderr, error.message),
    });
  });
  child.on("close", (status, signal) => {
    clearTimeout(timeout);
    clearKillTimeout();
    if (child.pid) {
      unregisterActiveClaudeCliChild(child.pid);
    }
    request.signal?.removeEventListener("abort", onAbort);
    if (timedOut) {
      resolve({
        status: status ?? 124,
        signal,
        stdout,
        stderr: appendBounded(
          stderr,
          `\nClaude CLI timed out after ${request.timeoutMs}ms.`,
        ),
      });
      return;
    }
    if (aborted) {
      resolve({
        status: status ?? 124,
        signal,
        stdout,
        stderr,
      });
      return;
    }
    resolve({ status, signal, stdout, stderr });
  });
  try {
    child.stdin?.end(request.input);
  } catch (error) {
    stderr = appendBounded(
      stderr,
      `\nClaude CLI stdin error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return promise;
}

// ----------------------------------------------------------------------------
// Parent cleanup (mirror codex-cli: never orphan a Claude Code subprocess)
// ----------------------------------------------------------------------------

function registerActiveClaudeCliChild(pid: number): void {
  installClaudeCliParentCleanup();
  activeClaudeCliChildPids.add(pid);
}

function unregisterActiveClaudeCliChild(pid: number): void {
  activeClaudeCliChildPids.delete(pid);
}

function installClaudeCliParentCleanup(): void {
  if (claudeCliParentCleanupInstalled) {
    return;
  }
  claudeCliParentCleanupInstalled = true;

  process.once("exit", () => {
    terminateActiveClaudeCliChildren("SIGTERM");
  });

  for (const signal of CLAUDE_CLI_PARENT_SIGNALS) {
    process.once(signal, () => {
      const activeChildren = activeClaudeCliChildPids.size;
      terminateActiveClaudeCliChildren(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
      process.exitCode = signalExitCode(signal);

      setTimeout(
        () => {
          terminateActiveClaudeCliChildren("SIGKILL");
          process.exit(signalExitCode(signal));
        },
        activeChildren > 0 ? CLAUDE_CLI_FORCED_PARENT_EXIT_MS : 0,
      );
    });
  }
}

function terminateActiveClaudeCliChildren(signal: NodeJS.Signals): void {
  for (const pid of activeClaudeCliChildPids) {
    terminateClaudeCliChildPid(pid, signal);
  }
}

function terminateClaudeCliChildPid(pid: number, signal: NodeJS.Signals): void {
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

// ----------------------------------------------------------------------------
// Diagnostics
// ----------------------------------------------------------------------------

async function startClaudeCliDiagnostics(args: {
  config: ClaudeCliProviderConfig;
  request: ClaudeCliRunRequest;
  reasoningEffort: string;
  retry: { attempt: number; maxAttempts: number };
}): Promise<ClaudeCliDiagnosticHandle | undefined> {
  const diagnosticsDir = resolveClaudeCliDiagnosticsDir(args.config);
  if (!diagnosticsDir) {
    return undefined;
  }

  try {
    await mkdir(diagnosticsDir, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
    const promptStats = inspectClaudeCompletionPrompt(args.request.promptText);
    const mode = resolveClaudeCliDiagnosticsMode(args.config);
    const record: ClaudeCliDiagnosticRecord = {
      schemaVersion: 1,
      id,
      runId: resolveBenchmarkRunId(),
      startedAt: new Date().toISOString(),
      provider: "claude-cli",
      model: args.config.model,
      reasoningEffort: args.reasoningEffort,
      executable: path.basename(args.request.executable),
      ...(args.request.timeoutMs ? { timeoutMs: args.request.timeoutMs } : {}),
      workspaceBasename: path.basename(args.request.workspacePath),
      prompt: promptStats,
      command: {
        args: redactClaudeCliArgs(args.request.args),
      },
      retry: args.retry,
      ...(mode === "full" ? { fullPrompt: args.request.promptText } : {}),
    };
    const filePath = path.join(diagnosticsDir, `${id}.json`);
    await writeClaudeCliDiagnosticRecord(filePath, record);
    return { path: filePath, record };
  } catch {
    return undefined;
  }
}

async function finishClaudeCliDiagnostics(
  handle: ClaudeCliDiagnosticHandle | undefined,
  startedAt: number,
  outcome: ClaudeCliDiagnosticOutcome,
): Promise<void> {
  if (!handle) {
    return;
  }

  const result = outcome.result;
  const error = outcome.error;
  const record: ClaudeCliDiagnosticRecord = {
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
            stdoutTail: tailText(result.stdout, 2_000),
            stderrTail: tailText(result.stderr, 2_000),
          },
        }
      : {}),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  };
  handle.record = record;

  try {
    await writeClaudeCliDiagnosticRecord(handle.path, record);
  } catch {
    // Diagnostics must never change benchmark behavior.
  }
}

async function writeClaudeCliDiagnosticRecord(
  filePath: string,
  record: ClaudeCliDiagnosticRecord,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function resolveClaudeCliDiagnosticsDir(
  config: ClaudeCliProviderConfig,
): string | undefined {
  const dir = config.diagnosticsDir ?? process.env[CLAUDE_CLI_DIAGNOSTICS_DIR_ENV];
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

function resolveClaudeCliDiagnosticsMode(
  config: ClaudeCliProviderConfig,
): "metadata" | "full" {
  const raw = config.diagnosticsMode ?? process.env[CLAUDE_CLI_DIAGNOSTICS_MODE_ENV];
  return raw === "full" ? "full" : "metadata";
}

function inspectClaudeCompletionPrompt(
  promptText: string,
): ClaudeCliDiagnosticRecord["prompt"] {
  const stats: ClaudeCliDiagnosticRecord["prompt"] = {
    sha256: createHash("sha256").update(promptText).digest("hex"),
    chars: promptText.length,
    lines: promptText.length === 0 ? 0 : promptText.split("\n").length,
  };
  const marker = "BENCHMARK_REQUEST_JSON:";
  const markerIndex = promptText.indexOf(marker);
  if (markerIndex < 0) {
    return stats;
  }

  try {
    const parsed = JSON.parse(promptText.slice(markerIndex + marker.length).trim()) as {
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

function redactClaudeCliArgs(args: string[]): string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    const value = redacted[index];
    const lowered = value.toLowerCase();
    if (value === "--system-prompt") {
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

function resolveClaudeCliExecutable(config: ClaudeCliProviderConfig): string {
  const configured =
    config.executable ?? process.env[CLAUDE_CLI_EXECUTABLE_ENV];
  if (configured === undefined) {
    return "claude";
  }

  const trimmed = configured.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `${CLAUDE_CLI_EXECUTABLE_ENV} / claude-cli executable must not be empty`,
    );
  }
  return expandHomeRelativePath(trimmed);
}

function buildClaudeCompletionPrompt(
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

function buildIsolatedClaudeEnv(
  apiKey?: string,
  baseUrl?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isAllowedClaudeRuntimeEnvKey(key)) {
      env[key] = value;
    }
  }

  // Config apiKey/baseUrl take precedence over the inherited env, mirroring
  // codex-cli (buildIsolatedCodexEnv). This is how --system-api-key etc.
  // reach Claude Code headless as ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL.
  const resolvedApiKey = (apiKey ?? process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (resolvedApiKey.length > 0) {
    env.ANTHROPIC_API_KEY = resolvedApiKey;
  }
  const resolvedBaseUrl = (baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "").trim();
  if (resolvedBaseUrl.length > 0) {
    env.ANTHROPIC_BASE_URL = resolvedBaseUrl;
  }
  return env;
}

function isAllowedClaudeRuntimeEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return CLAUDE_CLI_RUNTIME_ENV_ALLOWLIST.has(normalized)
    || normalized.startsWith("LC_");
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function appendBounded(existing: string, next: string): string {
  const combined = existing + next;
  if (combined.length <= CLAUDE_CLI_STDIO_LIMIT) {
    return combined;
  }
  return combined.slice(combined.length - CLAUDE_CLI_STDIO_LIMIT);
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

function normalizeClaudeCliMaxAttempts(value: number | undefined): number {
  if (value === undefined) {
    return 3;
  }
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(10, Math.floor(value));
}

function isRetryableClaudeCliResult(result: ClaudeCliRunResult): boolean {
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

async function sleepBeforeClaudeCliRetry(
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
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, delayMs);
    await promise;
    return;
  }
  if (signal.aborted) {
    throw claudeCliAbortError(signal);
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const cleanup = (): void => {
    signal.removeEventListener("abort", onAbort);
  };
  const onAbort = (): void => {
    clearTimeout(timeout);
    cleanup();
    reject(claudeCliAbortError(signal));
  };
  const timeout = setTimeout(() => {
    cleanup();
    resolve();
  }, delayMs);
  signal.addEventListener("abort", onAbort, { once: true });
  await promise;
}

function claudeCliAbortError(signal: AbortSignal): Error {
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

export function createClaudeCliProvider(
  config: ClaudeCliProviderConfig,
  deps?: ClaudeCliProviderDeps,
): LlmProvider {
  return new ClaudeCliProvider(config, deps);
}

export const __claudeCliProviderTestHooks = {
  buildClaudeCompletionPrompt,
  buildIsolatedClaudeEnv,
  extractClaudeUsage,
  parseClaudeResultEnvelope,
  resolveClaudeCliDiagnosticsDir,
  resolveClaudeCliExecutable,
};
