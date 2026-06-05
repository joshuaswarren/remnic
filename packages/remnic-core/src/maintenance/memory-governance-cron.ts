import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY_SUMMARY_CRON_ID = "engram-day-summary";
const GOVERNANCE_CRON_ID = "engram-nightly-governance";
const PROCEDURAL_MINING_CRON_ID = "engram-procedural-mining";
const CONTRADICTION_SCAN_CRON_ID = "engram-contradiction-scan";
const PATTERN_REINFORCEMENT_CRON_ID = "engram-pattern-reinforcement";
const GRAPH_EDGE_DECAY_CRON_ID = "engram-graph-edge-decay";

type CronJobsShape =
  | Array<Record<string, unknown>>
  | {
      jobs: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };

async function acquireCronJobsLock(jobsPath: string): Promise<() => Promise<void>> {
  const lockPath = `${jobsPath}.lock`;
  const start = Date.now();
  const staleMs = 30_000;
  const timeoutMs = 5_000;
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() - start < timeoutMs) {
    try {
      await mkdir(lockPath);
      return async () => {
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {
          // Lock cleanup should not fail cron registration.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock may have been released between stat/rm attempts.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`cron jobs lock acquisition timed out after ${timeoutMs}ms`);
}

function parseCronJobsShape(raw: string): { parsed: CronJobsShape; jobs: Array<Record<string, unknown>> } {
  const parsed = JSON.parse(raw) as CronJobsShape;
  const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : null;
  if (!jobs) {
    throw new Error("jobs.json has unexpected structure");
  }
  return { parsed, jobs };
}

async function writeCronJobsAtomic(jobsPath: string, value: CronJobsShape): Promise<void> {
  const tempPath = `${jobsPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await rename(tempPath, jobsPath);
}

export async function ensureCronJob(
  jobsPath: string,
  jobId: string,
  buildJob: () => Record<string, unknown>,
  options: { updateExisting?: boolean; updateFields?: string[] } = {},
): Promise<{ created: boolean; updated: boolean; jobId: string }> {
  const releaseLock = await acquireCronJobsLock(jobsPath);
  try {
    const raw = await readFile(jobsPath, "utf-8");
    const { parsed, jobs } = parseCronJobsShape(raw);

    const existingIndex = jobs.findIndex((job) => job.id === jobId);
    if (existingIndex >= 0) {
      if (!options.updateExisting) {
        return { created: false, updated: false, jobId };
      }

      const desired = buildJob();
      const existing = jobs[existingIndex];
      const next = mergeCronJobUpdate(existing, desired, options.updateFields);
      if (stableJson(existing) === stableJson(next)) {
        return { created: false, updated: false, jobId };
      }

      jobs[existingIndex] = next;
      const output = Array.isArray(parsed) ? jobs : { ...parsed, jobs };
      await writeCronJobsAtomic(jobsPath, output);
      return { created: false, updated: true, jobId };
    }

    jobs.push(buildJob());
    const output = Array.isArray(parsed) ? jobs : { ...parsed, jobs };
    await writeCronJobsAtomic(jobsPath, output);
    return { created: true, updated: false, jobId };
  } finally {
    await releaseLock();
  }
}

function mergeCronJobUpdate(
  existing: Record<string, unknown>,
  desired: Record<string, unknown>,
  updateFields?: string[],
): Record<string, unknown> {
  if (!updateFields) {
    return desired;
  }

  const next = { ...existing };
  for (const field of updateFields) {
    if (Object.prototype.hasOwnProperty.call(desired, field)) {
      next[field] = desired[field];
    } else {
      delete next[field];
    }
  }
  return next;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function ensureDaySummaryCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
  },
): Promise<{ created: boolean; jobId: string }> {
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  return ensureCronJob(jobsPath, DAY_SUMMARY_CRON_ID, () => ({
    id: DAY_SUMMARY_CRON_ID,
    agentId,
    name: "Remnic Day Summary (auto)",
    enabled: true,
    schedule: {
      kind: "cron",
      expr: "47 23 * * *",
      tz: options.timezone,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      timeoutSeconds: 900,
      thinking: "off",
      message:
        "You are OpenClaw automation. Call tool engram.day_summary with empty params (it will auto-gather today's facts). If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
    },
    delivery: { mode: "none" },
  }));
}

export async function ensureNightlyGovernanceCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
    recentDays?: number;
    maxMemories?: number;
    batchSize?: number;
    scheduleExpr?: string;
  },
): Promise<{ created: boolean; jobId: string }> {
  const recentDays =
    typeof options.recentDays === "number" && Number.isFinite(options.recentDays)
      ? Math.max(1, Math.floor(options.recentDays))
      : 2;
  const maxMemories =
    typeof options.maxMemories === "number" && Number.isFinite(options.maxMemories)
      ? Math.max(1, Math.floor(options.maxMemories))
      : 500;
  const batchSize =
    typeof options.batchSize === "number" && Number.isFinite(options.batchSize)
      ? Math.max(1, Math.floor(options.batchSize))
      : 100;
  const scheduleExpr =
    typeof options.scheduleExpr === "string" && options.scheduleExpr.trim().length > 0
      ? options.scheduleExpr.trim()
      : "23 2 * * *";
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  return ensureCronJob(jobsPath, GOVERNANCE_CRON_ID, () => ({
      id: GOVERNANCE_CRON_ID,
      agentId,
      name: "Remnic Nightly Governance (batched)",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: scheduleExpr,
        tz: options.timezone,
      },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        timeoutSeconds: 900,
        thinking: "off",
        message:
          "You are OpenClaw automation. Call the tool `engram.memory_governance_run` with params " +
          `{"mode": "apply", "recentDays": ${recentDays}, "maxMemories": ${maxMemories}, "batchSize": ${batchSize}}` +
          ". If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
      },
      delivery: { mode: "none" },
    }));
}

export async function ensureProceduralMiningCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
    scheduleExpr?: string;
  },
): Promise<{ created: boolean; jobId: string }> {
  const scheduleExpr =
    typeof options.scheduleExpr === "string" && options.scheduleExpr.trim().length > 0
      ? options.scheduleExpr.trim()
      : "17 3 * * *";
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  return ensureCronJob(jobsPath, PROCEDURAL_MINING_CRON_ID, () => ({
    id: PROCEDURAL_MINING_CRON_ID,
    agentId,
    name: "Remnic Procedural Mining (nightly)",
    enabled: true,
    schedule: {
      kind: "cron",
      expr: scheduleExpr,
      tz: options.timezone,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      timeoutSeconds: 900,
      thinking: "off",
      message:
        "You are OpenClaw automation. Call tool `engram.procedure_mining_run` with empty params. " +
        "If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
    },
    delivery: { mode: "none" },
  }));
}

export async function ensureContradictionScanCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
    scheduleExpr?: string;
  },
): Promise<{ created: boolean; jobId: string }> {
  const scheduleExpr =
    typeof options.scheduleExpr === "string" && options.scheduleExpr.trim().length > 0
      ? options.scheduleExpr.trim()
      : "37 3 * * *";
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  return ensureCronJob(jobsPath, CONTRADICTION_SCAN_CRON_ID, () => ({
    id: CONTRADICTION_SCAN_CRON_ID,
    agentId,
    name: "Remnic Contradiction Scan (nightly)",
    enabled: true,
    schedule: {
      kind: "cron",
      expr: scheduleExpr,
      tz: options.timezone,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      timeoutSeconds: 900,
      thinking: "off",
      message:
        "You are OpenClaw automation. Call tool `engram.contradiction_scan_run` with empty params. " +
        "If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
    },
    delivery: { mode: "none" },
  }));
}

export async function ensurePatternReinforcementCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
    /**
     * Cron expression. Default `"53 4 * * 0"` — Sunday 04:53 in the
     * configured timezone, deliberately offset from sibling crons
     * (`23 2 * * *`, `17 3 * * *`, `37 3 * * *`) so the maintenance
     * passes don't pile up on the same minute.
     */
    scheduleExpr?: string;
  },
): Promise<{ created: boolean; jobId: string }> {
  const scheduleExpr =
    typeof options.scheduleExpr === "string" && options.scheduleExpr.trim().length > 0
      ? options.scheduleExpr.trim()
      : "53 4 * * 0";
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  return ensureCronJob(jobsPath, PATTERN_REINFORCEMENT_CRON_ID, () => ({
    id: PATTERN_REINFORCEMENT_CRON_ID,
    agentId,
    name: "Remnic Pattern Reinforcement (weekly)",
    enabled: true,
    schedule: {
      kind: "cron",
      expr: scheduleExpr,
      tz: options.timezone,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      timeoutSeconds: 900,
      thinking: "off",
      message:
        "You are OpenClaw automation. Call tool `engram.pattern_reinforcement_run` with empty params. " +
        "If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
    },
    delivery: { mode: "none" },
  }));
}

/**
 * Register a cron job that runs the graph-edge-decay maintenance pass
 * (issue #681 PR 2/3). Default schedule is weekly on Sunday 04:13 — the
 * cadence is configurable via `scheduleExpr`. Cadence is also expressible
 * in milliseconds via `Config.graphEdgeDecayCadenceMs`; the orchestrator
 * picks the right cron expression for sub-daily, daily, or weekly cadence.
 */
export async function ensureGraphEdgeDecayCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
    scheduleExpr?: string;
  },
): Promise<{ created: boolean; jobId: string }> {
  const scheduleExpr =
    typeof options.scheduleExpr === "string" && options.scheduleExpr.trim().length > 0
      ? options.scheduleExpr.trim()
      : "13 4 * * 0";
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  const scheduleLabel = graphEdgeDecayScheduleLabel(scheduleExpr);

  return ensureCronJob(
    jobsPath,
    GRAPH_EDGE_DECAY_CRON_ID,
    () => ({
      id: GRAPH_EDGE_DECAY_CRON_ID,
      agentId,
      // Schedule label reflects the actual cron expression (`daily` /
      // `weekly` / `custom`) so cron dashboards do not show "weekly"
      // when the schedule is in fact daily — Cursor review on PR #729.
      name: `Remnic Graph Edge Decay (${scheduleLabel})`,
      enabled: true,
      schedule: {
        kind: "cron",
        expr: scheduleExpr,
        tz: options.timezone,
      },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        timeoutSeconds: 900,
        thinking: "off",
        message:
          "You are OpenClaw automation. Call tool `engram.graph_edge_decay_run` with empty params. " +
          "If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
      },
      delivery: { mode: "none" },
    }),
    {
      updateExisting: true,
      updateFields: ["name", "schedule"],
    },
  );
}

/**
 * Pick a cron expression that approximates a cadence in milliseconds.
 *
 * - cadence <= 1 day → daily at 04:13. Sub-daily cadence is not natively
 *   expressible in 5-field cron without hour/minute step patterns; daily
 *   preserves the previous conservative behavior for those values.
 * - cadence > 1 day → weekly on Sunday 04:13. Multi-day intervals like
 *   2-6 days cannot be represented accurately by a portable 5-field cron
 *   expression, and daily would run more often than requested.
 *
 * Operators who need finer-grained control should set `scheduleExpr`
 * directly via `ensureGraphEdgeDecayCron`.
 */
export function graphEdgeDecayCadenceToCronExpr(cadenceMs: number): string {
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    return "13 4 * * 0";
  }
  const day = 24 * 60 * 60 * 1000;
  if (cadenceMs <= day) return "13 4 * * *";
  return "13 4 * * 0";
}

/**
 * Derive a human-friendly schedule label ("daily" / "weekly" / "custom")
 * for the given cron expression. Used to keep the cron job name in
 * sync with the actual schedule (Cursor review on PR #729).
 */
function graphEdgeDecayScheduleLabel(scheduleExpr: string): string {
  if (scheduleExpr === "13 4 * * *") return "daily";
  if (scheduleExpr === "13 4 * * 0") return "weekly";
  return "custom";
}
