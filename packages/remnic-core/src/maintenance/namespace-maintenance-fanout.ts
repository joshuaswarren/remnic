/**
 * Namespace maintenance fanout coordinator (issue #1500).
 *
 * Builds on the namespace-aware maintenance planner (#1499 / #1517) to fan out
 * the REMAINING background maintenance jobs — dreams, pattern reinforcement,
 * governance/lifecycle, contradiction scans, semantic/causal consolidation,
 * graph decay, fact archival, tier migration — across all maintained
 * namespaces.
 *
 * The planner (`namespace-planner.ts`) already handles namespace discovery
 * (configured + catalog), per-kind gating, cycle budgeting, per-job+namespace
 * locking, status recording, and catalog maintenance timestamps. QMD
 * maintenance was wired through it in #1517. This module standardizes the
 * per-job adapter pattern so every other maintenance job can be fanned out
 * with one call, and aggregates per-namespace health for doctor/dashboard.
 *
 * Design contract (issue #1500 compatibility requirements):
 * - Existing direct `runJob({ namespace })` calls continue to work unchanged.
 * - Namespaces disabled: fanout is a no-op (the planner returns only the
 *   default namespace; jobs run exactly as before).
 * - `maintenanceNamespaceFanoutEnabled: false`: fanout is a no-op.
 * - A failure in one namespace must not abort other namespaces (the planner
 *   already isolates per-namespace failures).
 * - Per-namespace locks prevent duplicate concurrent runs (planner-provided).
 */

import { resolveNamespaceCapabilities } from "../capabilities.js";
import type { NamespaceCatalog } from "../namespaces/catalog.js";
import type { PluginConfig } from "../types.js";
import {
  planNamespaceMaintenance,
  readNamespaceMaintenanceLastRanStatuses,
  readNamespaceMaintenanceStatuses,
  runNamespaceMaintenancePlan,
  type NamespaceMaintenanceCandidate,
  type NamespaceMaintenanceRunStatus,
  type NamespaceMaintenanceSummary,
} from "./namespace-planner.js";

/**
 * Standard maintenance job names fanned out across namespaces.
 *
 * These strings are used as the `jobName` key in:
 * - per-namespace status files (`state/namespace-maintenance-status/<job>/...`)
 * - catalog `lastMaintenanceAt[jobName]` timestamps
 * - per-job+namespace lock files (`state/maintenance-locks/<job>/...`)
 *
 * Keeping them centralized ensures the doctor, CLI, and dashboard all report
 * against the same keys.
 */
export const NAMESPACE_MAINTENANCE_JOBS = [
  "qmd",
  "pattern-reinforcement",
  "contradiction-scan",
  "semantic-consolidation",
  "governance",
  "lifecycle",
  "graph-decay",
  "fact-archival",
  "tier-migration",
] as const;

export type NamespaceMaintenanceStandardJob =
  (typeof NAMESPACE_MAINTENANCE_JOBS)[number];

/**
 * Context passed to a fanout job runner. The runner receives the per-namespace
 * candidate (namespace name, kind, storage dir) and a storage resolver that
 * the orchestrator wires to `storageRouter.storageFor(namespace)`.
 *
 * The storage resolver is intentionally typed as `unknown` here so this module
 * does not depend on the `StorageManager` class — the orchestrator provides the
 * typed resolver. This keeps the fanout module free of orchestrator/storage
 * imports and unit-testable with a stub.
 */
export interface NamespaceMaintenanceFanoutRunnerContext {
  config: PluginConfig;
  candidate: NamespaceMaintenanceCandidate;
  resolveStorage: (namespace: string) => Promise<unknown>;
}

/**
 * Result returned by a fanout job runner. `itemCount` is optional and
 * domain-specific (e.g. memories scanned, edges decayed, embeddings updated).
 *
 * `skipped`/`skipReason`: when a runner performs no work for a namespace
 * (e.g. the job's own cadence gate throttled it), set `skipped: true`. The
 * planner records the namespace as `state: "skipped"` and does NOT touch
 * the catalog's `lastMaintenanceAt`, so a throttled namespace is not
 * falsely reported as maintained.
 */
export interface NamespaceMaintenanceFanoutRunnerResult {
  itemCount?: number;
  skipped?: boolean;
  skipReason?: string;
}

export type NamespaceMaintenanceFanoutRunner = (
  ctx: NamespaceMaintenanceFanoutRunnerContext,
) => Promise<NamespaceMaintenanceFanoutRunnerResult | undefined>;

export interface RunNamespaceMaintenanceFanoutOptions {
  config: PluginConfig;
  catalog?: NamespaceCatalog;
  jobName: string;
  runner: NamespaceMaintenanceFanoutRunner;
  resolveStorage: (namespace: string) => Promise<unknown>;
  /**
   * When `false`, skip fanout entirely and return a zero-summary without
   * touching the planner or locks. This lets callers gate fanout on
   * per-job config (e.g. `semanticConsolidationEnabled`) without repeating
   * the namespace-discovery logic.
   */
  enabled?: boolean;
}

/**
 * Fan out a single maintenance job across all maintained namespaces.
 *
 * This is the primary entry point for wiring a maintenance job through the
 * namespace-aware planner. It:
 * 1. Plans which namespaces should be maintained (configured + catalog,
 *    budgeted, kind-gated).
 * 2. Runs the job per-namespace through `runNamespaceMaintenancePlan`, which
 *    acquires per-job+namespace locks, records status files, and touches the
 *    catalog's `lastMaintenanceAt`.
 *
 * When namespaces are disabled or fanout is off, the planner returns only the
 * default namespace, so the job runs exactly once against default storage —
 * preserving single-user behavior.
 */
export async function runNamespaceMaintenanceFanout(
  options: RunNamespaceMaintenanceFanoutOptions,
): Promise<NamespaceMaintenanceSummary> {
  if (options.enabled === false) {
    return {
      jobName: options.jobName,
      generatedAt: new Date().toISOString(),
      ran: 0,
      skipped: 0,
      failed: 0,
      statuses: [],
    };
  }

  const plan = await planNamespaceMaintenance(options.config, {
    jobName: options.jobName,
    catalog: options.catalog,
  });

  return runNamespaceMaintenancePlan(
    options.config,
    plan,
    async (candidate) => {
      return options.runner({
        config: options.config,
        candidate,
        resolveStorage: options.resolveStorage,
      });
    },
    options.catalog,
  );
}

// ---------------------------------------------------------------------------
// Health summary for doctor / dashboard / CLI
// ---------------------------------------------------------------------------

export interface NamespaceMaintenanceJobHealth {
  jobName: string;
  ran: number;
  skipped: number;
  failed: number;
  lastRunAt: string | null;
  namespaces: NamespaceMaintenanceRunStatus[];
}

export interface NamespaceMaintenanceHealthSummary {
  generatedAt: string;
  fanoutEnabled: boolean;
  namespacesEnabled: boolean;
  maxNamespacesPerCycle: number;
  jobs: NamespaceMaintenanceJobHealth[];
  totalRan: number;
  totalSkipped: number;
  totalFailed: number;
}

/**
 * Read all per-namespace maintenance status files and aggregate them into a
 * health summary suitable for `remnic doctor` and the admin dashboard.
 *
 * This is a pure read operation — it never runs maintenance or acquires locks.
 */
export async function summarizeNamespaceMaintenanceHealth(
  config: PluginConfig,
): Promise<NamespaceMaintenanceHealthSummary> {
  const generatedAt = new Date().toISOString();
  const statuses = await readNamespaceMaintenanceStatuses(config);
  // Merge last-successful-run records so lastRunAt reflects the most recent
  // successful maintenance, not just the latest (possibly skipped/failed)
  // outcome. The latest status file is overwritten on every run; without
  // this merge a namespace that ran then got budget-skipped shows ran=0 /
  // lastRunAt=null (review #1622: preserve last successful run).
  const lastRanStatuses = await readNamespaceMaintenanceLastRanStatuses(config);
  const lastRanByJobNs = new Map<string, NamespaceMaintenanceRunStatus>();
  for (const lr of lastRanStatuses) {
    lastRanByJobNs.set(`${lr.jobName}\u0000${lr.namespace}`, lr);
  }

  const byJob = new Map<string, NamespaceMaintenanceRunStatus[]>();
  for (const status of statuses) {
    const bucket = byJob.get(status.jobName);
    if (bucket) {
      bucket.push(status);
    } else {
      byJob.set(status.jobName, [status]);
    }
  }

  const knownJobs = new Set<string>(NAMESPACE_MAINTENANCE_JOBS);
  // Include any job names seen in status files that are not in the standard
  // set (e.g. custom jobs registered by the orchestrator) so the doctor does
  // not silently hide them.
  for (const jobName of byJob.keys()) {
    knownJobs.add(jobName);
  }

  const jobs: NamespaceMaintenanceJobHealth[] = [];
  let totalRan = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const jobName of [...knownJobs].sort()) {
    const jobStatuses = byJob.get(jobName) ?? [];
    const ran = jobStatuses.filter((s) => s.state === "ran").length;
    const skipped = jobStatuses.filter((s) => s.state === "skipped").length;
    const failed = jobStatuses.filter((s) => s.state === "failed").length;
    // Consider BOTH the latest outcome and the last successful run so a
    // namespace that ran then was later skipped still reports lastRunAt.
    const candidates: string[] = [];
    for (const st of jobStatuses) {
      if (typeof st.completedAt === "string") candidates.push(st.completedAt);
      const lr = lastRanByJobNs.get(`${jobName}\u0000${st.namespace}`);
      if (lr && typeof lr.completedAt === "string") candidates.push(lr.completedAt);
    }
    const lastRunAt = candidates.sort().at(-1) ?? null;

    totalRan += ran;
    totalSkipped += skipped;
    totalFailed += failed;

    jobs.push({
      jobName,
      ran,
      skipped,
      failed,
      lastRunAt,
      namespaces: jobStatuses,
    });
  }

  return {
    generatedAt,
    fanoutEnabled: config.maintenanceNamespaceFanoutEnabled !== false,
    namespacesEnabled: resolveNamespaceCapabilities(config).namespaces,
    maxNamespacesPerCycle: config.maintenanceMaxNamespacesPerCycle,
    jobs,
    totalRan,
    totalSkipped,
    totalFailed,
  };
}

/**
 * Format the health summary as human-readable text for the CLI.
 */
export function formatNamespaceMaintenanceHealthText(
  summary: NamespaceMaintenanceHealthSummary,
): string {
  const lines: string[] = [
    "=== Namespace Maintenance ===",
    "",
    `  fanout:        ${summary.fanoutEnabled ? "enabled" : "disabled"}`,
    `  namespaces:    ${summary.namespacesEnabled ? "enabled" : "disabled"}`,
    `  max/cycle:     ${summary.maxNamespacesPerCycle}`,
    `  total ran:     ${summary.totalRan}`,
    `  total skipped: ${summary.totalSkipped}`,
    `  total failed:  ${summary.totalFailed}`,
    "",
  ];

  if (summary.totalRan === 0 && summary.totalSkipped === 0 && summary.totalFailed === 0) {
    lines.push("  (no maintenance status recorded yet)");
    return lines.join("\n");
  }

  lines.push("  Per-job breakdown:");
  for (const job of summary.jobs) {
    const parts = [
      `ran=${job.ran}`,
      `skipped=${job.skipped}`,
      `failed=${job.failed}`,
    ];
    if (job.lastRunAt) {
      parts.push(`last=${job.lastRunAt}`);
    }
    lines.push(`    ${job.jobName}: ${parts.join(", ")}`);
    // Surface failed namespaces with their reason/error so operators know
    // WHAT to fix without rerunning with --json (review #1622).
    const failedNs = job.namespaces.filter((n) => n.state === "failed");
    for (const ns of failedNs) {
      const detail = ns.error ? `: ${ns.error}` : "";
      lines.push(`      ! ${ns.namespace} failed (reason=${ns.reason ?? "unknown"})${detail}`);
    }
  }

  return lines.join("\n");
}
