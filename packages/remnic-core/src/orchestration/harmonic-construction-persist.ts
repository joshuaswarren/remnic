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
import type { ExtractionResult } from "../types.js";

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
 * {@link persistConstructedHarmonicRecords} pass covers it. Duplicate ids
 * (two facts merging into one target in a batch) are safe: the constructor
 * dedupes sourceMemoryIds and both merges' claims are real batch output.
 */
export function enqueueMergedTargetForHarmonicConstruction(
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
): void {
  const entry = entries.get(storage.dir) ?? { storage, facts: [] };
  entry.facts.push({ ...fact, content, memoryId, insertedAt });
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
