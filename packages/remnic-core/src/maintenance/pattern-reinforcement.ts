
import { clusterByKey } from "../procedural/reinforcement-core.js";
import { buildRetiredFactTombstoneInputs, type TombstoneReason, type TombstoneCreatedBy } from "../lifecycle/tombstones.js";
import { supersessionKeysForFact } from "../temporal-supersession.js";
import { excludeSupportPassportPrivateMemories } from "../support-passport/card-projection.js";
import type {
  MemoryFile,
  MemoryFrontmatter,
  MemoryStatus,
} from "../types.js";

/**
 * Storage surface the job needs.  Defined as a structural interface so
 * tests can pass an in-memory stub without booting a full
 * `StorageManager` (mirrors the pattern in `forget.ts`).
 */
export interface PatternReinforcementStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  writeMemoryFrontmatter(
    memory: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
  ): Promise<boolean>;
  /**
   * Best-effort tombstone append for retired duplicates (issue #1579 thread
   * Oblq9). Optional so unit-test stubs need not implement it; the production
   * StorageManager satisfies it via its appendTombstone chokepoint.
   */
  appendTombstone?(input: {
    reason: TombstoneReason;
    createdBy: TombstoneCreatedBy;
    sourceMemoryId: string;
    contentHash?: string;
    rawContent: string;
    entityRef?: string;
    supersessionKey?: string;
    createdAt: string;
  }): Promise<string | null>;
}

export interface PatternReinforcementOptions {
  /** Categories the job considers (e.g. ["preference", "fact", "decision"]). */
  categories: readonly string[];
  minCount: number;
  /** ISO 8601 timestamp source.  Defaults to `Date.now()`. */
  now?: () => Date;
}

export interface PatternReinforcementClusterResult {
  canonicalId: string;
  /** Cluster size at run time (mirrors `reinforcement_count`). */
  count: number;
  sourceIds: readonly string[];
  supersededIds: readonly string[];
  /**
   * `true` when the canonical's `reinforcement_count` actually
   * changed during this run.  False when the job converged
   * idempotently (same cluster size as the previous run).
   */
  reinforcementBumped: boolean;
}

export interface PatternReinforcementResult {
  /** Number of clusters that met the `minCount` threshold. */
  clustersFound: number;
  canonicalsUpdated: number;
  duplicatesSuperseded: number;
  /** Per-cluster details for tests / observability. */
  clusters: PatternReinforcementClusterResult[];
}

/**
 * Cluster key derivation: lowercase + collapse whitespace + truncate to
 * 200 chars.  Pure helper so callers and tests can compute the same key
 * without re-implementing the rule.
 *
 * Truncation is intentional — long-form content with a stable opening
 * still clusters together even when the tail differs slightly.  200
 * chars matches the spec.
 *
 * @deprecated Prefer `patternReinforcementClusterKey(category, content)`
 * which partitions by memory category so identical text in different
 * categories does not get cross-superseded (PR #730 review feedback,
 * Codex P2).  This bare helper is kept exported for backward
 * compatibility with callers that already partition by category
 * upstream.
 */
export function patternReinforcementKey(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

export function patternReinforcementClusterKey(category: string, content: string): string {
  return `${category}::${patternReinforcementKey(content)}`;
}

function pickCanonical(memories: MemoryFile[]): MemoryFile {
  let best = memories[0];
  let bestInstant = memoryInstant(best);
  let bestStamp = memoryStamp(best);
  for (let i = 1; i < memories.length; i += 1) {
    const candidate = memories[i];
    const instant = memoryInstant(candidate);
    const stamp = memoryStamp(candidate);
    let cmp: number;
    if (instant !== null && bestInstant !== null) {
      cmp = instant - bestInstant;
    } else {
      cmp = stamp.localeCompare(bestStamp);
    }
    if (cmp > 0 || (cmp === 0 && candidate.frontmatter.id > best.frontmatter.id)) {
      best = candidate;
      bestInstant = instant;
      bestStamp = stamp;
    }
  }
  return best;
}

function memoryStamp(memory: MemoryFile): string {
  // Prefer `updated`, fall back to `created`.  Both are ISO-8601 and
  // present on every well-formed memory; the parser default-fills them
  // when absent.
  return memory.frontmatter.updated || memory.frontmatter.created || "";
}

/**
 * Parse a memory's effective timestamp to epoch milliseconds.  Returns
 * `null` for an unparseable / empty stamp so callers can fall back to
 * a string compare without observing `NaN` propagation.
 */
function memoryInstant(memory: MemoryFile): number | null {
  const stamp = memoryStamp(memory);
  if (stamp.length === 0) return null;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}

const ACTIVE_STATUS: MemoryStatus = "active";

/**
 * Run pattern reinforcement across the configured categories.
 *
 * The function is intentionally pure (modulo the storage handle): no
 * cron scheduling, no telemetry side effects, no logging.  Callers
 * (orchestrator cron path / CLI surface in PR 4) own those concerns.
 */
export async function runPatternReinforcement(
  storage: PatternReinforcementStorage,
  options: PatternReinforcementOptions,
): Promise<PatternReinforcementResult> {
  const minCount = Math.max(2, Math.floor(options.minCount));
  const targetCategories = new Set(options.categories);
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();

  if (targetCategories.size === 0) {
    return emptyResult();
  }

  const memories = excludeSupportPassportPrivateMemories(await storage.readAllMemories());

  const eligible = memories.filter((m) => {
    if (!targetCategories.has(m.frontmatter.category)) return false;
    const status = m.frontmatter.status ?? ACTIVE_STATUS;
    return status === ACTIVE_STATUS || status === "superseded";
  });

  if (eligible.length === 0) return emptyResult();

  const clusters = clusterByKey(eligible, (m) =>
    patternReinforcementClusterKey(m.frontmatter.category, m.content),
  );

  const result: PatternReinforcementResult = {
    clustersFound: 0,
    canonicalsUpdated: 0,
    duplicatesSuperseded: 0,
    clusters: [],
  };

  for (const cluster of clusters.values()) {
    if (cluster.length < minCount) continue;

    const activeMembers = cluster.filter((m) => {
      const status = m.frontmatter.status ?? ACTIVE_STATUS;
      return status === ACTIVE_STATUS;
    });
    if (activeMembers.length === 0) continue;

    result.clustersFound += 1;

    const canonical = pickCanonical(activeMembers);
    const activeDuplicates = activeMembers.filter((m) => m !== canonical);

    const sourceIds = [...cluster]
      .map((m) => m.frontmatter.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();

    const previousCount = canonical.frontmatter.reinforcement_count ?? 0;
    const newCount = sourceIds.length;
    const reinforcementBumped = newCount > previousCount;

    const previousDerivedFrom = Array.isArray(canonical.frontmatter.derived_from)
      ? [...canonical.frontmatter.derived_from].sort()
      : [];
    const sortedSourceIds = [...sourceIds].sort();
    const membershipChanged =
      previousDerivedFrom.length !== sortedSourceIds.length ||
      previousDerivedFrom.some((id, i) => id !== sortedSourceIds[i]);
    const previousVia = canonical.frontmatter.derived_via;
    const viaChanged = previousVia !== "pattern-reinforcement";
    const canonicalNeedsRefresh =
      reinforcementBumped || membershipChanged || viaChanged;

    if (canonicalNeedsRefresh) {
      const patch: Partial<MemoryFrontmatter> = {
        derived_from: sourceIds,
        derived_via: "pattern-reinforcement",
        updated: nowIso,
      };
      if (reinforcementBumped) {
        patch.reinforcement_count = newCount;
        patch.last_reinforced_at = nowIso;
      } else {
        patch.reinforcement_count =
          canonical.frontmatter.reinforcement_count ?? newCount;
        patch.last_reinforced_at =
          canonical.frontmatter.last_reinforced_at ?? nowIso;
      }
      await storage.writeMemoryFrontmatter(canonical, patch);
      result.canonicalsUpdated += 1;
    }

    const supersededIds: string[] = [];
    for (const dup of activeDuplicates) {
      const patch: Partial<MemoryFrontmatter> = {
        status: "superseded",
        supersededBy: canonical.frontmatter.id,
        supersededAt: nowIso,
        updated: nowIso,
      };
      await storage.writeMemoryFrontmatter(dup, patch);
      supersededIds.push(dup.frontmatter.id);
      result.duplicatesSuperseded += 1;
      if (storage.appendTombstone) {
        for (const input of buildRetiredFactTombstoneInputs(
          {
            id: dup.frontmatter.id,
            content: dup.content,
            contentHash: dup.frontmatter.contentHash,
            entityRef: dup.frontmatter.entityRef,
            structuredAttributes: dup.frontmatter.structuredAttributes,
          },
          { reason: "supersession", createdBy: "supersession", createdAt: nowIso, supersessionKeysForFact },
        )) {
          try {
            await storage.appendTombstone(input);
          } catch {
            // Best-effort: a tombstone append failure must not fail the
            // reinforcement job (gotcha #13 / rule 34 spirit).
          }
        }
      }
    }

    result.clusters.push({
      canonicalId: canonical.frontmatter.id,
      count: newCount,
      sourceIds,
      supersededIds,
      reinforcementBumped,
    });
  }

  return result;
}

function emptyResult(): PatternReinforcementResult {
  return {
    clustersFound: 0,
    canonicalsUpdated: 0,
    duplicatesSuperseded: 0,
    clusters: [],
  };
}
