import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CodexCreditAccountingError,
  type CodexCreditBudgetConfig,
  CodexCreditDispatchError,
  parseCodexJsonlUsage,
  runWithinCodexCreditBudget,
} from "@remnic/bench";

import {
  RELAY_MODEL,
  RELAY_NAMESPACE,
  RELAY_QUERY,
  RELAY_REASONING_EFFORT,
  RelayBuilderModelOutputSchema,
  RelayBuilderOutputSchema,
  type RelayCodexCallResult,
  RelayCodexCallSummarySchema,
  type RelayRecallReceipt,
  RelayRecallReceiptSchema,
  type RelayRole,
  promptFilenameForRole,
  schemaFilenameForRole,
  schemaForRole,
} from "./contracts.js";
import { type RelayRunDirectories, createRoleCodexHome } from "./isolation.js";
import {
  RELAY_ISOLATED_MCP_URL,
  RELAY_NETWORK_PROXY_PORT,
  RELAY_UNSHARE_NAMESPACE_ARGS,
  type RelayNetworkGateway,
  startRelayNetworkGateway,
} from "./network-gateway.js";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export const RELAY_DISABLED_CODEX_FEATURES = [
  "apps",
  "in_app_browser",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
] as const;

export interface RunRelayCodexOneShotOptions {
  repoRoot: string;
  directories: RelayRunDirectories;
  role: RelayRole;
  workspace: string;
  codexBinary: string;
  authSourcePath: string;
  mcpUrl: string;
  mcpToken: string;
  timeoutMs: number;
  budget: CodexCreditBudgetConfig;
  signal?: AbortSignal;
}

interface SpawnCapture {
  spawned: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RelayCodexFailureDiagnostic {
  schemaVersion: 1;
  role: RelayRole;
  model: typeof RELAY_MODEL;
  spawned: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  threadStarted: boolean;
  eventCounts: Record<string, number>;
  errorClasses: string[];
  jsonlErrorCodes: string[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildRelayCodexSafetyArgs(): string[] {
  return RELAY_DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]);
}

export function buildRelayCodexConfigArgs(mcpUrl: string): string[] {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(mcpUrl)) {
    throw new Error("Relay MCP URL must be a loopback HTTP /mcp endpoint");
  }
  const overrides = [
    `model_reasoning_effort=${tomlString(RELAY_REASONING_EFFORT)}`,
    'approval_policy="never"',
    'web_search="disabled"',
    'shell_environment_policy.inherit="none"',
    "shell_environment_policy.ignore_default_excludes=false",
    'shell_environment_policy.set={ PATH="/usr/bin:/bin", HOME="/codex-home", TMPDIR="/tmp", LANG="C.UTF-8", LC_ALL="C.UTF-8" }',
    `mcp_servers.relay.url=${tomlString(mcpUrl)}`,
    'mcp_servers.relay.bearer_token_env_var="REMNIC_RELAY_MCP_TOKEN"',
    'mcp_servers.relay.enabled_tools=["remnic.recall"]',
    "mcp_servers.relay.required=true",
    "mcp_servers.relay.startup_timeout_sec=10",
    "mcp_servers.relay.tool_timeout_sec=30",
  ];
  return overrides.flatMap((override) => ["--config", override]);
}

export function buildRelayCodexArgs(role: RelayRole, mcpUrl: string): string[] {
  return [
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    ...buildRelayCodexSafetyArgs(),
    "--model",
    RELAY_MODEL,
    ...buildRelayCodexConfigArgs(mcpUrl),
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--cd",
    "/workspace",
    "--json",
    "--color",
    "never",
    "--output-schema",
    "/output/schema.json",
    "--output-last-message",
    "/output/final.json",
    "-",
  ];
}

function classifyCodexFailure(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`;
  const classes: string[] = [];
  const add = (name: string, pattern: RegExp) => {
    if (pattern.test(combined)) classes.push(name);
  };
  add("authentication", /\b(?:401|403|authentication|not logged in|unauthori[sz]ed)\b/i);
  add("cli-arguments", /\b(?:unknown|unexpected|invalid) argument\b|\bUsage:/i);
  add("mcp-startup", /\bMCP\b|mcp_servers|remnic\.recall/i);
  add("model-availability", /\bmodel\b.{0,80}\b(?:not found|unsupported|unavailable|does not exist)\b/i);
  add("network", /\b(?:connection|DNS|network|websocket).{0,80}(?:failed|refused|timed out|unreachable)\b/i);
  add("output-schema", /\b(?:output|json|response).{0,40}schema\b|response_format|structured output/i);
  add("sandbox-helper", /\b(?:bubblewrap|bwrap|sandbox)\b/i);
  if (classes.length === 0 && /\berror\b|"type"\s*:\s*"error"/i.test(combined)) classes.push("runtime-error");
  return classes.sort();
}

export function buildRelayCodexFailureDiagnostic(
  role: RelayRole,
  capture: Pick<SpawnCapture, "spawned" | "exitCode" | "signal" | "stdout" | "stderr" | "durationMs">
): RelayCodexFailureDiagnostic {
  const eventCounts = new Map<string, number>();
  const errorCodes = new Set<string>();
  for (const line of capture.stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        code?: unknown;
        error?: { code?: unknown };
      };
      if (typeof event.type === "string" && /^[a-z][a-z0-9_.-]{0,63}$/i.test(event.type)) {
        eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
      }
      const code = event.error?.code ?? event.code;
      if (typeof code === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(code)) errorCodes.add(code);
    } catch {
      // Failure diagnostics intentionally retain no raw stdout or stderr.
    }
  }
  return {
    schemaVersion: 1,
    role,
    model: RELAY_MODEL,
    spawned: capture.spawned,
    exitCode: capture.exitCode,
    signal: capture.signal,
    durationMs: capture.durationMs,
    stdoutBytes: Buffer.byteLength(capture.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(capture.stderr, "utf8"),
    stdoutSha256: sha256(capture.stdout),
    stderrSha256: sha256(capture.stderr),
    threadStarted: parseThreadId(capture.stdout) !== undefined,
    eventCounts: Object.fromEntries([...eventCounts].sort(([left], [right]) => left.localeCompare(right))),
    errorClasses: classifyCodexFailure(capture.stdout, capture.stderr),
    jsonlErrorCodes: [...errorCodes].sort(),
  };
}

async function writeFailureDiagnostic(
  outputDir: string,
  role: RelayRole,
  capture: Pick<SpawnCapture, "spawned" | "exitCode" | "signal" | "stdout" | "stderr" | "durationMs">
): Promise<RelayCodexFailureDiagnostic> {
  const diagnostic = buildRelayCodexFailureDiagnostic(role, capture);
  await writeFile(path.join(outputDir, "failure-diagnostic.json"), `${JSON.stringify(diagnostic, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return diagnostic;
}

export function parseThreadId(jsonl: string): string | undefined {
  for (const line of jsonl.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
    } catch {
      // Non-JSON diagnostics may be mixed into a failed invocation.
    }
  }
  return undefined;
}

export function countRecallToolCalls(jsonl: string): number {
  const completedIds = new Set<string>();
  let anonymous = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        item?: { id?: unknown; type?: unknown; server?: unknown; tool?: unknown; name?: unknown; status?: unknown };
      };
      if (event.type !== "item.completed" || event.item?.type !== "mcp_tool_call") continue;
      const tool = event.item.tool ?? event.item.name;
      if (tool !== "remnic.recall" && tool !== "relay.remnic.recall") continue;
      if (event.item.server !== "relay") continue;
      if (event.item.status !== "completed") continue;
      if (typeof event.item.id === "string") completedIds.add(event.item.id);
      else anonymous += 1;
    } catch {
      // Ignore malformed/non-JSON diagnostic lines; terminal usage remains mandatory.
    }
  }
  return completedIds.size + anonymous;
}

export function parseRelayRecallReceipts(jsonl: string): RelayRecallReceipt[] {
  const receipts: RelayRecallReceipt[] = [];
  const completedIds = new Set<string>();
  for (const line of jsonl.split(/\r?\n/)) {
    let event: {
      type?: unknown;
      item?: {
        id?: unknown;
        type?: unknown;
        server?: unknown;
        tool?: unknown;
        name?: unknown;
        status?: unknown;
        arguments?: unknown;
        result?: { structured_content?: unknown; structuredContent?: unknown };
      };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "item.completed" || event.item?.type !== "mcp_tool_call") continue;
    const tool = event.item.tool ?? event.item.name;
    if (event.item.server !== "relay" || (tool !== "remnic.recall" && tool !== "relay.remnic.recall")) continue;
    if (event.item.status !== "completed") continue;
    if (typeof event.item.id === "string") {
      if (completedIds.has(event.item.id)) continue;
      completedIds.add(event.item.id);
    }
    const args = event.item.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new RelayCodexRunError("Relay completed recall omitted structured arguments");
    }
    const argumentsObject = args as Record<string, unknown>;
    if (argumentsObject.query !== RELAY_QUERY || argumentsObject.namespace !== RELAY_NAMESPACE) {
      throw new RelayCodexRunError("Relay completed recall escaped the fixed query or namespace");
    }
    const structured = event.item.result?.structured_content ?? event.item.result?.structuredContent;
    if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
      throw new RelayCodexRunError("Relay completed recall omitted structured MCP result evidence");
    }
    const result = structured as Record<string, unknown>;
    receipts.push(
      RelayRecallReceiptSchema.parse({
        query: result.query,
        namespace: result.namespace,
        memoryIds: result.memoryIds,
      })
    );
  }
  return receipts;
}

async function spawnIsolated(
  options: RunRelayCodexOneShotOptions,
  codexHome: string,
  outputDir: string,
  prompt: string,
  gateway: RelayNetworkGateway
): Promise<SpawnCapture> {
  const isolationScript = path.join(options.repoRoot, "scripts", "relay", "isolate-codex.sh");
  const networkProxyScript = path.join(options.repoRoot, "scripts", "relay", "network-proxy.mjs");
  const args = [
    ...RELAY_UNSHARE_NAMESPACE_ARGS,
    isolationScript,
    ...buildRelayCodexArgs(options.role, RELAY_ISOLATED_MCP_URL),
  ];
  const startedAt = Date.now();
  return await new Promise<SpawnCapture>((resolve, reject) => {
    const child = spawn("unshare", args, {
      cwd: options.repoRoot,
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        RELAY_ROOTFS: options.directories.rootfsDir,
        RELAY_WORKSPACE: options.workspace,
        RELAY_CODEX_HOME: codexHome,
        RELAY_OUTPUT_DIR: outputDir,
        RELAY_CODEX_BIN: options.codexBinary,
        RELAY_WORKSPACE_READ_ONLY: options.role === "scout" || options.role === "resolver" ? "1" : "0",
        RELAY_NETWORK_PROXY_SCRIPT: networkProxyScript,
        RELAY_NETWORK_GATEWAY_SOCKET: gateway.socketPath,
        RELAY_NETWORK_PROXY_PORT: String(RELAY_NETWORK_PROXY_PORT),
        RELAY_NETWORK_MCP_TARGET_PORT: String(gateway.mcpTargetPort),
        REMNIC_RELAY_MCP_TOKEN: options.mcpToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let spawned = false;
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      if (!spawned)
        reject(new CodexCreditDispatchError("isolated Codex process failed before dispatch", { cause: error }));
      else reject(new CodexCreditAccountingError("isolated Codex process errored after dispatch"));
    });
    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      const next = (target === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_CAPTURE_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (overflow) {
        reject(new CodexCreditAccountingError("Codex output exceeded the bounded capture limit after dispatch"));
        return;
      }
      if (timedOut) {
        reject(
          new CodexCreditAccountingError("Codex one-shot timed out after dispatch; usage requires reconciliation")
        );
        return;
      }
      if (aborted) {
        reject(
          new CodexCreditAccountingError("Codex one-shot was cancelled after dispatch; usage requires reconciliation")
        );
        return;
      }
      resolve({ spawned, exitCode, signal, stdout, stderr, durationMs: Date.now() - startedAt });
    });
    child.stdin.end(prompt);
  });
}

export class RelayCodexRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayCodexRunError";
  }
}

export async function runRelayCodexOneShot(
  options: RunRelayCodexOneShotOptions
): Promise<RelayCodexCallResult<unknown>> {
  if (options.signal?.aborted) {
    throw new CodexCreditDispatchError("Relay Codex one-shot was cancelled before dispatch");
  }
  if (RELAY_MODEL.toLowerCase().includes("sol")) throw new Error("Relay model policy forbids Sol");
  const promptPath = path.join(
    options.repoRoot,
    "fixtures",
    "remnic-relay",
    "prompts",
    promptFilenameForRole(options.role)
  );
  const schemaPath = path.join(
    options.repoRoot,
    "fixtures",
    "remnic-relay",
    "schemas",
    schemaFilenameForRole(options.role)
  );
  const [prompt, schemaContents] = await Promise.all([readFile(promptPath, "utf8"), readFile(schemaPath)]);
  const outputDir = path.join(options.directories.outputsDir, options.role);
  await mkdir(outputDir, { mode: 0o700 });
  await writeFile(path.join(outputDir, "schema.json"), schemaContents, { mode: 0o600, flag: "wx" });
  const codexHome = await createRoleCodexHome(options.directories.codexHomesDir, options.role, options.authSourcePath);
  const gateway = await startRelayNetworkGateway({ outputDir, mcpUrl: options.mcpUrl });

  let capture: SpawnCapture;
  try {
    capture = await runWithinCodexCreditBudget({
      config: options.budget,
      model: RELAY_MODEL,
      run: async () => {
        const result = await spawnIsolated(options, codexHome, outputDir, prompt, gateway);
        if (!result.spawned) throw new CodexCreditDispatchError("isolated Codex process never dispatched");
        const usage = parseCodexJsonlUsage(result.stdout);
        if (!usage) {
          const diagnostic = await writeFailureDiagnostic(outputDir, options.role, result);
          const classification =
            diagnostic.errorClasses.length > 0 ? diagnostic.errorClasses.join(",") : "unclassified";
          throw new CodexCreditAccountingError(
            `Codex completion did not emit a complete turn.completed usage record (diagnostic: ${classification})`
          );
        }
        return { value: result, usage };
      },
    });
  } finally {
    await gateway.stop().catch(() => undefined);
  }

  const exitCode = capture.exitCode ?? (capture.signal ? 128 : -1);
  if (exitCode !== 0) {
    await writeFailureDiagnostic(outputDir, options.role, capture);
    throw new RelayCodexRunError(`Relay ${options.role} one-shot exited with status ${exitCode}`);
  }
  const threadId = parseThreadId(capture.stdout);
  if (!threadId) throw new RelayCodexRunError(`Relay ${options.role} one-shot omitted thread.started identity`);
  const finalPath = path.join(outputDir, "final.json");
  const finalRaw = await readFile(finalPath, "utf8").catch(() => {
    throw new RelayCodexRunError(`Relay ${options.role} one-shot omitted structured final output`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalRaw);
  } catch {
    throw new RelayCodexRunError(`Relay ${options.role} one-shot wrote invalid JSON output`);
  }
  const modelOutput = schemaForRole(options.role).parse(parsed);
  const usage = parseCodexJsonlUsage(capture.stdout);
  if (!usage) throw new RelayCodexRunError(`Relay ${options.role} one-shot usage disappeared after accounting`);
  const recallToolCalls = countRecallToolCalls(capture.stdout);
  const recallReceipts = parseRelayRecallReceipts(capture.stdout);
  if (recallReceipts.length !== recallToolCalls) {
    throw new RelayCodexRunError(`Relay ${options.role} recall count lacks a complete structured receipt`);
  }
  const isBuilder = options.role === "stale-builder" || options.role === "cold-builder";
  if ((isBuilder && recallReceipts.length !== 1) || (!isBuilder && recallReceipts.length !== 0)) {
    throw new RelayCodexRunError(`Relay ${options.role} violated its fixed recall contract`);
  }
  const recallReceipt = recallReceipts[0] ?? null;
  const output = isBuilder
    ? RelayBuilderOutputSchema.parse({
        ...RelayBuilderModelOutputSchema.parse(modelOutput),
        recall_memory_id: recallReceipt?.memoryIds[0],
        recall_provenance: `Relay captured completed Codex MCP recall for query ${RELAY_QUERY} in namespace ${RELAY_NAMESPACE}`,
      })
    : modelOutput;
  const summary = RelayCodexCallSummarySchema.parse({
    role: options.role,
    model: RELAY_MODEL,
    reasoningEffort: RELAY_REASONING_EFFORT,
    threadId,
    promptSha256: sha256(prompt),
    outputSha256: sha256(finalRaw),
    exitCode,
    durationMs: capture.durationMs,
    usage,
    recallToolCalls,
    recallReceipt,
    status: "completed",
  });
  await chmod(finalPath, 0o600);
  await writeFile(path.join(outputDir, "call-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return { summary, output, stdout: capture.stdout, stderr: capture.stderr };
}
