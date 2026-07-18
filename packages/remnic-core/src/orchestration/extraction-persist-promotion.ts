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
import type { PluginConfig } from "../types.js";
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
