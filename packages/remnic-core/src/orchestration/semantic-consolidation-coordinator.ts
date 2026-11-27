
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
import { deindexMemoriesBatchAsync } from "../temporal-index-batch.js";
import { runPeerProfileReasoner } from "../peers/index.js";
import type { StorageManager } from "../index.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { EmbeddingFallback } from "../embedding-fallback.js";
import type { PluginConfig, MemoryFile, AgentPersonaModelConfig } from "../types.js";
import { log } from "../logger.js";
import { composeMemoryEnvelope } from "../write-envelope.js";
import { resolveConversationContextCapabilities } from "../capabilities.js";
import { excludeSupportPassportPrivateMemories } from "../support-passport/card-projection.js";

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
  embeddingFallback: EmbeddingFallback;
  removeContentHashForMemory: (
    targetStorage: StorageManager,
    memory: MemoryFile,
    context: string,
  ) => Promise<void>;
  saveContentHashIndexes: () => Promise<void>;
}

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

    const allMemories = excludeSupportPassportPrivateMemories(await targetStorage.readAllMemories());
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

    let extensionsBlock = "";
    try {
      extensionsBlock = await buildExtensionsBlockForConsolidation(this.config);
    } catch (err) {
      log.warn(`[semantic-consolidation] extension discovery failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const cluster of clusters) {
      let canonicalWriteCompleted = false;
      try {
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
              ? 'You are a memory consolidation system. Return ONLY a JSON object with an "operator" key and either "output" or, for split, "outputs". The "operator" value MUST be one of the exact strings "merge", "update", or "split" — never a pipe-separated placeholder, never prose. "output" is the canonical memory text; "outputs" is an array with one canonical memory text per separated fact.'
              : "You are a memory consolidation system. Output only the consolidated memory text.",
          },
          { role: "user" as const, content: prompt },
        ];
        const llmOpts = { temperature: 0.2, maxTokens: 2000 };

        let response: { content: string } | null = null;
        if (useGateway) {
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

        let canonicalOutputs: string[];
        let operator: SemanticConsolidationLlmOperator;
        if (operatorAwareEnabled) {
          const parsed = parseOperatorAwareConsolidationResponse(
            response.content,
            cluster,
          );
          canonicalOutputs = parsed.outputs;
          operator = parsed.operator;
        } else {
          canonicalOutputs = [parseConsolidationResponse(response.content)];
          operator = chooseConsolidationOperator(cluster);
        }
        cluster.canonicalContent = canonicalOutputs.join("\n\n");

        const sorted = [...cluster.memories].sort(
          (a, b) =>
            new Date(b.frontmatter.created).getTime() -
            new Date(a.frontmatter.created).getTime(),
        );
        const newest = sorted[0];
        const lineageIds = cluster.memories.map((m) => m.frontmatter.id);

        const derivedFromEntries: string[] = [];
        for (const m of cluster.memories) {
          if (!m.path) continue;
          const entry = await targetStorage.snapshotForProvenance(m.path);
          if (entry) derivedFromEntries.push(entry);
        }

        // SPLIT writes one canonical memory per output (#3566); every write shares the lineage.
        const canonicalIds: string[] = [];
        let canonicalBlocked = false;
        for (const canonicalContent of canonicalOutputs) {
          const canonicalEnvelope = composeMemoryEnvelope(
            {
              content: canonicalContent,
              category: newest.frontmatter.category,
              confidence: newest.frontmatter.confidence,
              tags: [
                ...new Set(
                  cluster.memories.flatMap((m) => m.frontmatter.tags ?? []),
                ),
              ],
            },
            { source: "semantic-consolidation" },
            { salvage: true },
          );
          if (canonicalEnvelope.salvageNotes.length > 0) {
            log.warn(`semantic-consolidation write salvaged invalid fields: ${canonicalEnvelope.salvageNotes.join("; ")}`);
          }
          const written = await targetStorage.writeSealedMemory(
            canonicalEnvelope,
            {
              actor: "semantic-consolidation",
              lineage: lineageIds,
              derivedFrom: derivedFromEntries.length > 0 ? derivedFromEntries : undefined,
              derivedVia: operator,
            },
          );
          canonicalIds.push(written.id);
          if (written.tombstoneBlocked) canonicalBlocked = true;
        }
        if (canonicalBlocked) {
          log.info(`[semantic-consolidation] cluster in "${cluster.category}" tombstone-blocked — keeping ${cluster.memories.length} source(s) active (pending_review ${canonicalIds.join(", ")})`);
          continue;
        }
        canonicalWriteCompleted = true;

        result.memoriesConsolidated++;

        const clusterDeindexBatch: Array<{ path: string; createdAt: string; tags: string[] }> = [];
        try {
          for (const m of cluster.memories) {
            const archiveResult = await targetStorage.archiveMemory(m, {
              actor: "semantic-consolidation",
              reasonCode: "semantic-consolidation",
              relatedMemoryIds: canonicalIds,
            });
            if (archiveResult) {
              await this.deps.removeContentHashForMemory(
                targetStorage,
                m,
                "semantic-consolidation",
              );
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
          `[semantic-consolidation] consolidated ${cluster.memories.length} memories → ${canonicalIds.join(", ")}`,
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
