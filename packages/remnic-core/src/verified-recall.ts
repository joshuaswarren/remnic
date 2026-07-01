import { BoxBuilder, type BoxFrontmatter } from "./boxes.js";
import { getCachedEpisodeMap, setCachedEpisodeMap } from "./memory-cache.js";
import { StorageManager } from "./storage.js";
import type { MemoryFile } from "./types.js";
import { countRecallTokenOverlap, normalizeRecallTokens } from "./recall-tokenization.js";

export interface VerifiedEpisodeResult {
  box: BoxFrontmatter;
  score: number;
  verifiedEpisodeCount: number;
  verifiedMemoryIds: string[];
  matchedFields: string[];
}

interface VerifiedEpisodeCandidate {
  box: BoxFrontmatter;
  score: number;
  matchedFields: Set<string>;
  verifiedMemories: MemoryFile[];
}

function createReadOnlyBoxBuilder(memoryDir: string): BoxBuilder {
  return new BoxBuilder(memoryDir, {
    memoryBoxesEnabled: true,
    traceWeaverEnabled: false,
    boxTopicShiftThreshold: 0.35,
    boxTimeGapMs: 30 * 60 * 1000,
    boxMaxMemories: 50,
    traceWeaverLookbackDays: 7,
    traceWeaverOverlapThreshold: 0.4,
  });
}

function scoreVerifiedEpisodeCandidate(box: BoxFrontmatter, verifiedMemories: MemoryFile[], queryTokens: Set<string>) {
  const matchedFields = new Set<string>();
  let score = 0;

  const topicMatches = countRecallTokenOverlap(queryTokens, box.topics.join(" "));
  if (topicMatches > 0) {
    score += topicMatches * 3;
    matchedFields.add("topics");
  }

  const goalMatches = countRecallTokenOverlap(queryTokens, box.goal);
  if (goalMatches > 0) {
    score += goalMatches * 4;
    matchedFields.add("goal");
  }

  const toolMatches = countRecallTokenOverlap(queryTokens, box.toolsUsed?.join(" "));
  if (toolMatches > 0) {
    score += toolMatches * 2;
    matchedFields.add("toolsUsed");
  }

  let episodeContentMatches = 0;
  for (const memory of verifiedMemories) {
    episodeContentMatches += countRecallTokenOverlap(queryTokens, memory.content);
  }
  if (episodeContentMatches > 0) {
    score += episodeContentMatches * 4;
    matchedFields.add("episodeContent");
  }

  return { score, matchedFields };
}

function resolveVerifiedEpisodeMemoriesFromMap(
  memoryById: ReadonlyMap<string, MemoryFile>,
  memoryIds: string[],
): MemoryFile[] {
  const verified: MemoryFile[] = [];
  for (const memoryId of memoryIds) {
    try {
      const memory = memoryById.get(memoryId);
      if (!memory) continue;
      if (memory.frontmatter.status === "archived" || memory.frontmatter.status === "forgotten") continue;
      if (memory.frontmatter.memoryKind !== "episode") continue;
      verified.push(memory);
    } catch {
      // fail-open: malformed or unreadable memories should not abort recall
    }
  }
  return verified;
}

export function compareVerifiedEpisodeResults(left: VerifiedEpisodeResult, right: VerifiedEpisodeResult): number {
  return (
    right.score - left.score ||
    right.verifiedEpisodeCount - left.verifiedEpisodeCount ||
    right.box.sealedAt.localeCompare(left.box.sealedAt) ||
    left.box.id.localeCompare(right.box.id)
  );
}

export async function searchVerifiedEpisodes(options: {
  memoryDir: string;
  query: string;
  maxResults: number;
  boxRecallDays?: number;
}): Promise<VerifiedEpisodeResult[]> {
  const queryTokens = new Set(normalizeRecallTokens(options.query, ["what", "which"]));
  if (queryTokens.size === 0 || options.maxResults <= 0) return [];

  const storage = new StorageManager(options.memoryDir);
  const version = storage.getMemoryStatusVersion();

  // Use derived episode cache to avoid O(146K) filter+map on every call.
  let verifiedMemoryById = getCachedEpisodeMap(storage.dir, version);
  if (!verifiedMemoryById) {
    const allMemories = await storage.readAllMemories();
    verifiedMemoryById = setCachedEpisodeMap(storage.dir, allMemories, version);
  }
  const boxes = await createReadOnlyBoxBuilder(options.memoryDir)
    .readRecentBoxes(Math.max(1, Math.floor(options.boxRecallDays ?? 3)))
    .catch(() => [] as BoxFrontmatter[]);

  const candidates: VerifiedEpisodeCandidate[] = [];
  for (const box of boxes) {
    const verifiedMemories = resolveVerifiedEpisodeMemoriesFromMap(verifiedMemoryById, box.memoryIds);
    if (verifiedMemories.length === 0) continue;
    const { score, matchedFields } = scoreVerifiedEpisodeCandidate(box, verifiedMemories, queryTokens);
    if (score <= 0) continue;
    candidates.push({
      box,
      score,
      matchedFields,
      verifiedMemories,
    });
  }

  return candidates
    .map((candidate) => ({
      box: candidate.box,
      score: candidate.score,
      verifiedEpisodeCount: candidate.verifiedMemories.length,
      verifiedMemoryIds: candidate.verifiedMemories.map((memory) => memory.frontmatter.id),
      matchedFields: [...candidate.matchedFields].sort(),
    }))
    .sort(compareVerifiedEpisodeResults)
    .slice(0, options.maxResults);
}
