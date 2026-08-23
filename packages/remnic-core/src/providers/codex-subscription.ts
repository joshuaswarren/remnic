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

import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CodexCliFallbackConfig,
  CodexCliFallbackMessage,
  CodexCliFallbackRequest,
  CodexCliFallbackResult,
  CodexCliFallbackRunner,
} from "../cli-fallback.js";
import { isCodexCliFallbackRunnerRegistered, normalizeCodexCliTimeoutMs, setCodexCliFallbackRunnerForProcess } from "../cli-fallback.js";
import { log } from "../logger.js";
import { launchProcess } from "../runtime/child-process.js";
import type { CodexCliReasoningEffort, ModelProviderConfig } from "../types.js";
import { expandTildePath } from "../utils/path.js";

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
 * Env keys whose value is a filesystem path. Relative values resolve against
 * the original process cwd before either child launches, because the exec
 * child runs with cwd = the ephemeral workspace (same rule as executables).
 */
const PATH_BEARING_ENV_KEYS: Readonly<Record<string, true>> = Object.freeze({ CODEX_HOME: true, HOME: true, USERPROFILE: true });

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
  /** Runs `codex login status`. Default: isolated subprocess. Receives the
   * login-status timeout budget (capped by the request deadline) and the
   * shared-check abort signal (fires when the last waiter leaves). */
  runLoginStatus?: (
    executable: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    signal?: AbortSignal
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

interface LoginStatusCacheEntry {
  at: number;
  promise: Promise<void>;
  /** Auth-store fingerprint at check time; a mismatch invalidates the entry. */
  fingerprint: string | null;
  /** Live waiters. The in-flight check aborts when the last waiter leaves. */
  waiters: number;
  settled: boolean;
  controller: AbortController;
}

const loginStatusCache = new Map<string, LoginStatusCacheEntry>();
const childrenByRunner = new WeakMap<CodexCliFallbackRunner, Set<number>>();
const runnerByOwner = new WeakMap<object, CodexCliFallbackRunner>();
let defaultRegisteredRunner: CodexCliFallbackRunner | undefined;
let coreRunnerRegistered = false;

export function createCodexSubscriptionRunner(deps: CodexSubscriptionRunnerDeps = {}): CodexCliFallbackRunner {
  const envSource = deps.env ?? process.env;
  const children = new Set<number>();
  const runnerDeps: CodexSubscriptionRunnerDeps = {
    ...deps,
    runCodexExec: deps.runCodexExec ?? ((request) => runCodexExecSubprocess(request, children)),
    runLoginStatus:
      deps.runLoginStatus ??
      ((executable, env, timeoutMs, signal) =>
        runLoginStatusSubprocess(executable, env, timeoutMs, signal, children)),
  };
  const runner: CodexCliFallbackRunner = (request) =>
    runCodexSubscriptionRequest(request, runnerDeps, envSource);
  childrenByRunner.set(runner, children);
  return runner;
}

/** One runner per owning runtime/config object so teardown cannot cross instances. */
export function getCodexSubscriptionRunnerForOwner(owner: object): CodexCliFallbackRunner {
  let runner = runnerByOwner.get(owner);
  if (!runner) {
    runner = createCodexSubscriptionRunner();
    runnerByOwner.set(owner, runner);
  }
  return runner;
}

/**
 * Registers the core subprocess transport on the codex-cli seam, but only
 * when no runner is registered yet — a host or benchmark runner that claimed
 * the seam first always wins. If the seam was cleared afterwards
 * (setCodexCliFallbackRunnerForProcess(undefined)), the core runner is
 * re-registered so the next call still routes. Idempotent.
 */
export function ensureCodexSubscriptionRunnerRegistered(deps: CodexSubscriptionRunnerDeps = {}): boolean {
  if (isCodexCliFallbackRunnerRegistered()) return false;
  defaultRegisteredRunner = createCodexSubscriptionRunner(deps);
  setCodexCliFallbackRunnerForProcess(defaultRegisteredRunner);
  coreRunnerRegistered = true;
  return true;
}

/** Host shutdown hook: terminate this runtime's detached Codex children. Does not exit. */
export function terminateActiveCodexSubscriptionChildren(
  signal: NodeJS.Signals = "SIGTERM",
  runner?: CodexCliFallbackRunner,
): void {
  const target = runner ?? defaultRegisteredRunner;
  if (!target) return;
  const pids = childrenByRunner.get(target);
  if (!pids) return;
  for (const pid of pids) {
    terminateCodexChildPid(pid, signal);
  }
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

  const providerTimeoutMs = config.retryOptions?.timeoutMs !== undefined
    ? normalizeCodexCliTimeoutMs(config.retryOptions.timeoutMs)
    : undefined;
  const timeoutMs = request.options.timeoutMs ?? providerTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The effective deadline starts BEFORE the login-status precheck: login
  // consumes the same call/provider timeout budget, it is not additive.
  const now = deps.now ?? Date.now;
  const deadlineStartedAt = now();
  if (request.options.signal?.aborted) {
    throw abortErrorOf(request.options.signal);
  }
  await assertSubscriptionLogin(executable, env, deps, {
    loginStatusTimeoutMs: Math.min(LOGIN_STATUS_TIMEOUT_MS, timeoutMs),
    callerTimeoutMs: timeoutMs,
    deadlineStartedAt,
    signal: request.options.signal,
  });

  if (request.options.signal?.aborted) {
    throw abortErrorOf(request.options.signal);
  }

  const remainingTimeoutMs = timeoutMs - (now() - deadlineStartedAt);
  if (remainingTimeoutMs <= 0) {
    throw new CodexSubscriptionTimeoutError(timeoutMs);
  }
  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(path.join(deps.tmpdir?.() ?? os.tmpdir(), "remnic-codex-sub-"));
    const workspacePath = path.join(tempDir, "workspace");
    const outputPath = path.join(tempDir, "last-message.txt");
    await mkdir(workspacePath, { recursive: true });

    const runCodexExec = deps.runCodexExec!;
    const result = await runCodexExec({
      executable,
      args: buildExecArgs(request.modelId, config, workspacePath, outputPath),
      input: buildPrompt(request.messages),
      env,
      outputPath,
      workspacePath,
      timeoutMs: remainingTimeoutMs,
      signal: request.options.signal,
    });

    if (result.status !== 0) {
      const failure = execFailureError(result, remainingTimeoutMs, executable, env);
      if (failure instanceof CodexSubscriptionTimeoutError) {
        throw failure;
      }
      if (request.options.signal?.aborted) {
        throw abortErrorOf(request.options.signal);
      }
      throw failure;
    }
    if (request.options.signal?.aborted) {
      throw abortErrorOf(request.options.signal);
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
export function assertNoApiKeyConfig(config: CodexCliFallbackConfig): void {
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
  // The exec child runs with cwd = the temp workspace, and spawn resolves a
  // relative executable against the CHILD cwd. Resolve relative paths against
  // the original process cwd now so `./codex` stays valid; bare names keep
  // PATH lookup.
  if (expanded.includes("/") || expanded.includes("\\")) {
    return path.resolve(expanded);
  }
  return expanded;
}

function buildIsolatedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isAllowedEnvKey(key)) {
      env[key] = PATH_BEARING_ENV_KEYS[key.toUpperCase()] === true
        ? normalizePathEnvValue(value)
        : value;
    }
  }
  return env;
}

/**
 * The exec child runs with cwd = the ephemeral workspace while the login
 * child runs with cwd = this process, so a relative HOME/CODEX_HOME would
 * resolve differently per child. Anchor both to the original process cwd.
 */
function normalizePathEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  const expanded = expandTildePath(trimmed);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

function isAllowedEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return CODEX_RUNTIME_ENV_ALLOWLIST[normalized] === true || normalized.startsWith("LC_");
}

interface LoginCheckContext {
  /** Budget for the login-status subprocess itself. */
  loginStatusTimeoutMs: number;
  /** The caller's overall effective deadline (login + exec). */
  callerTimeoutMs: number;
  deadlineStartedAt: number;
  signal?: AbortSignal;
}

/**
 * Verifies the operator's Codex subscription login via `codex login status`.
 * Success is cached briefly; failures are never cached so a re-login takes
 * effect on the next request. A cached success is also invalidated when the
 * auth store changes on disk (e.g. another process switches the same Codex
 * home from a ChatGPT login to an API key), so the cache can never mask a
 * later non-subscription login mode.
 */
async function assertSubscriptionLogin(
  executable: string,
  env: NodeJS.ProcessEnv,
  deps: CodexSubscriptionRunnerDeps,
  ctx: LoginCheckContext
): Promise<void> {
  const now = deps.now ?? Date.now;
  const cacheKey = `${executable}\0${env.CODEX_HOME ?? env.HOME ?? ""}`;
  const cached = loginStatusCache.get(cacheKey);
  if (cached && now() - cached.at < LOGIN_STATUS_CACHE_TTL_MS) {
    if (!cached.settled || (await authStoreFingerprint(env)) === cached.fingerprint) {
      await waitForLoginEntry(cached, cacheKey, ctx, now);
      return;
    }
  }
  loginStatusCache.delete(cacheKey);
  if (ctx.signal?.aborted) {
    throw abortErrorOf(ctx.signal);
  }
  const entry: LoginStatusCacheEntry = {
    at: now(),
    fingerprint: null,
    waiters: 0,
    settled: false,
    controller: new AbortController(),
    promise: Promise.resolve(undefined),
  };
  entry.promise = runLoginStatusCheck(executable, env, deps, ctx, entry);
  entry.promise.then(
    () => {
      entry.settled = true;
    },
    () => {
      entry.settled = true;
      if (loginStatusCache.get(cacheKey) === entry) {
        loginStatusCache.delete(cacheKey);
      }
    }
  );
  loginStatusCache.set(cacheKey, entry);
  await waitForLoginEntry(entry, cacheKey, ctx, now);
}

async function runLoginStatusCheck(
  executable: string,
  env: NodeJS.ProcessEnv,
  deps: CodexSubscriptionRunnerDeps,
  ctx: LoginCheckContext,
  entry: LoginStatusCacheEntry
): Promise<void> {
  const runLoginStatus = deps.runLoginStatus!;
  const result = await runLoginStatus(executable, env, ctx.loginStatusTimeoutMs, entry.controller.signal);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (TIMEOUT_PATTERN.test(output)) {
    // A login-status subprocess timeout is a deadline expiry, not an auth
    // failure — never report it as "unauthenticated".
    throw new CodexSubscriptionTimeoutError(ctx.loginStatusTimeoutMs);
  }
  if (result.status === 0 && LOGIN_OK_PATTERN.test(output)) {
    entry.fingerprint = await authStoreFingerprint(env);
    return;
  }
  const apiKeyNote = LOGIN_API_KEY_PATTERN.test(output)
    ? " The CLI currently reports an API-key login; subscription extraction needs a ChatGPT login."
    : "";
  throw new CodexSubscriptionAuthError(
    "unauthenticated",
    `codex-subscription: no ChatGPT-backed Codex login found. Run \`codex login\` and choose the ChatGPT account option, then retry.${apiKeyNote}`
  );
}

/**
 * Waits on a shared login check with this caller's own budget. A deadline or
 * caller abort rejects immediately — without cancelling the shared check
 * while other callers still wait on it. When the LAST waiter leaves an
 * in-flight check, the subprocess is aborted and the entry dropped so a later
 * caller starts a fresh check.
 */
async function waitForLoginEntry(
  entry: LoginStatusCacheEntry,
  cacheKey: string,
  ctx: LoginCheckContext,
  now: () => number
): Promise<void> {
  const remainingMs = ctx.callerTimeoutMs - (now() - ctx.deadlineStartedAt);
  if (remainingMs <= 0) {
    throw new CodexSubscriptionTimeoutError(ctx.callerTimeoutMs);
  }
  const signal = ctx.signal;
  let rejectOnAbort!: (reason?: unknown) => void;
  const abortWait = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  // Identity matters: the same reference is removed in the finally below.
  const onAbort = (): void => {
    if (signal === undefined) return;
    rejectOnAbort(abortErrorOf(signal));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  entry.waiters++;
  // The deadline timer intentionally holds the event loop: this caller's
  // await is backed by nothing else while the shared check is in flight.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entry.promise,
      abortWait,
      new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new CodexSubscriptionTimeoutError(ctx.callerTimeoutMs)),
          remainingMs
        );
      }),
    ]);
  } catch (err) {
    if (signal?.aborted) {
      throw abortErrorOf(signal);
    }
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", onAbort);
    entry.waiters--;
    if (entry.waiters <= 0 && !entry.settled) {
      entry.controller.abort();
      if (loginStatusCache.get(cacheKey) === entry) {
        loginStatusCache.delete(cacheKey);
      }
    }
  }
}

/**
 * `mtimeMs:size` of the Codex auth store, read as metadata only — the
 * provider never reads the store's contents. A change between the cached
 * check and now invalidates the cached login mode.
 */
async function authStoreFingerprint(env: NodeJS.ProcessEnv): Promise<string | null> {
  const home = env.CODEX_HOME
    ?? (env.HOME ? path.join(env.HOME, ".codex") : undefined);
  if (!home) {
    return null;
  }
  try {
    const stats = await stat(path.join(home, "auth.json"));
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
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

/**
 * One JSON object per message: role boundaries are structural (JSON string
 * escaping), so literal `[system]`/role-marker text inside message content
 * can never forge another role's turn. Content stays model-visible verbatim.
 */
function buildPrompt(messages: readonly CodexCliFallbackMessage[]): string {
  const transcript = messages
    .map((message) => JSON.stringify({ role: message.role, content: message.content }))
    .join("\n");
  return [
    "You are acting as an LLM completion endpoint for a memory-extraction pipeline, not as a coding agent.",
    "Answer the request in the transcript below. Do not inspect files, run commands, browse, or use tools.",
    "Return only the final answer text. If the request asks for JSON, return raw JSON only.",
    "",
    'TRANSCRIPT (JSON Lines: one {"role":"...","content":"..."} object per message; newlines inside content are escaped):',
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
  // The authoritative timeout marker wins over auth-pattern text: a timed-out
  // exec may have already printed model/diagnostic output containing 401/403
  // before the deadline fired (issue #2833).
  if (TIMEOUT_PATTERN.test(combined)) {
    return new CodexSubscriptionTimeoutError(timeoutMs);
  }
  if (AUTH_FAILURE_PATTERN.test(combined)) {
    // Re-check login on the next request; the cached status is now stale.
    loginStatusCache.delete(`${executable}\0${env.CODEX_HOME ?? env.HOME ?? ""}`);
    return new CodexSubscriptionAuthError(
      "expired_or_revoked",
      "codex-subscription: the Codex CLI rejected the request as unauthenticated " +
        "(session expired or revoked). Run `codex login` again to re-authenticate, then retry."
    );
  }
  const exitLabel = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unknown"}`;
  return new Error(
    `codex-subscription: codex exec failed (${exitLabel}): ${summarizeOutput(result.stderr, result.stdout)}`
  );
}

/** Secret-redacted, then bounded tail of child output — the only child text
 * that ever reaches a thrown error. Redaction runs BEFORE bounding so a
 * secret straddling the cutoff cannot survive as an unmatchable fragment. */
function summarizeOutput(stderr: string, stdout: string): string {
  const summary = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join("\n");
  if (summary.length === 0) {
    return "no process output";
  }
  return redactSecretEchoes(summary).slice(-OUTPUT_SUMMARY_LIMIT);
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
  if (signal.reason instanceof CodexSubscriptionTimeoutError) return signal.reason;
  const reason =
    signal.reason instanceof Error
      ? signal.reason
      : signal.reason !== undefined
        ? new Error(String(signal.reason))
        : new DOMException("The operation was aborted.", "AbortError");
  const match = /timed out after (\d+)ms/i.exec(reason.message);
  if (match) {
    return new CodexSubscriptionTimeoutError(Number(match[1]));
  }
  return reason;
}

/** Bounds streamed child output to STDIO_LIMIT, keeping the TAIL — codex
 * prints its final error or turn.completed result last. Secrets are redacted
 * BEFORE bounding so one straddling the cutoff cannot leak a fragment. */
function appendBounded(existing: string, next: string): string {
  const redacted = redactSecretEchoes(existing + next);
  return redacted.length > STDIO_LIMIT ? redacted.slice(-STDIO_LIMIT) : redacted;
}

async function runLoginStatusSubprocess(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  children: Set<number>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await runSubprocess(executable, ["login", "status"], {
    env,
    stdin: undefined,
    timeoutMs,
    timeoutLabel: "login status",
    signal,
    children,
  });
}

async function runCodexExecSubprocess(
  request: CodexSubscriptionExecRequest,
  children: Set<number>,
): Promise<CodexSubscriptionExecResult> {
  const result = await runSubprocess(request.executable, request.args, {
    env: request.env,
    stdin: request.input,
    timeoutMs: request.timeoutMs,
    timeoutLabel: "exec",
    signal: request.signal,
    cwd: request.workspacePath,
    children,
  });
  if (result.status === 124) return { ...result, outputText: "" };
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
  children: Set<number>;
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
    registerActiveCodexChild(child.pid, options.children);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
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
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const settleTimeout = (): void => {
      timedOut = true;
      stderr = appendBounded(
        stderr,
        `\ncodex-subscription: ${options.timeoutLabel} timed out after ${options.timeoutMs}ms.`
      );
      finish(() => {
        resolve({
          status: 124,
          signal: "SIGTERM",
          stdout,
          stderr,
        });
      });
    };
    const onAbort = (): void => {
      const reasonText =
        options.signal?.reason instanceof Error
          ? options.signal.reason.message
          : String(options.signal?.reason ?? "");
      terminate("SIGTERM");
      scheduleForcedKill();
      if (TIMEOUT_PATTERN.test(reasonText)) {
        settleTimeout();
        return;
      }
      finish(() => reject(abortErrorOf(options.signal!)));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          terminate("SIGTERM");
          scheduleForcedKill();
          settleTimeout();
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
    child.on("error", (error) => {
      unregisterActiveCodexChild(child.pid, options.children);
      finish(() => {
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
      clearKillTimeout();
      unregisterActiveCodexChild(child.pid, options.children);
      finish(() => {
        resolve({
          status: timedOut ? (status === null || status === 0 ? 124 : status) : status,
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
  activeCodexChildCount: (runner?: CodexCliFallbackRunner): number => {
    const target = runner ?? defaultRegisteredRunner;
    return target ? (childrenByRunner.get(target)?.size ?? 0) : 0;
  },
  appendBounded,
  resetLoginStatusCache: (): void => {
    loginStatusCache.clear();
  },
  isCoreRunnerRegistered: (): boolean => coreRunnerRegistered,
  resetCoreRunnerRegistered: (): void => {
    coreRunnerRegistered = false;
    defaultRegisteredRunner = undefined;
  },
};

function registerActiveCodexChild(pid: number | undefined, children: Set<number>): void {
  if (pid === undefined) return;
  children.add(pid);
}

function unregisterActiveCodexChild(pid: number | undefined, children: Set<number>): void {
  if (pid === undefined) return;
  children.delete(pid);
}

function terminateCodexChildPid(pid: number, signal: NodeJS.Signals): void {
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
