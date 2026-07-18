import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CodexCreditAccountingError,
  CodexCreditDispatchError,
  parseCodexJsonlUsage,
  runWithinCodexCreditBudget,
  type CodexCreditBudgetConfig,
} from "@remnic/bench";
import type { z } from "zod";

import {
  RELAY_MODEL,
  RELAY_REASONING_EFFORT,
  RelayCodexCallSummarySchema,
  type RelayCodexCallResult,
  type RelayRole,
  promptFilenameForRole,
  schemaFilenameForRole,
  schemaForRole,
} from "./contracts.js";
import { createRoleCodexHome, type RelayRunDirectories } from "./isolation.js";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export interface RunRelayCodexOneShotOptions<T> {
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
  outputSchema?: z.ZodType<T>;
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildRelayCodexArgs(role: RelayRole, mcpUrl: string): string[] {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(mcpUrl)) {
    throw new Error("Relay MCP URL must be a loopback HTTP /mcp endpoint");
  }
  return [
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--model",
    RELAY_MODEL,
    "--config",
    `model_reasoning_effort=${tomlString(RELAY_REASONING_EFFORT)}`,
    "--config",
    'approval_policy="never"',
    "--config",
    'web_search="disabled"',
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    'shell_environment_policy.ignore_default_excludes=false',
    "--config",
    'shell_environment_policy.set={ PATH="/usr/bin:/bin", HOME="/codex-home", TMPDIR="/tmp", LANG="C.UTF-8", LC_ALL="C.UTF-8" }',
    "--config",
    `mcp_servers.relay.url=${tomlString(mcpUrl)}`,
    "--config",
    'mcp_servers.relay.bearer_token_env_var="REMNIC_RELAY_MCP_TOKEN"',
    "--config",
    'mcp_servers.relay.enabled_tools=["remnic.recall"]',
    "--config",
    "mcp_servers.relay.required=true",
    "--config",
    "mcp_servers.relay.startup_timeout_sec=10",
    "--config",
    "mcp_servers.relay.tool_timeout_sec=30",
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
        item?: { id?: unknown; type?: unknown; tool?: unknown; name?: unknown; status?: unknown };
      };
      if (event.type !== "item.completed" || event.item?.type !== "mcp_tool_call") continue;
      const tool = event.item.tool ?? event.item.name;
      if (tool !== "remnic.recall" && tool !== "relay.remnic.recall") continue;
      if (event.item.status !== "completed") continue;
      if (typeof event.item.id === "string") completedIds.add(event.item.id);
      else anonymous += 1;
    } catch {
      // Ignore malformed/non-JSON diagnostic lines; terminal usage remains mandatory.
    }
  }
  return completedIds.size + anonymous;
}

async function spawnIsolated(
  options: RunRelayCodexOneShotOptions<unknown>,
  codexHome: string,
  outputDir: string,
  prompt: string,
): Promise<SpawnCapture> {
  const isolationScript = path.join(options.repoRoot, "scripts", "relay", "isolate-codex.sh");
  const args = [
    "--user",
    "--map-root-user",
    "--mount",
    "--pid",
    "--fork",
    "--kill-child=SIGKILL",
    isolationScript,
    ...buildRelayCodexArgs(options.role, options.mcpUrl),
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
        RELAY_WORKSPACE_READ_ONLY:
          options.role === "scout" || options.role === "resolver" ? "1" : "0",
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
      if (!spawned) reject(new CodexCreditDispatchError("isolated Codex process failed before dispatch", { cause: error }));
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
        reject(new CodexCreditAccountingError("Codex one-shot timed out after dispatch; usage requires reconciliation"));
        return;
      }
      if (aborted) {
        reject(new CodexCreditAccountingError("Codex one-shot was cancelled after dispatch; usage requires reconciliation"));
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

export async function runRelayCodexOneShot<T>(
  options: RunRelayCodexOneShotOptions<T>,
): Promise<RelayCodexCallResult<T>> {
  if (options.signal?.aborted) {
    throw new CodexCreditDispatchError("Relay Codex one-shot was cancelled before dispatch");
  }
  if (RELAY_MODEL.toLowerCase().includes("sol")) throw new Error("Relay model policy forbids Sol");
  const promptPath = path.join(options.repoRoot, "fixtures", "remnic-relay", "prompts", promptFilenameForRole(options.role));
  const schemaPath = path.join(options.repoRoot, "fixtures", "remnic-relay", "schemas", schemaFilenameForRole(options.role));
  const [prompt, schemaContents] = await Promise.all([readFile(promptPath, "utf8"), readFile(schemaPath)]);
  const outputDir = path.join(options.directories.outputsDir, options.role);
  await mkdir(outputDir, { mode: 0o700 });
  await writeFile(path.join(outputDir, "schema.json"), schemaContents, { mode: 0o600, flag: "wx" });
  const codexHome = await createRoleCodexHome(options.directories.codexHomesDir, options.role, options.authSourcePath);

  const capture = await runWithinCodexCreditBudget({
    config: options.budget,
    model: RELAY_MODEL,
    run: async () => {
      const result = await spawnIsolated(options as RunRelayCodexOneShotOptions<unknown>, codexHome, outputDir, prompt);
      if (!result.spawned) throw new CodexCreditDispatchError("isolated Codex process never dispatched");
      const usage = parseCodexJsonlUsage(result.stdout);
      if (!usage) {
        throw new CodexCreditAccountingError("Codex completion did not emit a complete turn.completed usage record");
      }
      return { value: result, usage };
    },
  });

  const exitCode = capture.exitCode ?? (capture.signal ? 128 : -1);
  if (exitCode !== 0) {
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
  const outputSchema = options.outputSchema ?? (schemaForRole(options.role) as z.ZodType<T>);
  const output = outputSchema.parse(parsed);
  const usage = parseCodexJsonlUsage(capture.stdout);
  if (!usage) throw new RelayCodexRunError(`Relay ${options.role} one-shot usage disappeared after accounting`);
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
    recallToolCalls: countRecallToolCalls(capture.stdout),
    status: "completed",
  });
  await chmod(finalPath, 0o600);
  return { summary, output, stdout: capture.stdout, stderr: capture.stderr };
}
