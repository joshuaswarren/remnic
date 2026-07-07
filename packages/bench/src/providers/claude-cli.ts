import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

interface ClaudeCliRunRequest {
  executable: string;
  args: string[];
  input: string;
  cwd: string;
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
 * Subset of `claude -p --output-format json` stdout we rely on. The CLI's
 * JSON result schema is not versioned/published, so this only reads the
 * fields that have been stable across `claude --help` output: `result`
 * (answer text, or the error text when `is_error` is true), `is_error`,
 * and `usage` token counts. Anything else (session_id, duration_ms,
 * total_cost_usd, num_turns, ...) is intentionally ignored because
 * `CompletionResult` has no field for it.
 */
interface ClaudeCliJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const CLAUDE_CLI_STDIO_LIMIT = 64_000;
const CLAUDE_CLI_PARENT_SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];
const CLAUDE_CLI_FORCED_PARENT_EXIT_MS = 1_000;
const CLAUDE_CLI_EXECUTABLE_ENV = "REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE";
const CLAUDE_CLI_VERSION_TIMEOUT_MS = 5_000;

/** Default model alias when a config does not pin an explicit model.
 * There is no repo-wide "current Opus model id" constant for the `claude`
 * CLI (unlike e.g. a pinned OpenAI model string) — the CLI itself exposes
 * stable rolling aliases (`--model opus|sonnet|fable`) specifically so
 * callers do not have to hardcode a dated model id that goes stale. Bench
 * CLI wiring / callers still set `config.model` explicitly per run; this
 * constant only documents the recommended default for a Tier-F "Opus as
 * judge" invocation. */
export const DEFAULT_CLAUDE_CLI_MODEL_ALIAS = "opus";

/**
 * Runtime env keys forwarded to the `claude` child process. Deliberately
 * does NOT include ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL by default: this
 * provider exists specifically to run `claude -p` against the operator's
 * Claude Max subscription (OAuth/keychain auth), which is free under the
 * plan's usage caps. Leaking an ambient ANTHROPIC_API_KEY into the child
 * would silently switch it to metered API billing instead. HOME is kept
 * pointed at the real user home (not redirected) so the CLI can still find
 * its OAuth session — isolation from CLAUDE.md / project settings is
 * achieved via `--safe-mode` plus a freshly created empty cwd instead, see
 * `buildClaudeCliArgs`. CLAUDE_CODE_OAUTH_TOKEN IS forwarded: it is the
 * subscription OAuth token (free under the Max plan) used to authenticate
 * headless/CI runs that have no interactive keychain login — unlike
 * ANTHROPIC_API_KEY it does not switch the child to metered API billing.
 */
const CLAUDE_CLI_RUNTIME_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CLAUDE_CODE_OAUTH_TOKEN",
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

/** Default wall-clock budget (ms) to keep backing off on detected Claude
 * usage/session-limit responses before giving up. This is deliberately far
 * longer than a normal transient-failure retry: a Claude Max 5-hour/weekly
 * cap does not clear in seconds. Overridable via `retryOptions.max429WaitMs`
 * (the same field `retryFetch` uses for provider-side quota waits). */
const DEFAULT_USAGE_LIMIT_MAX_WAIT_MS = 30 * 60 * 1000;
/** Base backoff (ms) for the first usage-limit retry; doubles each attempt. */
const USAGE_LIMIT_BASE_BACKOFF_MS = 60_000;
/** Backoff ceiling (ms) for any single usage-limit retry step. */
const USAGE_LIMIT_MAX_STEP_MS = 10 * 60 * 1000;

const activeClaudeCliChildPids = new Set<number>();
let claudeCliParentCleanupInstalled = false;

/** Serializes `.complete()` calls so the harness never fires concurrent
 * `claude -p` invocations against the operator's shared Claude Max quota.
 * Defaults to 1 (fully serialized); `config.concurrency` can raise this for
 * local testing but should stay at 1 for real benchmark runs.
 *
 * IMPORTANT: this gate must be shared process-wide (see
 * `getSharedClaudeCliGate` below), not one-per-`ClaudeCliProvider`. A
 * benchmark run constructs separate `claude-cli` provider instances for the
 * responder and the judge; if each held its own gate, a responder call and a
 * judge call could still run `claude -p` concurrently against the same
 * Claude Max session, defeating the whole point of serializing (PR #1735
 * review). */
class ClaudeCliConcurrencyGate {
  private active = 0;
  private limit: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = normalizeGateLimit(limit);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Raises the gate's limit if `limit` is higher than the current one;
   * never lowers it. Immediately wakes any queued waiters that fit under
   * the new, higher limit — see `getSharedClaudeCliGate` for the policy
   * this implements (shared max across all constructed instances). */
  raiseLimit(limit: number): void {
    const normalized = normalizeGateLimit(limit);
    if (normalized <= this.limit) {
      return;
    }
    this.limit = normalized;
    while (this.active < this.limit) {
      const next = this.waiters.shift();
      if (!next) {
        break;
      }
      next();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

function normalizeGateLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
}

/** Process-wide `claude -p` concurrency gate, shared by every
 * `ClaudeCliProvider` instance in this process (see `ClaudeCliConcurrencyGate`
 * doc for why a per-instance gate is unsafe). Lazily created on first use
 * with limit 1.
 *
 * Concurrency-sharing policy when instances disagree: the gate is a true
 * singleton, and its limit only ever goes UP, never down — each
 * `ClaudeCliProvider` constructor call passes its own `config.concurrency`
 * (default 1) here, and the shared gate's limit becomes the MAX of every
 * value seen so far. This is deliberate: 1 is the only limit that is safe
 * for a real benchmark run sharing the operator's Claude Max session, so any
 * single instance opting into a higher number is assumed to be an explicit,
 * deliberate local-testing choice — and per the finding this fixes, that
 * higher shared budget is intentionally what every other `claude-cli`
 * instance in the same process (e.g. both the responder and the judge) gets
 * too, since they all draw on the same underlying quota regardless of which
 * instance raised the limit. Do not reach for a per-instance override here:
 * that would silently reintroduce the concurrent-subprocess bug this fixes. */
let sharedClaudeCliGate: ClaudeCliConcurrencyGate | undefined;

function getSharedClaudeCliGate(requestedLimit: number): ClaudeCliConcurrencyGate {
  if (!sharedClaudeCliGate) {
    sharedClaudeCliGate = new ClaudeCliConcurrencyGate(requestedLimit);
    return sharedClaudeCliGate;
  }
  sharedClaudeCliGate.raiseLimit(requestedLimit);
  return sharedClaudeCliGate;
}

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
  private readonly gate: ClaudeCliConcurrencyGate;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: ClaudeCliProviderConfig, deps: ClaudeCliProviderDeps = {}) {
    this.config = config;
    this.runClaudeCli = deps.runClaudeCli ?? runClaudeCliCommand;
    this.runClaudeVersion = deps.runClaudeVersion ?? runClaudeVersionCommand;
    this.gate = getSharedClaudeCliGate(config.concurrency ?? 1);
    this.id = `claude-cli:${config.model}`;
    this.name = config.model;
  }

  async complete(prompt: string, opts: CompletionOpts = {}): Promise<CompletionResult> {
    return this.gate.run(() => this.completeSerialized(prompt, opts));
  }

  private async completeSerialized(
    prompt: string,
    opts: CompletionOpts,
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    const maxAttempts = normalizeClaudeCliMaxAttempts(this.config.retryOptions?.maxAttempts);
    const usageLimitBudgetMs = normalizeUsageLimitMaxWaitMs(this.config.retryOptions?.max429WaitMs);
    const loopStartedAt = performance.now();

    for (let attempt = 1; ; attempt += 1) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-claude-cli-"));

      try {
        const request = this.buildRunRequest(prompt, opts, tempDir);
        const result = await this.runClaudeCli(request);

        if (result.status !== 0) {
          // Usage-limit detection is deliberately restricted to FAILURE
          // paths (non-zero exits here, is_error payloads below). A
          // successful benchmark answer that merely mentions "rate limit"
          // or "429" must never trigger backoff.
          if (isClaudeUsageLimitSignal(`${result.stderr}\n${result.stdout}`)) {
            await sleepBeforeUsageLimitRetry({
              attempt,
              loopStartedAt,
              budgetMs: usageLimitBudgetMs,
              failureSummary: summarizeProcessOutput(result.stderr, result.stdout),
              signal: opts.signal,
            });
            continue;
          }
          const exitLabel = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unknown"}`;
          const error = new Error(
            `Claude CLI completion failed (${exitLabel}): ${summarizeProcessOutput(result.stderr, result.stdout)}`,
          );
          if (attempt < maxAttempts && isRetryableClaudeCliResult(result)) {
            await sleepBeforeClaudeCliRetry({
              attempt,
              baseBackoffMs: this.config.retryOptions?.baseBackoffMs,
              maxStepMs: 30_000,
              capMs: Number.POSITIVE_INFINITY,
              signal: opts.signal,
            });
            continue;
          }
          throw error;
        }

        const payload = parseClaudeCliJsonResult(result.stdout);
        if (payload.is_error) {
          // Usage-limit responses can surface as a zero-exit is_error JSON
          // payload, or as bare stderr with empty stdout — both land here.
          if (
            isClaudeUsageLimitSignal(
              `${result.stderr}\n${payload.error ?? ""}\n${payload.result ?? ""}`,
            )
          ) {
            await sleepBeforeUsageLimitRetry({
              attempt,
              loopStartedAt,
              budgetMs: usageLimitBudgetMs,
              failureSummary: summarizeProcessOutput(result.stderr, result.stdout),
              signal: opts.signal,
            });
            continue;
          }
          throw new Error(
            `Claude CLI reported is_error: ${
              payload.error?.trim() || payload.result?.trim() || summarizeProcessOutput(result.stderr, result.stdout)
            }`,
          );
        }

        const text = (payload.result ?? "").trim();
        if (text.length === 0) {
          // A zero-exit, empty-result payload whose quota text lives only on
          // stderr is still a usage-limit failure — back off like the other
          // failure shapes instead of throwing a terminal "no result text".
          if (isClaudeUsageLimitSignal(`${result.stderr}\n${payload.error ?? ""}`)) {
            await sleepBeforeUsageLimitRetry({
              attempt,
              loopStartedAt,
              budgetMs: usageLimitBudgetMs,
              failureSummary: summarizeProcessOutput(result.stderr, result.stdout),
              signal: opts.signal,
            });
            continue;
          }
          throw new Error(
            `Claude CLI completion returned no result text: ${summarizeProcessOutput(result.stderr, result.stdout)}`,
          );
        }

        const inputTokens = nonNegativeInt(payload.usage?.input_tokens);
        const outputTokens = nonNegativeInt(payload.usage?.output_tokens);
        this.recordUsage(inputTokens, outputTokens);

        return {
          text,
          tokens: { input: inputTokens, output: outputTokens },
          latencyMs: Math.round(performance.now() - startedAt),
          model: this.config.model,
        };
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    }
  }

  async discover(): Promise<DiscoveredModel[]> {
    const version = await this.runClaudeVersion(
      resolveClaudeCliExecutable(this.config),
      buildIsolatedClaudeEnv(this.config),
    );
    if (version.status !== 0) {
      throw new Error(
        `Claude CLI discovery failed: ${version.stderr.trim() || `exit ${version.status ?? "unknown"}`}`,
      );
    }

    return [
      {
        id: this.config.model,
        name: `${this.config.model} (Claude CLI)`,
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

  private buildRunRequest(prompt: string, opts: CompletionOpts, cwd: string): ClaudeCliRunRequest {
    return {
      executable: resolveClaudeCliExecutable(this.config),
      args: buildClaudeCliArgs(this.config, opts.systemPrompt),
      input: buildClaudeCompletionPrompt(prompt),
      cwd,
      timeoutMs: this.config.retryOptions?.timeoutMs,
      signal: opts.signal,
      env: buildIsolatedClaudeEnv(this.config, opts.maxTokens),
    };
  }
}

/**
 * Builds the isolated, tool-free `claude -p` invocation.
 *
 * - `--safe-mode` disables CLAUDE.md/skills/plugins/hooks/MCP/custom agents
 *   while leaving subscription auth and model selection intact (the CLI's
 *   own documented mechanism for exactly this "harness call, not a coding
 *   agent" case).
 * - `--tools ""` (verified against `claude --help` / `claude -p --help` on
 *   the installed CLI, v2.1.202) makes every built-in tool (Bash, Read,
 *   Write, Edit, WebFetch, ...) genuinely UNAVAILABLE to the model, not
 *   merely un-auto-approved. This replaces a prior `--allowedTools ""`,
 *   which per the CLI's own help text only controls which tools skip
 *   permission prompts — it does not remove tools from the model's tool
 *   list. Live verification (PR #1735 review): with `--allowedTools ""`
 *   and `--permission-mode bypassPermissions`, a `claude -p` child process
 *   was still able to invoke the Write tool and create a file on disk.
 *   With `--tools ""`, the same prompt produced only a hallucinated
 *   "I wrote the file" response in the *text* output — no tool actually
 *   ran and no file was created. `--tools ""` is the CLI's own documented
 *   mechanism for "no tools available at all" and does not depend on
 *   permission-mode defaults or the operator's global `settings.json`
 *   allow-list, both of which `--allowedTools` is exposed to.
 * - `--strict-mcp-config` with no `--mcp-config` ensures no MCP server is
 *   ever attached, even if a global/user MCP config exists.
 * - `--append-system-prompt` carries the caller's scoring/format protocol
 *   (`opts.systemPrompt`) through the CLI's own system-prompt channel
 *   instead of embedding it in the stdin user payload (PR #1735 review).
 *   Verified live: a `claude -p --append-system-prompt "<marker>"` call
 *   correctly echoed the marker back when asked to quote its system-level
 *   instructions, confirming the flag is real and wired through on this
 *   CLI build.
 * - `--output-format json` / `--input-format text` give a single parseable
 *   JSON result read from stdin (see `runClaudeCliCommand`, which pipes the
 *   prompt over stdin rather than argv — mirrors codex-cli.ts's approach so
 *   large benchmark prompts never hit an OS argv length limit).
 * - `--no-session-persistence` (verified against `claude -p --help` on the
 *   installed CLI, v2.1.202: "Disable session persistence - sessions will
 *   not be saved to disk and cannot be resumed (only works with --print)")
 *   stops the CLI from writing this call's transcript/session state to disk
 *   at all, so recalled-memory context and expected answers fed into a
 *   responder/judge call can't leak into or be resumed by a later `claude
 *   -p` call (PR #1735 review, finding 1). This is in addition to, not a
 *   replacement for, the isolated per-call temp `cwd`: the flag addresses
 *   session-transcript persistence, while the fresh cwd addresses
 *   CLAUDE.md/project-file discovery.
 *
 * There is no `--max-turns` flag on this CLI build (`claude --help` was
 * checked; codex CLI's `exec` equivalent doesn't need one either since
 * tools are fully denied here, so there's nothing for the session to loop
 * on).
 */
function buildClaudeCliArgs(config: ClaudeCliProviderConfig, systemPrompt?: string): string[] {
  const args = [
    "--print",
    "--model",
    config.model,
    "--output-format",
    "json",
    "--input-format",
    "text",
    "--safe-mode",
    "--strict-mcp-config",
    "--tools",
    "",
    "--no-session-persistence",
  ];

  const trimmedSystemPrompt = systemPrompt?.trim();
  if (trimmedSystemPrompt) {
    args.push("--append-system-prompt", trimmedSystemPrompt);
  }

  return args;
}

function buildClaudeCompletionPrompt(userPrompt: string): string {
  const payload = { userPrompt };

  return [
    "You are a benchmark evaluation endpoint, not a coding agent.",
    "Use only the explicit JSON payload below.",
    "Any additional scoring/format protocol instructions are provided via the",
    "system prompt, which takes priority over this user payload.",
    "Do not use tools, do not read or write files, do not browse, and do not use persisted memory.",
    "Return only the final answer text. If the request asks for JSON, return raw JSON only.",
    "",
    "BENCHMARK_REQUEST_JSON:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

/**
 * `claude -p --help` has no `--max-tokens` / `--max-output-tokens` flag (v2.1.202
 * checked; see `buildClaudeCliArgs` for the flags that do exist). The CLI does,
 * however, honor an undocumented-in---help env var, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`:
 * it appears in the installed binary's own strings alongside the runtime message
 * "Claude's response exceeded the ... output token maximum. To configure this
 * behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.", and was
 * confirmed live (PR #1735 review, finding 2) — a `claude -p` call asked to count
 * to 200 produced 434 output tokens uncapped, and only 117 output tokens (8 lines)
 * with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=50` set, with `is_error: false` (a silent
 * truncation, not a hard error). This is the CLI's real, if unofficial, mechanism
 * for `opts.maxTokens`, so it's forwarded here rather than left unhonored. Because
 * truncation is silent, this is a soft cap: the judge/responder prompts themselves
 * ("answer yes/no only", "return a single number", ...) still do the primary work
 * of keeping the answer shape small; this env var is a backstop, not a hard
 * contract enforced by the API itself the way an SDK's `max_tokens` param is.
 */
const CLAUDE_CLI_MAX_OUTPUT_TOKENS_ENV = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";

function buildIsolatedClaudeEnv(config: ClaudeCliProviderConfig, maxTokens?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isAllowedClaudeRuntimeEnvKey(key)) {
      env[key] = value;
    }
  }

  // Opt-in only: forwarding an ambient ANTHROPIC_API_KEY by default would
  // silently switch the child from free subscription auth to metered API
  // billing. Only set it when the caller explicitly configured one.
  if (config.apiKey && config.apiKey.trim().length > 0) {
    env.ANTHROPIC_API_KEY = config.apiKey.trim();
  }
  if (config.baseUrl && config.baseUrl.trim().length > 0) {
    env.ANTHROPIC_BASE_URL = config.baseUrl.trim();
  }
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    env[CLAUDE_CLI_MAX_OUTPUT_TOKENS_ENV] = String(Math.floor(maxTokens));
  }

  return env;
}

function isAllowedClaudeRuntimeEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return CLAUDE_CLI_RUNTIME_ENV_ALLOWLIST.has(normalized) || normalized.startsWith("LC_");
}

function resolveClaudeCliExecutable(config: ClaudeCliProviderConfig): string {
  const configured = config.executable ?? process.env[CLAUDE_CLI_EXECUTABLE_ENV];
  if (configured === undefined) {
    return "claude";
  }

  const trimmed = configured.trim();
  if (trimmed.length === 0) {
    throw new Error(`${CLAUDE_CLI_EXECUTABLE_ENV} / claude-cli executable must not be empty`);
  }
  return expandHomeRelativePath(trimmed);
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

function parseClaudeCliJsonResult(stdout: string): ClaudeCliJsonResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { is_error: true, error: "Claude CLI produced no stdout." };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // `--output-format json` yielding a non-object (null / number / string /
      // array) is itself an anomaly; treat it as an error blob so a later
      // `payload.is_error` read can't throw a TypeError.
      return { is_error: true, error: trimmed.slice(-1_000) };
    }
    return parsed as ClaudeCliJsonResult;
  } catch {
    // Fall back to treating raw stdout as an error blob — a non-JSON
    // response from `--output-format json` is itself an anomaly.
    return { is_error: true, error: trimmed.slice(-1_000) };
  }
}

function nonNegativeInt(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

const USAGE_LIMIT_SIGNAL_REGEX =
  /\b(usage limit|rate limit|rate-limited|rate limited|too many requests|quota exceeded|429|please try again (?:later|in)|resets? (?:at|in)\b.*\b(?:hour|minute|day))\b/i;

function isClaudeUsageLimitSignal(combinedOutput: string): boolean {
  return USAGE_LIMIT_SIGNAL_REGEX.test(combinedOutput);
}

function isRetryableClaudeCliResult(result: ClaudeCliRunResult): boolean {
  if (!result.signal) {
    return false;
  }
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes("timed out after") || stderr.includes("aborted by benchmark timeout")) {
    return false;
  }
  return true;
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

function normalizeUsageLimitMaxWaitMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_USAGE_LIMIT_MAX_WAIT_MS;
  }
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_USAGE_LIMIT_MAX_WAIT_MS;
  }
  return value;
}

/**
 * Backoff for detected usage-limit/rate-limit failures. Gives up (throws)
 * when the NEXT required backoff step no longer fits in the remaining
 * wall-clock budget — sleeping a truncated sliver and immediately hammering
 * a capped Claude Max session again would only burn quota.
 */
async function sleepBeforeUsageLimitRetry(options: {
  attempt: number;
  loopStartedAt: number;
  budgetMs: number;
  failureSummary: string;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const delayMs = Math.min(
    USAGE_LIMIT_BASE_BACKOFF_MS * Math.pow(2, options.attempt - 1),
    USAGE_LIMIT_MAX_STEP_MS,
  );
  const remainingBudgetMs = options.budgetMs - (performance.now() - options.loopStartedAt);
  if (delayMs > remainingBudgetMs) {
    throw new Error(
      `Claude CLI usage-limit backoff budget (${options.budgetMs}ms) exhausted: ${options.failureSummary}`,
    );
  }
  await sleepBeforeClaudeCliRetry({
    attempt: options.attempt,
    baseBackoffMs: USAGE_LIMIT_BASE_BACKOFF_MS,
    maxStepMs: USAGE_LIMIT_MAX_STEP_MS,
    capMs: remainingBudgetMs,
    signal: options.signal,
  });
}

async function sleepBeforeClaudeCliRetry(options: {
  attempt: number;
  baseBackoffMs: number | undefined;
  maxStepMs: number;
  capMs: number;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const baseBackoffMs =
    options.baseBackoffMs !== undefined && Number.isFinite(options.baseBackoffMs) && options.baseBackoffMs > 0
      ? options.baseBackoffMs
      : 1000;
  const uncappedDelayMs = baseBackoffMs * Math.pow(2, options.attempt - 1);
  const delayMs = Math.max(0, Math.min(uncappedDelayMs, options.maxStepMs, options.capMs));

  const signal = options.signal;
  if (!signal) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    return;
  }
  if (signal.aborted) {
    throw claudeCliAbortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(claudeCliAbortError(signal));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  const summary = [stderr.trim(), stdout.trim()].filter((value) => value.length > 0).join("\n").trim();
  return summary.length > 0 ? summary.slice(-1_000) : "no process output";
}

function runClaudeVersionCommand(
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
    }, CLAUDE_CLI_VERSION_TIMEOUT_MS);
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
        status: timedOut ? (status ?? 124) : status,
        stderr: timedOut
          ? appendBounded(stderr, `\nClaude CLI --version timed out after ${CLAUDE_CLI_VERSION_TIMEOUT_MS}ms.`)
          : stderr,
      });
    });
  });
}

function runClaudeCliCommand(request: ClaudeCliRunRequest): Promise<ClaudeCliRunResult> {
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      resolve({
        status: 124,
        signal: null,
        stdout: "",
        stderr: "Claude CLI aborted before start.",
      });
      return;
    }

    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
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
      stderr = appendBounded(stderr, `\nClaude CLI stdin error: ${error.code ?? error.message}`);
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      clearKillTimeout();
      if (child.pid) {
        unregisterActiveClaudeCliChild(child.pid);
      }
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (status, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
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
          stderr: appendBounded(stderr, `\nClaude CLI timed out after ${request.timeoutMs}ms.`),
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
      stderr = appendBounded(stderr, `\nClaude CLI stdin error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

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

function appendBounded(existing: string, next: string): string {
  const combined = existing + next;
  if (combined.length <= CLAUDE_CLI_STDIO_LIMIT) {
    return combined;
  }
  return combined.slice(combined.length - CLAUDE_CLI_STDIO_LIMIT);
}

export function createClaudeCliProvider(
  config: ClaudeCliProviderConfig,
  deps?: ClaudeCliProviderDeps,
): LlmProvider {
  return new ClaudeCliProvider(config, deps);
}

export const __claudeCliProviderTestHooks = {
  buildClaudeCliArgs,
  buildClaudeCompletionPrompt,
  buildIsolatedClaudeEnv,
  getActiveClaudeCliChildCount: () => activeClaudeCliChildPids.size,
  isClaudeUsageLimitSignal,
  parseClaudeCliJsonResult,
  resolveClaudeCliExecutable,
  runClaudeCliCommand,
  terminateActiveClaudeCliChildren,
  /** Test-only: drops the process-wide shared `claude -p` concurrency gate
   * so each concurrency test starts from a fresh limit instead of inheriting
   * one raised by an earlier test in the same process (the gate's limit only
   * ever grows — see `getSharedClaudeCliGate`). Must never be called from
   * non-test code. */
  resetSharedClaudeCliGateForTests: () => {
    sharedClaudeCliGate = undefined;
  },
};
