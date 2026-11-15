import type { FaithfulnessResult } from "../extraction-faithfulness.js";
import type { JudgeVerdict } from "../extraction-judge.js";
import { receiptExistingMemory } from "../extraction-receipt-runtime.js";
import { isAboveImportanceThreshold } from "../importance.js";
import type { StorageManager } from "../storage.js";
import type { ExtractedFact, ImportanceLevel, MemoryFile, MemorySubject, PluginConfig } from "../types.js";
import { type FactDedupMatchOptions, matchesActiveConnectorDuplicate } from "./fact-dedup-window.js";

export interface ReceiptFactDedupOptions {
  fact: ExtractedFact;
  subject?: MemorySubject;
  config: PluginConfig;
  importance: ImportanceLevel;
  faithfulness?: FaithfulnessResult;
  judge?: JudgeVerdict;
  temporal: boolean;
  toolScoped: boolean;
}
/** Bounded support: exact plain facts only; richer effects retain deferred coverage. */
export async function confirmReceiptFactDuplicate(
  storage: StorageManager,
  namespace: string,
  match: MemoryFile | null | undefined,
  predicate: FactDedupMatchOptions,
  options: ReceiptFactDedupOptions
): Promise<boolean> {
  const { fact, config, faithfulness, judge } = options;
  if (
    !match ||
    predicate.category !== "fact" ||
    fact.scope === "project" ||
    options.temporal ||
    Object.keys(fact.structuredAttributes ?? {}).length > 0 ||
    !isAboveImportanceThreshold(options.importance, config.extractionMinImportanceLevel) ||
    (config.provenance?.requireSpans === true && fact.requireSpansPending === true) ||
    (config.extractionFaithfulnessGate === "enforce" &&
      faithfulness !== undefined &&
      (!faithfulness.ok || faithfulness.verdict !== "entailed")) ||
    (!config.extractionJudgeShadow && judge !== undefined && !judge.durable)
  )
    return false;
  return receiptExistingMemory(storage, namespace, async () => {
    const current = await storage.readMemoryByPath(match.path);
    if (
      !current ||
      current.path !== match.path ||
      current.frontmatter.id !== match.frontmatter.id ||
      !matchesActiveConnectorDuplicate(current, predicate) ||
      current.frontmatter.valid_at !== undefined ||
      current.frontmatter.invalid_at !== undefined ||
      current.frontmatter.expiresAt !== undefined ||
      current.frontmatter.eventTimeSource !== undefined ||
      current.frontmatter.tags.includes("chunked") ||
      current.frontmatter.parentId !== undefined ||
      current.frontmatter.chunkIndex !== undefined ||
      current.frontmatter.chunkTotal !== undefined ||
      current.frontmatter.source === "artifact" ||
      /[\\/]artifacts[\\/]/.test(current.path) ||
      current.frontmatter.artifactType !== undefined ||
      current.frontmatter.sourceMemoryId !== undefined ||
      current.frontmatter.entityRef !== fact.entityRef ||
      (current.frontmatter.subject ?? "user") !== (options.subject ?? "user") ||
      (current.frontmatter.toolScoped === true) !== options.toolScoped ||
      current.frontmatter.confidence < fact.confidence ||
      fact.tags.some((tag) => !current.frontmatter.tags.includes(tag)) ||
      Object.keys(current.frontmatter.structuredAttributes ?? {}).length > 0
    )
      return null;
    return current;
  });
}
