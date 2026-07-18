/**
 * Semantic-consolidation coordinator — extracted from the orchestrator
 * (issue #1526, seam 5).
 *
 * Owns the semantic-consolidation lifecycle: discovering clusters of
 * similar memories, synthesizing a canonical memory per cluster via the
 * LLM (operator-aware or legacy), archiving the superseded sources, and
 * firing post-consolidation hooks (Codex materialize, peer-profile
 * reasoner).
 *
 * The orchestrator constructs one instance and delegates the internal
 * entrypoint (`runSemanticConsolidation`) to it. The public wrappers
 * (`runSemanticConsolidationNow`, `runSemanticConsolidationFanout`)
 * remain on the orchestrator as thin pass-throughs. Storage is the
 * orchestrator's stable `this.storage` (or a per-namespace override
 * passed via options); the fast-tier LLM, content-hash removal, and
 * index save arrive as callbacks so the orchestrator keeps ownership of
 * gateway routing and cross-subsystem persistence.
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps a thin delegating method so existing call sites
 * and tests that exercise the public API continue to work.
 */

import {
  findSimilarClusters,
  buildConsolidationPrompt,
  parseConsolidationResponse,
  buildOperatorAwareConsolidationPrompt,
  parseOperatorAwareConsolidationResponse,
  chooseConsolidationOperator,
  buildExtensionsBlockForConsolidation,
  materializeAfterSemanticConsolidation,
} from "../semantic-consolidation.js";
import type {
  SemanticConsolidationLlmOperator,
  SemanticConsolidationResult,
} from "../semantic-consolidation.js";
import {
  FallbackLlmClient,
  fallbackLlmRuntimeContextFromConfig,
  gatewayTaskChainOptions,
} from "../fallback-llm.js";
import { resolveIndexingCapabilities, resolveConsolidationCapabilities } from "../capabilities.js";
import { deindexMemoriesBatchAsync } from "../temporal-index.js";
import { runPeerProfileReasoner } from "../peers/index.js";
import type { StorageManager } from "../index.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { EmbeddingFallback } from "../embedding-fallback.js";
import type { PluginConfig, MemoryFile, AgentPersonaModelConfig } from "../types.js";
import { log } from "../logger.js";
import { resolveConversationContextCapabilities } from "../capabilities.js";

/** Dependencies injected by the orchestrator. All stable references or
 *  live accessors. */
export interface SemanticConsolidationCoordinatorDeps {
  config: PluginConfig;
  /** Live accessor: the orchestrator's storage manager (stable post-ctor). */
  getStorage: () => StorageManager;
  /** Live accessor for the fast-tier local LLM client (falls back to main
   *  local LLM when localLlmFastEnabled is false — orchestrator ctor handles
   *  this). Injected as an accessor so tests that overwrite orchestrator.fastLlm
   *  after construction still take effect. */
  getFastLlm: () => LocalLlmClient;
  /** The embedding-fallback manager used for index cleanup on archival. */
  embeddingFallback: EmbeddingFallback;
  /** Remove a memory's content-hash entry from the storage-scoped index.
   *  Delegated to the orchestrator which owns the per-storage index map. */
  removeContentHashForMemory: (
    targetStorage: StorageManager,
    memory: MemoryFile,
    context: string,
  ) => Promise<void>;
  /** Persist all dirty content-hash indexes to disk. */
  saveContentHashIndexes: () => Promise<void>;
}

/**
 * Coordinates semantic consolidation. Holds no mutable state of its own —
 * all persistence flows through the injected storage managers and
 * callbacks.
 */
export class SemanticConsolidationCoordinator {
  constructor(private readonly deps: SemanticConsolidationCoordinatorDeps) {}

  private get config(): PluginConfig {
    return this.deps.config;
  }

  async runSemanticConsolidation(options?: {
    dryRun?: boolean;
    thresholdOverride?: number;
    force?: boolean;
    storage?: StorageManager;
  }): Promise<SemanticConsolidationResult> {
    const targetStorage = options?.storage ?? this.deps.getStorage();
    const result: SemanticConsolidationResult = {
      clustersFound: 0,
      memoriesConsolidated: 0,
      memoriesArchived: 0,
      errors: 0,
      clusters: [],
    };

    if (!resolveConsolidationCapabilities(this.config).semanticConsolidation && !options?.force) {
      log.debug("[semantic-consolidation] disabled in config");
      return result;
    }

    log.info("[semantic-consolidation] starting run");

    const allMemories = await targetStorage.readAllMemories();
    if (allMemories.length < 10) {
      log.debug("[semantic-consolidation] too few memories, skipping");
      return result;
    }

    const threshold =
      options?.thresholdOverride ?? this.config.semanticConsolidationThreshold;
    const clusters = findSimilarClusters(allMemories, {
      threshold,
      minClusterSize: this.config.semanticConsolidationMinClusterSize,
      excludeCategories: this.config.semanticConsolidationExcludeCategories,
      maxPerRun: this.config.semanticConsolidationMaxPerRun,
    });

    result.clustersFound = clusters.length;
    result.clusters = clusters;

    if (clusters.length === 0) {
      log.info("[semantic-consolidation] no clusters found");
      return result;
    }

    log.info(`[semantic-consolidation] found ${clusters.length} cluster(s)`);

    if (options?.dryRun) {
      log.info(
        "[semantic-consolidation] dry run — skipping LLM synthesis and archival",
      );
      return result;
    }

    // Use FallbackLlmClient for LLM calls (same pattern as causal-consolidation.ts)
    // Honor semanticConsolidationModel: "auto" = primary, "fast" = local fast, or specific model
    const useGateway = this.config.modelSource === "gateway";
    const modelSetting = this.config.semanticConsolidationModel;
    if (modelSetting === "fast" && this.deps.getFastLlm() && !useGateway) {
      log.info("[semantic-consolidation] using fast local LLM for synthesis");
    }
    // Gateway routing: an explicit "fast" setting keeps the fast persona chain
    // (the operator's deliberate fast-tier choice). Otherwise route through the
    // shared task-chain resolution so taskModelChain applies to semantic
    // consolidation like every other background task (gotcha #22). Issue #1365.
    const gatewayChainOptions: { modelChain?: AgentPersonaModelConfig; agentId?: string } =
      !useGateway
        ? {}
        : modelSetting === "fast"
          ? (this.config.fastGatewayAgentId
              ? { agentId: this.config.fastGatewayAgentId }
              : this.config.gatewayAgentId
                ? { agentId: this.config.gatewayAgentId }
                : {})
          : gatewayTaskChainOptions(this.config);
    const llm = new FallbackLlmClient(
      this.config.gatewayConfig,
      fallbackLlmRuntimeContextFromConfig(this.config),
    );
    if (!llm.isAvailable(gatewayChainOptions) && !(modelSetting === "fast" && this.deps.getFastLlm() && !useGateway)) {
      log.warn(
        "[semantic-consolidation] no LLM available — skipping synthesis",
      );
      return result;
    }

    // Discover memory extensions once for all clusters (#382)
    let extensionsBlock = "";
    try {
      extensionsBlock = await buildExtensionsBlockForConsolidation(this.config);
    } catch (err) {
      log.warn(`[semantic-consolidation] extension discovery failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const cluster of clusters) {
      let canonicalWriteCompleted = false;
      try {
        // Operator-aware prompt (issue #561 PR 3): ask the LLM to pick the
        // SPLIT/MERGE/UPDATE operator alongside the canonical output.  Falls
        // back to the legacy plain-blob prompt when operator-aware
        // consolidation is explicitly disabled via config, so rollbacks stay
        // clean.
        // Use the `=== true` idiom for default-false flags (PR #632
        // review, cursor Low): sibling disabled-by-default flags like
        // `semanticConsolidationEnabled` follow the same convention,
        // while `!== false` is reserved for default-on flags.
        const operatorAwareEnabled =
          resolveConversationContextCapabilities(this.config).operatorAwareConsolidation === true;
        let prompt = operatorAwareEnabled
          ? buildOperatorAwareConsolidationPrompt(cluster)
          : buildConsolidationPrompt(cluster);
        if (extensionsBlock.length > 0) {
          prompt += "\n\n" + extensionsBlock;
        }
        const messages = [
          {
            role: "system" as const,
            content: operatorAwareEnabled
              ? 'You are a memory consolidation system. Return ONLY a JSON object with two keys, "operator" and "output". The "operator" value MUST be one of the exact strings "merge", "update", or "split" — never a pipe-separated placeholder, never prose. The "output" value is the canonical memory text.'
              : "You are a memory consolidation system. Output only the consolidated memory text.",
          },
          { role: "user" as const, content: prompt },
        ];
        const llmOpts = { temperature: 0.2, maxTokens: 2000 };

        // Route to the configured model
        let response: { content: string } | null = null;
        if (useGateway) {
          // Gateway model source — use the appropriate agent chain
          response = await llm.chatCompletion(messages, { ...llmOpts, ...gatewayChainOptions });
        } else if (modelSetting === "fast" && this.deps.getFastLlm()) {
          const fastResult = await this.deps.getFastLlm().chatCompletion(messages, {
            operation: "semantic-consolidation",
            maxTokens: llmOpts.maxTokens,
            temperature: llmOpts.temperature,
            priority: "background",
            forceDisableThinking: true,
          });
          response = fastResult ? { content: fastResult.content } : null;
        } else {
          response = await llm.chatCompletion(messages, llmOpts);
        }

        if (!response?.content) {
          log.warn(
            `[semantic-consolidation] empty LLM response for cluster in "${cluster.category}"`,
          );
          result.errors++;
          continue;
        }

        // Operator-aware parse (issue #561 PR 3).  In legacy mode we fall
        // back to the plain-text parser and derive the operator from the
        // cluster-shape heuristic so `derived_via` still lands.
        // Restricted to `SemanticConsolidationLlmOperator`
        // (split/merge/update) — `pattern-reinforcement` joined the
        // wider `ConsolidationOperator` type in #687 PR 2/4 but is
        // reserved for the maintenance job and must never be assignable
        // here (Cursor Bugbot review, PR #730).
        let canonicalContent: string;
        let operator: SemanticConsolidationLlmOperator;
        if (operatorAwareEnabled) {
          const parsed = parseOperatorAwareConsolidationResponse(
            response.content,
            cluster,
          );
          canonicalContent = parsed.output;
          operator = parsed.operator;
        } else {
          canonicalContent = parseConsolidationResponse(response.content);
          operator = chooseConsolidationOperator(cluster);
        }
        cluster.canonicalContent = canonicalContent;

        // Pick the most recent memory's metadata as the basis for lineage
        const sorted = [...cluster.memories].sort(
          (a, b) =>
            new Date(b.frontmatter.created).getTime() -
            new Date(a.frontmatter.created).getTime(),
        );
        const newest = sorted[0];
        const lineageIds = cluster.memories.map((m) => m.frontmatter.id);

        // Consolidation provenance (issue #561 PR 2+3): snapshot each
        // source memory BEFORE archiving it, collecting
        // "<relpath>:<versionId>" pointers for the new canonical memory's
        // `derived_from` frontmatter field.  Snapshots are best-effort — if
        // page-versioning is disabled (default in `config.ts`) or a single
        // source fails to snapshot we simply omit that entry rather than
        // abort the consolidation.  The `derived_via` operator is chosen
        // above (PR 3) from the LLM response or the cluster-shape
        // heuristic fallback and emitted unconditionally so consolidation
        // outputs stay identifiable even when no snapshots are captured
        // (PR #624 review feedback).
        const derivedFromEntries: string[] = [];
        for (const m of cluster.memories) {
          if (!m.path) continue;
          const entry = await targetStorage.snapshotForProvenance(m.path);
          if (entry) derivedFromEntries.push(entry);
        }

        // Write the canonical memory
        const { id: canonicalId, tombstoneBlocked: canonicalBlocked } = await targetStorage.writeMemory(
          newest.frontmatter.category,
          canonicalContent,
          {
            actor: "semantic-consolidation",
            confidence: newest.frontmatter.confidence,
            tags: [
              ...new Set(
                cluster.memories.flatMap((m) => m.frontmatter.tags ?? []),
              ),
            ],
            source: "semantic-consolidation",
            lineage: lineageIds,
            derivedFrom: derivedFromEntries.length > 0 ? derivedFromEntries : undefined,
            derivedVia: operator,
          },
        );
        if (canonicalBlocked) {
          // #1645: canonical matched a tombstone (pending_review). Don't archive
          // the sources — consolidation must never delete the only active copy.
          log.info(`[semantic-consolidation] cluster in "${cluster.category}" tombstone-blocked — keeping ${cluster.memories.length} source(s) active (pending_review ${canonicalId})`);
          continue;
        }
        canonicalWriteCompleted = true;

        result.memoriesConsolidated++;

        // Archive originals
        // Collect deindex entries and remove them in one batch rather than a full
        // index read-modify-write per archived source. Guard is preserved: entries
        // are only collected when queryAwareIndexing is on.
        const clusterDeindexBatch: Array<{ path: string; createdAt: string; tags: string[] }> = [];
        try {
          for (const m of cluster.memories) {
            const archiveResult = await targetStorage.archiveMemory(m, {
              actor: "semantic-consolidation",
              reasonCode: "semantic-consolidation",
              relatedMemoryIds: [canonicalId],
            });
            if (archiveResult) {
              // Remove from the same storage-scoped content-hash index that
              // originally deduped this memory.
              await this.deps.removeContentHashForMemory(
                targetStorage,
                m,
                "semantic-consolidation",
              );
              // Best-effort index cleanup: a failure here (e.g. on-disk index save
              // under disk-full) must NOT abort the archival loop and thereby skip
              // the catalog write touch below for an already-durable canonical write
              // (kilo NV0mh).
              try {
                await this.deps.embeddingFallback.removeFromIndex(m.frontmatter.id);
                if (
                  resolveIndexingCapabilities(this.config).queryAwareIndexing &&
                  m.path &&
                  m.frontmatter?.created
                ) {
                  clusterDeindexBatch.push({
                    path: m.path,
                    createdAt: m.frontmatter.created,
                    tags: m.frontmatter.tags ?? [],
                  });
                }
              } catch (cleanupErr) {
                log.warn(
                  `[semantic-consolidation] index cleanup failed (non-fatal): ${cleanupErr}`,
                );
              }
              result.memoriesArchived++;
            }
          }
        } finally {
          // Best-effort batch index cleanup, flushed in `finally` so sources
          // already archived on disk are de-indexed even if a later archive
          // iteration throws. Never abort the cluster (and thereby skip the
          // catalog touch in the outer `finally`) on an index write failure.
          if (clusterDeindexBatch.length > 0) {
            try {
              await deindexMemoriesBatchAsync(targetStorage.dir, clusterDeindexBatch);
            } catch (cleanupErr) {
              log.warn(
                `[semantic-consolidation] index cleanup failed (non-fatal): ${cleanupErr}`,
              );
            }
          }
        }

        log.info(
          `[semantic-consolidation] consolidated ${cluster.memories.length} memories → ${canonicalId}`,
        );
      } catch (err) {
        log.warn(
          `[semantic-consolidation] cluster processing failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        result.errors++;
      } finally {
        if (canonicalWriteCompleted) {
          // Catalog write touch (issue #1499 sweep): record after the canonical
          // write and, on the happy path, after archival of superseded cluster
          // memories, so `lastWriteAt` reflects every durable mutation in this
          // consolidation (cursor NUtCK). The `finally` also covers partial
          // failures where the canonical memory was written but a later archive
          // step throws and the cluster catch continues (codex NY-dK).
          // Best-effort; namespace decoded from the storage dir since this path
          // #1522: catalog touch handled at the storage chokepoint.
        }
      }
    }

    // Save hash indexes if we modified them.
    if (result.memoriesArchived > 0) {
      await this.deps.saveContentHashIndexes().catch((err) =>
        log.warn(
          `[semantic-consolidation] content-hash index save failed: ${err}`,
        ),
      );
    }

    log.info(
      `[semantic-consolidation] complete: clusters=${result.clustersFound}, consolidated=${result.memoriesConsolidated}, archived=${result.memoriesArchived}, errors=${result.errors}`,
    );

    // #378: fire the Codex materialize post-hook so `codexMaterializeOnConsolidation`
    // actually has a runtime effect. The helper silently no-ops when the
    // feature flag or the per-trigger toggle is off, when the sentinel is
    // missing, or when nothing has changed since the previous run, so it's
    // safe to always call here. Wrapped in a try/catch because a failed
    // materialize must never abort the consolidation result — consolidation
    // is the load-bearing operation; materialization is an optional mirror.
    try {
      await materializeAfterSemanticConsolidation({
        config: this.config,
        memoryDir: targetStorage.dir,
      });
    } catch (err) {
      log.warn(
        `[semantic-consolidation] Codex materialize post-hook failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Issue #679 PR 2/5 — async peer profile reasoner runs as part of
    // the REM phase, immediately after semantic consolidation. Gated
    // on `peerProfileReasonerEnabled` (default false, opt-in). Wrapped
    // in a try/catch because reasoner I/O (LLM call, peer-profile
    // writes) must never abort the consolidation result. The reasoner
    // itself also defends against partial failure — see profile-reasoner.ts.
    if (resolveConversationContextCapabilities(this.config).peerProfileReasoner) {
      try {
        const peerLlm = new FallbackLlmClient(
          this.config.gatewayConfig,
          fallbackLlmRuntimeContextFromConfig(this.config),
        );
        const peerResult = await runPeerProfileReasoner({
          memoryDir: targetStorage.dir,
          enabled: true,
          llm: peerLlm,
          model: this.config.peerProfileReasonerModel,
          minInteractions: this.config.peerProfileReasonerMinInteractions,
          maxFieldsPerRun: this.config.peerProfileReasonerMaxFieldsPerRun,
          log: {
            debug: (msg) => log.debug(msg),
            info: (msg) => log.info(msg),
            warn: (msg) => log.warn(msg),
          },
        });
        log.info(
          `[peer-profile-reasoner] complete: peers=${peerResult.peersConsidered}, processed=${peerResult.peersProcessed}, fields=${peerResult.fieldsApplied}`,
        );
      } catch (err) {
        log.warn(
          `[peer-profile-reasoner] post-consolidation hook failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return result;
  }
}
