import { resolveNamespaceCapabilities } from "./capabilities.js";
import { createHash } from "node:crypto";
import { sanitizeMemoryContent } from "./sanitize.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectNativeKnowledgeChunks, type NativeKnowledgeChunk } from "./native-knowledge.js";
import { compareEntityTimestamps, normalizeEntityName, type StorageManager } from "./storage.js";
import { normalizeEntityText, resolveRequestedEntitySectionKeys } from "./entity-schema.js";
import type { EntityStructuredSection, MemoryFile, PluginConfig, TranscriptEntry } from "./types.js";
import { containsPhrase } from "./entity-retrieval-boundaries.js";
import { throwIfAborted } from "./abort-error.js";

const ENTITY_INDEX_VERSION = 3;
const RECENT_TRANSCRIPT_LOOKBACK_HOURS = 24;
const INSTRUCTION_LIKE_RE = /\b(always|never|must|should|remember to|do not|don't|process|workflow|template|checklist|instruction)\b/i;
const METADATA_WRAPPER_RE = /^(source|context|metadata|notes?):/i;
const ENTITY_PRONOUN_RE = /\b(he|him|his|she|her|they|them|their|it|its)\b/i;
const BELIEF_LEDGER_SECTION_KEY = "belief_ledger";
const BELIEF_LEDGER_FACT_RE = /^claim=([^;]+);\s*status=([^;]+);\s*updatedAt=([^;]+);\s*(.+)$/;

type EntityQueryMode = "direct" | "timeline" | "follow_up";

type EntityMentionIndexEntry = {
  canonicalId: string;
  name: string;
  type: string;
  aliases: string[];
  summary?: string;
  facts: string[];
  timelineFacts: string[];
  structuredSections: EntityStructuredSection[];
  timeline: Array<{
    timestamp: string;
    text: string;
    source?: string;
    sessionKey?: string;
    principal?: string;
  }>;
  relationships: Array<{ target: string; label: string }>;
  activity: Array<{ date: string; note: string }>;
  factCount: number;
  memorySnippets: string[];
  nativeChunks: Array<{
    chunkId: string;
    title: string;
    sourceKind: NativeKnowledgeChunk["sourceKind"];
    sourcePath: string;
    snippet: string;
    derivedDate?: string;
  }>;
};

type EntityMentionIndex = {
  version: number;
  updatedAt: string;
  entityStatusVersion?: number;
  entities: EntityMentionIndexEntry[];
};

type EntityCandidate = {
  entry: EntityMentionIndexEntry;
  alias: string;
  score: number;
  source: "query" | "recent_turn";
};

type EntityHintSnippet = {
  text: string;
  score: number;
  kind: "summary" | "fact" | "section" | "relationship" | "activity" | "memory" | "native";
};

export interface BuildEntityRecallSectionOptions {
  config: PluginConfig;
  storage: StorageManager;
  namespaceStorage?: (namespace: string) => Promise<StorageManager>;
  query: string;
  recallNamespaces?: string[];
  recentTurns: number;
  maxHints: number;
  maxSupportingFacts: number;
  maxRelatedEntities: number;
  maxChars: number;
  transcriptEntries: TranscriptEntry[];
  /**
   * Cancels the build at its next checkpoint (issue #2291).  Entity recall reads
   * every entity and memory file across the recalled namespaces, which is
   * minutes of work on a large or slow store; without this the scan kept running
   * after the recall that asked for it had been abandoned.
   */
  abortSignal?: AbortSignal;
}

function tokenize(value: string): string[] {
  return normalizeEntityText(value).split(/\s+/).filter((token) => token.length >= 2);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function compactLine(value: string, maxLength: number = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function dedupeHintSnippetsByText(snippets: EntityHintSnippet[]): EntityHintSnippet[] {
  const seen = new Set<string>();
  const result: EntityHintSnippet[] = [];
  for (const snippet of snippets) {
    const key = normalizeEntityText(snippet.text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(snippet);
  }
  return result;
}

function isBeliefLedgerSection(section: Pick<EntityStructuredSection, "key">): boolean {
  return normalizeEntityText(section.key).replace(/\s+/g, "_") === BELIEF_LEDGER_SECTION_KEY;
}

function beliefLedgerFactKeys(sections: EntityStructuredSection[]): Set<string> {
  const keys = new Set<string>();
  for (const section of sections) {
    if (!isBeliefLedgerSection(section)) continue;
    for (const fact of section.facts) {
      keys.add(normalizeEntityText(fact));
    }
  }
  return keys;
}

function recallFactsForStructuredSection(section: EntityStructuredSection): string[] {
  if (!isBeliefLedgerSection(section)) return section.facts;
  return currentActiveBeliefLedgerFactTexts(section.facts);
}

function currentActiveBeliefLedgerFactTexts(facts: string[]): string[] {
  const byClaim = new Map<string, { status: string; updatedAtMs: number; texts: string[] }>();
  for (const fact of facts) {
    const match = BELIEF_LEDGER_FACT_RE.exec(fact.trim());
    if (!match) continue;
    const [, claimId, status, updatedAt, text] = match;
    const updatedAtMs = Date.parse(updatedAt);
    if (!claimId?.trim() || !status?.trim() || !Number.isFinite(updatedAtMs) || !text?.trim()) continue;
    const normalizedStatus = status.trim().toLowerCase();
    const normalizedClaimId = claimId.trim();
    const current = byClaim.get(normalizedClaimId);
    const inactiveTieWins =
      current &&
      updatedAtMs === current.updatedAtMs &&
      current.status === "active" &&
      normalizedStatus !== "active";
    if (!current || updatedAtMs > current.updatedAtMs || inactiveTieWins) {
      byClaim.set(normalizedClaimId, { status: normalizedStatus, updatedAtMs, texts: [text.trim()] });
      continue;
    }
    if (updatedAtMs === current.updatedAtMs && current.status === normalizedStatus) {
      current.texts.push(text.trim());
    }
  }
  const result: string[] = [];
  for (const current of byClaim.values()) {
    if (current.status === "active") {
      result.push(...current.texts);
    }
  }
  return result;
}

function relationLine(entry: EntityMentionIndexEntry, relationship: { target: string; label: string }): string {
  const normalizedLabel = relationship.label.replace(/\s+/g, " ").trim();
  if (normalizedLabel.length === 0) return `${entry.name} is connected to ${relationship.target}`;
  return `${entry.name} ${normalizedLabel} ${relationship.target}`;
}

function detectEntityQueryMode(query: string): EntityQueryMode | null {
  const normalized = normalizeEntityText(query);
  if (!normalized) return null;
  if (
    /^(what about|and what about|how about|what happened (with|to) (he|him|his|she|her|they|them|their|it|its)|did (he|she|they|it)|is (he|she|they|it)|was (he|she|they|it))\b/.test(normalized)
  ) {
    return "follow_up";
  }
  if (
    /^(who is|who s|what do we know about|what does|tell me about|what can you tell me about|what s new with|what happened with|what happened to|status of|where is|how is)\b/.test(normalized)
  ) {
    if (/^what does\b/.test(normalized)) {
      if (/^what does (?:this|that|it|the|a|an|my|our|your|their)\b/.test(normalized)) {
        return null;
      }
      if (
        /^what does [a-z0-9-]+ (?:error|warning|exception|failure|stack|trace|code|message|log)\b/.test(normalized)
        && /\b(mean|means|indicate|indicates|imply|implies)\b/.test(normalized)
      ) {
        return null;
      }
    }
    return /what happened|what s new|status of|how is|where is/.test(normalized) ? "timeline" : "direct";
  }
  if (ENTITY_PRONOUN_RE.test(normalized) && normalized.split(/\s+/).length <= 8) {
    return "follow_up";
  }
  return null;
}

function scoreAliasMatch(query: string, alias: string): number {
  const normalizedQuery = normalizeEntityText(query);
  const normalizedAlias = normalizeEntityText(alias);
  if (!normalizedAlias) return 0;
  if (normalizedQuery === normalizedAlias) return 10;
  if (containsPhrase(normalizedQuery, normalizedAlias)) return 8 + Math.min(normalizedAlias.split(/\s+/).length, 3);
  const queryTokens = new Set(tokenize(normalizedQuery));
  const aliasTokens = tokenize(normalizedAlias);
  if (aliasTokens.length === 0) return 0;
  const overlap = aliasTokens.filter((token) => queryTokens.has(token)).length;
  if (overlap === 0) return 0;
  // Cross-entity contamination guard (#682 PR 2/3 R-2). For multi-token
  // aliases, partial-token overlap that hits ONLY shared common tokens
  // (like "person" in "Person-A1" / "Person-B1") would surface every
  // similarly-prefixed entity for a query that named only one. Require
  // that the overlap include at least one DISTINCTIVE alias token —
  // i.e. a token that does not also appear in any other entity's
  // alias-token vocabulary. Since this function is pure / per-pair, we
  // approximate "distinctive" by requiring the overlap to include at
  // least one token that is not a substring-of common identifier
  // affixes. The aliasTokens with length > 1 must contribute at least
  // one non-affix overlap. "Alice Example" (["alice", "example"])
  // matched by query "Tell me about Alice" → overlap = 1 on "alice",
  // and "alice" is not an affix → score = 1. "Person-A1" tokens
  // ["person", "a1"] matched by query "Who is Person-B1?" → overlap =
  // 1 on "person", and "person" IS an affix → score = 0.
  if (aliasTokens.length > 1) {
    const nonAffixOverlap = aliasTokens.filter(
      (token) => queryTokens.has(token) && !isAliasAffixToken(token),
    ).length;
    if (nonAffixOverlap === 0) return 0;
  }
  return overlap;
}

/**
 * Tokens that look like type prefixes / generic role identifiers and
 * therefore should not, on their own, count as evidence that a
 * multi-token alias matches a query (#682 PR 2/3 R-2).
 *
 * Kept as a small explicit list rather than a regex so additions are
 * deliberate. The list mirrors the entity types listed in
 * `entity-schema.ts` plus the most common generic role identifiers
 * that frequently appear as the leading token of a display name.
 */
const ALIAS_AFFIX_TOKENS = new Set<string>([
  "person", "people", "user", "users", "team", "teams",
  "project", "projects", "topic", "topics",
  "org", "orgs", "organization", "organizations", "company", "companies",
  "place", "places", "tool", "tools", "service", "services",
  "system", "systems", "agent", "agents", "bot", "bots",
]);

function isAliasAffixToken(token: string): boolean {
  return ALIAS_AFFIX_TOKENS.has(token);
}

function isLikelyInstructionLike(value: string): boolean {
  return INSTRUCTION_LIKE_RE.test(value) || METADATA_WRAPPER_RE.test(value);
}

function sanitizeEntityFact(fact: string): string {
  const sanitized = sanitizeMemoryContent(fact);
  const clean = sanitized.text.trim();
  if (!clean) return "";
  if (INSTRUCTION_LIKE_RE.test(clean) && clean.length > 100) return "";
  return clean;
}

function scoreHintSnippet(snippet: EntityHintSnippet, queryTokens: string[]): EntityHintSnippet | null {
  const normalized = normalizeEntityText(snippet.text);
  if (!normalized) return null;
  const scored = { ...snippet };
  if (isLikelyInstructionLike(scored.text) && scored.kind !== "summary") {
    scored.score -= 3;
  }
  const overlap = queryTokens.filter((token) => normalized.includes(token)).length;
  scored.score += overlap * 2;
  if (METADATA_WRAPPER_RE.test(scored.text)) scored.score -= 2;
  if (scored.text.length <= 160) scored.score += 1;
  return scored.score > 0 ? scored : null;
}

function sortTimelineEntriesDesc(
  left: EntityMentionIndexEntry["timeline"][number],
  right: EntityMentionIndexEntry["timeline"][number],
): number {
  const timestampOrder = compareEntityTimestamps(right.timestamp, left.timestamp);
  if (timestampOrder !== 0) {
    return timestampOrder;
  }
  return right.text.localeCompare(left.text);
}

function jaccardSimilarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function buildAliasIndex(entries: EntityMentionIndexEntry[]): Map<string, EntityMentionIndexEntry[]> {
  const index = new Map<string, EntityMentionIndexEntry[]>();
  for (const entry of entries) {
    const aliases = uniqueStrings([entry.name, ...entry.aliases]).map(normalizeEntityText).filter(Boolean);
    for (const alias of aliases) {
      const existing = index.get(alias) ?? [];
      existing.push(entry);
      index.set(alias, existing);
    }
  }
  return index;
}

async function readNativeChunks(
  config: PluginConfig,
  recallNamespaces?: string[],
): Promise<NativeKnowledgeChunk[]> {
  if (!config.nativeKnowledge?.enabled) return [];
  return collectNativeKnowledgeChunks({
    workspaceDir: config.workspaceDir,
    memoryDir: config.memoryDir,
    config: config.nativeKnowledge,
    recallNamespaces: resolveNamespaceCapabilities(config).namespaces ? recallNamespaces : undefined,
    defaultNamespace: config.defaultNamespace,
  }).catch(() => []);
}

async function resolveEntityIndexStorages(
  storage: StorageManager,
  config: PluginConfig,
  recallNamespaces?: string[],
  namespaceStorage?: (namespace: string) => Promise<StorageManager>,
): Promise<StorageManager[]> {
  if (
    !resolveNamespaceCapabilities(config).namespaces ||
    !namespaceStorage ||
    !recallNamespaces ||
    recallNamespaces.length === 0
  ) {
    return [storage];
  }

  const storages: StorageManager[] = [];
  const seenDirs = new Set<string>();
  for (const namespace of uniqueStrings(recallNamespaces)) {
    try {
      const scopedStorage = await namespaceStorage(namespace);
      const storageDir = path.resolve(scopedStorage.dir);
      if (seenDirs.has(storageDir)) continue;
      seenDirs.add(storageDir);
      storages.push(scopedStorage);
    } catch {
      continue;
    }
  }

  return storages.length > 0 ? storages : [storage];
}

function entityIndexStatePath(storage: StorageManager): string {
  return path.join(storage.dir, "state", "entity-mention-index.json");
}

async function readEntityIndexState(storage: StorageManager): Promise<EntityMentionIndex | null> {
  const raw = await readFile(entityIndexStatePath(storage), "utf-8").catch(() => "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EntityMentionIndex>;
    if (parsed.version !== ENTITY_INDEX_VERSION || !Array.isArray(parsed.entities)) return null;
    return parsed as EntityMentionIndex;
  } catch {
    return null;
  }
}


async function readCurrentPersistedEntityIndex(
  storage: StorageManager,
  config: PluginConfig,
  recallNamespaces?: string[],
  namespaceStorage?: (namespace: string) => Promise<StorageManager>,
): Promise<EntityMentionIndex | null> {
  if (
    resolveNamespaceCapabilities(config).namespaces &&
    namespaceStorage &&
    recallNamespaces &&
    recallNamespaces.length > 0
  ) {
    return null;
  }
  const index = await readEntityIndexState(storage);
  if (!index || index.entityStatusVersion !== storage.getMemoryStatusVersion()) {
    return null;
  }
  return index;
}
const namespaceEntityIndexCache = new Map<string, EntityMentionIndex>();
const MAX_NAMESPACE_ENTITY_INDEX_CACHE_ENTRIES = 32;

function nativeEntityIndexRevision(chunks: NativeKnowledgeChunk[]): string {
  const projection = chunks.map((chunk) => [
    chunk.chunkId,
    chunk.sourcePath,
    chunk.title,
    chunk.sourceKind,
    uniqueStrings(chunk.aliases ?? []),
    compactLine(chunk.content, 180),
    chunk.derivedDate ?? null,
  ]);
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function namespaceEntityIndexCacheKey(
  storages: StorageManager[],
  recallNamespaces: string[],
  nativeRevision: string,
): string {
  const namespaceKey = uniqueStrings(recallNamespaces).join("\u001f");
  const storageKey = storages
    .map((scopedStorage) => {
      const aliases = Object.entries(scopedStorage.entityAliases)
        .sort(([left], [right]) => left.localeCompare(right));
      return (
        `${path.resolve(scopedStorage.dir)}@${scopedStorage.getMemoryStatusVersion()}` +
        `:${scopedStorage.getMemoryCorpusVersion()}:${scopedStorage.getEntityMutationVersion()}` +
        `:${scopedStorage.hotCacheKeyId()}:${JSON.stringify(aliases)}`
      );
    })
    .join("\u001f");
  return `${namespaceKey}\u001e${storageKey}\u001e${nativeRevision}`;
}

function rememberNamespaceEntityIndex(key: string, index: EntityMentionIndex): void {
  if (namespaceEntityIndexCache.size >= MAX_NAMESPACE_ENTITY_INDEX_CACHE_ENTRIES) {
    const oldestKey = namespaceEntityIndexCache.keys().next().value;
    if (typeof oldestKey === "string") namespaceEntityIndexCache.delete(oldestKey);
  }
  namespaceEntityIndexCache.set(key, index);
}

async function writeEntityIndexState(storage: StorageManager, index: EntityMentionIndex): Promise<void> {
  const statePath = entityIndexStatePath(storage);
  await mkdir(path.dirname(statePath), { recursive: true });
  const nextContent = JSON.stringify(index, null, 2) + "\n";
  const currentContent = await readFile(statePath, "utf-8").catch(() => "");
  if (currentContent === nextContent) return;
  await writeFile(statePath, nextContent, "utf-8");
}

function nativePseudoCanonicalId(chunk: NativeKnowledgeChunk): string {
  return `native:${createHash("sha256").update(chunk.sourcePath).digest("hex").slice(0, 12)}`;
}

function createPseudoNativeEntry(chunk: NativeKnowledgeChunk): EntityMentionIndexEntry {
  const canonicalId = nativePseudoCanonicalId(chunk);
  return {
    canonicalId,
    name: chunk.title,
    type: chunk.sourceKind,
    aliases: uniqueStrings(chunk.aliases ?? []),
    facts: [],
    structuredSections: [],
    timelineFacts: [],
    timeline: [],
    relationships: [],
    activity: [],
    factCount: 0,
    memorySnippets: [],
    nativeChunks: [
      {
        chunkId: chunk.chunkId,
        title: chunk.title,
        sourceKind: chunk.sourceKind,
        sourcePath: chunk.sourcePath,
        snippet: compactLine(chunk.content, 180),
        derivedDate: chunk.derivedDate,
      },
    ],
  };
}

function mergeNativeChunk(entry: EntityMentionIndexEntry, chunk: NativeKnowledgeChunk): void {
  const existing = entry.nativeChunks.find((item) => item.chunkId === chunk.chunkId);
  if (existing) return;
  entry.nativeChunks.push({
    chunkId: chunk.chunkId,
    title: chunk.title,
    sourceKind: chunk.sourceKind,
    sourcePath: chunk.sourcePath,
    snippet: compactLine(chunk.content, 180),
    derivedDate: chunk.derivedDate,
  });
  entry.aliases = uniqueStrings([...entry.aliases, ...(chunk.aliases ?? [])]);
}

function hasFreshNativeExplicitMention(
  index: EntityMentionIndex,
  nativeChunks: NativeKnowledgeChunk[],
  query: string,
): boolean {
  if (nativeChunks.length === 0) return false;
  const nativeCanonicalIds = new Set(nativeChunks.map(nativePseudoCanonicalId));
  const freshNativeIndex: EntityMentionIndex = {
    ...index,
    entities: [
      ...index.entities.filter((entry) => !nativeCanonicalIds.has(entry.canonicalId)),
      ...nativeChunks.map(createPseudoNativeEntry),
    ],
  };
  return resolveLanguageIndependentExplicitCandidates(freshNativeIndex, query).length > 0;
}

async function buildEntityMentionIndex(
  storage: StorageManager,
  config: PluginConfig,
  recallNamespaces?: string[],
  namespaceStorage?: (namespace: string) => Promise<StorageManager>,
  nativeChunksOverride?: NativeKnowledgeChunk[],
  resolvedStorages?: StorageManager[],
  abortSignal?: AbortSignal,
): Promise<EntityMentionIndex> {
  throwIfAborted(abortSignal, "entity recall aborted");
  const storages = resolvedStorages ?? await resolveEntityIndexStorages(
    storage,
    config,
    recallNamespaces,
    namespaceStorage,
  );
  const shouldPersistIndex =
    storages.length === 1 && path.resolve(storages[0]!.dir) === path.resolve(storage.dir);
  const entityStatusVersionBefore = shouldPersistIndex ? storage.getMemoryStatusVersion() : undefined;
  const [previousIndex, entityFileSets, memorySets, nativeChunks] = await Promise.all([
    shouldPersistIndex ? readEntityIndexState(storage) : Promise.resolve(null),
    Promise.all(storages.map((scopedStorage) => scopedStorage.readAllEntityFiles())),
    Promise.all(storages.map((scopedStorage) => scopedStorage.readAllMemories())),
    nativeChunksOverride ? Promise.resolve(nativeChunksOverride) : readNativeChunks(config, recallNamespaces),
  ]);
  // The bulk reads above cannot be interrupted mid-flight; stop before spending
  // the (larger) indexing pass over their results.
  throwIfAborted(abortSignal, "entity recall aborted");
  // Pair each entity with the storage that owns it (#1534): canonical ids must
  // reflect that store's aliases and historical migration mappings, never another
  // namespace's.
  const entityRecords = entityFileSets.flatMap((set, index) =>
    set.map((entity) => ({ entity, storage: storages[index]! })),
  );
  const memories = memorySets.flat();

  const entities = new Map<string, EntityMentionIndexEntry>();
  for (const { entity, storage: entityStorage } of entityRecords) {
    const canonicalId =
      typeof entityStorage.normalizeEntityName === "function"
        ? entityStorage.normalizeEntityName(entity.name, entity.type)
        : normalizeEntityName(entity.name, entity.type, entityStorage.entityAliases);
    const rawStructuredSections = entity.structuredSections ?? [];
    const rawBeliefLedgerFactKeys = beliefLedgerFactKeys(rawStructuredSections);
    const sanitizedFacts = entity.facts
      .map((fact) => sanitizeEntityFact(fact))
      .filter(Boolean)
      .filter((fact) => !rawBeliefLedgerFactKeys.has(normalizeEntityText(fact)))
      .map((fact) => compactLine(fact, 180));
    const sanitizedTimelineFacts = entity.timeline
      .map((entry) => sanitizeEntityFact(entry.text))
      .filter(Boolean)
      .map((fact) => compactLine(fact, 180));
    entities.set(canonicalId, {
      canonicalId,
      name: entity.name,
      type: entity.type,
      aliases: uniqueStrings(entity.aliases),
      summary: entity.synthesis?.trim() || entity.summary?.trim() || undefined,
      facts: sanitizedFacts,
      timelineFacts: uniqueStrings(sanitizedTimelineFacts),
      structuredSections: rawStructuredSections.map((section) => ({
        key: section.key,
        title: section.title,
        facts: recallFactsForStructuredSection(section)
          .map((fact) => sanitizeEntityFact(fact))
          .filter(Boolean)
          .map((fact) => compactLine(fact, 180)),
      })).filter((section) => section.facts.length > 0),
      timeline: entity.timeline.map((entry) => ({ ...entry })),
      relationships: entity.relationships.map((relationship) => ({ ...relationship })),
      activity: entity.activity.map((activity) => ({ ...activity })),
      factCount: sanitizedFacts.length,
      memorySnippets: [],
      nativeChunks: [],
    });
  }

  for (const memory of memories) {
    const entityRef = typeof memory.frontmatter.entityRef === "string" ? memory.frontmatter.entityRef : "";
    if (!entityRef) continue;
    const entry = entities.get(entityRef);
    if (!entry) continue;
    const snippet = await readMemorySnippet(memory);
    if (!entry.memorySnippets.includes(snippet)) {
      entry.memorySnippets.push(snippet);
    }
  }

  const aliasIndex = buildAliasIndex([...entities.values()]);
  for (const chunk of nativeChunks) {
    const existingPseudo = entities.get(nativePseudoCanonicalId(chunk));
    if (existingPseudo) {
      mergeNativeChunk(existingPseudo, chunk);
      continue;
    }
    const candidateAliases = uniqueStrings([chunk.title, ...(chunk.aliases ?? [])]).map(normalizeEntityText).filter(Boolean);
    let matched = false;
    for (const alias of candidateAliases) {
      for (const entry of aliasIndex.get(alias) ?? []) {
        mergeNativeChunk(entry, chunk);
        matched = true;
      }
    }
    if (matched) continue;
    const pseudoEntry = createPseudoNativeEntry(chunk);
    entities.set(pseudoEntry.canonicalId, pseudoEntry);
  }

  const sortedEntities = [...entities.values()].sort((left, right) => left.name.localeCompare(right.name));
  const previousEntities = previousIndex ? JSON.stringify(previousIndex.entities) : "";
  const nextEntities = JSON.stringify(sortedEntities);
  const entityStatusVersionAfter = shouldPersistIndex ? storage.getMemoryStatusVersion() : undefined;
  const canPersistIndex = shouldPersistIndex && entityStatusVersionBefore === entityStatusVersionAfter;
  const index: EntityMentionIndex = {
    version: ENTITY_INDEX_VERSION,
    updatedAt:
      previousIndex && previousEntities === nextEntities
        ? previousIndex.updatedAt
        : new Date().toISOString(),
    entityStatusVersion: canPersistIndex ? entityStatusVersionAfter : undefined,
    entities: sortedEntities,
  };
  if (canPersistIndex) {
    await writeEntityIndexState(storage, index);
  }
  return index;
}

function resolveExplicitCandidates(
  index: EntityMentionIndex,
  query: string,
): EntityCandidate[] {
  const candidates: EntityCandidate[] = [];
  for (const entry of index.entities) {
    const aliases = uniqueStrings([entry.name, ...entry.aliases]);
    let bestAlias = "";
    let bestScore = 0;
    for (const alias of aliases) {
      const score = scoreAliasMatch(query, alias);
      if (score > bestScore) {
        bestAlias = alias;
        bestScore = score;
      }
    }
    if (bestScore <= 0) continue;
    candidates.push({ entry, alias: bestAlias, score: bestScore, source: "query" });
  }
  return candidates.sort((left, right) => right.score - left.score);
}

const EXPLICIT_ENTITY_MENTION_SCORE = 9;

const IMPLICIT_ENTITY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "has",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

function isDistinctiveImplicitAlias(normalizedAlias: string): boolean {
  const tokens = normalizedAlias.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => IMPLICIT_ENTITY_STOP_WORDS.has(token))) return false;
  if (tokens.length !== 1) return true;
  const token = tokens[0]!;
  return Array.from(token).length > 1 && !IMPLICIT_ENTITY_STOP_WORDS.has(token);
}

function isShortLatinAlias(alias: string): boolean {
  return /^[A-Za-z]{2,3}$/.test(alias.trim());
}

function hasStrongShortLatinAliasMention(query: string, alias: string): boolean {
  const normalizedAlias = alias.trim();
  const titleCaseAlias = `${normalizedAlias[0]!.toUpperCase()}${normalizedAlias.slice(1).toLowerCase()}`;
  const forms = new Set([normalizedAlias, normalizedAlias.toUpperCase(), titleCaseAlias]);
  return [...forms].some((form) => {
    if (form === form.toLowerCase()) return false;
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`).test(query);
  });
}

function resolveLanguageIndependentExplicitCandidates(
  index: EntityMentionIndex,
  query: string,
): EntityCandidate[] {
  const canonicalIdsByAlias = new Map<string, Set<string>>();
  for (const entry of index.entities) {
    for (const alias of uniqueStrings([entry.name, ...entry.aliases])) {
      const normalizedAlias = normalizeEntityText(alias);
      if (!normalizedAlias) continue;
      const canonicalIds = canonicalIdsByAlias.get(normalizedAlias) ?? new Set<string>();
      canonicalIds.add(entry.canonicalId);
      canonicalIdsByAlias.set(normalizedAlias, canonicalIds);
    }
  }

  const candidates: EntityCandidate[] = [];
  for (const entry of index.entities) {
    let bestAlias = "";
    let bestScore = 0;
    for (const alias of uniqueStrings([entry.name, ...entry.aliases])) {
      const normalizedAlias = normalizeEntityText(alias);
      const score = scoreAliasMatch(query, alias);
      if (
        !normalizedAlias ||
        !isDistinctiveImplicitAlias(normalizedAlias) ||
        (isShortLatinAlias(alias) && !hasStrongShortLatinAliasMention(query, alias)) ||
        canonicalIdsByAlias.get(normalizedAlias)?.size !== 1 ||
        score < EXPLICIT_ENTITY_MENTION_SCORE ||
        score <= bestScore
      ) {
        continue;
      }
      bestAlias = alias;
      bestScore = score;
    }
    if (bestAlias) {
      candidates.push({ entry, alias: bestAlias, score: bestScore, source: "query" });
    }
  }

  return candidates.sort(
    (left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name),
  );
}

function resolveRecentTurnCandidates(
  index: EntityMentionIndex,
  transcriptEntries: TranscriptEntry[],
  recentTurns: number,
): EntityCandidate[] {
  if (recentTurns <= 0 || transcriptEntries.length === 0) return [];
  const recentEntries = transcriptEntries.slice(-recentTurns);
  const candidates = new Map<string, EntityCandidate>();
  for (let indexOffset = recentEntries.length - 1; indexOffset >= 0; indexOffset -= 1) {
    const turn = recentEntries[indexOffset];
    const recencyBoost = recentEntries.length - indexOffset;
    const roleWeight = turn.role === "user" ? 2 : turn.role === "assistant" ? -1 : 0;
    for (const entry of index.entities) {
      const aliases = uniqueStrings([entry.name, ...entry.aliases]);
      for (const alias of aliases) {
        const score = scoreAliasMatch(turn.content, alias);
        if (score <= 0) continue;
        const current = candidates.get(entry.canonicalId);
        const weightedScore = score + Math.max(0, 6 - recencyBoost) + roleWeight;
        if (!current || weightedScore > current.score) {
          candidates.set(entry.canonicalId, {
            entry,
            alias,
            score: weightedScore,
            source: "recent_turn",
          });
        }
      }
    }
  }
  return [...candidates.values()].sort((left, right) => right.score - left.score);
}

async function readMemorySnippet(memory: MemoryFile): Promise<string> {
  const content = memory.content.replace(/\s+/g, " ").trim();
  return compactLine(content, 180);
}

async function buildHintSnippets(
  entry: EntityMentionIndexEntry,
  queryTokens: string[],
  mode: EntityQueryMode,
  maxSupportingFacts: number,
  requestedSectionKeys: Set<string>,
): Promise<EntityHintSnippet[]> {
  const snippets: EntityHintSnippet[] = [];
  const aliasTokens = new Set(tokenize(uniqueStrings([entry.name, ...entry.aliases]).join(" ")));
  if (entry.summary) {
    snippets.push({ text: compactLine(entry.summary, 180), score: 10, kind: "summary" });
  }

  if (requestedSectionKeys.size > 0) {
    for (const section of entry.structuredSections) {
      if (!requestedSectionKeys.has(normalizeEntityText(section.key).replace(/\s+/g, "_"))) continue;
      for (const fact of section.facts) {
        snippets.push({ text: fact, score: mode === "direct" ? 8 : 9, kind: "section" });
      }
    }
  } else {
    for (const fact of entry.timelineFacts) {
      snippets.push({ text: fact, score: mode === "direct" ? 6 : 7, kind: "fact" });
    }
    for (const section of entry.structuredSections) {
      for (const fact of section.facts) {
        const normalizedFact = normalizeEntityText(fact);
        const hasNonAliasQueryOverlap = queryTokens.some((token) =>
          !aliasTokens.has(token) && normalizedFact.includes(token)
        );
        if (entry.timelineFacts.length > 0 && !hasNonAliasQueryOverlap) {
          continue;
        }
        snippets.push({ text: fact, score: mode === "direct" ? 6 : 7, kind: "fact" });
      }
    }
    if (entry.timelineFacts.length === 0 && entry.structuredSections.length === 0) {
      for (const fact of entry.facts) {
        if (!fact.trim()) continue;
        snippets.push({ text: fact, score: mode === "direct" ? 6 : 7, kind: "fact" });
      }
    }
  }

  if (requestedSectionKeys.size === 0) {
    for (const relationship of entry.relationships) {
      snippets.push({
        text: compactLine(relationLine(entry, relationship), 180),
        score: mode === "direct" && entry.type.toLowerCase() === "person" ? 6 : 4,
        kind: "relationship",
      });
    }

    for (const activity of entry.activity) {
      snippets.push({
        text: compactLine(`${activity.date}: ${activity.note}`, 180),
        score: 4,
        kind: "activity",
      });
    }

    for (const memorySnippet of entry.memorySnippets.slice(0, Math.min(maxSupportingFacts, 4))) {
      snippets.push({
        text: memorySnippet,
        score: 5,
        kind: "memory",
      });
    }

    for (const chunk of entry.nativeChunks) {
      snippets.push({
        text: compactLine(chunk.snippet, 180),
        score: 3,
        kind: "native",
      });
    }
  }

  const deduped = new Map<string, EntityHintSnippet>();
  for (const snippet of snippets) {
    const scored = scoreHintSnippet(snippet, queryTokens);
    if (!scored) continue;
    const normalized = normalizeEntityText(scored.text);
    const existing = deduped.get(normalized);
    if (!existing || scored.score > existing.score) deduped.set(normalized, scored);
  }

  return [...deduped.values()]
    .filter((snippet) => snippet.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSupportingFacts);
}

function summarizeUncertainty(snippets: EntityHintSnippet[]): string | null {
  const direct = snippets.filter((snippet) =>
    snippet.kind === "summary"
    || snippet.kind === "fact"
    || snippet.kind === "section"
    || snippet.kind === "memory"
  );
  if (direct.length < 2) return null;
  for (let index = 0; index < direct.length; index += 1) {
    for (let compare = index + 1; compare < direct.length; compare += 1) {
      if (jaccardSimilarity(direct[index].text, direct[compare].text) < 0.2) {
        return "Evidence is mixed across stored facts; treat the hints below as partial and verify before answering definitively.";
      }
    }
  }
  return null;
}

function formatEntityHintSection(
  candidates: Array<{
    candidate: EntityCandidate;
    snippets: EntityHintSnippet[];
    uncertainty: string | null;
  }>,
  queryTokens: string[],
  mode: EntityQueryMode,
  maxRelatedEntities: number,
  maxChars: number,
): string | null {
  if (candidates.length === 0) return null;
  const lines: string[] = ["## entity_answer_hints", ""];
  for (const { candidate, snippets, uncertainty } of candidates) {
    const hasSummary = Boolean(candidate.entry.summary?.trim());
    const preferredTopSnippets = hasSummary
      ? snippets.filter((snippet) => snippet.kind !== "fact")
      : snippets;
    let topSnippets = (
      preferredTopSnippets.length > 0 ? preferredTopSnippets : snippets
    ).slice(0, 3);
    const buildTimelineSnippets = (seedExcludedTexts: Set<string>): EntityHintSnippet[] => {
      const explicitTimelinePool = dedupeHintSnippetsByText(
        (candidate.entry.timeline ?? [])
          .slice()
          .sort(sortTimelineEntriesDesc)
          .map((entry) => sanitizeEntityFact(entry.text))
          .filter(Boolean)
          .map((text) => scoreHintSnippet({
            text: compactLine(text, 180),
            score: 7,
            kind: "activity" as const,
          }, queryTokens))
          .filter((snippet): snippet is EntityHintSnippet => snippet !== null)
          .filter((snippet) => !seedExcludedTexts.has(normalizeEntityText(snippet.text))),
      ).slice(0, 2);
      const activityTimelinePool = dedupeHintSnippetsByText(
        snippets
          .filter((snippet) => (
            snippet.kind === "activity" || snippet.kind === "memory"
          ) && !seedExcludedTexts.has(normalizeEntityText(snippet.text))),
      ).slice(0, 2);
      return explicitTimelinePool.length > 0
        ? explicitTimelinePool
        : activityTimelinePool.length > 0
          ? activityTimelinePool
          : dedupeHintSnippetsByText(
            snippets
              .filter((snippet) => (
                snippet.kind === "fact" || snippet.kind === "summary"
              ) && !seedExcludedTexts.has(normalizeEntityText(snippet.text))),
          ).slice(0, 2);
    };
    const baseTopSnippetTexts = new Set(topSnippets.map((snippet) => normalizeEntityText(snippet.text)));
    const timelinePool = mode !== "direct" ? buildTimelineSnippets(baseTopSnippetTexts) : [];
    if (mode !== "direct" && hasSummary && topSnippets.length < 2) {
      if (timelinePool.length > 0) {
        topSnippets = [...topSnippets, timelinePool[0]!].slice(0, 3);
      }
    }
    const topSnippetTexts = new Set(topSnippets.map((snippet) => normalizeEntityText(snippet.text)));
    lines.push(`- target: ${candidate.entry.name} (${candidate.entry.type})`);
    if (candidate.source === "recent_turn") {
      lines.push(`- resolution: carried forward from recent turns via alias "${candidate.alias}"`);
    } else {
      lines.push(`- resolution: matched alias "${candidate.alias}" in the query`);
    }
    if (uncertainty) lines.push(`- uncertainty: ${uncertainty}`);
    if (topSnippets.length > 0) {
      lines.push("- likely answer:");
      for (const snippet of topSnippets) {
        lines.push(`  - ${snippet.text}`);
      }
    }
    if (mode !== "direct") {
      const fallbackTimeline = timelinePool.filter(
        (snippet) => !topSnippetTexts.has(normalizeEntityText(snippet.text)),
      );
      if (fallbackTimeline.length > 0) {
        lines.push("- recent timeline:");
        for (const snippet of fallbackTimeline) {
          lines.push(`  - ${snippet.text}`);
        }
      }
    }
    const related = candidate.entry.relationships.slice(0, maxRelatedEntities).map((relationship) => relationship.target);
    if (related.length > 0) {
      lines.push(`- related entities: ${related.join(", ")}`);
    }
    lines.push(`- support counts: facts=${candidate.entry.factCount}, memories=${candidate.entry.memorySnippets.length}, native=${candidate.entry.nativeChunks.length}`);
    lines.push("");
  }

  let result = lines.join("\n");
  if (result.length > maxChars) {
    result = `${result.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n\n...(trimmed)\n`;
  }
  return result.trim().length > 0 ? result.trimEnd() : null;
}

export async function buildEntityRecallSection(options: BuildEntityRecallSectionOptions): Promise<string | null> {
  // Checkpoints sit at the real I/O boundaries below (persisted-index read,
  // native-chunk read, storage resolution, index build).  The per-candidate
  // formatting that follows never awaits real I/O, so a deadline that fires
  // during a scan is observed here (issue #2291).
  throwIfAborted(options.abortSignal, "entity recall aborted");
  const prefixedMode = detectEntityQueryMode(options.query);
  const persistedIndex = prefixedMode
    ? null
    : await readCurrentPersistedEntityIndex(
      options.storage,
      options.config,
      options.recallNamespaces,
      options.namespaceStorage,
    );
  throwIfAborted(options.abortSignal, "entity recall aborted");
  let nativeChunks: NativeKnowledgeChunk[] | undefined;
  if (
    !prefixedMode &&
    persistedIndex &&
    resolveLanguageIndependentExplicitCandidates(persistedIndex, options.query).length === 0
  ) {
    nativeChunks = await readNativeChunks(options.config, options.recallNamespaces);
    if (!hasFreshNativeExplicitMention(persistedIndex, nativeChunks, options.query)) {
      return null;
    }
  }
  const namespaceScoped =
    resolveNamespaceCapabilities(options.config).namespaces &&
    options.namespaceStorage !== undefined &&
    (options.recallNamespaces?.length ?? 0) > 0;
  if (namespaceScoped) {
    nativeChunks = await readNativeChunks(options.config, options.recallNamespaces);
  }
  const resolvedStorages = namespaceScoped
    ? await resolveEntityIndexStorages(
      options.storage,
      options.config,
      options.recallNamespaces,
      options.namespaceStorage,
    )
    : undefined;
  const namespaceCacheKey =
    resolvedStorages && options.recallNamespaces && nativeChunks
      ? namespaceEntityIndexCacheKey(
        resolvedStorages,
        options.recallNamespaces,
        nativeEntityIndexRevision(nativeChunks),
      )
      : undefined;
  let index: EntityMentionIndex | undefined = namespaceCacheKey
    ? namespaceEntityIndexCache.get(namespaceCacheKey)
    : undefined;
  throwIfAborted(options.abortSignal, "entity recall aborted");
  if (!index) {
    index = await buildEntityMentionIndex(
      options.storage,
      options.config,
      options.recallNamespaces,
      options.namespaceStorage,
      nativeChunks,
      resolvedStorages,
      options.abortSignal,
    );
    if (namespaceCacheKey) rememberNamespaceEntityIndex(namespaceCacheKey, index);
  }
  const explicitCandidates = resolveExplicitCandidates(index, options.query);
  const queryCandidates = prefixedMode
    ? explicitCandidates
    : resolveLanguageIndependentExplicitCandidates(index, options.query);
  const mode = prefixedMode ?? (queryCandidates.length > 0 ? "direct" : null);
  if (!mode) return null;

  const candidates = queryCandidates.length > 0
    ? queryCandidates
    : resolveRecentTurnCandidates(index, options.transcriptEntries, options.recentTurns);

  if (candidates.length === 0) return null;

  const queryTokens = tokenize(options.query);
  const candidateLimit = queryCandidates.length === 0 && mode === "follow_up"
    ? 1
    : options.maxHints;
  const rankedCandidates = candidates.slice(0, candidateLimit);
  const enriched = await Promise.all(
    rankedCandidates.map(async (candidate) => {
      const requestedSectionKeys = new Set(
        resolveRequestedEntitySectionKeys(
          options.query,
          candidate.entry.type,
          candidate.entry.structuredSections,
          options.config.entitySchemas,
        ),
      );
      const snippets = await buildHintSnippets(
        candidate.entry,
        queryTokens,
        mode,
        options.maxSupportingFacts,
        requestedSectionKeys,
      );
      return {
        candidate,
        snippets,
        uncertainty: summarizeUncertainty(snippets),
      };
    }),
  );

  const section = formatEntityHintSection(enriched, queryTokens, mode, options.maxRelatedEntities, options.maxChars);
  if (!section) return null;
  return section;
}

export async function readRecentEntityTranscriptEntries(
  transcriptEntriesPromise: Promise<TranscriptEntry[]>,
  recentTurns: number,
): Promise<TranscriptEntry[]> {
  if (recentTurns <= 0) return [];
  const transcriptEntries = await transcriptEntriesPromise.catch(() => []);
  if (transcriptEntries.length === 0) return [];
  return transcriptEntries.slice(-Math.max(1, recentTurns * 2));
}

export const entityIndexVersion = ENTITY_INDEX_VERSION;
export const entityRecentTranscriptLookbackHours = RECENT_TRANSCRIPT_LOOKBACK_HOURS;
