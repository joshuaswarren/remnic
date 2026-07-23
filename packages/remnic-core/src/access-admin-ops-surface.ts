/**
 * Access admin/ops read-surface (extracted from access-service.ts;
 * god-file decomposition, #1526 playbook: verbatim move + live selfDeps
 * wiring).
 *
 * Owns the operator-facing read/maintenance surfaces of the access
 * layer: review queue listing, governance runs, conversation-index
 * updates, profiling reports, graph snapshots, capsule listing, dreams
 * pipeline runs, and admin memory promotion.
 */

import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { AdminPromotionError, type MemoryPromotionTargetKind, type PromotionStorageProvider, promoteMemory } from "./admin/admin-surfaces.js";
import { resolveGraphConstructionCapabilities, resolveIndexingCapabilities, resolveNamespaceCapabilities } from "./capabilities.js";
import { type CapsuleListEntry, defaultCapsulesDir } from "./capsule-cli.js";
import { resolveCodingNamespaceOverlay } from "./coding/coding-namespace.js";
import { type GraphSnapshotNodeMetadata, type GraphSnapshotRequest, type GraphSnapshotResponse, buildGraphSnapshot } from "./graph-snapshot.js";
import { log } from "./logger.js";
import { composeMemoryEnvelope } from "./write-envelope.js";
import { buildQualityScore, groupActionsByStatus, listMemoryGovernanceRuns, readMemoryGovernanceRunArtifact, runMemoryGovernance } from "./maintenance/memory-governance.js";
import { resolveScopeProfilePlan } from "./namespaces/scope-profiles.js";
import type { Orchestrator } from "./orchestrator.js";
import { formatProfileTraceAscii } from "./profiling.js";
import { resolveScopePlan } from "./scopes/scope-plan.js";
import {
  EngramAccessInputError,
  buildProjectedGovernanceProposedActions,
  hasGroupedGovernanceActions,
  type AccessProfilingReportRequest,
  type AccessProfilingReportResponse,
  type EngramAccessCapsuleListResponse,
  type EngramAccessReviewQueueResponse,
} from "./access-service.js";

export interface AccessAdminOpsSurfaceDeps {
  readonly orchestrator: Orchestrator;
  resolveReadableNamespace(namespace: string | undefined, principal?: string): string;
  writableNamespaceFor(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string,
  ): string;
}

export class AccessAdminOpsSurface {
  constructor(
    private readonly deps: AccessAdminOpsSurfaceDeps,
  ) {}

  async reviewQueue(runId?: string, namespace?: string, principal?: string): Promise<EngramAccessReviewQueueResponse> {
    const resolvedNamespace = this.deps.resolveReadableNamespace(namespace, principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNamespace);
    const projected = await storage.getProjectedGovernanceRecord();
    if (projected && (!runId || projected.runId === runId.trim())) {
      const projectedAppliedActions = projected.appliedActionRows.map((row) => ({
        action: row.action,
        memoryId: row.memoryId,
        reasonCode: row.reasonCode,
        beforeStatus: row.beforeStatus,
        afterStatus: row.afterStatus,
        originalPath: row.originalPath,
        currentPath: row.currentPath,
      })) as Awaited<
        ReturnType<typeof readMemoryGovernanceRunArtifact>
      >["appliedActions"];
      const projectedProposedActions = await buildProjectedGovernanceProposedActions(storage, projected);
      const projectedArtifact = await (async () => {
        try {
          return await readMemoryGovernanceRunArtifact(storage.dir, projected.runId);
        } catch {
          return null;
        }
      })();
      const metrics = projected.metrics as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["metrics"];
      const fallbackTransitionReport = {
        proposed: groupActionsByStatus(projectedProposedActions),
        applied: groupActionsByStatus(projectedAppliedActions),
      };
      const transitionReport = projectedArtifact?.transitionReport
        ? {
            proposed:
              hasGroupedGovernanceActions(projectedArtifact.transitionReport.proposed) || projectedProposedActions.length === 0
                ? projectedArtifact.transitionReport.proposed
                : fallbackTransitionReport.proposed,
            applied:
              hasGroupedGovernanceActions(projectedArtifact.transitionReport.applied) || projectedAppliedActions.length === 0
                ? projectedArtifact.transitionReport.applied
                : fallbackTransitionReport.applied,
          }
        : fallbackTransitionReport;
      const qualityScore = projectedArtifact?.qualityScore ?? metrics?.qualityScore ?? buildQualityScore(metrics?.reviewReasons ?? {
        exact_duplicate: 0,
        semantic_duplicate_candidate: 0,
        disputed_memory: 0,
        speculative_low_confidence: 0,
        archive_candidate: 0,
        explicit_capture_review: 0,
        malformed_import: 0,
      });
      const effectiveMetrics = metrics ? { ...metrics, qualityScore: metrics.qualityScore ?? qualityScore } : metrics;

      return {
        found: true,
        namespace: resolvedNamespace,
        runId: projected.runId,
        summary: projected.summary as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["summary"],
        metrics: effectiveMetrics,
        qualityScore,
        reviewQueue: projected.reviewQueueRows.map((row) => ({
          entryId: row.entryId,
          memoryId: row.memoryId,
          path: row.path,
          reasonCode: row.reasonCode,
          severity: row.severity,
          suggestedAction: row.suggestedAction,
          suggestedStatus: row.suggestedStatus,
          relatedMemoryIds: row.relatedMemoryIds,
        })) as Awaited<
          ReturnType<typeof readMemoryGovernanceRunArtifact>
        >["reviewQueue"],
        appliedActions: projectedAppliedActions,
        transitionReport,
        report: projected.report,
      };
    }

    const resolvedRunId = runId?.trim() || (await listMemoryGovernanceRuns(storage.dir))[0];
    if (!resolvedRunId) return { found: false, namespace: resolvedNamespace };
    const artifact = await readMemoryGovernanceRunArtifact(storage.dir, resolvedRunId);
    return {
      found: true,
      namespace: resolvedNamespace,
      runId: resolvedRunId,
      summary: artifact.summary,
      metrics: artifact.metrics,
      qualityScore: artifact.qualityScore,
      reviewQueue: artifact.reviewQueue,
      appliedActions: artifact.appliedActions,
      transitionReport: artifact.transitionReport,
      report: artifact.report,
    };
  }

  async governanceRun(
    request: {
      namespace?: string;
      mode?: "shadow" | "apply";
      recentDays?: number;
      maxMemories?: number;
      batchSize?: number;
      authenticatedPrincipal?: string;
    },
    principal?: string,
  ): Promise<{
    namespace: string;
    runId: string;
    traceId: string;
    mode: "shadow" | "apply";
    reviewQueueCount: number;
    proposedActionCount: number;
    appliedActionCount: number;
    summaryPath: string;
    reportPath: string;
  }> {
    const deepSleep = this.deps.orchestrator.config.dreamsPhases.deepSleep;
    if (deepSleep.enabled === false && deepSleep.enabledExplicitlySet === true) {
      throw new Error("memory governance is disabled by dreams.phases.deepSleep.enabled=false");
    }
    const resolvedNamespace = this.deps.writableNamespaceFor(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal,
    );
    const storage = await this.deps.orchestrator.getStorage(resolvedNamespace);
    const mode = request.mode === "apply" ? "apply" : "shadow";
    const boundedBatchSize =
      typeof request.batchSize === "number" && Number.isFinite(request.batchSize)
        ? Math.max(1, Math.floor(request.batchSize))
        : undefined;
    const result = await runMemoryGovernance({
      memoryDir: storage.dir,
      mode,
      recentDays:
        typeof request.recentDays === "number" && Number.isFinite(request.recentDays)
          ? Math.max(1, Math.floor(request.recentDays))
          : undefined,
      maxMemories:
        typeof request.maxMemories === "number" && Number.isFinite(request.maxMemories)
          ? Math.max(1, Math.floor(request.maxMemories))
          : undefined,
      batchSize: boundedBatchSize,
    });
    if (mode === "apply") {
      try {
        await this.deps.orchestrator.entitySynthesisCoordinator.processQueue(
          resolvedNamespace,
          Math.min(boundedBatchSize ?? 5, 5),
        );
      } catch (error) {
        log.debug(`governanceRun: entity synthesis refresh failed after governance apply: ${error}`);
      }
    }

    return {
      namespace: resolvedNamespace,
      runId: result.runId,
      traceId: result.traceId,
      mode: result.mode,
      reviewQueueCount: result.reviewQueue.length,
      proposedActionCount: result.proposedActions.length,
      appliedActionCount: result.appliedActions.length,
      summaryPath: result.summaryPath,
      reportPath: result.reportPath,
    };
  }

  /**
   * Operator-triggered bulk drain of the entity synthesis queue (issue #2136).
   * Every automatic call site processes at most 5 entities per event, which a
   * busy deployment's queue inflow outruns; this surface drains a bounded
   * batch on demand. `maxEntities` is clamped to 200 per call so a single
   * request stays bounded; loop until `processed < requested` to drain fully.
   */
  async entitySynthesisRun(
    request: {
      namespace?: string;
      maxEntities?: number;
      authenticatedPrincipal?: string;
    },
    principal?: string,
  ): Promise<{
    namespace: string;
    requested: number;
    processed: number;
    remaining: number;
  }> {
    const resolvedNamespace = this.deps.writableNamespaceFor(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal,
    );
    let requested = 25;
    if (request.maxEntities !== undefined) {
      if (
        typeof request.maxEntities !== "number"
        || !Number.isInteger(request.maxEntities)
        || request.maxEntities < 1
      ) {
        throw new Error(
          `Invalid maxEntities: ${String(request.maxEntities)} (expected an integer >= 1)`,
        );
      }
      requested = Math.min(200, request.maxEntities);
    }
    const processed = await this.deps.orchestrator.entitySynthesisCoordinator.processQueue(
      resolvedNamespace,
      requested,
    );
    const storage = await this.deps.orchestrator.getStorage(resolvedNamespace);
    const remaining = (await storage.readEntitySynthesisQueue()).length;
    return { namespace: resolvedNamespace, requested, processed, remaining };
  }

  async conversationIndexUpdate(
    request: {
      sessionKey?: string;
      hours?: number;
      embed?: boolean;
    } = {},
  ): Promise<{
    enabled: boolean;
    sessionKey?: string;
    sessions: number;
    chunks: number;
    skipped: number;
    skippedSessionKeys: string[];
    embeddedRuns: number;
    reason?: string;
    retryAfterMs?: number;
  }> {
    if (!resolveIndexingCapabilities(this.deps.orchestrator.config).conversationIndex) {
      return {
        enabled: false,
        sessions: 0,
        chunks: 0,
        skipped: 0,
        skippedSessionKeys: [],
        embeddedRuns: 0,
        reason: "disabled",
      };
    }

    const hours =
      typeof request.hours === "number" && Number.isFinite(request.hours)
        ? Math.max(1, Math.floor(request.hours))
        : 24;

    let sessionKey: string | undefined;
    if (request.sessionKey !== undefined) {
      if (typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
        throw new EngramAccessInputError("sessionKey must be a non-empty string when provided");
      }
      sessionKey = request.sessionKey.trim();
    }

    if (sessionKey) {
      const result = await this.deps.orchestrator.conversationIndexCoordinator.update(
        sessionKey,
        hours,
        { embed: request.embed },
      );
      return {
        enabled: true,
        sessionKey,
        sessions: 1,
        chunks: result.chunks,
        skipped: result.skipped ? 1 : 0,
        skippedSessionKeys: result.skipped ? [sessionKey] : [],
        embeddedRuns: result.embedded ? 1 : 0,
        reason: result.reason,
        retryAfterMs: result.retryAfterMs,
      };
    }

    const sessionKeys = await this.deps.orchestrator.transcript.listSessionKeys();
    let chunks = 0;
    let skipped = 0;
    const skippedSessionKeys: string[] = [];
    let embeddedRuns = 0;

    for (const sessionKey of sessionKeys) {
      const result = await this.deps.orchestrator.conversationIndexCoordinator.update(
        sessionKey,
        hours,
        { embed: request.embed },
      );
      chunks += result.chunks;
      if (result.skipped) {
        skipped += 1;
        skippedSessionKeys.push(sessionKey);
      }
      if (result.embedded) {
        embeddedRuns += 1;
      }
    }

    return {
      enabled: true,
      sessions: sessionKeys.length,
      chunks,
      skipped,
      skippedSessionKeys,
      embeddedRuns,
    };
  }

  async profilingReport(
    request: AccessProfilingReportRequest = {},
  ): Promise<AccessProfilingReportResponse> {
    const profiler = this.deps.orchestrator.profiler;
    if (!profiler.isEnabled) {
      return {
        enabled: false,
        reason: "disabled",
        message: "Profiling is disabled. Set profilingEnabled: true in your plugin config to enable.",
      };
    }

    const format = request.format ?? "ascii";
    if (format !== "ascii" && format !== "json") {
      throw new EngramAccessInputError("format must be one of: ascii, json");
    }

    const limit = request.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new EngramAccessInputError("limit must be an integer between 1 and 20");
    }

    const traces = profiler.getRecentTraces(limit);
    const stats = profiler.getStats();
    const bottleneck = profiler.identifyBottleneck();

    if (format === "json") {
      return {
        enabled: true,
        format,
        traces,
        stats,
        bottleneck,
      };
    }

    const lines: string[] = [];
    lines.push("Engram Profiling Report");
    lines.push("=".repeat(60));
    lines.push("");

    type BucketEntry = { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number };
    const allBuckets: Array<[string, Record<string, BucketEntry>]> = [
      ["byKind", stats.byKind],
      ["bySpan", stats.bySpan],
    ];
    const hasStats = allBuckets.some(([, entries]) => Object.keys(entries).length > 0);
    if (hasStats) {
      lines.push("Aggregate Stats (all retained traces):");
      for (const [bucket, entries] of allBuckets) {
        for (const [key, summary] of Object.entries(entries)) {
          lines.push(
            `  ${bucket}/${key}: avg=${summary.avgMs}ms p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms max=${summary.maxMs}ms (n=${summary.count})`,
          );
        }
      }
      lines.push("");
    }

    if (bottleneck) {
      lines.push(`Bottleneck: ${bottleneck}`);
      lines.push("");
    }

    if (traces.length === 0) {
      lines.push("No traces recorded yet. Trigger a recall or extraction to see timing data.");
    } else {
      for (const trace of traces) {
        lines.push(formatProfileTraceAscii(trace));
        lines.push("");
      }
    }

    return {
      enabled: true,
      format,
      report: lines.join("\n"),
    };
  }

  /**
   * Read-only graph snapshot for the admin pane (issue #691 PR 2/5).
   *
   * Reads adjacency from the JSONL edge store written by `GraphIndex` and
   * resolves node metadata via the namespaced storage manager.  Namespace
   * resolution mirrors the read-side path used by `recall` /
   * `procedureStats`, so multi-principal deployments can't leak edges from
   * a peer namespace (CLAUDE.md rule 42).
   */
  async graphSnapshot(
    request: GraphSnapshotRequest & { namespace?: string },
    authenticatedPrincipal?: string,
  ): Promise<GraphSnapshotResponse> {
    const namespace = this.deps.resolveReadableNamespace(
      request.namespace,
      authenticatedPrincipal,
    );
    const storage = await this.deps.orchestrator.getStorage(namespace);
    const cfg = this.deps.orchestrator.config;
    const graphCaps = resolveGraphConstructionCapabilities(cfg);
    // Canonicalize the storage root once — through `realpath` so that any
    // symlink in the namespace root path itself is resolved before we
    // compare children against it.  This is required because
    // `GraphEdge.from` / `to` are JSONL-parsed strings — a malformed edge
    // with an absolute path, a `..` segment, OR a symlink that resolves
    // to a file outside the namespace would otherwise read a memory file
    // from a peer namespace, leaking metadata across tenants
    // (codex P1 + follow-up on PR #734; CLAUDE.md rule 42).
    let namespaceRootReal: string;
    try {
      namespaceRootReal = await nodeFs.realpath(storage.dir);
    } catch {
      // If the namespace root itself doesn't exist on disk yet (fresh
      // install with no memories), fall back to the lexical resolve so
      // the snapshot can still return an empty result rather than
      // throwing.  No symlink can resolve through a missing path, so
      // this fallback is safe — every candidate we see will fail the
      // realpath step below and surface as `null`.
      namespaceRootReal = nodePath.resolve(storage.dir);
    }
    const namespaceRootWithSep = namespaceRootReal.endsWith(nodePath.sep)
      ? namespaceRootReal
      : namespaceRootReal + nodePath.sep;
    const loadNode = async (relPath: string): Promise<GraphSnapshotNodeMetadata | null> => {
      // `GraphEdge.from` / `to` are storage-relative paths; resolve against
      // the namespaced storage root so the metadata read honors namespace
      // boundaries even when the same memory id exists in multiple
      // namespaces.
      //
      // Three-stage guard:
      //   1. Reject absolute paths up front — only relative endpoints are
      //      ever produced by the writer, so anything else is malformed.
      //   2. Lexical containment check on the resolved path.  This catches
      //      `..` traversals before we touch the filesystem.
      //   3. `fs.realpath` containment check — resolves symlinks so an
      //      in-namespace path that *points* at an out-of-namespace file
      //      is still rejected.  Without this step a symlinked endpoint
      //      could leak a peer namespace's frontmatter.
      // Bad paths surface a length-only warning (never echo the offending
      // segments — those would themselves cross namespace boundaries
      // through the log surface) and fall through to a `null` metadata
      // result.
      if (nodePath.isAbsolute(relPath)) {
        log.warn(
          `graphSnapshot: rejected absolute edge endpoint (len=${relPath.length}) `
          + `outside namespace root`,
        );
        return null;
      }
      const candidate = nodePath.resolve(namespaceRootReal, relPath);
      if (candidate !== namespaceRootReal && !candidate.startsWith(namespaceRootWithSep)) {
        log.warn(
          `graphSnapshot: rejected traversing edge endpoint (len=${relPath.length}) `
          + `outside namespace root`,
        );
        return null;
      }
      let canonical: string;
      try {
        canonical = await nodeFs.realpath(candidate);
      } catch {
        // Missing file — `readMemoryByPath` will return null too.  We
        // intentionally still call it so callers see a consistent
        // "unknown" result rather than special-casing missing edges.
        canonical = candidate;
      }
      if (canonical !== namespaceRootReal && !canonical.startsWith(namespaceRootWithSep)) {
        log.warn(
          `graphSnapshot: rejected symlinked edge endpoint (len=${relPath.length}) `
          + `that resolved outside namespace root`,
        );
        return null;
      }
      // Both `canonical` (realpath of candidate) and `namespaceRootReal`
      // (realpath of storage.dir) are fully resolved here, so the
      // containment check above is comparing apples-to-apples even when
      // storage.dir (= storage.baseDir) is itself a symlink to the real
      // directory.  Pass `canonical` — not the pre-realpath `candidate` —
      // so the storage read also uses the stable real path.
      const memory = await storage.readMemoryByPath(canonical);
      if (!memory) return null;
      const fm = memory.frontmatter;
      return {
        category: fm.category ?? "unknown",
        label: fm.id ?? nodePath.basename(canonical, nodePath.extname(canonical)),
        updated: fm.updated,
      };
    };
    // Use the realpath-resolved namespace root for the edge-file read so
    // the JSONL location is stable whether storage.dir is a direct path
    // or a symlink.  namespaceRootReal was computed via `fs.realpath`
    // above; using it here keeps both the graph-file I/O and the loadNode
    // containment check on the same resolved base path.
    return buildGraphSnapshot({
      memoryDir: namespaceRootReal,
      graphConfig: {
        entityGraph: graphCaps.entityGraph,
        timeGraph: graphCaps.timeGraph,
        causalGraph: graphCaps.causalGraph,
      },
      request: {
        limit: request.limit,
        since: request.since,
        focusNodeId: request.focusNodeId,
        categories: request.categories,
      },
      loadNode,
    });
  }

  /**
   * List capsule archives in the namespace-scoped capsule store.
   *
   * MCP uses this access-layer method instead of reading arbitrary paths so
   * capsule discovery remains bound to the same namespace ACLs as export and
   * import.
   */
  async capsuleList(options?: {
    namespace?: string;
    principal?: string;
  }): Promise<EngramAccessCapsuleListResponse> {
    const resolvedNamespace = this.deps.resolveReadableNamespace(options?.namespace, options?.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNamespace);
    const capsulesDir = defaultCapsulesDir(storage.dir);
    let dirEntries: import("node:fs").Dirent[];
    try {
      const capsulesDirStat = await nodeFs.lstat(capsulesDir);
      if (capsulesDirStat.isSymbolicLink()) {
        throw new EngramAccessInputError("capsule list failed: capsule store directory must not be a symlink");
      }
      if (!capsulesDirStat.isDirectory()) {
        throw new EngramAccessInputError("capsule list failed: capsule store path must be a directory");
      }
      dirEntries = await nodeFs.readdir(capsulesDir, { withFileTypes: true });
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
      if (code === "ENOENT") {
        return { namespace: resolvedNamespace, capsulesDir, capsules: [] };
      }
      throw err;
    }

    const archiveNames = dirEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".capsule.json.gz") ||
            entry.name.endsWith(".capsule.json.gz.enc")),
      )
      .map((entry) => entry.name)
      .sort();

    const capsules: CapsuleListEntry[] = [];
    for (const archiveName of archiveNames) {
      const archivePath = nodePath.join(capsulesDir, archiveName);
      const id = archiveName
        .replace(/\.capsule\.json\.gz\.enc$/, "")
        .replace(/\.capsule\.json\.gz$/, "");
      const manifestPath = nodePath.join(capsulesDir, `${id}.manifest.json`);

      let createdAt: string | null = null;
      let pluginVersion: string | null = null;
      let fileCount: number | null = null;
      let description: string | null = null;
      let manifestPathOrNull: string | null = manifestPath;

      try {
        const manifestStat = await nodeFs.lstat(manifestPath);
        if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
          capsules.push({
            id,
            archivePath,
            manifestPath: manifestPathOrNull,
            createdAt,
            pluginVersion,
            fileCount,
            description,
          });
          continue;
        }
        const raw = await nodeFs.readFile(manifestPath, "utf-8");
        const sidecar = JSON.parse(raw) as Record<string, unknown>;
        createdAt = typeof sidecar.createdAt === "string" ? sidecar.createdAt : null;
        pluginVersion = typeof sidecar.pluginVersion === "string" ? sidecar.pluginVersion : null;
        fileCount = Array.isArray(sidecar.files) ? sidecar.files.length : null;
        const capsule = sidecar.capsule as Record<string, unknown> | undefined;
        description = capsule && typeof capsule.description === "string"
          ? capsule.description
          : null;
      } catch (err) {
        const code = typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
        if (code === "ENOENT") {
          manifestPathOrNull = null;
        }
      }

      capsules.push({
        id,
        archivePath,
        manifestPath: manifestPathOrNull,
        createdAt,
        pluginVersion,
        fileCount,
        description,
      });
    }

    return { namespace: resolvedNamespace, capsulesDir, capsules };
  }

  /**
   * Manually invoke a single Dreams phase pass (PR 4/4).
   *
   * Deep-sleep delegates to memory governance (shadow → dry-run, apply → live).
   * Light-sleep and REM scan the observation ledger and memory corpus
   * respectively, returning the same telemetry shape as a scheduled run.
   */
  async dreamsRun(options: {
    phase: import("./types.js").DreamsPhase;
    dryRun?: boolean;
    namespace?: string;
    authenticatedPrincipal?: string;
  }): Promise<import("./types.js").DreamsRunResult> {
    const { runDreamsPhase } = await import("./maintenance/dreams-ledger.js");
    const validPhases = ["lightSleep", "rem", "deepSleep"];
    if (!validPhases.includes(options.phase)) {
      throw new EngramAccessInputError(
        `Invalid phase: ${String(options.phase)}. Must be one of: ${validPhases.join(", ")}`,
      );
    }
    const deepSleep = this.deps.orchestrator.config.dreamsPhases.deepSleep;
    if (
      options.phase === "deepSleep" &&
      deepSleep.enabled === false &&
      deepSleep.enabledExplicitlySet === true
    ) {
      throw new EngramAccessInputError(
        "memory governance is disabled by dreams.phases.deepSleep.enabled=false",
      );
    }
    const dryRun = options.dryRun === true;
    const resolvedNamespace = this.deps.writableNamespaceFor(
      options.namespace,
      undefined,
      options.authenticatedPrincipal,
    );
    const storage = await this.deps.orchestrator.getStorage(resolvedNamespace);
    const memoryDir = storage.dir;
    const phaseRunner = dryRun || options.phase === "deepSleep"
      ? undefined
      : async (_opts: { memoryDir: string; phase: "lightSleep" | "rem" }) => {
          if (_opts.phase === "lightSleep") {
            const result = await this.deps.orchestrator.runLifecyclePolicyNow(storage);
            return {
              itemsProcessed: result.memoriesAssessed,
              notes: `scored ${result.memoriesAssessed} memories`,
            };
          }
          const result = await this.deps.orchestrator.runSemanticConsolidationNow({
            dryRun: false,
            storage,
          });
          const itemsProcessed = result.clusters.reduce(
            (sum, cluster) => sum + cluster.memories.length,
            0,
          );
          return {
            itemsProcessed,
            notes: `REM consolidation found ${result.clustersFound} clusters`,
          };
        };
    const governanceRunner = options.phase === "deepSleep"
      ? async (_opts: { memoryDir: string; dryRun: boolean }) => {
          return this.deps.orchestrator.runDeepSleepGovernanceNow({
            storage,
            dryRun: _opts.dryRun,
          });
        }
      : undefined;
    const result = await runDreamsPhase(
      { memoryDir, phase: options.phase, dryRun },
      governanceRunner,
      phaseRunner,
    );
    return {
      phase: result.phase,
      dryRun: result.dryRun,
      durationMs: result.durationMs,
      itemsProcessed: result.itemsProcessed,
      notes: result.notes,
    };
  }

  /**
   * Manually promote a memory into one or more authorized targets. Requires
   * a non-empty reason (audit-logged). Reuses the scope-profile promotion
   * resolution and `canWriteNamespace` gate — there is no dashboard-only
   * write path.
   */
  async adminPromoteMemory(request: {
    sourceMemoryId: string;
    namespace?: string;
    principal?: string;
    sessionKey?: string;
    targets: ReadonlyArray<{ kind: MemoryPromotionTargetKind; namespace?: string }>;
    reason: string;
    actor?: never; // ignored — actor is derived from the authenticated principal
  }) {
    const config = this.deps.orchestrator.config;
    const namespacesEnabled = resolveNamespaceCapabilities(config).namespaces === true;
    // Fix OdCl3: when no namespace is supplied, resolve the source via the
    // scope plan (principal self / scope-profile write layer / coding overlay)
    // instead of falling through to config.defaultNamespace. This matches the
    // runtime observe/write path.
    let sourceNamespace: string;
    if (request.namespace) {
      sourceNamespace = this.deps.resolveReadableNamespace(
        request.namespace,
        request.principal,
      );
    } else {
      const codingContext = request.sessionKey
        ? this.deps.orchestrator.getCodingContextForSession(request.sessionKey) ?? null
        : null;
      const plan = resolveScopePlan({
        config,
        sessionKey: request.sessionKey,
        principalOverride: request.principal,
        codingContext,
        namespacesEnabled,
      });
      sourceNamespace = this.deps.resolveReadableNamespace(
        plan.baseNamespace,
        request.principal,
      );
    }
    // Fix OdB0c: thread coding context into the scope-profile plan so
    // userProject/teamProject promotion targets resolve for project-scoped
    // sessions (previously hard-coded to null).
    const codingContext = request.sessionKey
      ? this.deps.orchestrator.getCodingContextForSession(request.sessionKey) ?? null
      : null;
    const codingOverlay = codingContext
      ? resolveCodingNamespaceOverlay(
          codingContext,
          config.codingMode,
          config.defaultNamespace,
        )
      : null;
    const scopeProfilePlan = resolveScopeProfilePlan({
      config,
      principal: request.principal,
      codingContext,
      codingOverlay,
    });
    const storage: PromotionStorageProvider = {
      readMemory: async (namespace, memoryId) => {
        const resolved = await this.deps.orchestrator.getStorage(namespace);
        const memory = await resolved.getMemoryById(memoryId);
        if (!memory) return null;
        return {
          category: memory.frontmatter.category,
          content: memory.content,
          frontmatter: memory.frontmatter,
        };
      },
      writePromotedMemory: async (namespace, memory) => {
        const resolved = await this.deps.orchestrator.getStorage(namespace);
        // Sealed-envelope write (issue #1989 PR4): an admin promotion
        // REPLAYS a stored memory into another namespace — legacy rows may
        // predate current field limits, so salvage (drops warn-logged).
        const promotionEnvelope = composeMemoryEnvelope(
          {
            content: memory.content,
            category: memory.category,
            confidence: memory.confidence,
            tags: memory.tags,
            entityRef: memory.entityRef,
            validAt: memory.validAt,
            ...(memory.sourceConnector ? { sourceConnector: memory.sourceConnector } : {}),
          },
          { source: `admin-promotion:${memory.sourceNamespace}:${memory.reason.slice(0, 120)}` },
          { salvage: true },
        );
        if (promotionEnvelope.salvageNotes.length > 0) {
          log.warn(`admin-promotion write salvaged invalid fields: ${promotionEnvelope.salvageNotes.join("; ")}`);
        }
        const { id, tombstoneBlocked } = await resolved.writeSealedMemory(promotionEnvelope, {
          lineage: memory.lineage,
          sourceMemoryId: memory.sourceMemoryId,
          actor: memory.actor,
        });
        // #1645: a tombstone-blocked promotion lands pending_review (no active
        // copy in the target). Report it as a failed promotion so the admin
        // sees an honest result — the content is queued for review, not
        // actively promoted. promoteMemory's catch block sanitizes this into
        // a generic "promotion write failed" audit entry.
        if (tombstoneBlocked) {
          throw new Error(
            "target namespace tombstone-blocked the promoted content (pending_review)",
          );
        }
        return id;
      },
    };
    try {
      return await promoteMemory({
        config,
        sourceMemoryId: request.sourceMemoryId,
        sourceNamespace,
        principal: request.principal,
        targets: request.targets,
        reason: request.reason,
        actor: request.principal ?? "admin-console",
        storage,
        scopeProfilePlan,
      });
    } catch (err) {
      if (err instanceof AdminPromotionError) {
        throw new EngramAccessInputError(err.message);
      }
      throw err;
    }
  }
}
