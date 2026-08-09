import type { MemoryFile } from "../types.js";
export interface UpdateLocalizationStorage {
  readAllMemories(): Promise<MemoryFile[]>;
}
import { lookupAttributeByNormalizedKey } from "../temporal-supersession.js";

export interface UpdateAnchor {
  entityRef?: string;
  category: string;
  attributes?: Record<string, string>;
}

export interface UpdateLocalizationSearchHit {
  id: string;
  content: string;
  category: string;
  score: number;
}

export interface LocalizedCandidate {
  id: string;
  content: string;
  category: string;
  source: "anchor" | "search";
  score: number;
}

export interface UpdateLocalizationOptions {
  anchorCandidates: number;
  searchCandidates: number;
  maxCandidates: number;
}

export interface UpdateLocalizationDeps {
  storage: UpdateLocalizationStorage;
  qmdSearch: (query: string, limit: number) => Promise<UpdateLocalizationSearchHit[]>;
}

function cap(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function compareCandidates(left: LocalizedCandidate, right: LocalizedCandidate): number {
  const leftScore = Number.isFinite(left.score) ? left.score : Number.NEGATIVE_INFINITY;
  const rightScore = Number.isFinite(right.score) ? right.score : Number.NEGATIVE_INFINITY;
  if (leftScore !== rightScore) return rightScore - leftScore;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function anchorScore(memory: MemoryFile, anchor: UpdateAnchor): number {
  const attributes = anchor.attributes;
  if (attributes && Object.keys(attributes).length > 0) {
    const candidateAttributes = memory.frontmatter.structuredAttributes;
    if (!candidateAttributes) return 0;
    let overlap = 0;
    for (const key of Object.keys(attributes)) {
      if (lookupAttributeByNormalizedKey(candidateAttributes, key) !== undefined) overlap++;
    }
    return overlap;
  }

  const created = Date.parse(memory.frontmatter.created);
  return Number.isFinite(created) ? created : 0;
}

function toAnchorCandidate(memory: MemoryFile, anchor: UpdateAnchor): LocalizedCandidate {
  return {
    id: memory.frontmatter.id,
    content: memory.content,
    category: memory.frontmatter.category,
    source: "anchor",
    score: anchorScore(memory, anchor),
  };
}

export async function localizeUpdateCandidates(
  deps: UpdateLocalizationDeps,
  anchor: UpdateAnchor,
  newContent: string,
  options: UpdateLocalizationOptions,
): Promise<LocalizedCandidate[]> {
  const maxCandidates = cap(options.maxCandidates);
  if (maxCandidates === 0) return [];

  const anchorLimit = cap(options.anchorCandidates);
  const searchLimit = cap(options.searchCandidates);
  const anchorCandidates: LocalizedCandidate[] = [];

  if (anchor.entityRef && anchorLimit > 0) {
    const memories = await deps.storage.readAllMemories();
    for (const memory of memories) {
      if (memory.frontmatter.status !== "active") continue;
      if (memory.frontmatter.entityRef !== anchor.entityRef) continue;
      if (memory.frontmatter.category !== anchor.category) continue;
      anchorCandidates.push(toAnchorCandidate(memory, anchor));
    }
    anchorCandidates.sort(compareCandidates);
    anchorCandidates.splice(anchorLimit);
  }

  const searchCandidates: LocalizedCandidate[] = [];
  if (searchLimit > 0) {
    const searchHits = await deps.qmdSearch(newContent, searchLimit);
    for (const hit of searchHits) {
      searchCandidates.push({
        id: hit.id,
        content: hit.content,
        category: hit.category,
        source: "search",
        score: hit.score,
      });
    }
    searchCandidates.sort(compareCandidates);
    searchCandidates.splice(searchLimit);
  }

  const merged: LocalizedCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...anchorCandidates, ...searchCandidates]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    merged.push(candidate);
    if (merged.length >= maxCandidates) break;
  }
  return merged;
}
