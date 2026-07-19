/**
 * Recall section coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the recall-output section-budgeting subsystem: section enablement
 * lookups, per-section maxChars/number resolution, section bucket appends,
 * budget-aware section truncation, and final ordered assembly of recall
 * sections within the configured character budget. Also builds the
 * LastRecallBudgetSummary and collects the sources used for X-ray tracing.
 *
 * Behavior-preserving move from orchestrator.ts — no logic changes; the
 * orchestrator constructs one instance and keeps thin delegating methods so
 * existing call sites (recallInternal, consolidation) continue to work.
 *
 * Config is accessed through a getter callback (not captured at construction)
 * so that post-construction reassignment of the orchestrator's live
 * `config` field is honored. This mirrors the ConversationIndexCoordinator /
 * TierMigrationCoordinator accessor pattern.
 */

import type { PluginConfig, RecallSectionConfig } from "../types.js";
import type { LastRecallBudgetSummary } from "../recall-state.js";

export interface RecallSectionAppendOptions {
  atomic?: boolean;
  memoryId?: string;
  memoryPath?: string;
}

export interface RecallSectionChunk {
  content: string;
  atomic?: boolean;
  memoryId?: string;
  memoryPath?: string;
}

export type RecallSectionBuckets = Map<
  string,
  Array<string | RecallSectionChunk>
>;

/**
 * Coordinator for the recall section budgeting + assembly subsystem.
 *
 * All methods are pure with respect to the coordinator's own state — they
 * read config via the getter and operate on the caller-provided section
 * buckets. No caches are held because the config-derived values are cheap
 * to recompute and the buckets are transient (per-recall-call).
 */
export class RecallSectionCoordinator {
  private readonly getConfig: () => PluginConfig;
  private readonly resolveSectionEnabled: (
    sectionId: string,
    defaultEnabled: boolean,
  ) => boolean;

  constructor(options: {
    getConfig: () => PluginConfig;
    resolveSectionEnabled?: (
      sectionId: string,
      defaultEnabled: boolean,
    ) => boolean;
  }) {
    this.getConfig = options.getConfig;
    // Default to the coordinator's own config-based check so standalone usage
    // (e.g. config-recall-pipeline tests) keeps self-gating. The orchestrator
    // injects its own resolver so appendRecallSection flows through the same
    // overridable isRecallSectionEnabled that the recallInternal computation
    // gates use — keeping compute-side and append-side enablement coherent
    // (seam 13). This preserves the recall-hardening test seam where tests
    // override orchestrator.isRecallSectionEnabled to isolate sections.
    this.resolveSectionEnabled =
      options.resolveSectionEnabled ??
      ((id, def) => this.isRecallSectionEnabled(id, def));
  }

  getRecallSectionEntry(
    sectionId: string,
  ): RecallSectionConfig | undefined {
    const pipeline = Array.isArray(this.getConfig().recallPipeline)
      ? this.getConfig().recallPipeline
      : [];
    return pipeline.find((entry) => entry.id === sectionId);
  }

  isRecallSectionEnabled(
    sectionId: string,
    defaultEnabled: boolean = true,
  ): boolean {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return defaultEnabled;
    return entry.enabled !== false;
  }

  isSpecializedRecallSectionEnabled(
    sectionId: string,
    topLevelEnabled: boolean,
  ): boolean {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return topLevelEnabled;
    return entry.enabled === true || (topLevelEnabled && entry.enabled !== false);
  }

  getRecallSectionMaxChars(
    sectionId: string,
  ): number | null | undefined {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return undefined;
    if (entry.maxChars === null) return null;
    if (typeof entry.maxChars !== "number") return undefined;
    return Math.max(0, Math.floor(entry.maxChars));
  }

  getRecallSectionNumber(
    sectionId: string,
    key: keyof RecallSectionConfig,
  ): number | undefined {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return undefined;
    const value = entry[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(0, Math.floor(value));
  }

  appendRecallSection(
    sectionBuckets: RecallSectionBuckets,
    sectionId: string,
    content: string,
    options: RecallSectionAppendOptions = {},
  ): boolean {
    if (!this.resolveSectionEnabled(sectionId, true)) return false;
    const trimmed = content.trim();
    if (trimmed.length === 0) return false;

    const maxChars = this.getRecallSectionMaxChars(sectionId);
    let finalContent = trimmed;
    if (maxChars === 0) return false;
    if (
      !options.atomic &&
      typeof maxChars === "number" &&
      finalContent.length > maxChars
    ) {
      finalContent =
        sectionId === "profile"
          ? this.truncateProfileToBoundary(finalContent, maxChars)
          : `${finalContent.slice(0, maxChars)}\n\n...(trimmed)\n`;
    }
    if (finalContent.length === 0) return false;

    const existing = sectionBuckets.get(sectionId) ?? [];
    if (options.atomic) {
      existing.push({
        content: finalContent,
        atomic: true,
        ...(options.memoryId ? { memoryId: options.memoryId } : {}),
        ...(options.memoryPath ? { memoryPath: options.memoryPath } : {}),
      });
    } else {
      existing.push(finalContent);
    }
    sectionBuckets.set(sectionId, existing);
    return true;
  }

  truncateProfileToBoundary(content: string, maxChars: number): string {
    if (maxChars <= 0) return "";
    if (content.length <= maxChars) return content;
    const suffix = "\n\n...(profile context trimmed)";
    const contentLimit = maxChars - suffix.length;
    if (contentLimit <= 0) {
      const boundary = content.lastIndexOf("\n", maxChars);
      return content.slice(0, boundary > 0 ? boundary : maxChars).trimEnd();
    }
    const boundary = content.lastIndexOf("\n", contentLimit);
    const end = boundary > 0 ? boundary : contentLimit;
    return `${content.slice(0, end).trimEnd()}${suffix}`;
  }

  truncateRecallSectionToBudget(
    content: string,
    maxChars: number,
  ): string {
    if (maxChars <= 0) return "";
    if (content.length <= maxChars) return content;
    const suffix = "\n\n...(memory context trimmed)";
    if (maxChars <= suffix.length) {
      return content.slice(0, maxChars);
    }
    return `${content.slice(0, maxChars - suffix.length)}${suffix}`;
  }


  getRecallBudgetChars(override?: number): number {
    if (
      typeof override === "number" &&
      Number.isFinite(override) &&
      override >= 0
    ) {
      return Math.floor(override);
    }
    const configuredBudget = this.getConfig().recallBudgetChars;
    if (
      typeof configuredBudget === "number" &&
      Number.isFinite(configuredBudget) &&
      configuredBudget >= 0
    ) {
      return Math.floor(configuredBudget);
    }
    const tokenBudget = this.getConfig().maxMemoryTokens;
    if (
      typeof tokenBudget === "number" &&
      Number.isFinite(tokenBudget) &&
      tokenBudget >= 0
    ) {
      return Math.floor(tokenBudget * 4);
    }
    return 0;
  }

  assembleRecallSections(
    sectionBuckets: RecallSectionBuckets,
    budgetOverride?: number,
  ): {
    sections: string[];
    includedIds: string[];
    omittedIds: string[];
    truncated: boolean;
    finalChars: number;
    includedMemoryIds: string[];
    includedMemoryPaths: string[];
    omittedMemoryIds: string[];
  } {
    type OrderedSection = { id: string; chunks: RecallSectionChunk[] };
    const normalizeChunk = (
      chunk: string | RecallSectionChunk,
    ): RecallSectionChunk =>
      typeof chunk === "string" ? { content: chunk } : chunk;
    const orderedSections: OrderedSection[] = [];
    const pipeline = Array.isArray(this.getConfig().recallPipeline)
      ? this.getConfig().recallPipeline
      : [];
    const orderedIds = pipeline
      .filter((entry) => entry.enabled !== false)
      .map((entry) => entry.id);
    const seen = new Set<string>();

    for (const id of orderedIds) {
      const chunks = sectionBuckets.get(id);
      if (!chunks || chunks.length === 0) continue;
      orderedSections.push({
        id,
        chunks: chunks.map(normalizeChunk),
      });
      seen.add(id);
    }

    for (const [id, chunks] of sectionBuckets.entries()) {
      if (seen.has(id) || chunks.length === 0) continue;
      orderedSections.push({
        id,
        chunks: chunks.map(normalizeChunk),
      });
    }

    const budget = this.getRecallBudgetChars(budgetOverride);
    const candidateMemoryIds = orderedSections
      .find((section) => section.id === "memories")
      ?.chunks
      .filter((chunk) => chunk.atomic && chunk.memoryId)
      .map((chunk) => chunk.memoryId!)
      ?? [];
    if (budget === 0) {
      return {
        sections: [],
        includedIds: [],
        omittedIds: orderedSections.map((entry) => entry.id),
        truncated: orderedSections.length > 0,
        finalChars: 0,
        includedMemoryIds: [],
        includedMemoryPaths: [],
        omittedMemoryIds: candidateMemoryIds,
      };
    }

    const separator = "\n\n---\n\n";
    const sectionById = new Map(
      orderedSections.map((section) => [section.id, section]),
    );
    const allocationOrder = [
      "memories",
      "knowledge-index",
      ...orderedSections
        .map((section) => section.id)
        .filter((id) => id !== "memories" && id !== "knowledge-index"),
    ];
    const selected = new Map<string, string>();
    const includedMemoryIds: string[] = [];
    const includedMemoryPaths: string[] = [];
    let usedChars = 0;
    let truncated = false;

    for (const id of allocationOrder) {
      const section = sectionById.get(id);
      if (!section || selected.has(id)) continue;
      const separatorChars = selected.size > 0 ? separator.length : 0;
      const available = budget - usedChars - separatorChars;
      const sectionMaxChars = this.getRecallSectionMaxChars(id);
      const sectionAvailable =
        typeof sectionMaxChars === "number"
          ? Math.min(available, sectionMaxChars)
          : available;
      if (sectionAvailable <= 0) {
        truncated = true;
        continue;
      }


      const atomicChunks = section.chunks.filter((chunk) => chunk.atomic);
      let finalContent: string;
      if (id !== "memories" || atomicChunks.length === 0) {
        const content = section.chunks.map((chunk) => chunk.content).join("\n\n");
        const profileLimit =
          id === "profile"
            ? Math.min(
                Math.floor(
                  budget *
                    (typeof this.getConfig().recallProfileMaxRatio === "number"
                      ? this.getConfig().recallProfileMaxRatio
                      : 0.3),
                ),
                this.getRecallSectionMaxChars("profile") ?? budget,
              )
            : sectionAvailable;
        const boundedContent =
          id === "profile"
            ? this.truncateProfileToBoundary(content, profileLimit)
            : content;
        finalContent = this.truncateRecallSectionToBudget(
          boundedContent,
          sectionAvailable,
        );
        if (!finalContent) {
          truncated = true;
          continue;
        }
        if (finalContent.length < content.length) truncated = true;
      } else {
        const prefix = section.chunks
          .filter((chunk) => !chunk.atomic)
          .map((chunk) => chunk.content)
          .join("\n\n");
        if (prefix.length >= sectionAvailable) {
          truncated = true;
          continue;
        }
        let rendered = prefix;
        let includedAtomicCount = 0;
        for (const chunk of atomicChunks) {
          const candidate = rendered
            ? `${rendered}\n\n${chunk.content}`
            : chunk.content;
          if (candidate.length > sectionAvailable) {
            truncated = true;
            continue;
          }
          rendered = candidate;
          includedAtomicCount += 1;
          if (chunk.memoryId) includedMemoryIds.push(chunk.memoryId);
          if (chunk.memoryPath) includedMemoryPaths.push(chunk.memoryPath);
        }
        if (includedAtomicCount === 0) {
          truncated = true;
          continue;
        }
        finalContent = rendered;
        if (includedAtomicCount < atomicChunks.length) truncated = true;
      }

      selected.set(id, finalContent);
      usedChars += separatorChars + finalContent.length;
    }

    const sections: string[] = [];
    const includedIds: string[] = [];
    const omittedIds: string[] = [];
    for (const section of orderedSections) {
      const content = selected.get(section.id);
      if (content) {
        sections.push(content);
        includedIds.push(section.id);
      } else {
        omittedIds.push(section.id);
      }
    }

    return {
      sections,
      includedIds,
      omittedIds,
      truncated,
      finalChars: usedChars,
      includedMemoryIds: [...new Set(includedMemoryIds)],
      includedMemoryPaths: [...new Set(includedMemoryPaths)],
      omittedMemoryIds: candidateMemoryIds.filter(
        (id) => !includedMemoryIds.includes(id),
      ),
    };
  }

  buildLastRecallBudgetSummary(options: {
    requestedTopK?: number;
    recallResultLimit: number;
    qmdFetchLimit: number;
    qmdHybridFetchLimit: number;
    finalContextChars?: number;
    truncated?: boolean;
    includedSections?: string[];
    includedMemoryIds?: string[];
    includedMemoryPaths?: string[];
    omittedMemoryIds?: string[];
    omittedSections?: string[];
  }): LastRecallBudgetSummary {
    return {
      requestedTopK: options.requestedTopK,
      appliedTopK: options.recallResultLimit,
      recallBudgetChars: this.getRecallBudgetChars(),
      maxMemoryTokens: this.getConfig().maxMemoryTokens,
      qmdFetchLimit: options.qmdFetchLimit,
      qmdHybridFetchLimit: options.qmdHybridFetchLimit,
      finalContextChars: options.finalContextChars,
      truncated: options.truncated,
      includedMemoryIds: [...(options.includedMemoryIds ?? [])],
      includedMemoryPaths: [...(options.includedMemoryPaths ?? [])],
      omittedMemoryIds: [...(options.omittedMemoryIds ?? [])],
      includedSections: [...(options.includedSections ?? [])],
      omittedSections: [...(options.omittedSections ?? [])],
    };
  }

  collectLastRecallSources(
    sectionBuckets: RecallSectionBuckets,
    recallSource:
      | "none"
      | "hot_qmd"
      | "hot_embedding"
      | "cold_fallback"
      | "recent_scan",
  ): string[] {
    const used = new Set<string>();
    if (recallSource !== "none") {
      used.add(recallSource);
    }
    for (const [sectionId, chunks] of sectionBuckets.entries()) {
      if (chunks.length > 0) {
        used.add(sectionId);
      }
    }
    return [...used];
  }
}
