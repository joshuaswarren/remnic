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
import { inferMemoryStatus, toMemoryPathRel } from "../memory-lifecycle-ledger-utils.js";
import { confidenceTier, type MemorySubject } from "../types.js";
import {
  resolveNamespaceCapabilities,
  resolveRecallEnhancementCapabilities,
} from "../capabilities.js";
import type { MemoryFile, PluginConfig } from "../types.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import type { MergedTargetPromotionPayload } from "./semantic-merge-persist.js";

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
 * Finding E (final round) + round N+12 (B): the scan covers ALL resolved
 * layers — NEVER filtered by today's `autoPromote.targets` selection, by
 * current write authorization, or by today's `promotionTargets` list. A copy
 * created while a layer was listed stays linked by `sourceMemoryId` after
 * the operator removes that layer from the promotion selection while it
 * remains resolvable through readOrder/layers; detection scans history while
 * policy governs writes (the authorization-change lesson applied to
 * selection). An unreadable promotion namespace is treated as "copies may
 * exist": the conservative create path runs rather than risk
 * cross-namespace divergence.
 */
export function promotionScanNamespaces(
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
    // Round N+12 (B): enumerate EVERY resolvable layer, not only today's
    // promotionTargets. A namespace that received promoted copies while its
    // layer was selected keeps serving them after the operator removes the
    // layer from the selection — the layer stays resolvable through
    // readOrder/layers, and the documented guarantee is that historical
    // copies remain detectable after selection changes. The shared namespace
    // joins below from config (the authoritative value).
    for (const layer of scopeProfileWritePlan.layers ?? []) {
      if (layer.id !== "serverShared" && layer.namespace) {
        namespaces.push(layer.namespace);
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
            // Round N+11 (A): only ACTIVE copies count as promoted (§41 —
            // enumerate the active set). readActiveMemoriesBothTiers returns
            // every hot+cold copy, superseded ones included; a superseded
            // copy serves no body, so counting it made targetHasPromotedCopies
            // reject every later judge-approved merge and the supposedly
            // mergeable updates accumulated as new fragments instead.
            sourceIds: new Set(
              active
                .filter(
                  (memory) =>
                    inferMemoryStatus(memory.frontmatter, toMemoryPathRel(storage.dir, memory.path)) ===
                    "active",
                )
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

/**
 * Round N+10 (A): run the merged target's promotion and its stale-copy
 * reconciliation as ONE step so reconciliation cannot be skipped on a
 * no-promotion exit. `promoteMemoryToShared` returns undefined when this
 * merge's min(incoming, target) downgrade dropped the committed record below
 * the profile/shared promotion minimum, and `buildMergedTargetPromotionPayload`
 * returns null for a degraded merge — in both cases no replacement copy is
 * written, yet a concurrent writer may have published the PRE-merge body
 * after the caller's initial probe. Reconciliation still runs: with no
 * promoted body supplied, {@link retireStaleMergedTargetPromotionCopies}
 * re-reads the committed record and retires copies predating it, superseding
 * them onto the committed target itself ("none is warranted" below the
 * threshold). Promotion failures stay fail-open — the merge stands.
 *
 * Round N+15 (A): the payload is a CACHE of the committed record as of the
 * builder's read. Between that read and this promotion another writer can
 * merge the same target again (or a lifecycle operation can retire it), so
 * the record is re-read and the cache confirmed against the committed
 * revision AND body immediately before promoting. On any advance — or an
 * unreadable record, which can never confirm the cache — the promotion AND
 * its reconciliation are abandoned: the newer writer's copy stands, a cached
 * body never becomes canonical, and the next merge retries both.
 */
export async function promoteAndReconcileMergedTarget(args: {
  promote: (payload: MergedTargetPromotionPayload) => Promise<string | undefined>;
  config: PluginConfig;
  getStorageRouter: () => {
    storageFor: (namespace: string) => Promise<StorageManager>;
  };
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined;
  sourceStorage: StorageManager;
  sourceMemoryId: string;
  /** Null = payload builder refused (degraded merge / target replaced mid-flight). */
  mergedPromotion: MergedTargetPromotionPayload | null;
  normalize: (content: string) => string;
  onReconciled?: () => void;
}): Promise<void> {
  let promotedCopyId: string | undefined;
  if (args.mergedPromotion) {
    const payload = args.mergedPromotion;
    const current = await args.sourceStorage
      .getMemoryByIdIncludingArchived(args.sourceMemoryId)
      .catch(() => null);
    if (
      !current ||
      inferMemoryStatus(current.frontmatter, current.path) !== "active" ||
      current.content !== payload.content ||
      (current.frontmatter.updated ?? undefined) !== (payload.committedRevision ?? undefined)
    ) {
      log.warn(
        `persistExtraction: merged-target promotion abandoned for ${args.sourceMemoryId} — the committed record advanced past the cached payload, so the newer writer's copy stands`,
      );
      return;
    }
    try {
      promotedCopyId = await args.promote(payload);
    } catch (err) {
      log.warn(
        `persistExtraction: merged-target promotion failed open for ${args.sourceMemoryId}: ${err}`,
      );
    }
  }
  try {
    await retireStaleMergedTargetPromotionCopies({
      config: args.config,
      getStorageRouter: args.getStorageRouter,
      scopeProfileWritePlan: args.scopeProfileWritePlan,
      sourceStorage: args.sourceStorage,
      sourceMemoryId: args.sourceMemoryId,
      ...(args.mergedPromotion
        ? { promotedContent: args.mergedPromotion.content }
        : {}),
      ...(promotedCopyId !== undefined
        ? { promotedMemoryId: promotedCopyId }
        : {}),
      normalize: args.normalize,
    });
    args.onReconciled?.();
  } catch (err) {
    log.warn(
      `persistExtraction: merged-target promotion reconciliation failed open for ${args.sourceMemoryId}: ${err}`,
    );
  }
}

/**
 * Round N+7 (B) + P1-A (#2330 round N+8) + round N+10 (A): reconcile a
 * merged target's promoted copies after the merged-body promotion lands.
 * The pre-mutation probe that guards the merge can race a concurrent writer
 * that is promoting the same target: the probe reports no copies, the other
 * writer publishes the PRE-merge body, and the merged-target promotion then
 * adds the current body — promotion dedups by content, so both copies stay
 * active across namespaces. Detection: an ACTIVE memory in any resolved
 * promotion namespace (never the source's own) whose `sourceMemoryId` names
 * this target and whose normalized body differs from the canonical body.
 * Round N+10 (A) extended this to the NO-promotion path:
 * `promotedContent` may be omitted and `promotedMemoryId` may be omitted
 * (below-threshold downgrade or degraded merge) — stale copies then
 * supersede onto the committed source target itself, leaving exactly one
 * current copy or none if none is warranted. Round N+13 (A): an
 * unreadable, missing, or empty canonical body ABORTS the reconciliation —
 * no copy is ever retired off a body that was never confirmed. Round N+15
 * (A): the canonical body is ALWAYS the re-read committed record, never the
 * promotion's cached payload — a writer committing a newer merge between
 * this writer's promotion and its reconciliation would otherwise have its
 * current copy superseded off the older cached body; when the re-read has
 * moved past the promoted body, this promotion's own copies are stale too
 * and supersede onto the SOURCE target. Replace, not add: each stale copy
 * is superseded with `supersededBy` pointing at the current copy (or the
 * source target). Best-effort and fail-open per namespace — a failed
 * retirement is logged and leaves the pre-fix state, which the next merge
 * retries. Returns the number of stale copies retired.
 */
export async function retireStaleMergedTargetPromotionCopies(args: {
  config: PluginConfig;
  getStorageRouter: () => {
    storageFor: (namespace: string) => Promise<StorageManager>;
  };
  scopeProfileWritePlan: ResolvedScopeProfilePlan | null | undefined;
  sourceStorage: StorageManager;
  sourceMemoryId: string;
  /** The body the merged-target promotion wrote (raw committed record content). Omit on the no-promotion path. The canonical body is always re-read from the committed record; this only selects the supersession target. */
  promotedContent?: string;
  /** The id of the promoted copy just written (supersession target while it still carries the canonical body). Omit when no replacement promotion ran — stale copies supersede onto the source target. */
  promotedMemoryId?: string;
  /** The caller's canonical content form (normalizeStoredHashSource). */
  normalize: (content: string) => string;
}): Promise<number> {
  const canonicalRecord = await args.sourceStorage
    .getMemoryByIdIncludingArchived(args.sourceMemoryId)
    .catch(() => null);
  const canonicalBody = canonicalRecord?.content;
  // Round N+13 (A): the guard's outcomes are "keep copies" and "retire
  // copies", so an unreadable canonical record MUST resolve to keep. A
  // failed re-read degrading to "" made every non-empty active copy compare
  // stale against normalize("") and superseded the whole copy set with no
  // confirmed replacement body to compare against. Abort the reconciliation
  // entirely; the next merge retries it.
  if (typeof canonicalBody !== "string" || canonicalBody.length === 0) {
    log.warn(
      `persistExtraction: merged-target promotion reconciliation aborted for ${args.sourceMemoryId} — the canonical record could not be read, so no copy is retired`,
    );
    return 0;
  }
  const canonicalForm = args.normalize(canonicalBody);
  // Round N+15 (A): the just-written copy is the supersession target only
  // while it still carries the canonical body. When the re-read record has
  // moved past the promoted body (a newer writer committed mid-flight), the
  // SOURCE target is the live canonical record and every stale copy — this
  // promotion's own included — supersedes onto it. The id exclusion the
  // filter used to carry is subsumed by the body compare: a copy carrying
  // the canonical body is never stale, whatever its id.
  const supersessionTarget =
    args.promotedContent !== undefined &&
    args.promotedMemoryId !== undefined &&
    args.normalize(args.promotedContent) === canonicalForm
      ? args.promotedMemoryId
      : args.sourceMemoryId;
  let retired = 0;
  for (const namespace of promotionScanNamespaces(args.config, args.scopeProfileWritePlan)) {
    try {
      const storage = await args.getStorageRouter().storageFor(namespace);
      if (storage.dir === args.sourceStorage.dir) continue;
      const active = await readActiveMemoriesBothTiers(storage);
      const stale = active.filter(
        (memory) =>
          memory.frontmatter.sourceMemoryId === args.sourceMemoryId &&
          (memory.frontmatter.status ?? "active") === "active" &&
          args.normalize(memory.content ?? "") !== canonicalForm,
      );
      for (const memory of stale) {
        const superseded = await storage.supersedeMemory(
          memory.frontmatter.id as string,
          supersessionTarget,
          "merged-target promotion reconciliation",
        );
        if (superseded) {
          retired++;
          log.warn(
            `persistExtraction: superseded stale promoted copy ${memory.frontmatter.id} of ${args.sourceMemoryId} — it carried the pre-merge body while ${supersessionTarget} serves the merged body`,
          );
        }
      }
    } catch (err) {
      log.warn(
        `persistExtraction: merged-target promotion reconciliation failed open for namespace "${namespace}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return retired;
}
