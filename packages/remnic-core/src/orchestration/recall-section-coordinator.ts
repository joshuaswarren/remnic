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
    sectionBuckets: Map<string, string[]>,
    sectionId: string,
    content: string,
  ): boolean {
    // Returns true when the section was actually appended to sectionBuckets,
    // false when it was dropped (disabled, empty, or maxChars===0). Callers
    // that need to know whether injection occurred (e.g. xray annotation for
    // peer-profile) must gate on this return value rather than on whether the
    // section text was computed (Codex P2 finding, PR #764).
    if (!this.resolveSectionEnabled(sectionId, true)) return false;
    const trimmed = content.trim();
    if (trimmed.length === 0) return false;

    const maxChars = this.getRecallSectionMaxChars(sectionId);
    let finalContent = trimmed;
    if (maxChars === 0) return false;
    if (typeof maxChars === "number" && finalContent.length > maxChars) {
      finalContent = `${finalContent.slice(0, maxChars)}\n\n...(trimmed)\n`;
    }

    const existing = sectionBuckets.get(sectionId) ?? [];
    existing.push(finalContent);
    sectionBuckets.set(sectionId, existing);
    return true;
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

  protectedRecallSectionIds(
    sectionBuckets: Map<string, string[]>,
  ): Set<string> {
    const protectedIds = new Set<string>();
    if ((sectionBuckets.get("memories")?.length ?? 0) > 0) {
      protectedIds.add("memories");
    }
    return protectedIds;
  }

  protectedRecallReservationChars(content: string): number {
    const headingBoundary = content.indexOf("\n\n");
    const headingChars =
      headingBoundary >= 0 ? headingBoundary + 2 : Math.min(content.length, 24);
    return Math.min(content.length, Math.max(headingChars, 24));
  }

  estimateReservedRecallBudget(
    entries: Array<{ id: string; content: string }>,
    startIndex: number,
    protectedIds: Set<string>,
    alreadyIncludedCount: number,
  ): number {
    const separatorLength = "\n\n---\n\n".length;
    let reserved = 0;
    let simulatedIncluded = alreadyIncludedCount;
    for (let i = startIndex; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || !protectedIds.has(entry.id)) continue;
      if (simulatedIncluded > 0) {
        reserved += separatorLength;
      }
      reserved += this.protectedRecallReservationChars(entry.content);
      simulatedIncluded += 1;
    }
    return reserved;
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
    sectionBuckets: Map<string, string[]>,
    budgetOverride?: number,
  ): {
    sections: string[];
    includedIds: string[];
    omittedIds: string[];
    truncated: boolean;
    finalChars: number;
  } {
    const orderedEntries: Array<{ id: string; content: string }> = [];
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
      orderedEntries.push({ id, content: chunks.join("\n\n") });
      seen.add(id);
    }

    for (const [id, chunks] of sectionBuckets.entries()) {
      if (seen.has(id)) continue;
      if (chunks.length === 0) continue;
      orderedEntries.push({ id, content: chunks.join("\n\n") });
    }

    const budget = this.getRecallBudgetChars(budgetOverride);
    if (budget === 0) {
      return {
        sections: [],
        includedIds: [],
        omittedIds: orderedEntries.map((entry) => entry.id),
        truncated: orderedEntries.length > 0,
        finalChars: 0,
      };
    }

    const separator = "\n\n---\n\n";
    const protectedIds = this.protectedRecallSectionIds(sectionBuckets);
    const sections: string[] = [];
    const includedIds: string[] = [];
    const omittedIds: string[] = [];
    let usedChars = 0;
    let truncated = false;

    for (let index = 0; index < orderedEntries.length; index += 1) {
      const entry = orderedEntries[index]!;
      const separatorChars = sections.length > 0 ? separator.length : 0;
      const reserve = protectedIds.has(entry.id)
        ? 0
        : this.estimateReservedRecallBudget(
            orderedEntries,
            index + 1,
            protectedIds,
            sections.length + 1,
          );
      const availableForEntry = budget - usedChars - separatorChars - reserve;
      if (availableForEntry <= 0) {
        omittedIds.push(entry.id);
        truncated = true;
        continue;
      }
      const finalContent = this.truncateRecallSectionToBudget(
        entry.content,
        availableForEntry,
      );
      if (!finalContent) {
        omittedIds.push(entry.id);
        truncated = true;
        continue;
      }
      if (finalContent.length < entry.content.length) {
        truncated = true;
      }
      sections.push(finalContent);
      includedIds.push(entry.id);
      usedChars += separatorChars + finalContent.length;
    }

    return {
      sections,
      includedIds,
      omittedIds,
      truncated,
      finalChars: usedChars,
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
      includedSections: [...(options.includedSections ?? [])],
      omittedSections: [...(options.omittedSections ?? [])],
    };
  }

  collectLastRecallSources(
    sectionBuckets: Map<string, string[]>,
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
