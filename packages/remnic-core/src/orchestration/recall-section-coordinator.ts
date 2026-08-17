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

import type { IncludedMemory, LastRecallBudgetSummary } from "../recall-state.js";
import { estimateTokenCount } from "../token-estimate.js";
import { graphemeUnits, truncateGraphemeSafe } from "../whitespace.js";
import type { PluginConfig, RecallSectionConfig } from "../types.js";

export interface RecallSectionAppendOptions {
  atomic?: boolean;
  memoryId?: string;
  memoryPath?: string;
  memoryNamespace?: string;
}

export interface RecallSectionChunk {
  content: string;
  atomic?: boolean;
  memoryId?: string;
  memoryPath?: string;
  memoryNamespace?: string;
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
          : `${truncateGraphemeSafe(finalContent, maxChars)}\n\n...(trimmed)\n`;
    }
    if (finalContent.length === 0) return false;
    const existing = sectionBuckets.get(sectionId) ?? [];

    if (options.atomic) {
      existing.push({
        content: finalContent,
        atomic: true,
        ...(options.memoryId ? { memoryId: options.memoryId } : {}),
        ...(options.memoryPath ? { memoryPath: options.memoryPath } : {}),
        ...(options.memoryNamespace
          ? { memoryNamespace: options.memoryNamespace }
          : {}),
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
      const clipped = boundary > 0
        ? content.slice(0, boundary)
        : truncateGraphemeSafe(content, maxChars);
      return clipped.trimEnd();
    }
    const boundary = content.lastIndexOf("\n", contentLimit);
    const clipped = boundary > 0
      ? content.slice(0, boundary)
      : truncateGraphemeSafe(content, contentLimit);
    return `${clipped.trimEnd()}${suffix}`;
  }
  truncateRecallSectionToBudget(
    content: string,
    maxChars: number,
    maxTokens?: number,
  ): string {
    if (maxChars <= 0 || maxTokens === 0) return "";
    const suffix = "\n\n...(memory context trimmed)";
    const charBounded =
      content.length <= maxChars
        ? content
        : maxChars <= suffix.length
          ? truncateGraphemeSafe(content, maxChars)
          : `${truncateGraphemeSafe(content, maxChars - suffix.length)}${suffix}`;
    if (maxTokens === undefined || estimateTokenCount(charBounded) <= maxTokens) {
      return charBounded;
    }
    const markerFits =
      maxChars > suffix.length && estimateTokenCount(suffix) <= maxTokens;
    const tokenSource = content.length > maxChars ? truncateGraphemeSafe(content, maxChars) : content;
    const units = graphemeUnits(tokenSource);
    let low = 0;
    let high = units.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const prefix = units.slice(0, mid).join("");
      const candidate = markerFits ? `${prefix}${suffix}` : prefix;
      if (candidate.length <= maxChars && estimateTokenCount(candidate) <= maxTokens) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    if (markerFits && low === 0) {
      low = 0;
      high = units.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const prefix = units.slice(0, mid).join("");
        if (prefix.length <= maxChars && estimateTokenCount(prefix) <= maxTokens) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      return units.slice(0, low).join("");
    }
    const prefix = units.slice(0, low).join("");
    return markerFits ? `${prefix}${suffix}` : prefix;
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
    includedMemories: IncludedMemory[];
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
      .filter(
        (entry) =>
          entry.enabled !== false &&
          this.resolveSectionEnabled(entry.id, true),
      )
      .map((entry) => entry.id);
    const seen = new Set<string>();

    for (const id of orderedIds) {
      if (seen.has(id)) continue;
      const chunks = sectionBuckets.get(id);
      if (!chunks || chunks.length === 0) continue;
      orderedSections.push({
        id,
        chunks: chunks.map(normalizeChunk),
      });
      seen.add(id);
    }

    for (const [id, chunks] of sectionBuckets.entries()) {
      if (
        seen.has(id) ||
        chunks.length === 0 ||
        !this.resolveSectionEnabled(id, true)
      ) {
        continue;
      }
      orderedSections.push({
        id,
        chunks: chunks.map(normalizeChunk),
      });
      seen.add(id);
    }

    const budget = this.getRecallBudgetChars(budgetOverride);
    const tokenBudget = Math.max(0, Math.floor(this.getConfig().maxMemoryTokens));
    const candidateMemoryChunks =
      orderedSections
        .find((section) => section.id === "memories")
        ?.chunks.filter((chunk) => chunk.atomic && chunk.memoryId)
        .map((chunk) => ({
          id: chunk.memoryId!,
          namespace: chunk.memoryNamespace,
        })) ?? [];
    const candidateMemoryIds = candidateMemoryChunks.map((chunk) => chunk.id);
    if (budget === 0) {
      return {
        sections: [],
        includedIds: [],
        omittedIds: orderedSections.map((entry) => entry.id),
        truncated: orderedSections.length > 0,
        finalChars: 0,
        includedMemories: [],
        omittedMemoryIds: candidateMemoryIds,
      };
    }

    const separator = "\n\n---\n\n";
    const sectionById = new Map(
      orderedSections.map((section) => [section.id, section]),
    );
    const allocationOrder = orderedSections.map((section) => section.id);
    const memorySection = sectionById.get("memories");
    const memoryIndex = allocationOrder.indexOf("memories");
    const memoryBudget = this.getRecallSectionMaxChars("memories") ?? budget;
    const memoryAllocationBudget = Math.min(budget, memoryBudget);
    let firstAtomicMemoryReserve:
      | { chars: number; tokens: number }
      | undefined;
    for (const chunk of memorySection?.chunks ?? []) {
      if (!chunk.atomic || chunk.content.length > memoryAllocationBudget) {
        continue;
      }
      const tokens = estimateTokenCount(chunk.content);
      if (tokens <= tokenBudget) {
        firstAtomicMemoryReserve = {
          chars: chunk.content.length,
          tokens,
        };
        break;
      }
    }
    const includedMemories: IncludedMemory[] = [];
    let usedChars = 0;
    let usedTokens = 0;
    let truncated = false;
    const selected = new Map<string, string>();

    for (const id of allocationOrder) {
      const section = sectionById.get(id);
      if (!section || selected.has(id)) continue;
      const separatorChars = selected.size > 0 ? separator.length : 0;
      const available = budget - usedChars - separatorChars;
      const separatorTokens = selected.size > 0 ? estimateTokenCount(separator) : 0;
      const availableTokens = tokenBudget - usedTokens - separatorTokens;
      const sectionMaxChars = this.getRecallSectionMaxChars(id);
      const reservedMemory =
        memoryIndex > allocationOrder.indexOf(id)
          ? firstAtomicMemoryReserve
          : undefined;
      const memoryReserveSeparatorChars = separator.length;
      const memoryReserveSeparatorTokens = estimateTokenCount(separator);
      const memoryReserve = reservedMemory
        ? reservedMemory.chars + memoryReserveSeparatorChars
        : 0;
      const availableAfterMemoryReserve = available - memoryReserve;
      const allocatedSectionAvailable =
        typeof sectionMaxChars === "number"
          ? Math.min(availableAfterMemoryReserve, sectionMaxChars)
          : availableAfterMemoryReserve;
      const availableAfterMemoryReserveTokens = reservedMemory
        ? availableTokens -
          reservedMemory.tokens -
          memoryReserveSeparatorTokens
        : availableTokens;
      const allocatedTokenAvailable = availableAfterMemoryReserveTokens;
      if (allocatedSectionAvailable <= 0 || allocatedTokenAvailable <= 0) {
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
            : allocatedSectionAvailable;
        const boundedContent =
          id === "profile"
            ? this.truncateProfileToBoundary(
                content,
                Math.min(profileLimit, allocatedSectionAvailable),
              )
            : content;
        finalContent = this.truncateRecallSectionToBudget(
          boundedContent,
          allocatedSectionAvailable,
          allocatedTokenAvailable,
        );
        if (!finalContent) {
          truncated = true;
          continue;
        }
        if (finalContent.length < content.length) truncated = true;
      } else {
        const firstAtomicIndex = section.chunks.findIndex((chunk) => chunk.atomic);
        let rendered = "";
        let includedAtomicCount = 0;
        let includedPostAtomicContent = false;
        const postAtomicContents: string[] = [];
        let includedLeadingContent = false;
        for (const [index, chunk] of section.chunks.entries()) {
          if (
            !chunk.atomic &&
            includedAtomicCount === 0 &&
            index < firstAtomicIndex
          ) {
            const candidate = rendered
              ? `${rendered}\n\n${chunk.content}`
              : chunk.content;
            if (
              candidate.length <= allocatedSectionAvailable &&
              estimateTokenCount(candidate) <= allocatedTokenAvailable
            ) {
              rendered = candidate;
              includedLeadingContent = true;
            } else {
              truncated = true;
            }
            continue;
          }

          const candidate = rendered
            ? `${rendered}\n\n${chunk.content}`
            : chunk.content;
          if (
            candidate.length > allocatedSectionAvailable ||
            estimateTokenCount(candidate) > allocatedTokenAvailable
          ) {
            if (
              chunk.atomic &&
              includedAtomicCount === 0 &&
              includedLeadingContent &&
              chunk.content.length <= allocatedSectionAvailable &&
              estimateTokenCount(chunk.content) <= allocatedTokenAvailable
            ) {
              rendered = chunk.content;
              includedLeadingContent = false;
              includedAtomicCount = 1;
              if (chunk.memoryId && chunk.memoryPath) {
                includedMemories.push(
                  chunk.memoryNamespace
                    ? { id: chunk.memoryId, path: chunk.memoryPath, namespace: chunk.memoryNamespace }
                    : { id: chunk.memoryId, path: chunk.memoryPath },
                );
              }
              continue;
            }
            if (
              !chunk.atomic &&
              includedAtomicCount === 0 &&
              includedLeadingContent &&
              chunk.content.length <= allocatedSectionAvailable &&
              estimateTokenCount(chunk.content) <= allocatedTokenAvailable
            ) {
              rendered = chunk.content;
              includedLeadingContent = false;
              includedPostAtomicContent = true;
              postAtomicContents.push(chunk.content);
              continue;
            }
            truncated = true;
            continue;
          }

          rendered = candidate;
          if (chunk.atomic) {
            includedAtomicCount += 1;
            if (chunk.memoryId && chunk.memoryPath) {
              includedMemories.push(
                chunk.memoryNamespace
                  ? { id: chunk.memoryId, path: chunk.memoryPath, namespace: chunk.memoryNamespace }
                  : { id: chunk.memoryId, path: chunk.memoryPath },
              );
            }
          } else {
            includedPostAtomicContent = true;
            postAtomicContents.push(chunk.content);
          }
        }
        if (includedAtomicCount === 0) {
          if (includedPostAtomicContent) {
            rendered = postAtomicContents.join("\n\n");
          } else {
            rendered = "";
            truncated = true;
          }
        } else if (includedAtomicCount < atomicChunks.length) {
          truncated = true;
        }
        finalContent = rendered;
      }

      if (!finalContent) {
        truncated = true;
        continue;
      }
      selected.set(id, finalContent);
      usedChars += separatorChars + finalContent.length;
      usedTokens += separatorTokens + estimateTokenCount(finalContent);
    }

    const sections: string[] = [];
    const includedIds: string[] = [];
    const omittedIds: string[] = [];
    const emittedIds = new Set<string>();
    for (const section of orderedSections) {
      if (emittedIds.has(section.id)) continue;
      emittedIds.add(section.id);
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
      includedMemories,
      omittedMemoryIds: (() => {
        const includedKeys = new Set(
          includedMemories.map(
            (memory) => `${memory.namespace ?? ""}\u0000${memory.id}`,
          ),
        );
        return candidateMemoryChunks
          .filter(
            (chunk) =>
              !includedKeys.has(`${chunk.namespace ?? ""}\u0000${chunk.id}`),
          )
          .map((chunk) => chunk.id);
      })(),
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
