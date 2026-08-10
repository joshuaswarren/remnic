import type { MemoryFile } from "../types.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { lookupAttributeByNormalizedKey, normalizeSupersessionKey } from "../temporal-supersession.js";

export interface UpdateLocalizationStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  readAllColdMemories?: () => Promise<MemoryFile[]>;
}

export function mergeMemorySnapshots(hot: MemoryFile[], cold: MemoryFile[]): MemoryFile[] {
  const merged: MemoryFile[] = [];
  const indexById = new Map<string, number>();
  for (const memory of [...hot, ...cold]) {
    const id = memory.frontmatter.id;
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, merged.length);
      merged.push(memory);
      continue;
    }
    const existing = merged[existingIndex];
    if (
      !isActiveMemoryStatus(existing.frontmatter.status) &&
      isActiveMemoryStatus(memory.frontmatter.status)
    ) {
      merged[existingIndex] = memory;
    }
  }
  return merged;
}

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

function normalizeEntityRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeSupersessionKey(value);
  return normalized.length > 0 ? normalized : undefined;
}

function compareCandidates(left: LocalizedCandidate, right: LocalizedCandidate): number {
  const leftScore = Number.isFinite(left.score) ? left.score : Number.NEGATIVE_INFINITY;
  const rightScore = Number.isFinite(right.score) ? right.score : Number.NEGATIVE_INFINITY;
  if (leftScore !== rightScore) return leftScore > rightScore ? -1 : 1;
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
  const normalizedAnchorEntityRef = normalizeEntityRef(anchor.entityRef);
  if (normalizedAnchorEntityRef !== undefined && anchorLimit > 0) {
    const hot = await deps.storage.readAllMemories();
    const cold = deps.storage.readAllColdMemories ? await deps.storage.readAllColdMemories() : [];
    const memories = mergeMemorySnapshots(hot, cold);
    for (const memory of memories) {
      if (!isActiveMemoryStatus(memory.frontmatter.status)) continue;
      const normalizedCandidateEntityRef = normalizeEntityRef(memory.frontmatter.entityRef);
      if (normalizedCandidateEntityRef !== normalizedAnchorEntityRef) continue;
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
