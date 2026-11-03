/**
 * Drain worker process (`remnic buffer drain` child).
 *
 * Each worker boots its own orchestrator — the same pattern as `remnic
 * import` — so the extraction runs in its own process, off the daemon's
 * event loop, with its own memory budget. A worker claims one session at a
 * time (the in-process extraction queue is serial by design) and reports
 * every session as NDJSON on stdout.
 *
 * A kill at any point is safe: the claimed turns live in the claim file
 * until they are extracted, so the next run resumes them.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { Orchestrator, parseConfig, resolveRemnicConfigRecord } from "@remnic/core";
import { BufferDrainRunner } from "@remnic/core/orchestration/buffer-drain-runner.js";

import { matchesFilters, type BufferDrainOptions } from "./buffer-drain-cmd.js";

interface WorkerArgs {
  configPath: string;
  memoryDir: string;
  options: BufferDrainOptions;
}

function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  const options: BufferDrainOptions = { concurrency: 1, sessions: [], dryRun: false, json: false };
  let configPath = "";
  let memoryDir = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--config" && value) {
      configPath = value;
      index += 1;
    } else if (arg === "--memory-dir" && value) {
      memoryDir = value;
      index += 1;
    } else if (arg === "--session" && value) {
      options.sessions.push(value);
      index += 1;
    } else if (arg === "--namespace" && value) {
      options.namespace = value;
      index += 1;
    }
  }
  return { configPath, memoryDir, options };
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<number> {
  const args = parseWorkerArgs(process.argv.slice(2));
  if (!args.configPath || !args.memoryDir) {
    emit({ type: "error", error: "drain worker requires --config and --memory-dir" });
    return 2;
  }
  const raw = fs.existsSync(args.configPath) ? JSON.parse(fs.readFileSync(args.configPath, "utf8")) : {};
  const config = parseConfig(resolveRemnicConfigRecord(raw));
  // The worker's memory root is the one the parent resolved; the config
  // record may point elsewhere (the parent passes the resolved path).
  config.memoryDir = args.memoryDir;

  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  await orchestrator.deferredReady;

  const runner = new BufferDrainRunner(orchestrator);
  const ownerId = `drain-${process.pid}-${randomUUID().slice(0, 8)}`;
  const abort = new AbortController();
  const stop = (): void => {
    abort.abort(new Error("buffer drain interrupted"));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  // A session is drained once per worker run: a deferred session keeps its
  // claim and is resumed by the NEXT run, not retried in a loop here.
  const attempted = new Set<string>();
  let failures = 0;
  try {
    for (;;) {
      if (abort.signal.aborted) break;
      const state = await orchestrator.storage.loadBuffer();
      const entries = state.entries ?? {};
      const claimed = await runner.claims.list();
      const candidates: { key: string; turns: number }[] = [];
      for (const [key, entry] of Object.entries(entries)) {
        const turns = entry.turns.length + (entry.retainedTurns?.length ?? 0);
        if (turns === 0) continue;
        if (!matchesFilters(key, entry, args.options)) continue;
        candidates.push({ key, turns });
      }
      for (const listed of claimed) {
        if (candidates.some((candidate) => candidate.key === listed.key)) continue;
        if (args.options.sessions.length > 0 && !args.options.sessions.includes(listed.key)) continue;
        candidates.push({ key: listed.key, turns: listed.turnCount });
      }
      const next = candidates.find((candidate) => !attempted.has(candidate.key) && candidate.turns > 0);
      if (!next) break;
      attempted.add(next.key);

      // Claim the session if it still has a session file; a session that is
      // already claimed (a previous run, or a crashed worker) is adopted by
      // the drain itself.
      await runner.claim(next.key, ownerId);
      const outcome = await runner.drainSession(next.key, {
        ownerId,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === "session_started") {
            emit({ type: "session_started", key: event.key, turns: event.turns });
          }
        },
      });
      if (outcome.status === "failed") failures += 1;
      emit({ type: "session_finished", outcome });
    }
  } catch (err) {
    emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    failures += 1;
  }

  const shutdown = (orchestrator as unknown as { shutdown?: () => Promise<void> }).shutdown;
  if (typeof shutdown === "function") {
    try {
      await shutdown.call(orchestrator);
    } catch {
      // Best effort: the claim files are the durable record, not the shutdown.
    }
  }
  emit({ type: "done", failures });
  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  },
);
