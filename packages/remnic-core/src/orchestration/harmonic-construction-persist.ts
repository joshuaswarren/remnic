import {
  type HarmonicConstructionInput,
  deriveHarmonicRecords,
  harmonicEntityReferenceMatches,
  harmonicEntitySegment,
  normalizedHarmonicEntityIdentity,
  persistHarmonicRecords,
} from "../harmonic-construction.js";
import { log } from "../logger.js";
import type { StorageManager } from "../index.js";
import type { MemoryFile, ExtractionResult } from "../types.js";

export interface HarmonicPersistenceEntry {
  storage: { dir: string };
  facts: HarmonicConstructionInput["persistedFacts"];
}

export function filterHarmonicEntityMentions(
  facts: HarmonicConstructionInput["persistedFacts"],
  entityMentions: ExtractionResult["entities"]
): ExtractionResult["entities"] {
  const identitiesBySegment = new Map<string, Set<string>>();
  for (const entity of entityMentions) {
    const segment = harmonicEntitySegment(entity.name);
    const identities = identitiesBySegment.get(segment) ?? new Set<string>();
    identities.add(normalizedHarmonicEntityIdentity(entity.name));
    identitiesBySegment.set(segment, identities);
  }
  return entityMentions.flatMap((entity) => {
    const allowSegmentFallback = identitiesBySegment.get(harmonicEntitySegment(entity.name))?.size === 1;
    const activeFacts = facts.filter(
      (fact) =>
        typeof fact.entityRef === "string" &&
        harmonicEntityReferenceMatches(fact.entityRef, entity.name, allowSegmentFallback)
    );
    return activeFacts.length > 0 ? [{ ...entity, facts: activeFacts.map((fact) => fact.content) }] : [];
  });
}

/**
 * Finding B (round N+3, PR #2771): a successful merge-on-write commits new
 * claims into an EXISTING target id. `persistedIds` stays new-fragment only
 * by contract and cue anchors ride only through the per-fact harmonic
 * entry, so without this enqueue a merge-only extraction emits no episode,
 * abstraction node, or cue anchors for the committed claims. Enqueue the
 * surviving target — with the COMMITTED merged body as content — into the
 * same batch map the create path feeds, so the end-of-batch
 * {@link persistConstructedHarmonicRecords} pass covers it.
 *
 * Round N+9 (C): two facts merging into the SAME target in one batch enqueue
 * twice under one `memoryId`. `deriveHarmonicRecords` dedupes only
 * `sourceMemoryIds` — `persistedFacts` keeps both entries, so the episode
 * summary concatenated both cumulative snapshots and the inserted-at
 * metadata overwrote its duplicate key. Coalesce instead: the entry for a
 * repeated target is REPLACED by the latest committed body (each merge's
 * body is cumulative, so the latest carries every claim) while the cue
 * anchors UNION across merges — anchors are deduped by id downstream, but
 * the union keeps the earlier merge's anchors alive when the later incoming
 * fact carried none.
 *
 * #2807 (finding 3): the entry's metadata comes from the REREAD committed
 * target, never the incoming fact alone. The parity gate lets an incoming
 * fact with no entityRef merge into a target that HAS one (only a
 * differing non-undefined incoming entity refuses), and incoming tags are
 * a subset of the target's — so stamping the incoming fields onto the
 * cumulative body dropped the target's committed entity association and
 * extra tags, and `deriveHarmonicRecords` skipped the deterministic
 * entity cue/topic linkage for the merged claims. Cue anchors stay
 * incoming-only: they are event-specific. An unreadable or advanced record
 * falls back to the incoming fact's own fields (fail-open, like every
 * merge-adjacent effect).
 */
export async function enqueueMergedTargetForHarmonicConstruction(
  entries: Map<
    string,
    { storage: StorageManager; facts: HarmonicConstructionInput["persistedFacts"] }
  >,
  storage: StorageManager,
  fact: Omit<
    HarmonicConstructionInput["persistedFacts"][number],
    "memoryId" | "insertedAt"
  >,
  memoryId: string,
  content: string,
  insertedAt: string,
): Promise<void> {
  let committed: MemoryFile | null = null;
  try {
    committed = await storage.getMemoryByIdIncludingArchived(memoryId);
  } catch {
    committed = null;
  }
  const derived =
    committed && committed.content === content
      ? {
          ...fact,
          category: committed.frontmatter.category,
          tags: [...new Set([...(committed.frontmatter.tags ?? []), ...fact.tags])],
          entityRef: committed.frontmatter.entityRef ?? fact.entityRef,
          validAt: committed.frontmatter.valid_at ?? fact.validAt,
        }
      : fact;
  const entry = entries.get(storage.dir) ?? { storage, facts: [] };
  const prior = entry.facts.findIndex((existing) => existing.memoryId === memoryId);
  if (prior !== -1) {
    entry.facts[prior] = {
      ...derived,
      content,
      memoryId,
      insertedAt,
      cueAnchors: [
        ...(entry.facts[prior]!.cueAnchors ?? []),
        ...(derived.cueAnchors ?? []),
      ],
    };
  } else {
    entry.facts.push({ ...derived, content, memoryId, insertedAt });
  }
  entries.set(storage.dir, entry);
}

export async function persistConstructedHarmonicRecords(options: {
  entries: Iterable<HarmonicPersistenceEntry>;
  baseStorageDir: string;
  abstractionNodeStoreDir?: string;
  sessionKey?: string;
  validAt?: string;
  episodeTitle?: string;
  anchorsEnabled: boolean;
  entityMentions: ExtractionResult["entities"];
}): Promise<void> {
  const sessionKey = options.sessionKey?.trim();
  if (!sessionKey) {
    log.warn("harmonic construction skipped: extraction session key is missing");
    return;
  }
  const recordedAt =
    options.validAt && Number.isFinite(Date.parse(options.validAt))
      ? new Date(options.validAt).toISOString()
      : new Date().toISOString();
  const entries = [...options.entries];
  const sharedEpisodeTitle = entries.length === 1 ? options.episodeTitle : undefined;
  for (const entry of entries) {
    try {
      const records = deriveHarmonicRecords({
        sessionKey,
        recordedAt,
        episodeTitle: sharedEpisodeTitle,
        persistedFacts: entry.facts,
        entityMentions: filterHarmonicEntityMentions(entry.facts, options.entityMentions).map((entity) => ({
          name: entity.name,
          type: entity.type,
          facts: entity.facts,
        })),
      });
      await persistHarmonicRecords({
        memoryDir: entry.storage.dir,
        abstractionNodeStoreDir:
          entry.storage.dir === options.baseStorageDir ? options.abstractionNodeStoreDir : undefined,
        nodes: records.nodes,
        anchors: options.anchorsEnabled ? records.anchors : [],
      });
    } catch (error) {
      log.warn(
        `harmonic construction failed open for namespace ${entry.storage.dir}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
