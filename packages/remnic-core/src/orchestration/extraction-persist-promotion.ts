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
import { withholdToolScopedFromSharedNamespace } from "../tool-scoped-memory.js";
import { evaluateSubjectGuard, isSharedPromotionTarget } from "../memory-subject.js";
import { confidenceTier, type MemorySubject } from "../types.js";
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
 * Merged-target promotion scope gate (PR #2771 finding A). A committed
 * record stamped `toolScoped: true` must keep its promoted copy withheld
 * from the shared namespace even when the merged body no longer matches
 * the content heuristics that earned the target its marker at write time —
 * the merge judge composes new text, and without the incoming connector
 * the heuristic returns false outright. The committed marker is
 * authoritative; the heuristics only ever ADD withholding. Not a
 * parsed-config surface: the field is the frontmatter literal `true` or
 * absent.
 */
export function promotionWithholdsToolScope(options: {
  toolScoped?: true;
  content: string;
  sourceConnector?: string;
  procedureSteps?: ReadonlyArray<{ toolCall?: { kind?: string } }>;
}): boolean {
  return (
    options.toolScoped === true || withholdToolScopedFromSharedNamespace(options)
  );
}

/**
 * Subject guard (issue #2372), extracted verbatim from the coordinator
 * closure: the ONE gate shared by every extraction-side promotion path so
 * behavior matches the spaces surface (§27).
 */
export function makeSubjectGuardAllows(
  config: PluginConfig,
): (subject: MemorySubject | undefined, target: string, label: string) => boolean {
  return (subject, target, label) => {
    const decision = evaluateSubjectGuard({
      subject,
      sharedTarget: isSharedPromotionTarget(target),
      mode: config.subjectGuard,
    });
    if (decision.action !== "allow") {
      log.warn(`subject-guard(${decision.action}) ${label}: ${decision.reason}`);
    }
    return decision.action !== "reject";
  };
}

/**
 * Finding C (issue #2330 review): a successful semantic merge mutates only
 * the source namespace, but the create path's promotion step owns the
 * shared/profile copies linked back by `sourceMemoryId`. Merging a target
 * that already has promoted copies would leave those copies serving the
 * pre-merge body while the source serves the merged claims, so such a
 * target must bypass the merge and let the normal write run.
 *
 * Finding E (final round): the scan covers ALL resolved promotion layers —
 * NEVER filtered by today's `autoPromote.targets` selection or by current
 * write authorization. A copy created while a layer was listed stays linked
 * by `sourceMemoryId` after the operator removes that layer; detection
 * scans history while policy governs writes (the authorization-change
 * lesson applied to selection). An unreadable promotion namespace is
 * treated as "copies may exist": the conservative create path runs rather
 * than risk cross-namespace divergence.
 */
function promotionScanNamespaces(
  config: PluginConfig,
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined,
): string[] {
  const namespaces: string[] = [];
  if (scopeProfileWritePlan) {
    for (const target of scopeProfileWritePlan.promotionTargets) {
      if (target.target !== "serverShared" && target.namespace) {
        namespaces.push(target.namespace);
      }
    }
  }
  namespaces.push(config.sharedNamespace);
  return [...new Set(namespaces)];
}

/** One namespace's promoted-copy scan. `sourceIds: null` means unreadable. */
interface PromotedCopyScanEntry {
  dir: string;
  sourceIds: Set<string> | null;
}

export interface BatchPromotedCopyProbe {
  check: (sourceStorage: StorageManager, targetMemoryId: string) => Promise<boolean>;
  /**
   * Finding F (final round): drop the cached scans after this batch itself
   * promoted a copy, so a later fact merging into the same target still sees
   * the copy the batch just wrote.
   */
  invalidate: () => void;
}

/**
 * Finding F (capacity regression): the guard scans every promotion
 * namespace's full hot+cold corpus, and a multi-fact extraction calls it
 * once per judge-approved fact — O(facts × namespaces × corpus). The probe
 * scans each namespace ONCE per batch and reuses the result. The uncached
 * per-call helper below shares this single implementation.
 */
export function createBatchPromotedCopyProbe(
  config: PluginConfig,
  getStorageRouter: () => {
    storageFor: (namespace: string) => Promise<StorageManager>;
  },
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined,
): BatchPromotedCopyProbe {
  const scans = new Map<string, Promise<PromotedCopyScanEntry>>();
  const scanNamespace = (namespace: string): Promise<PromotedCopyScanEntry> => {
    let entry = scans.get(namespace);
    if (entry === undefined) {
      entry = (async (): Promise<PromotedCopyScanEntry> => {
        try {
          const storage = await getStorageRouter().storageFor(namespace);
          const active = await readActiveMemoriesBothTiers(storage);
          return {
            dir: storage.dir,
            sourceIds: new Set(
              active
                .map((memory) => memory.frontmatter.sourceMemoryId)
                .filter((id): id is string => typeof id === "string"),
            ),
          };
        } catch (err) {
          log.warn(
            `semantic-merge guard: promotion namespace "${namespace}" unreadable; bypassing the merge (finding C): ${err instanceof Error ? err.message : String(err)}`,
          );
          return { dir: "", sourceIds: null };
        }
      })();
      scans.set(namespace, entry);
    }
    return entry;
  };
  return {
    check: async (sourceStorage, targetMemoryId) => {
      for (const namespace of promotionScanNamespaces(config, scopeProfileWritePlan)) {
        const entry = await scanNamespace(namespace);
        if (entry.sourceIds === null) return true;
        if (entry.dir === sourceStorage.dir) continue;
        if (entry.sourceIds.has(targetMemoryId)) return true;
      }
      return false;
    },
    invalidate: () => {
      scans.clear();
    },
  };
}

export async function mergeTargetHasPromotedCopies(args: {
  config: PluginConfig;
  getStorageRouter: () => {
    storageFor: (namespace: string) => Promise<StorageManager>;
  };
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined;
  sourceStorage: StorageManager;
  targetMemoryId: string;
}): Promise<boolean> {
  return createBatchPromotedCopyProbe(
    args.config,
    args.getStorageRouter,
    args.scopeProfileWritePlan,
  ).check(args.sourceStorage, args.targetMemoryId);
}
