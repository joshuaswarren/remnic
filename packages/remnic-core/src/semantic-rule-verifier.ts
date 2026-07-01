import { getCachedRuleMemories, setCachedRuleMemories } from "./memory-cache.js";
import { StorageManager } from "./storage.js";
import type { MemoryFile } from "./types.js";
import { countRecallTokenOverlap, normalizeRecallTokens } from "./recall-tokenization.js";

export type SemanticRuleVerificationStatus =
  | "verified"
  | "source-memory-missing"
  | "source-memory-archived"
  | "source-memory-forgotten"
  | "source-memory-not-episode";

export interface VerifiedSemanticRuleResult {
  rule: MemoryFile;
  score: number;
  sourceMemoryId: string;
  verificationStatus: SemanticRuleVerificationStatus;
  effectiveConfidence: number;
  matchedFields: string[];
}

const DEFAULT_MIN_EFFECTIVE_CONFIDENCE = 0.45;

function verificationConfidenceMultiplier(status: SemanticRuleVerificationStatus): number {
  switch (status) {
    case "verified":
      return 1;
    case "source-memory-not-episode":
      return 0.45;
    case "source-memory-archived":
      return 0.4;
    case "source-memory-forgotten":
      return 0.3;
    case "source-memory-missing":
      return 0.35;
    default:
      return 0.35;
  }
}

function resolveVerificationStatus(sourceMemory: MemoryFile | undefined): SemanticRuleVerificationStatus {
  if (!sourceMemory) return "source-memory-missing";
  if (sourceMemory.frontmatter.status === "archived") {
    return "source-memory-archived";
  }
  if (sourceMemory.frontmatter.status === "forgotten") return "source-memory-forgotten";
  if (sourceMemory.frontmatter.memoryKind !== "episode") return "source-memory-not-episode";
  return "verified";
}

function resolveEffectiveConfidence(rule: MemoryFile, sourceMemory: MemoryFile | undefined): {
  status: SemanticRuleVerificationStatus;
  effectiveConfidence: number;
} {
  const status = resolveVerificationStatus(sourceMemory);
  const ruleConfidence = Number.isFinite(rule.frontmatter.confidence) ? rule.frontmatter.confidence : 0.8;
  const sourceConfidence = Number.isFinite(sourceMemory?.frontmatter.confidence)
    ? sourceMemory!.frontmatter.confidence
    : ruleConfidence;
  const anchoredConfidence = Math.min(ruleConfidence, sourceConfidence);
  const effectiveConfidence = Math.max(
    0,
    Math.min(1, anchoredConfidence * verificationConfidenceMultiplier(status)),
  );
  return { status, effectiveConfidence };
}

function scoreVerifiedSemanticRuleCandidate(
  rule: MemoryFile,
  sourceMemory: MemoryFile | undefined,
  queryTokens: Set<string>,
  effectiveConfidence: number,
): { score: number; matchedFields: Set<string> } {
  const matchedFields = new Set<string>();
  let score = 0;

  const ruleContentMatches = countRecallTokenOverlap(queryTokens, rule.content);
  if (ruleContentMatches > 0) {
    score += ruleContentMatches * 5;
    matchedFields.add("ruleContent");
  }

  const tagMatches = countRecallTokenOverlap(queryTokens, rule.frontmatter.tags?.join(" "));
  if (tagMatches > 0) {
    score += tagMatches * 2;
    matchedFields.add("tags");
  }

  const sourceContentMatches = countRecallTokenOverlap(queryTokens, sourceMemory?.content);
  if (sourceContentMatches > 0) {
    score += sourceContentMatches * 2;
    matchedFields.add("sourceContent");
  }

  if (score > 0) {
    score += effectiveConfidence;
  }

  return { score, matchedFields };
}

export function compareVerifiedSemanticRuleResults(
  left: VerifiedSemanticRuleResult,
  right: VerifiedSemanticRuleResult,
): number {
  return (
    right.score - left.score ||
    right.effectiveConfidence - left.effectiveConfidence ||
    right.rule.frontmatter.updated.localeCompare(left.rule.frontmatter.updated) ||
    left.rule.frontmatter.id.localeCompare(right.rule.frontmatter.id)
  );
}

export async function searchVerifiedSemanticRules(options: {
  memoryDir: string;
  query: string;
  maxResults: number;
  minEffectiveConfidence?: number;
}): Promise<VerifiedSemanticRuleResult[]> {
  const queryTokens = new Set(normalizeRecallTokens(options.query, ["what", "which"]));
  if (queryTokens.size === 0 || options.maxResults <= 0) return [];

  const storage = new StorageManager(options.memoryDir);
  const version = storage.getMemoryStatusVersion();

  // Use derived rule cache to avoid O(146K) iteration on every call.
  let cachedRules = getCachedRuleMemories(storage.dir, version);
  if (!cachedRules) {
    const allMems = await storage.readAllMemories();
    cachedRules = setCachedRuleMemories(storage.dir, allMems, version);
  }
  const { all: ruleMemories, byId: memoryById } = cachedRules;
  const minEffectiveConfidence = options.minEffectiveConfidence ?? DEFAULT_MIN_EFFECTIVE_CONFIDENCE;

  const candidates: VerifiedSemanticRuleResult[] = [];
  // ruleMemories is pre-filtered to category=rule and recall-hidden statuses.
  for (const memory of ruleMemories) {
    if (memory.frontmatter.source !== "semantic-rule-promotion") continue;
    const sourceMemoryId = memory.frontmatter.sourceMemoryId;
    if (!sourceMemoryId) continue;

    const sourceMemory = memoryById.get(sourceMemoryId);
    const { status, effectiveConfidence } = resolveEffectiveConfidence(memory, sourceMemory);
    if (effectiveConfidence < minEffectiveConfidence) continue;

    const { score, matchedFields } = scoreVerifiedSemanticRuleCandidate(
      memory,
      sourceMemory,
      queryTokens,
      effectiveConfidence,
    );
    if (score <= 0) continue;

    candidates.push({
      rule: memory,
      score,
      sourceMemoryId,
      verificationStatus: status,
      effectiveConfidence,
      matchedFields: [...matchedFields].sort(),
    });
  }

  return candidates
    .sort(compareVerifiedSemanticRuleResults)
    .slice(0, options.maxResults);
}
