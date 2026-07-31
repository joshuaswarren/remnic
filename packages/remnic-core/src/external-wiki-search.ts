import path from "node:path";
import type { CitationEntry } from "./citations.js";
import {
  type ExternalWikiCatalogEntry,
  type ExternalWikiRoot,
  loadExternalWikiCatalog,
  readExternalWikiPage,
} from "./external-wiki.js";

export type { ExternalWikiRoot } from "./external-wiki.js";

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
const DEFAULT_MAX_CHARS_PER_HIT = 1_000;
const MAX_CHARS_PER_HIT = 8_000;
const DEFAULT_MAX_CANDIDATE_FILES = 40;
const MAX_CANDIDATE_FILES = 100;

export interface ExternalWikiSearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly wikiId?: string;
  readonly maxCharsPerHit?: number;
}

interface ExternalWikiSnippet {
  readonly text: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface ExternalWikiSearchHit {
  readonly wikiId: string;
  readonly title: string;
  readonly path: string;
  readonly snippet: string;
  readonly score: number;
  readonly rank: number;
  readonly citations: readonly CitationEntry[];
  readonly indexBlurb?: string;
}

export interface ExternalWikiSearchResult {
  readonly query: string;
  readonly hits: readonly ExternalWikiSearchHit[];
  readonly count: number;
  readonly degradedWikiIds: readonly string[];
}

export interface ExternalWikiCandidate {
  readonly path: string;
  readonly score?: number;
}

export interface ExternalWikiCandidateProvider {
  search(root: ExternalWikiRoot, query: string, limit: number): Promise<readonly ExternalWikiCandidate[]>;
}

export interface ExternalWikiSearchOptions {
  readonly candidateProvider?: ExternalWikiCandidateProvider;
  readonly maxCandidateFiles?: number;
}

export class ExternalWikiSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalWikiSearchError";
  }
}

interface RankedCatalogEntry {
  readonly entry: ExternalWikiCatalogEntry;
  readonly catalogScore: number;
  readonly providerScore: number;
  readonly providerRank?: number;
}

interface UnrankedHit extends Omit<ExternalWikiSearchHit, "rank"> {}

export async function searchExternalWikis(
  roots: readonly ExternalWikiRoot[],
  input: ExternalWikiSearchInput,
  options: ExternalWikiSearchOptions = {}
): Promise<ExternalWikiSearchResult> {
  const query = requireQuery(input.query);
  const limit = boundedInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit");
  const maxCharsPerHit = boundedInteger(
    input.maxCharsPerHit,
    DEFAULT_MAX_CHARS_PER_HIT,
    1,
    MAX_CHARS_PER_HIT,
    "maxCharsPerHit"
  );
  const maxCandidateFiles = boundedInteger(
    options.maxCandidateFiles,
    DEFAULT_MAX_CANDIDATE_FILES,
    1,
    MAX_CANDIDATE_FILES,
    "maxCandidateFiles"
  );
  const selectedRoots = selectRoots(roots, input.wikiId);
  const queryTokens = tokenize(query);
  const degradedWikiIds = new Set<string>();
  const perRootHits = await Promise.all(
    selectedRoots.map(async (root) => {
      try {
        const catalog = await loadExternalWikiCatalog(root, { maxEntries: maxCandidateFiles });
        if (!catalog.indexPresent) degradedWikiIds.add(root.id);
        const candidates = await rankCandidates(
          root,
          catalog.entries,
          query,
          queryTokens,
          maxCandidateFiles,
          options.candidateProvider
        );
        return await readCandidateHits(root, candidates, query, queryTokens, maxCharsPerHit);
      } catch {
        degradedWikiIds.add(root.id);
        return [];
      }
    })
  );

  const hits = perRootHits
    .flat()
    .sort(compareHits)
    .slice(0, limit)
    .map((hit, index): ExternalWikiSearchHit => ({ ...hit, rank: index + 1 }));

  return {
    query,
    hits,
    count: hits.length,
    degradedWikiIds: [...degradedWikiIds].sort(),
  };
}

function requireQuery(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExternalWikiSearchError("external wiki search query is required");
  }
  return value.trim();
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new ExternalWikiSearchError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function selectRoots(roots: readonly ExternalWikiRoot[], wikiId: string | undefined): ExternalWikiRoot[] {
  const enabled = roots.filter((root) => root.enabled);
  if (enabled.length === 0) {
    throw new ExternalWikiSearchError("no enabled external wiki roots are configured");
  }
  if (wikiId === undefined) return enabled;
  const normalizedWikiId = wikiId.trim();
  const selected = enabled.find((root) => root.id === normalizedWikiId);
  if (!selected) {
    throw new ExternalWikiSearchError(`unknown external wiki: ${normalizedWikiId || "(empty)"}`);
  }
  return [selected];
}

async function rankCandidates(
  root: ExternalWikiRoot,
  entries: readonly ExternalWikiCatalogEntry[],
  query: string,
  queryTokens: readonly string[],
  maxCandidateFiles: number,
  provider: ExternalWikiCandidateProvider | undefined
): Promise<RankedCatalogEntry[]> {
  let provided: readonly ExternalWikiCandidate[] = [];
  if (provider) {
    try {
      provided = await provider.search(root, query, maxCandidateFiles);
    } catch {
      provided = [];
    }
  }

  const providerByPath = new Map<string, { score: number; rank: number }>();
  for (const [index, candidate] of provided.slice(0, maxCandidateFiles).entries()) {
    if (!providerByPath.has(candidate.path)) {
      providerByPath.set(candidate.path, { score: finiteScore(candidate.score), rank: index });
    }
  }

  return entries
    .map((entry): RankedCatalogEntry => {
      const providerCandidate = providerByPath.get(entry.path);
      return {
        entry,
        catalogScore: scoreCatalogEntry(entry, query, queryTokens),
        providerScore: providerCandidate?.score ?? 0,
        ...(providerCandidate ? { providerRank: providerCandidate.rank } : {}),
      };
    })
    .sort((left, right) => {
      const leftProvided = left.providerRank !== undefined;
      const rightProvided = right.providerRank !== undefined;
      if (leftProvided !== rightProvided) return leftProvided ? -1 : 1;
      if (left.providerRank !== right.providerRank) {
        return (left.providerRank ?? Number.MAX_SAFE_INTEGER) - (right.providerRank ?? Number.MAX_SAFE_INTEGER);
      }
      if (right.catalogScore !== left.catalogScore) return right.catalogScore - left.catalogScore;
      return left.entry.path.localeCompare(right.entry.path);
    })
    .slice(0, maxCandidateFiles);
}

async function readCandidateHits(
  root: ExternalWikiRoot,
  candidates: readonly RankedCatalogEntry[],
  query: string,
  queryTokens: readonly string[],
  maxCharsPerHit: number
): Promise<UnrankedHit[]> {
  const results = await Promise.all(
    candidates.map(async (candidate): Promise<UnrankedHit | undefined> => {
      try {
        const page = await readExternalWikiPage(root, candidate.entry.path);
        const pageScore = scorePage(page.title, page.content, query, queryTokens);
        const score = candidate.catalogScore + candidate.providerScore + pageScore;
        if (score <= 0) return undefined;
        const snippet = extractSnippet(page.content, queryTokens, maxCharsPerHit);
        const rootRelativePath = path.posix.join(root.pagesDir.replaceAll("\\", "/"), page.path);
        const citation: CitationEntry = {
          path: rootRelativePath,
          lineStart: snippet.lineStart,
          lineEnd: snippet.lineEnd,
          note: page.title,
        };
        return {
          wikiId: root.id,
          title: page.title,
          path: rootRelativePath,
          snippet: snippet.text,
          score: roundScore(score),
          citations: [citation],
          ...(candidate.entry.indexBlurb === undefined ? {} : { indexBlurb: candidate.entry.indexBlurb }),
        };
      } catch {
        return undefined;
      }
    })
  );
  return results.filter((result): result is UnrankedHit => result !== undefined);
}

function scoreCatalogEntry(entry: ExternalWikiCatalogEntry, query: string, queryTokens: readonly string[]): number {
  return (
    scoreText(entry.title, query, queryTokens, 16, 20) +
    scoreText(entry.path, query, queryTokens, 8, 8) +
    scoreText(entry.indexBlurb ?? "", query, queryTokens, 4, 6)
  );
}

function scorePage(title: string, content: string, query: string, queryTokens: readonly string[]): number {
  const titleScore = scoreText(title, query, queryTokens, 12, 16);
  const lines = content.split(/\r?\n/u);
  let bestLineScore = 0;
  const matchedTokens = new Set<string>();
  for (const line of lines) {
    const normalizedLine = line.toLocaleLowerCase();
    let lineScore = 0;
    for (const token of queryTokens) {
      if (!normalizedLine.includes(token)) continue;
      matchedTokens.add(token);
      lineScore += line.startsWith("#") ? 6 : 3;
    }
    if (normalizedLine.includes(query.toLocaleLowerCase())) lineScore += 10;
    bestLineScore = Math.max(bestLineScore, lineScore);
  }
  return titleScore + bestLineScore + matchedTokens.size * 2;
}

function scoreText(
  value: string,
  query: string,
  queryTokens: readonly string[],
  tokenWeight: number,
  phraseWeight: number
): number {
  const normalized = value.toLocaleLowerCase();
  let score = normalized.includes(query.toLocaleLowerCase()) ? phraseWeight : 0;
  for (const token of queryTokens) {
    if (normalized.includes(token)) score += tokenWeight;
  }
  return score;
}

function tokenize(value: string): string[] {
  const tokens = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)];
}

function extractSnippet(content: string, queryTokens: readonly string[], maxChars: number): ExternalWikiSnippet {
  const lines = content.split(/\r?\n/u);
  if (lines.length === 0) return { text: "", lineStart: 1, lineEnd: 1 };
  let bestIndex = 0;
  let bestScore = -1;
  for (const [index, line] of lines.entries()) {
    const normalized = line.toLocaleLowerCase();
    const matchCount = queryTokens.reduce((sum, token) => sum + (normalized.includes(token) ? 1 : 0), 0);
    const score = matchCount * 2 + (matchCount > 0 && !/^#{1,6}\s/u.test(line) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  let headingIndex = bestIndex;
  while (headingIndex > 0 && !/^#{1,6}\s/u.test(lines[headingIndex] ?? "")) headingIndex -= 1;
  const bodyStart = Math.max(0, bestIndex - 1);
  const endExclusive = Math.min(lines.length, bestIndex + 3);
  const start = headingIndex < bodyStart ? headingIndex : bodyStart;
  const selected =
    headingIndex < bodyStart
      ? [lines[headingIndex] ?? "", ...lines.slice(bodyStart, endExclusive)]
      : lines.slice(start, endExclusive);
  const snippet = selected.join("\n").trim();
  if (snippet.length <= maxChars) {
    return { text: snippet, lineStart: start + 1, lineEnd: endExclusive };
  }

  const normalizedSnippet = snippet.toLocaleLowerCase();
  const firstMatch =
    queryTokens
      .map((token) => normalizedSnippet.indexOf(token))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? 0;
  const windowStart = Math.max(0, Math.min(firstMatch - Math.floor(maxChars / 3), snippet.length - maxChars));
  return {
    text: snippet.slice(windowStart, windowStart + maxChars).trim(),
    lineStart: start + 1,
    lineEnd: endExclusive,
  };
}

function finiteScore(score: number | undefined): number {
  return typeof score === "number" && Number.isFinite(score) ? Math.max(0, score) : 0;
}

function roundScore(score: number): number {
  return Math.round(score * 1_000) / 1_000;
}

function compareHits(left: UnrankedHit, right: UnrankedHit): number {
  if (right.score !== left.score) return right.score - left.score;
  const wikiComparison = left.wikiId.localeCompare(right.wikiId);
  return wikiComparison !== 0 ? wikiComparison : left.path.localeCompare(right.path);
}
