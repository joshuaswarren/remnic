/**
 * `remnic buffer drain` — one command that empties the extraction buffer.
 *
 * The command runs OUT of process: it starts worker processes that boot their
 * own orchestrator (the same pattern as `remnic import`) and drive the same
 * extraction pipeline the daemon uses. Nothing is extracted on the daemon's
 * event loop, so a busy daemon keeps serving while its backlog drains.
 *
 * Safety model (see docs/ops/buffer-drain.md):
 *   - A session is CLAIMED before it is drained. The claim is a durable file
 *     that holds the turns not yet extracted, so a kill at any instant loses
 *     nothing and the next run resumes.
 *   - A live buffer owner (the daemon) hands a claimed session's turns INTO
 *     the claim instead of writing them back: it can never resurrect drained
 *     content, and its queued extraction for a claimed session is skipped.
 *   - Two drains at once are safe: the claim lease (exclusive create) gives
 *     each session to exactly one drainer, and the loser skips it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig, resolveRemnicConfigRecord, StorageManager } from "@remnic/core";
import type { BufferEntryState } from "@remnic/core/types.js";

export const BUFFER_DRAIN_USAGE = `Usage: remnic buffer drain [options]

Drain the extraction buffer out of process: every buffered session is claimed,
extracted through the normal pipeline, and cleared. Safe with a live daemon
and safe to interrupt — the next run resumes where this one stopped.

Options:
  --concurrency <n>   Worker processes to run (default 2, max 8)
  --session <key>     Only drain this session (repeatable)
  --namespace <ns>    Only drain sessions captured for this namespace
  --dry-run           Report what would be drained; change nothing
  --json              Print the summary as JSON
  -h, --help          Show this help

Exit codes:
  0  buffer drained (nothing left)
  1  finished with sessions still deferred or failed
  2  usage or configuration error`;

export interface BufferDrainOptions {
  concurrency: number;
  sessions: string[];
  namespace?: string;
  dryRun: boolean;
  json: boolean;
}

export type BufferDrainArgs =
  | { kind: "options"; options: BufferDrainOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const MAX_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 2;

export function parseBufferDrainArgs(argv: readonly string[]): BufferDrainArgs {
  const options: BufferDrainOptions = { concurrency: DEFAULT_CONCURRENCY, sessions: [], dryRun: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--concurrency") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
        return { kind: "error", message: `--concurrency must be an integer between 1 and ${MAX_CONCURRENCY}` };
      }
      options.concurrency = value;
      index += 1;
      continue;
    }
    if (arg === "--session") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return { kind: "error", message: "--session requires a session key" };
      options.sessions.push(value);
      index += 1;
      continue;
    }
    if (arg === "--namespace") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return { kind: "error", message: "--namespace requires a namespace" };
      options.namespace = value;
      index += 1;
      continue;
    }
    return { kind: "error", message: `unknown option: ${arg}` };
  }
  return { kind: "options", options };
}

/** A session the drain reported on (worker → parent, NDJSON). */
export interface DrainSessionReport {
  key: string;
  status: "drained" | "deferred" | "failed" | "skipped";
  turnsAtStart: number;
  turnsRemaining: number;
  persistedCount: number;
  durableOutputCount: number;
  reason?: string;
}

export interface BufferDrainSummary {
  sessionsDrained: number;
  sessionsDeferred: number;
  sessionsFailed: number;
  sessionsSkipped: number;
  turnsDrained: number;
  factsPersisted: number;
  durableOutputs: number;
  turnsRemaining: number;
  sessionsRemaining: number;
}

export interface BufferDrainDeps {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  configPath: string;
  memoryDir: string;
}

/** The compiled worker entry (or its source twin under tsx). */
function resolveWorkerEntry(): { file: string; args: string[] } {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(moduleDir, "buffer-drain-worker.js");
  if (fs.existsSync(compiled)) return { file: compiled, args: [] };
  // Source checkout (tsx): run the TypeScript worker through the repo's tsx.
  return { file: path.join(moduleDir, "buffer-drain-worker.ts"), args: ["--import", "tsx"] };
}

interface WorkerEvent {
  type: string;
  key?: string;
  turns?: number;
  outcome?: DrainSessionReport;
  error?: string;
}

/**
 * Run the drain. Returns the process exit code.
 *
 * Workers claim and drain sessions themselves: the parent only starts them,
 * relays progress, and aggregates the outcome into one summary.
 */
export async function runBufferDrain(argv: readonly string[], deps: BufferDrainDeps): Promise<number> {
  const parsed = parseBufferDrainArgs(argv);
  if (parsed.kind === "help") {
    deps.stdout(BUFFER_DRAIN_USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    deps.stderr(`remnic buffer drain: ${parsed.message}`);
    deps.stderr(BUFFER_DRAIN_USAGE);
    return 2;
  }
  const options = parsed.options;

  let storage: StorageManager;
  try {
    storage = new StorageManager(deps.memoryDir);
  } catch (err) {
    deps.stderr(`remnic buffer drain: cannot open the memory store: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (options.dryRun) {
    const plan = await planDrain(storage, options);
    if (options.json) {
      deps.stdout(JSON.stringify(plan, null, 2));
      return 0;
    }
    if (plan.sessions.length === 0) {
      deps.stdout("Buffer is empty — nothing to drain.");
      return 0;
    }
    deps.stdout("Buffered sessions:");
    for (const session of plan.sessions) {
      const state = session.claimed ? "claimed" : "unclaimed";
      deps.stdout(`  ${session.key}  ${session.turns} turn(s)  ${state}`);
    }
    deps.stdout(`Total: ${plan.totalTurns} turn(s) across ${plan.sessions.length} session(s).`);
    return 0;
  }

  const worker = resolveWorkerEntry();
  const workerArgs = [
    ...worker.args,
    worker.file,
    "--config",
    deps.configPath,
    "--memory-dir",
    deps.memoryDir,
  ];
  for (const session of options.sessions) workerArgs.push("--session", session);
  if (options.namespace) workerArgs.push("--namespace", options.namespace);

  const reports: DrainSessionReport[] = [];
  const errors: string[] = [];
  await Promise.all(
    Array.from({ length: options.concurrency }, async () => {
      const child = spawn(process.execPath, workerArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let buffered = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          let event: WorkerEvent;
          try {
            event = JSON.parse(line) as WorkerEvent;
          } catch {
            continue;
          }
          if (event.type === "session_started" && event.key) {
            deps.stderr(`draining ${event.key} (${event.turns ?? 0} turn(s))`);
            continue;
          }
          if (event.type === "session_finished" && event.outcome) {
            reports.push(event.outcome);
            const outcome = event.outcome;
            if (outcome.status === "failed" || outcome.status === "deferred") {
              deps.stderr(
                `${outcome.key}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""} — ${outcome.turnsRemaining} turn(s) left`,
              );
            }
            continue;
          }
          if (event.type === "error" && event.error) errors.push(event.error);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => deps.stderr(chunk.trimEnd()));
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.on("error", (err) => {
          errors.push(err.message);
          resolve();
        });
      });
    }),
  );

  const summary = summarize(reports, await remainingTurns(storage));
  if (options.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    deps.stdout(
      `Drained ${summary.sessionsDrained} session(s), ${summary.turnsDrained} turn(s), ${summary.factsPersisted} fact(s) persisted.`,
    );
    if (summary.sessionsDeferred > 0) deps.stdout(`Deferred: ${summary.sessionsDeferred} session(s) — re-run to resume.`);
    if (summary.sessionsFailed > 0) deps.stdout(`Failed: ${summary.sessionsFailed} session(s) — see the logs above.`);
    deps.stdout(`Remaining: ${summary.turnsRemaining} turn(s) in ${summary.sessionsRemaining} session(s).`);
    for (const error of errors) deps.stderr(`worker error: ${error}`);
  }
  if (summary.turnsRemaining > 0 || summary.sessionsFailed > 0) return 1;
  return 0;
}

/** What a dry run would drain. */
export async function planDrain(
  storage: StorageManager,
  options: BufferDrainOptions,
): Promise<{ sessions: { key: string; turns: number; claimed: boolean }[]; totalTurns: number }> {
  const state = await storage.loadBuffer();
  const claims = storage.bufferDrainClaims();
  const sessions: { key: string; turns: number; claimed: boolean }[] = [];
  for (const [key, entry] of Object.entries(state.entries ?? {})) {
    const turns = entry.turns.length + (entry.retainedTurns?.length ?? 0);
    if (turns === 0) continue;
    if (!matchesFilters(key, entry, options)) continue;
    sessions.push({ key, turns, claimed: claims.isClaimed(key) });
  }
  for (const listed of await claims.list()) {
    if (sessions.some((session) => session.key === listed.key)) continue;
    if (options.sessions.length > 0 && !options.sessions.includes(listed.key)) continue;
    sessions.push({ key: listed.key, turns: listed.turnCount, claimed: true });
  }
  return { sessions, totalTurns: sessions.reduce((total, session) => total + session.turns, 0) };
}

/** Turns still buffered after the run (claimed or not). */
async function remainingTurns(storage: StorageManager): Promise<{ turns: number; sessions: number }> {
  const state = await storage.loadBuffer();
  const claims = storage.bufferDrainClaims();
  let turns = 0;
  let sessions = 0;
  for (const [key, entry] of Object.entries(state.entries ?? {})) {
    const claim = claims.isClaimed(key) ? await claims.load(key) : null;
    const remaining = claim
      ? claim.entry.turns.length + (claim.entry.retainedTurns?.length ?? 0)
      : entry.turns.length + (entry.retainedTurns?.length ?? 0);
    if (remaining === 0) continue;
    turns += remaining;
    sessions += 1;
  }
  for (const listed of await claims.list()) {
    if (listed.turnCount === 0) continue;
    if (state.entries && listed.key in state.entries) continue;
    turns += listed.turnCount;
    sessions += 1;
  }
  return { turns, sessions };
}

function summarize(reports: readonly DrainSessionReport[], remaining: { turns: number; sessions: number }): BufferDrainSummary {
  const summary: BufferDrainSummary = {
    sessionsDrained: 0,
    sessionsDeferred: 0,
    sessionsFailed: 0,
    sessionsSkipped: 0,
    turnsDrained: 0,
    factsPersisted: 0,
    durableOutputs: 0,
    turnsRemaining: remaining.turns,
    sessionsRemaining: remaining.sessions,
  };
  for (const report of reports) {
    if (report.status === "drained") {
      summary.sessionsDrained += 1;
      summary.turnsDrained += report.turnsAtStart - report.turnsRemaining;
    } else if (report.status === "deferred") {
      summary.sessionsDeferred += 1;
    } else if (report.status === "failed") {
      summary.sessionsFailed += 1;
    } else {
      summary.sessionsSkipped += 1;
    }
    summary.factsPersisted += report.persistedCount;
    summary.durableOutputs += report.durableOutputCount;
  }
  return summary;
}

/** Session filter: the requested keys, or the requested namespace. */
export function matchesFilters(
  key: string,
  entry: BufferEntryState,
  options: Pick<BufferDrainOptions, "sessions" | "namespace">,
): boolean {
  if (options.sessions.length > 0) {
    const matches = options.sessions.some(
      (session) => session === key || entry.turns.some((turn) => turn.sessionKey === session),
    );
    if (!matches) return false;
  }
  if (options.namespace !== undefined) {
    // A session captured for another namespace stays with its namespace: the
    // drain must not move pinned content across namespaces.
    const pinned = entry.turns.filter((turn) => turn.writeNamespaceOverride !== undefined);
    if (pinned.some((turn) => turn.writeNamespaceOverride !== options.namespace)) return false;
  }
  return true;
}

/** The config the workers use (the same record the rest of the CLI reads). */
export function loadDrainConfig(configPath: string) {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  return parseConfig(resolveRemnicConfigRecord(raw));
}
