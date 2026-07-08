/**
 * Operator-facing tier visibility (issue #686 PR 5/6).
 *
 * Two read-only surfaces:
 *
 *   - `summarizeTiers(storage)` — count memories by tier (hot vs cold)
 *     plus per-status breakdown so operators can see at a glance
 *     whether the lifecycle policy has actually demoted anything.
 *   - `explainTierForMemory(storage, id)` — show the value-score
 *     components and tier-transition decision for a single memory
 *     so an operator can reason about why a memory ended up where
 *     it did.
 *
 * Pure inspection — neither surface mutates anything.  The CLI wires
 * them as `remnic tier list` and `remnic tier explain <id>`.
 */

import type { StorageManager } from "../storage.js";
import type { MemoryFile, PluginConfig } from "../types.js";
import { computeLifecycleValueInputs } from "../lifecycle.js";
import {
  computeTierValueScore,
  decideTierTransition,
  type MemoryTier,
  type TierRoutingPolicy,
  type TierTransitionDecision,
} from "../tier-routing.js";
import { resolveQmdCapabilities } from "../capabilities.js";
import {
  applyUtilityPromotionRuntimePolicy,
  loadUtilityRuntimeValues,
} from "../utility-runtime.js";

export interface TierSummary {
  /** Total memories scanned (all tiers, all statuses). */
  total: number;
  byTier: Record<MemoryTier, number>;
  byStatus: Record<string, number>;
  /** Memories with `status === "forgotten"` (issue #686 PR 4/6). */
  forgottenCount: number;
  /** Top contributors to the forgotten / archived buckets, by category. */
  byCategory: Record<string, number>;
}

export interface TierExplainResult {
  id: string;
  path: string;
  currentTier: MemoryTier;
  status: string;
  category: string;
  valueScore: number;
  decision: TierTransitionDecision;
  signals: {
    confidence: number;
    accessCount: number;
    lastAccessed: string | null;
    created: string;
    updated: string;
    importance: number;
    feedback: number;
  };
}

interface TierVisibleMemory {
  memory: MemoryFile;
  tier: MemoryTier;
}

async function readTierVisibleMemories(
  storage: StorageManager,
): Promise<TierVisibleMemory[]> {
  const [hotMemories, coldMemories] = await Promise.all([
    storage.readAllMemories(),
    storage.readAllColdMemories(),
  ]);
  return [
    ...hotMemories.map((memory) => ({ memory, tier: "hot" as const })),
    ...coldMemories.map((memory) => ({ memory, tier: "cold" as const })),
  ];
}

async function tierRoutingPolicyFromConfig(
  config: PluginConfig,
): Promise<TierRoutingPolicy> {
  const basePolicy: TierRoutingPolicy = {
    enabled: resolveQmdCapabilities(config).qmdTierMigration,
    demotionMinAgeDays: config.qmdTierDemotionMinAgeDays,
    demotionValueThreshold: config.qmdTierDemotionValueThreshold,
    promotionValueThreshold: config.qmdTierPromotionValueThreshold,
  };
  const runtime = await loadUtilityRuntimeValues({
    memoryDir: config.memoryDir,
    memoryUtilityLearningEnabled: config.memoryUtilityLearningEnabled,
    promotionByOutcomeEnabled: config.promotionByOutcomeEnabled,
  });
  return applyUtilityPromotionRuntimePolicy(basePolicy, runtime);
}

export async function summarizeTiers(
  storage: StorageManager,
): Promise<TierSummary> {
  const all = await readTierVisibleMemories(storage);
  const summary: TierSummary = {
    total: all.length,
    byTier: { hot: 0, cold: 0 },
    byStatus: {},
    forgottenCount: 0,
    byCategory: {},
  };
  for (const { memory: m, tier } of all) {
    summary.byTier[tier] += 1;
    const status: string = m.frontmatter.status ?? "active";
    summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    // Compare via the widened `string` type so this module compiles
    // both before and after PR 4/6 lands `"forgotten"` in MemoryStatus.
    if (status === "forgotten") summary.forgottenCount += 1;
    const cat = m.frontmatter.category ?? "(uncategorized)";
    summary.byCategory[cat] = (summary.byCategory[cat] ?? 0) + 1;
  }
  return summary;
}

export async function explainTierForMemory(
  storage: StorageManager,
  id: string,
  config: PluginConfig,
): Promise<TierExplainResult> {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (trimmed.length === 0) {
    throw new Error("tier explain: memory id is required and must be non-empty");
  }
  const all = await readTierVisibleMemories(storage);
  const entry = all.find(({ memory: m }) => m.frontmatter.id === trimmed);
  if (!entry) {
    throw new Error(`tier explain: memory not found: ${trimmed}`);
  }
  const { memory, tier: currentTier } = entry;
  const now = new Date();
  const valueInputs = computeLifecycleValueInputs(memory, now);
  const valueScore = computeTierValueScore(memory, now);
  const policy = await tierRoutingPolicyFromConfig(config);
  const decision = decideTierTransition(memory, currentTier, policy, now);
  const fm = memory.frontmatter as unknown as Record<string, unknown>;
  return {
    id: trimmed,
    path: memory.path,
    currentTier,
    status: typeof fm.status === "string" ? (fm.status as string) : "active",
    category: typeof fm.category === "string" ? (fm.category as string) : "",
    valueScore,
    decision,
    signals: {
      confidence: valueInputs.confidence,
      accessCount:
        typeof fm.accessCount === "number" ? (fm.accessCount as number) : 0,
      lastAccessed:
        typeof fm.lastAccessed === "string" ? (fm.lastAccessed as string) : null,
      created: typeof fm.created === "string" ? (fm.created as string) : "",
      updated: typeof fm.updated === "string" ? (fm.updated as string) : "",
      importance: valueInputs.importance,
      feedback: valueInputs.feedback,
    },
  };
}

/**
 * Render a TierSummary as plain text for `remnic tier list` text mode.
 * Pure formatter — exposed so future surfaces (HTTP, MCP) can reuse.
 */
export function formatTierSummaryText(summary: TierSummary): string {
  const lines: string[] = [];
  lines.push("=== Memory Tier Distribution ===");
  lines.push(`Total memories: ${summary.total}`);
  lines.push("");
  lines.push("Tier:");
  lines.push(`  hot:  ${summary.byTier.hot}`);
  lines.push(`  cold: ${summary.byTier.cold}`);
  lines.push("");
  lines.push("Status:");
  const statusEntries = Object.entries(summary.byStatus).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  for (const [status, count] of statusEntries) {
    lines.push(`  ${status}: ${count}`);
  }
  lines.push("");
  lines.push("Top categories:");
  const categoryEntries = Object.entries(summary.byCategory)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);
  for (const [cat, count] of categoryEntries) {
    lines.push(`  ${cat}: ${count}`);
  }
  return lines.join("\n");
}

/**
 * Render a TierExplainResult as plain text for `remnic tier explain`.
 */
export function formatTierExplainText(explain: TierExplainResult): string {
  const lines: string[] = [];
  lines.push(`=== Tier Explain: ${explain.id} ===`);
  lines.push(`path:          ${explain.path}`);
  lines.push(`current tier:  ${explain.currentTier}`);
  lines.push(`status:        ${explain.status}`);
  lines.push(`category:      ${explain.category}`);
  lines.push(`value score:   ${explain.valueScore.toFixed(3)}`);
  lines.push("");
  lines.push("Tier-transition decision:");
  lines.push(`  next tier: ${explain.decision.nextTier}`);
  lines.push(`  changed:   ${explain.decision.changed}`);
  lines.push(`  reason:    ${explain.decision.reason}`);
  lines.push("");
  lines.push("Signals:");
  lines.push(`  confidence:   ${explain.signals.confidence}`);
  lines.push(`  accessCount:  ${explain.signals.accessCount}`);
  lines.push(`  lastAccessed: ${explain.signals.lastAccessed ?? "(never)"}`);
  lines.push(`  created:      ${explain.signals.created}`);
  lines.push(`  updated:      ${explain.signals.updated}`);
  lines.push(`  importance:   ${explain.signals.importance}`);
  lines.push(`  feedback:     ${explain.signals.feedback}`);
  return lines.join("\n");
}
