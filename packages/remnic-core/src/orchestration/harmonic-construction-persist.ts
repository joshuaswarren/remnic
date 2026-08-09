import {
  type HarmonicConstructionInput,
  deriveHarmonicRecords,
  harmonicEntityReferenceMatches,
  harmonicEntitySegment,
  normalizedHarmonicEntityIdentity,
  persistHarmonicRecords,
} from "../harmonic-construction.js";
import { log } from "../logger.js";
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
  for (const entry of options.entries) {
    try {
      const records = deriveHarmonicRecords({
        sessionKey,
        recordedAt,
        episodeTitle: options.episodeTitle,
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
