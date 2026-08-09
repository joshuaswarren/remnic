/**
 * Recall-introspection coordinator — extracted from the orchestrator
 * (issue #1526, seam 21).
 *
 * Owns the recall observability surfaces:
 *   - last-intent / last-graph-recall / last-QMD-recall snapshot
 *     recording, reading, and explain rendering
 *   - console faithfulness distribution
 *   - background direct-answer tier annotation (observation mode, #518)
 *
 * Behavior-preserving move from orchestrator.ts. The orchestrator keeps
 * thin delegating methods; all member access flows back through
 * RecallIntrospectionDeps live accessors/arrows (late-binding rule,
 * seams 18–20).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CapabilitySet, resolveRecallAuxiliaryCapabilities } from "../capabilities.js";
import { type DirectAnswerSources, tryDirectAnswer } from "../direct-answer-wiring.js";
import type { FaithfulnessGateCounters } from "../extraction-faithfulness.js";
import { StorageManager } from "../index.js";
import { log } from "../logger.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { GraphRecallCoordinator, type GraphRecallRankedResult, type GraphRecallShadowComparison } from "./graph-recall-coordinator.js";
import { buildRecallQueryPolicy } from "../recall-query-policy.js";
import { type GraphRecallExpandedEntry, LastRecallStore, clampGraphRecallExpandedEntries } from "../recall-state.js";
import { resolveScopePlan } from "../scopes/scope-plan.js";
import { DEFAULT_TAXONOMY } from "../taxonomy/index.js";
import { listTrustZoneRecords } from "../trust-zones.js";
import type { CodingContext, MemoryFile, MemoryIntent, PluginConfig, RecallPlanMode, RecallTierExplain } from "../types.js";
import {
  parseGraphRecallRankedResults,
  parseMemoryIntentSnapshot,
  parseQmdRecallResults,
  type GraphRecallSnapshot,
  type IntentDebugSnapshot,
  type QmdRecallSnapshot,
} from "../orchestrator.js";

export interface RecallIntrospectionDeps {
  annotateDirectAnswerTier(
    prompt: string,
    sessionKey: string,
    namespaces: string[],
    expectedIdentity:
      | { writeNonce?: string; traceId?: string; recordedAt?: string }
      | undefined,
    caps: CapabilitySet,
    _parentAbortSignal?: AbortSignal,
  ): Promise<void>;
  readonly config: PluginConfig;
  directAnswerObservationChain: Promise<void>;
  effectiveCronRecallInstructionHeavyTokenCap(): number;
  readonly faithfulnessCounters: FaithfulnessGateCounters;
  getCodingContextForSession(sessionKey: string | undefined): CodingContext | null;
  getStorage(namespace?: string): Promise<StorageManager>;
  readonly graphRecallCoordinator: GraphRecallCoordinator;
  readonly lastRecall: LastRecallStore;
  trackRecallBackgroundWrite(promise: Promise<void>, label: string): void;
  resolveStateDirForNamespace(
    namespace: string,
  ): Promise<string>;
  readonly storageRouter: NamespaceStorageRouter;
}

export class RecallIntrospectionCoordinator {
  constructor(
    private readonly deps: RecallIntrospectionDeps,
  ) {}

  /**
   * Faithfulness gate verdict distribution (issue #1576). Consumed by the
   * console-state aggregator so `remnic doctor` can render how the gate is
   * performing. Returns a fresh object so callers cannot mutate the
   * internal counters. Returns `undefined` when the gate is off so the
   * console-state snapshot omits the faithfulness block entirely (cursor
   * review: an all-zero block would otherwise always be truthy and leak
   * into snapshots that document it as absent-when-off).
   */
  getConsoleFaithfulnessDistribution(): FaithfulnessGateCounters | undefined {
    if (this.deps.config.extractionFaithfulnessGate === "off") return undefined;
    return { ...this.deps.faithfulnessCounters };
  }

  async getLastGraphRecallSnapshot(
    namespace?: string,
  ): Promise<GraphRecallSnapshot | null> {
    const storage = await this.deps.getStorage(namespace);
    const snapshotPath = path.join(
      storage.dir,
      "state",
      "last_graph_recall.json",
    );
    try {
      const raw = await readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GraphRecallSnapshot>;
      if (!parsed || typeof parsed !== "object") return null;
      return {
        recordedAt:
          typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
        mode: typeof parsed.mode === "string" ? parsed.mode : "full",
        queryHash: typeof parsed.queryHash === "string" ? parsed.queryHash : "",
        queryLength:
          typeof parsed.queryLength === "number" ? parsed.queryLength : 0,
        namespaces: Array.isArray(parsed.namespaces)
          ? parsed.namespaces.filter((v): v is string => typeof v === "string")
          : [],
        seedCount: typeof parsed.seedCount === "number" ? parsed.seedCount : 0,
        expandedCount:
          typeof parsed.expandedCount === "number" ? parsed.expandedCount : 0,
        seeds: Array.isArray(parsed.seeds)
          ? parsed.seeds.filter((v): v is string => typeof v === "string")
          : [],
        expanded: clampGraphRecallExpandedEntries(parsed.expanded, 64),
        status:
          parsed.status === "completed" ||
          parsed.status === "skipped" ||
          parsed.status === "aborted"
            ? parsed.status
            : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        shadowMode: parsed.shadowMode === true,
        queryIntent: parseMemoryIntentSnapshot(parsed.queryIntent),
        seedResults: parseGraphRecallRankedResults(parsed.seedResults),
        finalResults: parseGraphRecallRankedResults(parsed.finalResults),
        shadowComparison:
          parsed.shadowComparison && typeof parsed.shadowComparison === "object"
            ? {
                baselineCount:
                  typeof parsed.shadowComparison.baselineCount === "number"
                    ? parsed.shadowComparison.baselineCount
                    : 0,
                graphCount:
                  typeof parsed.shadowComparison.graphCount === "number"
                    ? parsed.shadowComparison.graphCount
                    : 0,
                overlapCount:
                  typeof parsed.shadowComparison.overlapCount === "number"
                    ? parsed.shadowComparison.overlapCount
                    : 0,
                overlapRatio:
                  typeof parsed.shadowComparison.overlapRatio === "number"
                    ? parsed.shadowComparison.overlapRatio
                    : 0,
                averageOverlapDelta:
                  typeof parsed.shadowComparison.averageOverlapDelta ===
                  "number"
                    ? parsed.shadowComparison.averageOverlapDelta
                    : 0,
              }
            : undefined,
      };
    } catch {
      return null;
    }
  }

  async getLastIntentSnapshot(
    namespace?: string,
  ): Promise<IntentDebugSnapshot | null> {
    const storage = await this.deps.getStorage(namespace);
    const snapshotPath = path.join(storage.dir, "state", "last_intent.json");
    try {
      const raw = await readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<IntentDebugSnapshot>;
      if (!parsed || typeof parsed !== "object") return null;
      const graphDecision =
        parsed.graphDecision && typeof parsed.graphDecision === "object"
          ? parsed.graphDecision
          : undefined;
      return {
        recordedAt:
          typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
        promptHash:
          typeof parsed.promptHash === "string" ? parsed.promptHash : "",
        promptLength:
          typeof parsed.promptLength === "number" ? parsed.promptLength : 0,
        retrievalQueryHash:
          typeof parsed.retrievalQueryHash === "string"
            ? parsed.retrievalQueryHash
            : "",
        retrievalQueryLength:
          typeof parsed.retrievalQueryLength === "number"
            ? parsed.retrievalQueryLength
            : 0,
        plannerEnabled: parsed.plannerEnabled !== false,
        plannedMode:
          parsed.plannedMode === "no_recall" ||
          parsed.plannedMode === "minimal" ||
          parsed.plannedMode === "full" ||
          parsed.plannedMode === "graph_mode"
            ? parsed.plannedMode
            : "full",
        effectiveMode:
          parsed.effectiveMode === "no_recall" ||
          parsed.effectiveMode === "minimal" ||
          parsed.effectiveMode === "full" ||
          parsed.effectiveMode === "graph_mode"
            ? parsed.effectiveMode
            : "full",
        recallResultLimit:
          typeof parsed.recallResultLimit === "number"
            ? parsed.recallResultLimit
            : 0,
        queryIntent: parseMemoryIntentSnapshot(parsed.queryIntent),
        graphExpandedIntentDetected:
          parsed.graphExpandedIntentDetected === true,
        graphDecision: {
          status:
            graphDecision?.status === "skipped" ||
            graphDecision?.status === "completed" ||
            graphDecision?.status === "aborted"
              ? graphDecision.status
              : "not_requested",
          reason:
            typeof graphDecision?.reason === "string"
              ? graphDecision.reason
              : undefined,
          shadowMode: graphDecision?.shadowMode === true,
          qmdAvailable: graphDecision?.qmdAvailable !== false,
          graphRecallEnabled: graphDecision?.graphRecallEnabled !== false,
          multiGraphMemoryEnabled:
            graphDecision?.multiGraphMemoryEnabled !== false,
        },
      };
    } catch {
      return null;
    }
  }

  async getLastQmdRecallSnapshot(
    namespace?: string,
  ): Promise<QmdRecallSnapshot | null> {
    const storage = await this.deps.getStorage(namespace);
    const snapshotPath = path.join(
      storage.dir,
      "state",
      "last_qmd_recall.json",
    );
    try {
      const raw = await readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<QmdRecallSnapshot>;
      if (!parsed || typeof parsed !== "object") return null;
      return {
        recordedAt:
          typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
        queryHash: typeof parsed.queryHash === "string" ? parsed.queryHash : "",
        queryLength:
          typeof parsed.queryLength === "number" ? parsed.queryLength : 0,
        collection:
          typeof parsed.collection === "string" ? parsed.collection : undefined,
        namespaces: Array.isArray(parsed.namespaces)
          ? parsed.namespaces.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        fetchLimit:
          typeof parsed.fetchLimit === "number" ? parsed.fetchLimit : 0,
        primaryResultCount:
          typeof parsed.primaryResultCount === "number"
            ? parsed.primaryResultCount
            : 0,
        hybridResultCount:
          typeof parsed.hybridResultCount === "number"
            ? parsed.hybridResultCount
            : 0,
        queryAwareSeedCount:
          typeof parsed.queryAwareSeedCount === "number"
            ? parsed.queryAwareSeedCount
            : 0,
        resultCount:
          typeof parsed.resultCount === "number" ? parsed.resultCount : 0,
        intentHint:
          typeof parsed.intentHint === "string" ? parsed.intentHint : undefined,
        explainEnabled: parsed.explainEnabled === true,
        hybridTopUpUsed: parsed.hybridTopUpUsed === true,
        hybridTopUpSkippedReason:
          typeof parsed.hybridTopUpSkippedReason === "string"
            ? parsed.hybridTopUpSkippedReason
            : undefined,
        results: parseQmdRecallResults(parsed.results),
      };
    } catch {
      return null;
    }
  }

  async explainLastGraphRecall(options?: {
    namespace?: string;
    maxExpanded?: number;
  }): Promise<string> {
    const snapshot = await this.getLastGraphRecallSnapshot(options?.namespace);
    if (!snapshot) return "No graph-recall snapshot found yet.";
    const maxExpanded = Math.max(1, Math.min(50, options?.maxExpanded ?? 10));
    const expanded = snapshot.expanded.slice(0, maxExpanded);
    const seedResults = (snapshot.seedResults ?? []).slice(0, maxExpanded);
    const finalResults = (snapshot.finalResults ?? []).slice(0, maxExpanded);
    const queryIntent = snapshot.queryIntent ?? {
      goal: "unknown",
      actionType: "unknown",
      entityTypes: [],
    };
    return [
      "## Last Graph Recall",
      "",
      `Recorded at: ${snapshot.recordedAt || "unknown"}`,
      `Mode: ${snapshot.mode}`,
      `Status: ${snapshot.status ?? "completed"}${snapshot.shadowMode ? " (shadow)" : ""}`,
      `Reason: ${snapshot.reason ?? "n/a"}`,
      `Query hash: ${snapshot.queryHash || "unknown"} (len=${snapshot.queryLength})`,
      `Query intent: goal=${queryIntent.goal}, action=${queryIntent.actionType}, entityTypes=${queryIntent.entityTypes.length > 0 ? queryIntent.entityTypes.join(", ") : "none"}`,
      `Namespaces: ${snapshot.namespaces.length > 0 ? snapshot.namespaces.join(", ") : "none"}`,
      `Seed results (${snapshot.seedResults?.length ?? 0}, showing ${seedResults.length}):`,
      ...seedResults.map(
        (entry) =>
          `- ${entry.path} (score=${entry.score.toFixed(3)}, sources=${entry.sourceLabels.join(",") || "baseline"})`,
      ),
      `Seed paths (${snapshot.seedCount}):`,
      ...snapshot.seeds.map((p) => `- ${p}`),
      `Expanded paths (${snapshot.expandedCount}, showing ${expanded.length}):`,
      ...expanded.map((e) => {
        // Issue #681 PR 3/3 — surface per-edge confidence in the
        // graph-explain document. Legacy snapshots without
        // `edgeConfidence` render as `conf=n/a` so older payloads
        // remain readable.
        const confLabel =
          typeof e.edgeConfidence === "number" && Number.isFinite(e.edgeConfidence)
            ? e.edgeConfidence.toFixed(2)
            : "n/a";
        const pathLabel =
          Array.isArray(e.pathNodeIds) && e.pathNodeIds.length > 0
            ? `, path=${e.pathNodeIds.join("->")}`
            : "";
        const penaltyLabel =
          typeof e.pathPenaltyApplied === "boolean"
            ? `, penalty=${e.pathPenaltyApplied ? "yes" : "no"}`
            : "";
        return `- ${e.path} (score=${e.score.toFixed(3)}, ns=${e.namespace}, seed=${e.seed || "unknown"}, hop=${e.hopDepth}, w=${e.decayedWeight.toFixed(3)}, type=${e.graphType}, conf=${confLabel}${penaltyLabel}${pathLabel})`;
      }),
      `Final ranked results (${snapshot.finalResults?.length ?? 0}, showing ${finalResults.length}):`,
      ...finalResults.map(
        (entry) =>
          `- ${entry.path} (score=${entry.score.toFixed(3)}, sources=${entry.sourceLabels.join(",") || "baseline"})`,
      ),
      ...(snapshot.shadowComparison
        ? [
            `Shadow comparison: baseline=${snapshot.shadowComparison.baselineCount}, graph=${snapshot.shadowComparison.graphCount}, overlap=${snapshot.shadowComparison.overlapCount} (${snapshot.shadowComparison.overlapRatio.toFixed(2)}), avgDelta=${snapshot.shadowComparison.averageOverlapDelta.toFixed(3)}`,
          ]
        : []),
    ].join("\n");
  }

  async explainLastIntent(options?: { namespace?: string }): Promise<string> {
    const snapshot = await this.getLastIntentSnapshot(options?.namespace);
    if (!snapshot) return "No intent-debug snapshot found yet.";
    return [
      "## Last Intent Debug",
      "",
      `Recorded at: ${snapshot.recordedAt || "unknown"}`,
      `Prompt hash: ${snapshot.promptHash || "unknown"} (len=${snapshot.promptLength})`,
      `Retrieval query hash: ${snapshot.retrievalQueryHash || "unknown"} (len=${snapshot.retrievalQueryLength})`,
      `Planner enabled: ${snapshot.plannerEnabled ? "yes" : "no"}`,
      `Planned mode: ${snapshot.plannedMode}`,
      `Effective mode: ${snapshot.effectiveMode}`,
      `Recall result limit: ${snapshot.recallResultLimit}`,
      `Query intent: goal=${snapshot.queryIntent.goal}, action=${snapshot.queryIntent.actionType}, entityTypes=${snapshot.queryIntent.entityTypes.length > 0 ? snapshot.queryIntent.entityTypes.join(", ") : "none"}`,
      `Broad graph intent: ${snapshot.graphExpandedIntentDetected ? "yes" : "no"}`,
      `Graph decision: status=${snapshot.graphDecision.status}, reason=${snapshot.graphDecision.reason ?? "n/a"}, shadow=${snapshot.graphDecision.shadowMode ? "yes" : "no"}, qmdAvailable=${snapshot.graphDecision.qmdAvailable ? "yes" : "no"}, graphRecallEnabled=${snapshot.graphDecision.graphRecallEnabled ? "yes" : "no"}, multiGraphMemoryEnabled=${snapshot.graphDecision.multiGraphMemoryEnabled ? "yes" : "no"}`,
    ].join("\n");
  }

  async explainLastQmdRecall(options?: {
    namespace?: string;
    maxResults?: number;
  }): Promise<string> {
    const snapshot = await this.getLastQmdRecallSnapshot(options?.namespace);
    if (!snapshot) return "No QMD recall snapshot found yet.";
    const maxResults = Math.max(1, Math.min(25, options?.maxResults ?? 10));
    const shown = snapshot.results.slice(0, maxResults);
    return [
      "## Last QMD Recall",
      "",
      `Recorded at: ${snapshot.recordedAt || "unknown"}`,
      `Query hash: ${snapshot.queryHash || "unknown"} (len=${snapshot.queryLength})`,
      `Collection: ${snapshot.collection ?? "default"}`,
      `Namespaces: ${snapshot.namespaces.length > 0 ? snapshot.namespaces.join(", ") : "none"}`,
      `Fetch limit: ${snapshot.fetchLimit}`,
      `Primary results: ${snapshot.primaryResultCount}`,
      `Hybrid top-up results: ${snapshot.hybridResultCount}`,
      `Query-aware seeds: ${snapshot.queryAwareSeedCount}`,
      `Final results: ${snapshot.resultCount}`,
      `Intent hint: ${snapshot.intentHint ?? "none"}`,
      `Explain enabled: ${snapshot.explainEnabled ? "yes" : "no"}`,
      `Hybrid top-up used: ${snapshot.hybridTopUpUsed ? "yes" : "no"}`,
      `Hybrid top-up skipped reason: ${snapshot.hybridTopUpSkippedReason ?? "n/a"}`,
      `Top results (${shown.length}):`,
      ...shown.map((result) => {
        const explainParts = [
          typeof result.explain?.blendedScore === "number"
            ? `blended=${result.explain.blendedScore.toFixed(3)}`
            : null,
          typeof result.explain?.rerankScore === "number"
            ? `rerank=${result.explain.rerankScore.toFixed(3)}`
            : null,
          typeof result.explain?.rrf === "number"
            ? `rrf=${result.explain.rrf.toFixed(3)}`
            : null,
        ].filter((entry): entry is string => Boolean(entry));
        const explainText =
          explainParts.length > 0 ? `, explain=${explainParts.join("/")}` : "";
        return `- ${result.path} (score=${result.score.toFixed(3)}, transport=${result.transport ?? "unknown"}${explainText})`;
      }),
    ].join("\n");
  }

  /**
   * Await the in-flight observation-mode direct-answer annotation chain.
   * Resolves to true when settled, false on timeout.
   */
  async waitForDirectAnswerObservationIdle(
    timeoutMs: number = 60_000,
  ): Promise<boolean> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const result = await Promise.race([
        this.deps.directAnswerObservationChain.then(() => "ok" as const),
        timeoutPromise,
      ]);
      if (result === "timeout") {
        log.warn(
          `waitForDirectAnswerObservationIdle timed out after ${timeoutMs}ms`,
        );
        return false;
      }
      return true;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  enqueueDirectAnswerObservation(
    prompt: string,
    sessionKey: string,
    namespaceOverride: string | undefined,
    principalOverride: string | undefined,
    caps: CapabilitySet,
    namespacesEnabled: boolean,
  ): void {
    const expectedSnapshot = this.deps.lastRecall.get(sessionKey);
    if (expectedSnapshot === null) return;
    if (expectedSnapshot.plannerMode === "no_recall") return;

    // Resolve the observation namespace set through the SAME ScopePlan resolver
    // the main recall path uses (#1521). The observe path does NOT throw on an
    // unreadable override (it falls through to the coding/legacy branches), so
    // we skip the readability gate the recall path enforces.
    const observationScopePlan = resolveScopePlan({
      config: this.deps.config,
      sessionKey,
      namespace: namespaceOverride,
      principalOverride,
      codingContext: sessionKey
        ? this.deps.getCodingContextForSession(sessionKey)
        : null,
      namespacesEnabled,
    });
    const observationNamespaces = observationScopePlan.readNamespaces;
    const observationQueryPolicy = buildRecallQueryPolicy(prompt, sessionKey, {
      cronRecallPolicyEnabled: resolveRecallAuxiliaryCapabilities(this.deps.config).cronRecallPolicy,
      cronRecallNormalizedQueryMaxChars:
        this.deps.config.cronRecallNormalizedQueryMaxChars,
      cronRecallInstructionHeavyTokenCap:
        this.deps.effectiveCronRecallInstructionHeavyTokenCap(),
      cronConversationRecallMode: this.deps.config.cronConversationRecallMode,
    });
    const observationQuery = observationQueryPolicy.retrievalQuery || prompt;
    const expectedIdentity = {
      writeNonce: expectedSnapshot.writeNonce,
      traceId: expectedSnapshot.traceId,
      recordedAt: expectedSnapshot.recordedAt,
    };
    const previous = this.deps.directAnswerObservationChain;
    this.deps.directAnswerObservationChain = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.deps.annotateDirectAnswerTier(
            observationQuery,
            sessionKey,
            observationNamespaces,
            expectedIdentity,
            caps,
            undefined,
          );
        } catch (err) {
          log.debug(`direct-answer observation chain error: ${err}`);
        }
      });
    this.deps.trackRecallBackgroundWrite(
      this.deps.directAnswerObservationChain,
      "direct-answer observation",
    );
  }

  async annotateDirectAnswerTier(
    prompt: string,
    sessionKey: string,
    namespaces: string[],
    expectedIdentity:
      | { writeNonce?: string; traceId?: string; recordedAt?: string }
      | undefined,
    caps: CapabilitySet,
    _parentAbortSignal?: AbortSignal,
  ): Promise<void> {
    const tierStart = Date.now();
    try {
      if (namespaces.length === 0) return;

      const trustZoneByNsAndRecordId = new Map<
        string,
        "quarantine" | "working" | "trusted"
      >();
      const trustZoneKey = (ns: string, recordId: string) =>
        `${ns}\u0000${recordId}`;
      const scopedStorages = new Map<
        string,
        Awaited<ReturnType<typeof this.deps.storageRouter.storageFor>>
      >();

      for (const ns of namespaces) {
        const storage = await this.deps.storageRouter.storageFor(ns);
        scopedStorages.set(ns, storage);
        const trustZones = await listTrustZoneRecords({
          memoryDir: storage.dir,
          trustZoneStoreDir: this.deps.config.trustZoneStoreDir,
          limit: 200,
        }).catch(() => ({
          allRecords: [] as Array<{
            recordId: string;
            zone: "quarantine" | "working" | "trusted";
          }>,
        }));
        for (const record of trustZones.allRecords ?? []) {
          trustZoneByNsAndRecordId.set(
            trustZoneKey(ns, record.recordId),
            record.zone,
          );
        }
      }

      const memoryNamespaceByPath = new Map<string, string>();
      const memoryNamespaceById = new Map<string, string>();
      let candidatesConsidered = 0;

      const sources: DirectAnswerSources = {
        taxonomy: DEFAULT_TAXONOMY,
        listCandidateMemories: async (options: { namespace: string; abortSignal?: AbortSignal }) => {
          const targetNs = options.namespace;
          const storage =
            scopedStorages.get(targetNs) ??
            (await this.deps.storageRouter.storageFor(targetNs));
          const all = await storage.readAllMemories();
          const active: MemoryFile[] = [];
          for (const m of all) {
            if ((m.frontmatter.status ?? "active") === "active") {
              active.push(m);
              memoryNamespaceByPath.set(m.path, targetNs);
              if (m.frontmatter.id) {
                memoryNamespaceById.set(m.frontmatter.id, targetNs);
              }
            }
          }
          candidatesConsidered += active.length;
          return active;
        },
        trustZoneFor: async (memoryId: string) => {
          const ns = memoryNamespaceById.get(memoryId);
          if (!ns) return null;
          return (
            trustZoneByNsAndRecordId.get(
              trustZoneKey(ns, memoryId),
            ) ?? null
          );
        },
        importanceFor: (memory) =>
          typeof memory.frontmatter.importance?.score === "number"
            ? memory.frontmatter.importance.score
            : 0,
      };

      let result: import("../direct-answer.js").DirectAnswerResult | undefined;
      for (const ns of namespaces) {
        const r = await tryDirectAnswer({
          query: prompt,
          namespace: ns,
          config: this.deps.config,
          enabled: caps.recallDirectAnswer,
          sources,
        });
        if (r.eligible && r.winner) {
          result = r;
          break;
        }
      }

      if (!result?.eligible || !result?.winner) return;

      const explain: RecallTierExplain = {
        tier: "direct-answer",
        tierReason: result.narrative,
        filteredBy: result.filteredBy,
        candidatesConsidered,
        latencyMs: Date.now() - tierStart,
        sourceAnchors: [{ path: result.winner.memory.path }],
      };

      await this.deps.lastRecall.annotateTierExplain(
        sessionKey,
        explain,
        expectedIdentity,
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      log.debug(`direct-answer observation failed: ${err}`);
    }
  }

  // Issue #1526 (seam 14): graph-recall snapshot moved to
  // GraphRecallCoordinator. Thin delegation keeps the private API stable.
  async recordLastGraphRecallSnapshot(options: {
    storage: StorageManager;
    prompt: string;
    recallMode: RecallPlanMode;
    recallNamespaces: string[];
    seedPaths: string[];
    expandedPaths: GraphRecallExpandedEntry[];
    status: "completed" | "skipped" | "aborted";
    reason?: string;
    shadowMode?: boolean;
    queryIntent: MemoryIntent;
    seedResults?: GraphRecallRankedResult[];
    finalResults?: GraphRecallRankedResult[];
    shadowComparison?: GraphRecallShadowComparison;
  }): Promise<void> {
    return this.deps.graphRecallCoordinator.recordLastGraphRecallSnapshot(options);
  }

  async recordLastIntentSnapshot(options: {
    storage: StorageManager;
    snapshot: IntentDebugSnapshot;
  }): Promise<void> {
    try {
      const snapshotPath = path.join(
        options.storage.dir,
        "state",
        "last_intent.json",
      );
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(
        snapshotPath,
        JSON.stringify(options.snapshot, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.debug(`last intent write failed: ${err}`);
    }
  }

  async recordLastQmdRecallSnapshot(options: {
    storage: StorageManager;
    snapshot: QmdRecallSnapshot;
  }): Promise<void> {
    try {
      const snapshotPath = path.join(
        options.storage.dir,
        "state",
        "last_qmd_recall.json",
      );
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(
        snapshotPath,
        JSON.stringify(options.snapshot, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.debug(`last qmd recall write failed: ${err}`);
    }
  }

  async recordLastIntentSnapshotForNamespace(options: {
    namespace: string;
    snapshot: IntentDebugSnapshot;
  }): Promise<void> {
    try {
      const stateDir = await this.deps.resolveStateDirForNamespace(
        options.namespace,
      );
      const snapshotPath = path.join(stateDir, "last_intent.json");
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(
        snapshotPath,
        JSON.stringify(options.snapshot, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.debug(`last intent write failed: ${err}`);
    }
  }
}
