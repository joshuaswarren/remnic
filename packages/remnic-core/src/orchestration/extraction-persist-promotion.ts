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
import { log } from "../logger.js";
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

/**
 * PR #2016: after `writeSealedMemory` has made a fact `.md` durable with its
 * fact-hash flush deferred (#1909 batching), a throw in the fallible post-write
 * work (contradiction resolve, indexing, shared promotion, artifact write)
 * would strand the deferred parent hash — the shared fact-hash index on disk
 * would be missing the parent until the next corpus rebuild, letting a peer
 * re-extract a duplicate. Flush the batch save before the error propagates so
 * the durable-hash invariant holds on every path. No-op when dedup is off
 * (`deferred=false` → the write already flushed and the batch saver is a no-op).
 * Best-effort: a flush failure is logged and never masks the original error.
 */
export async function flushDeferredFactHashOnFailure(
  saveContentHashIndexes: () => Promise<void>,
  deferred: boolean,
): Promise<void> {
  if (!deferred) return;
  await saveContentHashIndexes().catch((err) =>
    log.warn(`content-hash flush after post-write failure failed: ${err}`),
  );
}

/**
 * Finding C (issue #2330 review): a successful semantic merge mutates only
 * the source namespace, but the create path's promotion step owns the
 * shared/profile copies linked back by `sourceMemoryId`. Merging a target
 * that already has promoted copies would leave those copies serving the
 * pre-merge body while the source serves the merged claims, so such a
 * target must bypass the merge and let the normal write run.
 *
 * Target resolution mirrors `backfillTemporalBoundsOnPromotionCopies`: ALL
 * known auto-promote target namespaces plus the shared namespace, NEVER
 * gated by current write authorization or the current confidence — a
 * promoted copy may exist from an earlier extraction made under older
 * settings (higher confidence, an authorized profile, shared-write
 * permission later revoked). A permission change must never make an
 * existing copy invisible to this scan. An unreadable promotion namespace
 * is treated as "copies may exist": the conservative create path runs
 * rather than risk cross-namespace divergence.
 */
export async function mergeTargetHasPromotedCopies(args: {
  config: PluginConfig;
  getStorageRouter: () => {
    storageFor: (namespace: string) => Promise<StorageManager>;
  };
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined;
  sourceStorage: StorageManager;
  targetMemoryId: string;
}): Promise<boolean> {
  const namespaces: string[] = [];
  if (args.scopeProfileWritePlan) {
    const autoTargets = new Set(args.scopeProfileWritePlan.profile.autoPromote.targets);
    for (const target of args.scopeProfileWritePlan.promotionTargets) {
      if (
        target.target !== "serverShared" &&
        autoTargets.has(target.target) &&
        target.namespace
      ) {
        namespaces.push(target.namespace);
      }
    }
  }
  namespaces.push(args.config.sharedNamespace);
  for (const namespace of namespaces) {
    try {
      const storage = await args.getStorageRouter().storageFor(namespace);
      if (storage.dir === args.sourceStorage.dir) continue;
      const active = await readActiveMemoriesBothTiers(storage);
      if (active.some((m) => m.frontmatter.sourceMemoryId === args.targetMemoryId)) {
        return true;
      }
    } catch (err) {
      log.warn(
        `semantic-merge guard: promotion namespace "${namespace}" unreadable; bypassing the merge (finding C): ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }
  return false;
}
