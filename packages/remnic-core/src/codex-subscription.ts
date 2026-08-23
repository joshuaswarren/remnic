/**
 * Codex subscription extraction provider (issue #2784).
 *
 * Routes extraction/consolidation LLM calls through the `codex` CLI so the
 * operator's Codex subscription (ChatGPT OAuth login) authenticates the
 * request — no OpenAI API key and no codex-openai-proxy. Credentials stay in
 * the CLI's own auth store; this module never reads, accepts, or logs tokens.
 *
 * Transport contract mirrors `packages/bench/src/providers/codex-cli.ts`
 * (`codex exec --json --output-last-message`, env allowlist, login-status
 * precheck) but lives in core so the standalone daemon and host plugins get
 * a working `api: "codex-cli"` transport without importing the optional
 * bench package. Registered through the existing
 * `setCodexCliFallbackRunnerForProcess` seam, and only when no host or
 * benchmark runner has claimed it first.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CodexCliFallbackConfig,
  CodexCliFallbackMessage,
  CodexCliFallbackRequest,
  CodexCliFallbackResult,
  CodexCliFallbackRunner,
} from "./cli-fallback.js";
import { isCodexCliFallbackRunnerRegistered, normalizeCodexCliTimeoutMs, setCodexCliFallbackRunnerForProcess } from "./cli-fallback.js";
import { log } from "./logger.js";
import { launchProcess } from "./runtime/child-process.js";
import type { CodexCliReasoningEffort, ModelProviderConfig } from "./types.js";
import { expandTildePath } from "./utils/path.js";

export const CODEX_SUBSCRIPTION_PROVIDER_ID = "codex-subscription";

/** Env var overriding the codex executable (mirrors the bench provider). */
const CODEX_EXECUTABLE_ENV = "REMNIC_CODEX_EXECUTABLE";

const DEFAULT_REASONING_EFFORT: CodexCliReasoningEffort = "medium";
const DEFAULT_TIMEOUT_MS = 120_000;
const LOGIN_STATUS_TIMEOUT_MS = 10_000;
const LOGIN_STATUS_CACHE_TTL_MS = 10 * 60_000;
const STDIO_LIMIT = 64_000;
const OUTPUT_SUMMARY_LIMIT = 500;

/**
 * Environment keys forwarded to the codex child. Everything else — including
 * ambient `OPENAI_API_KEY` / `OPENAI_BASE_URL` — is stripped so the CLI cannot
 * silently fall back to metered API-key auth instead of the subscription
 * login. Mirrors the bench provider's allowlist.
 */
const CODEX_RUNTIME_ENV_ALLOWLIST: Readonly<Record<string, true>> = Object.freeze({
  ALL_PROXY: true,
  APPDATA: true,
  CODEX_HOME: true,
  COLORTERM: true,
  COMSPEC: true,
  FORCE_COLOR: true,
  HOME: true,
  HOMEDRIVE: true,
  HOMEPATH: true,
  LANG: true,
  LOCALAPPDATA: true,
  LOGNAME: true,
  NO_COLOR: true,
  NODE_EXTRA_CA_CERTS: true,
  NO_PROXY: true,
  NUMBER_OF_PROCESSORS: true,
  OS: true,
  PATH: true,
  PATHEXT: true,
  PROGRAMDATA: true,
  PROCESSOR_ARCHITECTURE: true,
  HTTP_PROXY: true,
  HTTPS_PROXY: true,
  SHELL: true,
  SSL_CERT_DIR: true,
  SSL_CERT_FILE: true,
  SYSTEMDRIVE: true,
  SYSTEMROOT: true,
  TEMP: true,
  TERM: true,
  TMP: true,
  TMPDIR: true,
  USER: true,
  USERNAME: true,
  USERPROFILE: true,
  WINDIR: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_RUNTIME_DIR: true,
});

const LOGIN_OK_PATTERN = /logged in using chatgpt/i;
const LOGIN_API_KEY_PATTERN = /api key/i;
/** CLI output shapes that mean the subscription session was rejected. */
const AUTH_FAILURE_PATTERN =
  /\b401\b|\b403\b|unauthorized|forbidden|not logged in|no active|re-?authenticat|token expired|session expired|please log ?in/i;
const TIMEOUT_PATTERN = /timed out after \d+ms/i;
/** Secret shapes a codex CLI could echo into errors; replaced before surfacing. */
const SECRET_ECHO_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/g,
  /eyJ[A-Za-z0-9._-]{10,}/g,
];

/**
 * Built-in provider entry so `"codex-subscription/<model>"` chains resolve
 * with no models.json and no apiKey — the transport owns authentication.
 */
export function codexSubscriptionBuiltinProviderConfig(): ModelProviderConfig {
  return {
    baseUrl: "codex-cli://subscription",
    api: "codex-cli",
    models: [],
  };
}

export type CodexSubscriptionAuthReason = "unauthenticated" | "expired_or_revoked";

/** Login/authorization failure with actionable re-auth guidance. */
export class CodexSubscriptionAuthError extends Error {
  readonly reason: CodexSubscriptionAuthReason;

  constructor(reason: CodexSubscriptionAuthReason, message: string) {
    super(message);
    this.name = "CodexSubscriptionAuthError";
    this.reason = reason;
  }
}

/** Provider config violated the no-raw-credentials contract. */
export class CodexSubscriptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSubscriptionConfigError";
  }
}

/** Request exceeded its deadline. Abort-driven cancellations rethrow the
 * caller's own abort reason instead, preserving the AbortError contract. */
export class CodexSubscriptionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`codex-subscription request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export interface CodexSubscriptionExecRequest {
  executable: string;
  args: string[];
  input: string;
  env: NodeJS.ProcessEnv;
  outputPath: string;
  workspacePath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CodexSubscriptionExecResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputText: string;
}

export interface CodexSubscriptionRunnerDeps {
  /** Runs `codex exec`. Default: isolated subprocess via launchProcess. */
  runCodexExec?: (request: CodexSubscriptionExecRequest) => Promise<CodexSubscriptionExecResult>;
  /** Runs `codex login status`. Default: isolated subprocess. */
  runLoginStatus?: (
    executable: string,
    env: NodeJS.ProcessEnv
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  /** Environment the isolated child env is filtered from. Tests inject fakes. */
  env?: NodeJS.ProcessEnv;
  tmpdir?: () => string;
  now?: () => number;
}

interface CommandOutput {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const loginStatusCache = new Map<string, { at: number; promise: Promise<void> }>();
let coreRunnerRegistered = false;

export function createCodexSubscriptionRunner(deps: CodexSubscriptionRunnerDeps = {}): CodexCliFallbackRunner {
  const envSource = deps.env ?? process.env;
  return (request) => runCodexSubscriptionRequest(request, deps, envSource);
}

/**
 * Registers the core subprocess transport on the codex-cli seam, but only
 * when no runner is registered yet — a host or benchmark runner that claimed
 * the seam first always wins. Idempotent.
 */
export function ensureCodexSubscriptionRunnerRegistered(deps: CodexSubscriptionRunnerDeps = {}): boolean {
  if (isCodexCliFallbackRunnerRegistered()) return false;
  if (!coreRunnerRegistered) {
    setCodexCliFallbackRunnerForProcess(createCodexSubscriptionRunner(deps));
    coreRunnerRegistered = true;
  }
  return true;
}

async function runCodexSubscriptionRequest(
  request: CodexCliFallbackRequest,
  deps: CodexSubscriptionRunnerDeps,
  envSource: NodeJS.ProcessEnv
): Promise<CodexCliFallbackResult> {
  const { config } = request;
  assertNoApiKeyConfig(config);
  const executable = resolveExecutable(config, envSource);
  const env = buildIsolatedEnv(envSource);

  await assertSubscriptionLogin(executable, env, deps);

  if (request.options.signal?.aborted) {
    throw abortErrorOf(request.options.signal);
  }

  const providerTimeoutMs = config.retryOptions?.timeoutMs !== undefined
    ? normalizeCodexCliTimeoutMs(config.retryOptions.timeoutMs)
    : undefined;
  const timeoutMs = request.options.timeoutMs ?? providerTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(path.join(deps.tmpdir?.() ?? os.tmpdir(), "remnic-codex-sub-"));
    const workspacePath = path.join(tempDir, "workspace");
    const outputPath = path.join(tempDir, "last-message.txt");
    await mkdir(workspacePath, { recursive: true });

    const runCodexExec = deps.runCodexExec ?? runCodexExecSubprocess;
    const result = await runCodexExec({
      executable,
      args: buildExecArgs(request.modelId, config, workspacePath, outputPath),
      input: buildPrompt(request.messages),
      env,
      outputPath,
      workspacePath,
      timeoutMs,
      signal: request.options.signal,
    });

    if (request.options.signal?.aborted) {
      throw abortErrorOf(request.options.signal);
    }
    if (result.status !== 0) {
      throw execFailureError(result, timeoutMs, executable, env);
    }

    const content = result.outputText.trim();
    if (content.length === 0) {
      throw new Error(
        `codex-subscription: codex exec returned no final message (${summarizeOutput(result.stderr, result.stdout)})`
      );
    }
    return { content, ...usageFrom(result) };
  } finally {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
    }
  }
}

/**
 * This provider authenticates exclusively through the codex CLI login, so a
 * configured apiKey is a configuration mistake — reject it without echoing
 * the value.
 */
function assertNoApiKeyConfig(config: CodexCliFallbackConfig): void {
  if (config.apiKey !== undefined && config.apiKey !== "") {
    throw new CodexSubscriptionConfigError(
      `${CODEX_SUBSCRIPTION_PROVIDER_ID} does not accept apiKey configuration: it authenticates through the Codex CLI login. Remove the apiKey field and run \`codex login\` with a ChatGPT account instead.`
    );
  }
}

function resolveExecutable(config: CodexCliFallbackConfig, env: NodeJS.ProcessEnv): string {
  const configured = config.codexCliExecutable ?? config.executable ?? env[CODEX_EXECUTABLE_ENV] ?? "codex";
  const expanded = expandTildePath(String(configured).trim());
  if (expanded.trim().length === 0) {
    throw new CodexSubscriptionConfigError(`${CODEX_EXECUTABLE_ENV} / executable must not be empty`);
  }
  return expanded;
}

function buildIsolatedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isAllowedEnvKey(key)) {
      env[key] = value;
    }
  }
  return env;
}

function isAllowedEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return CODEX_RUNTIME_ENV_ALLOWLIST[normalized] === true || normalized.startsWith("LC_");
}

/**
 * Verifies the operator's Codex subscription login via `codex login status`.
 * Success is cached briefly; failures are never cached so a re-login takes
 * effect on the next request.
 */
async function assertSubscriptionLogin(
  executable: string,
  env: NodeJS.ProcessEnv,
  deps: CodexSubscriptionRunnerDeps
): Promise<void> {
  const now = deps.now ?? Date.now;
  const cacheKey = `${executable}\0${env.CODEX_HOME ?? env.HOME ?? ""}`;
  const cached = loginStatusCache.get(cacheKey);
  if (cached && now() - cached.at < LOGIN_STATUS_CACHE_TTL_MS) {
    await cached.promise;
    return;
  }
  const promise = (async () => {
    const runLoginStatus = deps.runLoginStatus ?? runLoginStatusSubprocess;
    const result = await runLoginStatus(executable, env);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.status === 0 && LOGIN_OK_PATTERN.test(output)) {
      return;
    }
    const apiKeyNote = LOGIN_API_KEY_PATTERN.test(output)
      ? " The CLI currently reports an API-key login; subscription extraction needs a ChatGPT login."
      : "";
    throw new CodexSubscriptionAuthError(
      "unauthenticated",
      `codex-subscription: no ChatGPT-backed Codex login found. Run \`codex login\` and choose the ChatGPT account option, then retry.${apiKeyNote}`
    );
  })();
  loginStatusCache.set(cacheKey, { at: now(), promise });
  try {
    await promise;
  } catch (err) {
    loginStatusCache.delete(cacheKey);
    throw err;
  }
}

/**
 * Args mirror the bench provider: fully sandboxed, ephemeral, no tools/hooks/
 * plugins/memories — extraction must behave as a plain completion endpoint.
 */
function buildExecArgs(
  modelId: string,
  config: CodexCliFallbackConfig,
  workspacePath: string,
  outputPath: string
): string[] {
  const reasoningEffort = readReasoningEffort(config) ?? DEFAULT_REASONING_EFFORT;
  return [
    "exec",
    "--strict-config",
    "--model",
    modelId,
    "--config",
    `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    "--config",
    'approval_policy="never"',
    "--config",
    'web_search="disabled"',
    "--disable",
    "hooks",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "multi_agent",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "computer_use",
    "--disable",
    "image_generation",
    "--disable",
    "in_app_browser",
    "--disable",
    "goals",
    "--disable",
    "memories",
    "--disable",
    "chronicle",
    "--disable",
    "tool_suggest",
    "--disable",
    "workspace_dependencies",
    "--disable",
    "shell_snapshot",
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
}

function readReasoningEffort(config: CodexCliFallbackConfig): CodexCliReasoningEffort | undefined {
  for (const value of [config.codexCliReasoningEffort, config.reasoningEffort]) {
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh") {
        return normalized;
      }
      throw new CodexSubscriptionConfigError(
        "codex-subscription reasoningEffort must be one of low, medium, high, xhigh (got unrecognized value)"
      );
    }
  }
  return undefined;
}

function buildPrompt(messages: readonly CodexCliFallbackMessage[]): string {
  const transcript = messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
  return [
    "You are acting as an LLM completion endpoint for a memory-extraction pipeline, not as a coding agent.",
    "Answer the request in the transcript below. Do not inspect files, run commands, browse, or use tools.",
    "Return only the final answer text. If the request asks for JSON, return raw JSON only.",
    "",
    "TRANSCRIPT:",
    transcript,
  ].join("\n");
}

function execFailureError(
  result: CodexSubscriptionExecResult,
  timeoutMs: number,
  executable: string,
  env: NodeJS.ProcessEnv
): Error {
  const combined = `${result.stderr}\n${result.stdout}`;
  if (AUTH_FAILURE_PATTERN.test(combined)) {
    // Re-check login on the next request; the cached status is now stale.
    loginStatusCache.delete(`${executable}\0${env.CODEX_HOME ?? env.HOME ?? ""}`);
    return new CodexSubscriptionAuthError(
      "expired_or_revoked",
      "codex-subscription: the Codex CLI rejected the request as unauthenticated " +
        "(session expired or revoked). Run `codex login` again to re-authenticate, then retry."
    );
  }
  if (TIMEOUT_PATTERN.test(combined)) {
    return new CodexSubscriptionTimeoutError(timeoutMs);
  }
  const exitLabel = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unknown"}`;
  return new Error(
    `codex-subscription: codex exec failed (${exitLabel}): ${summarizeOutput(result.stderr, result.stdout)}`
  );
}

/** Bounded, secret-redacted tail of child output — the only child text that
 * ever reaches a thrown error. */
function summarizeOutput(stderr: string, stdout: string): string {
  const summary = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join("\n");
  const bounded = summary.length > 0 ? summary.slice(-OUTPUT_SUMMARY_LIMIT) : "no process output";
  return redactSecretEchoes(bounded);
}

export function redactSecretEchoes(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_ECHO_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}
type CodexSubscriptionUsage = Pick<CodexCliFallbackResult, "usage">;

function usageFrom(result: CodexSubscriptionExecResult): CodexSubscriptionUsage {
  const usage = parseCodexJsonlUsage(`${result.stdout}\n${result.stderr}`);
  if (!usage) {
    return {};
  }
  return {
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
    },
  };
}
/** Parses `turn.completed` usage events from codex exec JSONL output.
 * Mirrors the bench parser (core cannot import the optional bench package). */
export function parseCodexJsonlUsage(output: string): { inputTokens: number; outputTokens: number } | undefined {
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        usage?: Record<string, unknown>;
      };
      if (event.type !== "turn.completed" || !event.usage) continue;
      const inputTokens = readCounter(event.usage.input_tokens);
      const outputTokens = readCounter(event.usage.output_tokens);
      if (inputTokens !== undefined && outputTokens !== undefined) {
        usage = { inputTokens, outputTokens };
      }
    } catch {
      // codex exec prints non-JSON status text alongside JSONL; ignore it
    }
  }
  return usage;
}

function readCounter(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function abortErrorOf(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (signal.reason !== undefined) return new Error(String(signal.reason));
  return new DOMException("The operation was aborted.", "AbortError");
}

function appendBounded(existing: string, next: string): string {
  let combined = existing + next;
  if (combined.length > STDIO_LIMIT) {
    combined = combined.slice(0, STDIO_LIMIT);
  }
  return combined;
}

async function runLoginStatusSubprocess(
  executable: string,
  env: NodeJS.ProcessEnv
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await runSubprocess(executable, ["login", "status"], {
    env,
    stdin: undefined,
    timeoutMs: LOGIN_STATUS_TIMEOUT_MS,
    timeoutLabel: "login status",
  });
}

async function runCodexExecSubprocess(request: CodexSubscriptionExecRequest): Promise<CodexSubscriptionExecResult> {
  const result = await runSubprocess(request.executable, request.args, {
    env: request.env,
    stdin: request.input,
    timeoutMs: request.timeoutMs,
    timeoutLabel: "exec",
    signal: request.signal,
    cwd: request.workspacePath,
  });
  let outputText = "";
  try {
    outputText = (await readFile(request.outputPath, "utf8")).trim();
  } catch {
    // Missing output file surfaces as the no-final-message error path.
  }
  return { ...result, outputText };
}

interface SubprocessOptions {
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  timeoutLabel: string;
  signal?: AbortSignal;
  cwd?: string;
}

async function runSubprocess(executable: string, args: string[], options: SubprocessOptions): Promise<CommandOutput> {
  return await new Promise<CommandOutput>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortErrorOf(options.signal));
      return;
    }
    const child = launchProcess(executable, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const clearKillTimeout = (): void => {
      if (killTimeout) {
        clearTimeout(killTimeout);
        killTimeout = undefined;
      }
    };
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // fall through to killing the direct child
        }
      }
      child.kill(signal);
    };
    const scheduleForcedKill = (): void => {
      clearKillTimeout();
      killTimeout = setTimeout(() => terminate("SIGKILL"), 1_000);
      killTimeout.unref();
    };
    const onAbort = (): void => {
      terminate("SIGTERM");
      scheduleForcedKill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stderr = appendBounded(
            stderr,
            `\ncodex-subscription: ${options.timeoutLabel} timed out after ${options.timeoutMs}ms.`
          );
          terminate("SIGTERM");
          scheduleForcedKill();
        }, options.timeoutMs)
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
      stderr = appendBounded(stderr, `\ncodex-subscription: stdin error: ${error.code ?? error.message}`);
    });
    const settle = (fn: () => void): void => {
      clearTimeout(timeout);
      clearKillTimeout();
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("error", (error) => {
      settle(() => {
        reject(
          child.pid
            ? new Error(`codex-subscription: codex CLI failed after start: ${safeMessage(error)}`, { cause: error })
            : new CodexSubscriptionAuthError(
                "unauthenticated",
                `codex-subscription: codex CLI not found at \`${executable}\` — install the Codex CLI and run \`codex login\` with a ChatGPT account, then retry.`
              )
        );
      });
    });
    child.on("close", (status, signal) => {
      settle(() => {
        resolve({
          status: timedOut ? (status ?? 124) : status,
          signal: timedOut ? (signal ?? "SIGTERM") : signal,
          stdout,
          stderr,
        });
      });
    });
    if (options.stdin !== undefined) {
      try {
        child.stdin?.end(options.stdin);
      } catch (error) {
        log.debug(`codex-subscription: failed writing prompt to stdin: ${safeMessage(error)}`);
      }
    }
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __codexSubscriptionTestHooks = {
  resetLoginStatusCache: (): void => {
    loginStatusCache.clear();
  },
  isCoreRunnerRegistered: (): boolean => coreRunnerRegistered,
  resetCoreRunnerRegistered: (): void => {
    coreRunnerRegistered = false;
  },
};
