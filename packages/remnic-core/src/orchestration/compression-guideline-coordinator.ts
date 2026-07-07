/**
 * Compression-guideline learning coordinator — extracted from the
 * orchestrator (issue #1526, seam 4).
 *
 * Owns the compression-guideline learning lifecycle:
 *   - candidate computation from recorded memory-action events
 *   - optional LLM semantic refinement of the candidate
 *   - draft persistence + activation (optimizer/draft state files)
 *   - the recall section that surfaces active guidelines during recall
 *   - the consolidation-time learning pass that recomputes the draft
 *
 * The orchestrator constructs one instance and delegates the public
 * entrypoints (`optimizeCompressionGuidelines`,
 * `activateCompressionGuidelineDraft`) plus the two internal hooks
 * (`runCompressionGuidelineLearningPass`, called from the consolidation
 * loop; `buildCompressionGuidelineRecallSection`, called from the recall
 * pipeline) to it. Storage is the orchestrator's stable `this.storage`;
 * the fast-tier LLM call arrives as a callback so gateway routing stays
 * owned by the orchestrator.
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps thin delegating methods so existing call sites and
 * tests that exercise the public API continue to work.
 */

import { createHash } from "node:crypto";

// StorageManager type comes from the package barrel (type-only) so this
// module does not add a direct storage.ts import (#1533 ratchet).
import type { StorageManager } from "../index.js";
import type { PluginConfig, MemoryActionType, MemoryActionEvent } from "../types.js";
import { log } from "../logger.js";
import {
  computeCompressionGuidelineCandidate,
  refineCompressionGuidelineCandidateSemantically,
  renderCompressionGuidelinesMarkdown,
} from "../compression-optimizer.js";

/** Dependencies injected by the orchestrator. All stable references or
 *  live accessors. */
export interface CompressionGuidelineCoordinatorDeps {
  config: PluginConfig;
  /** Live accessor: the orchestrator's storage manager (stable post-ctor). */
  getStorage: () => StorageManager;
  /** Fast-tier LLM call used for optional semantic refinement. Routes
   *  through the gateway chain when configured — owned by the
   *  orchestrator, injected here so this module stays LLM-agnostic. */
  fastChatCompletion: (
    messages: Array<{ role: string; content: string }>,
    options: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      operation?: string;
      priority?: "background" | "recall-critical";
    },
  ) => Promise<{ content: string } | null>;
}

/**
 * Coordinates compression-guideline learning. Holds no mutable state of
 * its own — all persistence flows through the injected storage manager.
 */
export class CompressionGuidelineCoordinator {
  constructor(private readonly deps: CompressionGuidelineCoordinatorDeps) {}

  private get storage(): StorageManager {
    return this.deps.getStorage();
  }

  private get config(): PluginConfig {
    return this.deps.config;
  }

  async optimizeCompressionGuidelines(options?: {
    dryRun?: boolean;
    eventLimit?: number;
  }): Promise<{
    enabled: boolean;
    dryRun: boolean;
    eventCount: number;
    previousGuidelineVersion: number | null;
    nextGuidelineVersion: number;
    changedRules: number;
    semanticRefinementApplied: boolean;
    persisted: boolean;
    draftContentHash: string | null;
  }> {
    const dryRun = options?.dryRun === true;
    const eventLimit =
      typeof options?.eventLimit === "number"
        ? Math.max(0, Math.floor(options.eventLimit))
        : 500;

    const [activeState, draftState] = await Promise.all([
      this.storage.readCompressionGuidelineOptimizerState(),
      this.storage.readCompressionGuidelineDraftState().catch(() => null),
    ]);
    const previousState =
      draftState &&
      ((activeState?.guidelineVersion ?? 0) < draftState.guidelineVersion ||
        (activeState?.guidelineVersion ?? 0) === draftState.guidelineVersion)
        ? draftState
        : activeState;

    if (!this.config.compressionGuidelineLearningEnabled) {
      return {
        enabled: false,
        dryRun,
        eventCount: 0,
        previousGuidelineVersion: previousState?.guidelineVersion ?? null,
        nextGuidelineVersion: previousState?.guidelineVersion ?? 0,
        changedRules: 0,
        semanticRefinementApplied: false,
        persisted: false,
        draftContentHash: null,
      };
    }

    let events = await this.storage.readMemoryActionEvents(eventLimit);
    if (eventLimit > 0) {
      let effectiveEvents = events.filter((event) => event.dryRun !== true);
      let fetchLimit = eventLimit;
      while (
        effectiveEvents.length < eventLimit &&
        events.length === fetchLimit
      ) {
        fetchLimit = Math.min(fetchLimit * 2, fetchLimit + 1000);
        if (fetchLimit <= events.length) break;
        events = await this.storage.readMemoryActionEvents(fetchLimit);
        effectiveEvents = events.filter((event) => event.dryRun !== true);
      }
      events = effectiveEvents.slice(-eventLimit);
    }
    const generatedAt = new Date().toISOString();
    const candidate = computeCompressionGuidelineCandidate(events, {
      generatedAtIso: generatedAt,
      previousState,
    });
    if (candidate.eventCounts.total === 0) {
      return {
        enabled: true,
        dryRun,
        eventCount: 0,
        previousGuidelineVersion: previousState?.guidelineVersion ?? null,
        nextGuidelineVersion: previousState?.guidelineVersion ?? 0,
        changedRules: 0,
        semanticRefinementApplied: false,
        persisted: false,
        draftContentHash: null,
      };
    }
    const refinedCandidate =
      await refineCompressionGuidelineCandidateSemantically(candidate, {
        enabled: this.config.compressionGuidelineSemanticRefinementEnabled,
        timeoutMs: this.config.compressionGuidelineSemanticTimeoutMs,
        runRefinement: async (baseline) => {
          const prompt = [
            "You refine compression policy suggestions conservatively.",
            "Return JSON only in this shape:",
            '{"updates":[{"action":"summarize_node","delta":0.02,"confidence":"medium","note":"..."}]}',
            "Constraints:",
            "- Keep updates sparse and conservative.",
            "- delta must stay between -0.15 and 0.15.",
            "- Only include actions present in the input.",
            "Input candidate:",
            JSON.stringify(baseline),
          ].join("\n");

          const response = await this.deps.fastChatCompletion(
            [
              {
                role: "system",
                content: "Respond with strict JSON only. No markdown.",
              },
              { role: "user", content: prompt },
            ],
            {
              temperature: 0.1,
              maxTokens: 400,
              operation: "compression_guideline_semantic_refinement",
              priority: "background",
            },
          );

          return this.parseCompressionSemanticRefinement(
            response?.content ?? "",
          );
        },
      });

    const content = renderCompressionGuidelinesMarkdown(refinedCandidate);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const semanticRefinementApplied =
      JSON.stringify(refinedCandidate.ruleUpdates) !==
      JSON.stringify(candidate.ruleUpdates);
    const changedRules = refinedCandidate.ruleUpdates.filter(
      (rule) => rule.delta !== 0,
    ).length;

    if (!dryRun) {
      await this.storage.writeCompressionGuidelineDraft(content);
      await this.storage.writeCompressionGuidelineDraftState({
        version: refinedCandidate.optimizerVersion,
        updatedAt: refinedCandidate.generatedAt,
        sourceWindow: refinedCandidate.sourceWindow,
        eventCounts: refinedCandidate.eventCounts,
        guidelineVersion: refinedCandidate.guidelineVersion,
        contentHash,
        activationState: "draft",
        actionSummaries: refinedCandidate.actionSummaries,
        ruleUpdates: refinedCandidate.ruleUpdates,
      });
    }

    return {
      enabled: true,
      dryRun,
      eventCount: candidate.eventCounts.total,
      previousGuidelineVersion: previousState?.guidelineVersion ?? null,
      nextGuidelineVersion: refinedCandidate.guidelineVersion,
      changedRules,
      semanticRefinementApplied,
      persisted: !dryRun,
      draftContentHash: dryRun ? null : contentHash,
    };
  }

  async activateCompressionGuidelineDraft(options?: {
    expectedContentHash?: string;
    expectedGuidelineVersion?: number;
  }): Promise<{
    enabled: boolean;
    activated: boolean;
    guidelineVersion: number | null;
    reason?:
      | "disabled"
      | "missing_draft"
      | "expected_revision_required"
      | "content_hash_mismatch"
      | "guideline_version_mismatch"
      | "draft_changed";
  }> {
    if (!this.config.compressionGuidelineLearningEnabled) {
      return {
        enabled: false,
        activated: false,
        guidelineVersion: null,
        reason: "disabled",
      };
    }

    const draftState = await this.storage.readCompressionGuidelineDraftState();
    if (!draftState) {
      return {
        enabled: true,
        activated: false,
        guidelineVersion: null,
        reason: "missing_draft",
      };
    }

    const expectedContentHash = options?.expectedContentHash?.trim();
    const expectedGuidelineVersion = options?.expectedGuidelineVersion;

    if (
      (!expectedContentHash || expectedContentHash.length === 0) &&
      typeof expectedGuidelineVersion !== "number"
    ) {
      return {
        enabled: true,
        activated: false,
        guidelineVersion: null,
        reason: "expected_revision_required",
      };
    }

    if (expectedContentHash && draftState.contentHash !== expectedContentHash) {
      return {
        enabled: true,
        activated: false,
        guidelineVersion: null,
        reason: "content_hash_mismatch",
      };
    }

    if (
      typeof expectedGuidelineVersion === "number" &&
      draftState.guidelineVersion !== expectedGuidelineVersion
    ) {
      return {
        enabled: true,
        activated: false,
        guidelineVersion: null,
        reason: "guideline_version_mismatch",
      };
    }

    const activated = await this.storage.activateCompressionGuidelineDraft({
      ...(expectedContentHash ? { expectedContentHash } : {}),
      ...(typeof expectedGuidelineVersion === "number"
        ? { expectedGuidelineVersion }
        : {}),
    });
    return {
      enabled: true,
      activated,
      guidelineVersion: activated ? draftState.guidelineVersion : null,
      ...(activated ? {} : { reason: "draft_changed" as const }),
    };
  }

  /** Consolidation-time hook: recompute the draft from recent events. */
  async runCompressionGuidelineLearningPass(): Promise<void> {
    if (!this.config.compressionGuidelineLearningEnabled) return;
    try {
      const result = await this.optimizeCompressionGuidelines({
        dryRun: false,
        eventLimit: 500,
      });
      log.info(
        `compression guideline learning updated (${result.eventCount} events)`,
      );
    } catch (err) {
      log.warn(`compression guideline learning failed (ignored): ${err}`);
    }
  }

  /** Recall-time hook: surface active guidelines as a recall section. */
  async buildCompressionGuidelineRecallSection(): Promise<string | null> {
    if (!this.config.contextCompressionActionsEnabled) return null;
    if (!this.config.compressionGuidelineLearningEnabled) return null;

    const state = await this.storage
      .readCompressionGuidelineOptimizerState()
      .catch(() => null);
    if (!state || state.guidelineVersion <= 0) return null;

    const raw = await this.storage
      .readCompressionGuidelines()
      .catch(() => null);
    const summary = raw ? formatCompressionGuidelinesForRecall(raw, 5) : null;
    if (!summary) return null;

    return [
      "## Active Compression Guidelines",
      "",
      `Guideline version: ${state.guidelineVersion}`,
      `Updated: ${state.updatedAt}`,
      "",
      summary,
    ].join("\n");
  }

  private parseCompressionSemanticRefinement(raw: string): {
    updates: Array<{
      action: MemoryActionType;
      delta?: number;
      confidence?: "low" | "medium" | "high";
      note?: string;
    }>;
  } | null {
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;

    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        updates?: Array<{
          action?: unknown;
          delta?: unknown;
          confidence?: unknown;
          note?: unknown;
        }>;
      };
      if (!Array.isArray(parsed?.updates)) return null;

      const validActions = new Set<MemoryActionType>([
        "store_episode",
        "store_note",
        "update_note",
        "create_artifact",
        "summarize_node",
        "discard",
        "link_graph",
      ]);

      const updates = parsed.updates
        .filter(
          (item) =>
            item &&
            typeof item.action === "string" &&
            validActions.has(item.action as MemoryActionType),
        )
        .map((item) => {
          const confidence: "low" | "medium" | "high" | undefined =
            item.confidence === "low" ||
            item.confidence === "medium" ||
            item.confidence === "high"
              ? item.confidence
              : undefined;
          return {
            action: item.action as MemoryActionType,
            delta:
              typeof item.delta === "number" && Number.isFinite(item.delta)
                ? item.delta
                : undefined,
            confidence,
            note: typeof item.note === "string" ? item.note : undefined,
          };
        });

      return { updates };
    } catch {
      return null;
    }
  }
}

/**
 * Format the active compression-guidelines section for recall. Extracted
 * from the orchestrator (was a module-level export there); re-exported by
 * the orchestrator barrel to preserve the public API. Pure — no state.
 */
export function formatCompressionGuidelinesForRecall(
  raw: string,
  maxLines: number = 5,
): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const sectionMatch = raw.match(
    // End the section at `\n## ` or end-of-string. Plain $ (not \s*$): the
    // \s* branch overlapped the lazy body and backtracked polynomially
    // (CodeQL js/polynomial-redos). Captured lines are trimmed/filtered below,
    // so trailing whitespace handling is unchanged.
    /## Suggested Guidelines\s*\n([\s\S]*?)(?:\n##\s+|$)/i,
  );
  if (!sectionMatch) return null;

  const lines = sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, Math.max(1, Math.floor(maxLines)));
  if (lines.length === 0) return null;

  return lines.join("\n");
}
