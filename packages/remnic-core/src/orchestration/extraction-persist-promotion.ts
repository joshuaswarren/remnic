/**
 * Auto-promotion gating helpers for the extraction-persist pipeline
 * (extracted from extraction-persist.ts to keep that file under the
 * structural line-count ceiling; issue #1909 / seam 16).
 *
 * Pure decision helpers that answer "may this fact be auto-promoted?" for
 * both scope-profile targets and the server-shared namespace. Behavior is a
 * verbatim move from the closures that previously lived inside
 * `persistExtraction`; `this.deps.*` state is threaded in as explicit
 * parameters so the functions stay free of coordinator instance state.
 */

import { StorageManager } from "../index.js";
import { confidenceTier } from "../types.js";
import {
  resolveNamespaceCapabilities,
  resolveRecallEnhancementCapabilities,
} from "../capabilities.js";
import type { MemoryFile, PluginConfig } from "../types.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";

export const confidenceTierOrder = [
  "explicit",
  "implied",
  "inferred",
  "speculative",
] as const;

export function profileAutoPromotionAllows(
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined,
  category: string,
  confidence: number,
): boolean {
  if (!scopeProfileWritePlan) return false;
  const actualTier = confidenceTier(confidence);
  const actualRank = confidenceTierOrder.indexOf(actualTier);
  if (actualRank === -1) return false;
  const autoPromote = scopeProfileWritePlan.profile.autoPromote;
  if (!autoPromote.enabled) return false;
  if (!autoPromote.categories.includes(category as any)) return false;
  const minimumRank = confidenceTierOrder.indexOf(autoPromote.minConfidenceTier);
  return minimumRank !== -1 && actualRank <= minimumRank;
}

export function sharedAutoPromotionAllows(
  config: PluginConfig,
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined,
  category: string,
  confidence: number,
): boolean {
  if (!scopeProfileWritePlan) {
    const actualTier = confidenceTier(confidence);
    const actualRank = confidenceTierOrder.indexOf(actualTier);
    if (actualRank === -1) return false;
    if (!resolveRecallEnhancementCapabilities(config).autoPromoteToShared) return false;
    if (!config.autoPromoteToSharedCategories.includes(category as any))
      return false;
    const minimumRank = confidenceTierOrder.indexOf(
      config.autoPromoteMinConfidenceTier,
    );
    return minimumRank !== -1 && actualRank <= minimumRank;
  }
  return (
    scopeProfileWritePlan.profile.autoPromote.targets.includes("serverShared") &&
    profileAutoPromotionAllows(scopeProfileWritePlan, category, confidence)
  );
}

export function shouldPromoteToShared(
  config: PluginConfig,
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined,
  profileAllowsSharedWrites: boolean,
  storageDirNamespace: (storageDir: string) => string,
  targetStorage: StorageManager,
  category: string,
  confidence: number,
): boolean {
  if (
    !resolveNamespaceCapabilities(config).namespaces ||
    !profileAllowsSharedWrites ||
    !sharedAutoPromotionAllows(config, scopeProfileWritePlan, category, confidence)
  )
    return false;
  if (
    storageDirNamespace(targetStorage.dir) ===
    config.sharedNamespace
  )
    return false;
  return true;
}

/**
 * Read the active-copy corpus across BOTH storage tiers (hot + cold).
 *
 * #2016 cold-tier finding: the authoritative content-hash rebuild unions the
 * hot and cold tiers, so `hasFactContentHash()` can report a hit for a
 * fact/procedure whose only active copy was demoted to `cold/`. A promotion or
 * dedup confirmation scan that reads `readAllMemories()` (hot) alone misses
 * that copy, so it either writes a duplicate hot copy or skips a needed
 * temporal backfill. Scanning both tiers keeps the confirmation coherent with
 * the hash index. Cold reads are folded in only when the cold tier is
 * non-empty so hot-only namespaces incur no extra allocation.
 */
export async function readActiveMemoriesBothTiers(
  storage: StorageManager,
): Promise<MemoryFile[]> {
  const [hotMems, coldMems] = await Promise.all([
    storage.readAllMemories(),
    storage.readAllColdMemories(),
  ]);
  return coldMems.length === 0 ? hotMems : [...hotMems, ...coldMems];
}
