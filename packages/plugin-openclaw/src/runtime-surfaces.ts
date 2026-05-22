import type {
  ConsolidationObservation,
  MemoryFile,
  MemoryFrontmatter,
} from "@remnic/core";
import type { DreamEntry } from "@remnic/core/surfaces/dreams";
import type { HeartbeatEntry } from "@remnic/core/surfaces/heartbeat";

type StorageWriteOptions = {
  confidence?: number;
  tags?: string[];
  source?: string;
  memoryKind?: MemoryFrontmatter["memoryKind"];
  structuredAttributes?: Record<string, string>;
};

export interface RuntimeSurfaceStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  writeMemory(
    category: MemoryFrontmatter["category"],
    content: string,
    options?: StorageWriteOptions,
  ): Promise<string>;
  updateMemory(id: string, newContent: string): Promise<boolean>;
  writeMemoryFrontmatter(
    memory: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
  ): Promise<boolean>;
}

export interface RuntimeSurfaceLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

export interface SurfaceSyncResult {
  created: number;
  updated: number;
  linked: number;
}

export interface DreamNarrativePlan {
  timestamp: string;
  suggestedTags: string[];
  sessionLikeCount: number;
  memoryContext: string[];
}

const DREAM_SURFACE_TYPE = "dream";
const HEARTBEAT_SURFACE_TYPE = "heartbeat";
const DREAM_ENTRY_ID_KEY = "remnicDreamEntryId";
const HEARTBEAT_ENTRY_ID_KEY = "remnicHeartbeatEntryId";
const HEARTBEAT_SLUG_KEY = "relatedHeartbeatSlug";
const SURFACE_TYPE_KEY = "remnicSurfaceType";
const DREAM_REFLECTION_TAGS = new Set([
  "frustration",
  "recurring",
  "surprising",
  "stuck",
  "reflection",
  "reflective",
  "debug",
  "meta",
  "pattern",
  "patterns",
]);

function uniqueTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
  );
}

function serializeStringRecord(
  value: Record<string, string> | undefined,
): string {
  return JSON.stringify(
    Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeAttributePairs(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => [key.trim().toLowerCase(), value.trim()] as [string, string])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
}

function enrichSurfaceContent(
  content: string,
  structuredAttributes: Record<string, string> | undefined,
): string {
  if (!structuredAttributes || Object.keys(structuredAttributes).length === 0) {
    return content;
  }
  return `${content}\n[Attributes: ${normalizeAttributePairs(structuredAttributes)}]`;
}

function stripSurfaceAttributeSuffix(
  content: string,
  structuredAttributes: Record<string, string> | undefined,
): string {
  if (!structuredAttributes || Object.keys(structuredAttributes).length === 0) {
    return content;
  }
  const suffix = `\n[Attributes: ${normalizeAttributePairs(structuredAttributes)}]`;
  return content.endsWith(suffix) ? content.slice(0, -suffix.length) : content;
}

function buildDreamMemoryContent(entry: DreamEntry): string {
  return entry.title ? `${entry.title}\n\n${entry.body}` : entry.body;
}

function buildHeartbeatMemoryContent(entry: HeartbeatEntry): string {
  const lines = [entry.title, "", entry.body];
  if (entry.schedule) {
    lines.push("", `Schedule: ${entry.schedule}`);
  }
  return lines.join("\n").trim();
}

function findSurfaceMemoryByAttribute(
  memories: MemoryFile[],
  key: string,
  value: string,
): MemoryFile | null {
  return (
    memories.find(
      (memory) => memory.frontmatter.structuredAttributes?.[key] === value,
    ) ?? null
  );
}

function isSurfaceMemory(memory: MemoryFile, surfaceType: string): boolean {
  return memory.frontmatter.structuredAttributes?.[SURFACE_TYPE_KEY] === surfaceType;
}

function findUniqueSurfaceMemoryBySlug(
  memories: MemoryFile[],
  surfaceType: string,
  slug: string,
): MemoryFile | null {
  const matches = memories.filter(
    (memory) =>
      isSurfaceMemory(memory, surfaceType) &&
      memory.frontmatter.structuredAttributes?.[HEARTBEAT_SLUG_KEY] === slug,
  );
  return matches.length === 1 ? matches[0] ?? null : null;
}

async function patchMemory(
  storage: RuntimeSurfaceStorage,
  memory: MemoryFile,
  nextContent: string,
  patch: Partial<MemoryFrontmatter>,
): Promise<boolean> {
  let changed = false;
  const nextTags = JSON.stringify(uniqueTags(patch.tags ?? memory.frontmatter.tags ?? []));
  const prevTags = JSON.stringify(uniqueTags(memory.frontmatter.tags ?? []));
  const nextStructuredAttributes =
    patch.structuredAttributes ?? memory.frontmatter.structuredAttributes;
  const nextAttrs = serializeStringRecord(
    nextStructuredAttributes,
  );
  const prevAttrs = serializeStringRecord(memory.frontmatter.structuredAttributes);
  const sourceChanged =
    patch.source !== undefined && patch.source !== memory.frontmatter.source;
  const memoryKindChanged =
    patch.memoryKind !== undefined &&
    patch.memoryKind !== memory.frontmatter.memoryKind;
  const metadataChanged =
    nextTags !== prevTags ||
    nextAttrs !== prevAttrs ||
    sourceChanged ||
    memoryKindChanged;
  if (metadataChanged) {
    if (
      !(await storage.writeMemoryFrontmatter(memory, {
        ...patch,
        tags: uniqueTags(patch.tags ?? memory.frontmatter.tags ?? []),
        updated: new Date().toISOString(),
      }))
    ) {
      return false;
    }
    changed = true;
  }
  const persistedContent = enrichSurfaceContent(nextContent, nextStructuredAttributes);
  const existingBody = stripSurfaceAttributeSuffix(
    memory.content,
    memory.frontmatter.structuredAttributes,
  );
  const contentChanged =
    existingBody.trim() !== nextContent.trim() ||
    memory.content.trim() !== persistedContent.trim();
  if (contentChanged) {
    if (!(await storage.updateMemory(memory.frontmatter.id, persistedContent))) {
      if (metadataChanged) {
        throw new Error(
          `surface memory ${memory.frontmatter.id} frontmatter was updated but content update failed`,
        );
      }
      return false;
    }
    changed = true;
  }
  return changed;
}

function makeSurfaceMemorySnapshot(params: {
  id: string;
  category: MemoryFrontmatter["category"];
  content: string;
  tags: string[];
  source: string;
  memoryKind: MemoryFrontmatter["memoryKind"];
  structuredAttributes: Record<string, string>;
}): MemoryFile {
  const now = new Date().toISOString();
  return {
    path: params.id,
    content: enrichSurfaceContent(params.content, params.structuredAttributes),
    frontmatter: {
      id: params.id,
      category: params.category,
      created: now,
      updated: now,
      source: params.source,
      confidence: 1,
      confidenceTier: "explicit",
      tags: params.tags,
      memoryKind: params.memoryKind,
      structuredAttributes: params.structuredAttributes,
    },
  };
}

function applySurfaceMemorySnapshot(
  memory: MemoryFile,
  params: {
    content: string;
    tags: string[];
    source: string;
    memoryKind: MemoryFrontmatter["memoryKind"];
    structuredAttributes: Record<string, string>;
  },
): void {
  memory.content = enrichSurfaceContent(params.content, params.structuredAttributes);
  memory.frontmatter = {
    ...memory.frontmatter,
    updated: new Date().toISOString(),
    source: params.source,
    tags: params.tags,
    memoryKind: params.memoryKind,
    structuredAttributes: params.structuredAttributes,
  };
}

export async function syncDreamSurfaceEntries(params: {
  storage: RuntimeSurfaceStorage;
  entries: DreamEntry[];
  journalPath: string;
  maxEntries: number;
  reindexMemory?: (id: string) => Promise<void>;
}): Promise<SurfaceSyncResult> {
  const { storage, journalPath, reindexMemory } = params;
  const maxEntries = Math.max(0, params.maxEntries);
  if (maxEntries === 0) {
    return { created: 0, updated: 0, linked: 0 };
  }
  const entries = params.entries.slice(-maxEntries);
  const memories = await storage.readAllMemories();
  let created = 0;
  let updated = 0;

  for (const entry of entries) {
    const content = buildDreamMemoryContent(entry);
    const tags = uniqueTags([...entry.tags, "dream"]);
    const structuredAttributes = {
      [SURFACE_TYPE_KEY]: DREAM_SURFACE_TYPE,
      [DREAM_ENTRY_ID_KEY]: entry.id,
      remnicDreamTimestamp: entry.timestamp,
      remnicDreamJournalPath: journalPath,
      remnicDreamSourceOffset: String(entry.sourceOffset),
      ...(entry.title ? { remnicDreamTitle: entry.title } : {}),
    };
    const existing = findSurfaceMemoryByAttribute(memories, DREAM_ENTRY_ID_KEY, entry.id);
    if (!existing) {
      const memoryId = await storage.writeMemory("moment", content, {
        confidence: 0.85,
        tags,
        source: "dreams.md",
        memoryKind: "dream",
        structuredAttributes,
      });
      memories.push(
        makeSurfaceMemorySnapshot({
          id: memoryId,
          category: "moment",
          content,
          tags,
          source: "dreams.md",
          memoryKind: "dream",
          structuredAttributes,
        }),
      );
      await reindexMemory?.(memoryId);
      created += 1;
      continue;
    }
    if (
      await patchMemory(storage, existing, content, {
        source: "dreams.md",
        memoryKind: "dream",
        tags,
        structuredAttributes,
      })
    ) {
      applySurfaceMemorySnapshot(existing, {
        content,
        tags,
        source: "dreams.md",
        memoryKind: "dream",
        structuredAttributes,
      });
      await reindexMemory?.(existing.frontmatter.id);
      updated += 1;
    }
  }

  return { created, updated, linked: 0 };
}

export async function syncHeartbeatSurfaceEntries(params: {
  storage: RuntimeSurfaceStorage;
  entries: HeartbeatEntry[];
  journalPath: string;
  reindexMemory?: (id: string) => Promise<void>;
}): Promise<SurfaceSyncResult> {
  const { storage, entries, journalPath, reindexMemory } = params;
  const memories = await storage.readAllMemories();
  let created = 0;
  let updated = 0;

  for (const entry of entries) {
    const content = buildHeartbeatMemoryContent(entry);
    const tags = uniqueTags([...entry.tags, "heartbeat", "procedural", entry.slug]);
    const structuredAttributes = {
      [SURFACE_TYPE_KEY]: HEARTBEAT_SURFACE_TYPE,
      [HEARTBEAT_ENTRY_ID_KEY]: entry.id,
      [HEARTBEAT_SLUG_KEY]: entry.slug,
      remnicHeartbeatJournalPath: journalPath,
      remnicHeartbeatSourceOffset: String(entry.sourceOffset),
      ...(entry.schedule ? { remnicHeartbeatSchedule: entry.schedule } : {}),
    };
    const existing =
      findSurfaceMemoryByAttribute(memories, HEARTBEAT_ENTRY_ID_KEY, entry.id) ??
      findUniqueSurfaceMemoryBySlug(memories, HEARTBEAT_SURFACE_TYPE, entry.slug);

    if (!existing) {
      const memoryId = await storage.writeMemory("principle", content, {
        confidence: 0.95,
        tags,
        source: "heartbeat.md",
        memoryKind: "procedural",
        structuredAttributes,
      });
      memories.push(
        makeSurfaceMemorySnapshot({
          id: memoryId,
          category: "principle",
          content,
          tags,
          source: "heartbeat.md",
          memoryKind: "procedural",
          structuredAttributes,
        }),
      );
      await reindexMemory?.(memoryId);
      created += 1;
      continue;
    }

    if (
      await patchMemory(storage, existing, content, {
        source: "heartbeat.md",
        memoryKind: "procedural",
        tags,
        structuredAttributes,
      })
    ) {
      applySurfaceMemorySnapshot(existing, {
        content,
        tags,
        source: "heartbeat.md",
        memoryKind: "procedural",
        structuredAttributes,
      });
      await reindexMemory?.(existing.frontmatter.id);
      updated += 1;
    }
  }

  return { created, updated, linked: 0 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDelimitedBoundaryClass(): string {
  return "a-z0-9-";
}

function compileDelimitedPhrasePattern(value: string): RegExp | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const boundaryClass = buildDelimitedBoundaryClass();
  return new RegExp(
    `(^|[^${boundaryClass}])${escapeRegExp(normalized)}([^${boundaryClass}]|$)`,
  );
}

function matchesDelimitedPattern(haystack: string, pattern: RegExp | null): boolean {
  if (!pattern) return false;
  return pattern.test(haystack);
}

export function matchesDelimitedPhrase(haystack: string, value: string): boolean {
  const normalizedHaystack = haystack.toLowerCase();
  return matchesDelimitedPattern(normalizedHaystack, compileDelimitedPhrasePattern(value));
}

function findLastNonEmptyLineIndex(lines: string[], afterIndex: number): number {
  for (let index = lines.length - 1; index > afterIndex; index--) {
    if ((lines[index] ?? "").trim().length > 0) {
      return index;
    }
  }
  return -1;
}

function detectHeartbeatSlug(
  memory: MemoryFile,
  entries: Array<{
    slug: string;
    title: string;
    titlePattern: RegExp | null;
    slugPattern: RegExp | null;
  }>,
): string | null {
  const ignoredTagTerms = new Set(
    entries.flatMap((entry) =>
      [entry.slug, entry.title]
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  );
  const searchableTags = (memory.frontmatter.tags ?? []).filter(
    (tag) =>
      !tag.startsWith("heartbeat:") &&
      !ignoredTagTerms.has(tag.trim().toLowerCase()),
  );
  const searchableContent = stripSurfaceAttributeSuffix(
    memory.content,
    memory.frontmatter.structuredAttributes,
  );
  const haystack = `${searchableContent}\n${searchableTags.join(" ")}`.toLowerCase();
  const matches = entries.filter((entry) => {
    if (matchesDelimitedPattern(haystack, entry.titlePattern)) return true;
    return matchesDelimitedPattern(haystack, entry.slugPattern);
  });
  return matches.length === 1 ? (matches[0]?.slug ?? null) : null;
}

export async function syncHeartbeatOutcomeLinks(params: {
  storage: RuntimeSurfaceStorage;
  entries: HeartbeatEntry[];
  reindexMemory?: (id: string) => Promise<void>;
  logger?: RuntimeSurfaceLogger;
}): Promise<SurfaceSyncResult> {
  const { storage, entries, reindexMemory, logger } = params;
  const memories = await storage.readAllMemories();
  const matchEntries = entries.map((entry) => ({
    slug: entry.slug,
    title: entry.title,
    titlePattern: compileDelimitedPhrasePattern(entry.title),
    slugPattern: compileDelimitedPhrasePattern(entry.slug),
  }));
  let linked = 0;

  for (const memory of memories) {
    if (isSurfaceMemory(memory, HEARTBEAT_SURFACE_TYPE)) continue;
    const existingSlug = memory.frontmatter.structuredAttributes?.[HEARTBEAT_SLUG_KEY];
    const detectedSlug = detectHeartbeatSlug(memory, matchEntries);
    const baseAttributes = { ...(memory.frontmatter.structuredAttributes ?? {}) };
    delete baseAttributes[HEARTBEAT_SLUG_KEY];
    const baseTags = (memory.frontmatter.tags ?? []).filter(
      (tag) => !tag.startsWith("heartbeat:"),
    );
    if (!detectedSlug) {
      if (!existingSlug) continue;
      const wrote = await storage.writeMemoryFrontmatter(memory, {
        structuredAttributes: baseAttributes,
        tags: uniqueTags(baseTags),
        updated: new Date().toISOString(),
      });
      if (wrote) {
        await reindexMemory?.(memory.frontmatter.id);
        linked += 1;
        logger?.debug?.(
          `cleared stale heartbeat link for memory ${memory.frontmatter.id}`,
        );
      }
      continue;
    }
    if (existingSlug === detectedSlug) continue;
    const nextAttributes = {
      ...baseAttributes,
      [HEARTBEAT_SLUG_KEY]: detectedSlug,
    };
    const nextTags = uniqueTags([...baseTags, `heartbeat:${detectedSlug}`]);
    const wrote = await storage.writeMemoryFrontmatter(memory, {
      structuredAttributes: nextAttributes,
      tags: nextTags,
      updated: new Date().toISOString(),
    });
    if (wrote) {
      await reindexMemory?.(memory.frontmatter.id);
      linked += 1;
      logger?.debug?.(
        `linked memory ${memory.frontmatter.id} to heartbeat slug ${detectedSlug}`,
      );
    }
  }

  return { created: 0, updated: 0, linked };
}

function parseIsoTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function planDreamEntryFromConsolidation(params: {
  observation: ConsolidationObservation;
  existingDreams: DreamEntry[];
  minIntervalMinutes: number;
  now?: Date;
}): DreamNarrativePlan | null {
  const now = params.now ?? new Date();
  const latestDreamAt = Math.max(
    -1,
    ...params.existingDreams
      .map((entry) => parseIsoTimestamp(entry.timestamp))
      .filter((value): value is number => value !== null),
  );
  if (
    latestDreamAt > 0 &&
    now.getTime() - latestDreamAt < params.minIntervalMinutes * 60_000
  ) {
    return null;
  }

  const operationalMemories = params.observation.recentMemories.filter((memory) => {
    const surfaceType = memory.frontmatter.structuredAttributes?.[SURFACE_TYPE_KEY];
    return surfaceType !== DREAM_SURFACE_TYPE && surfaceType !== HEARTBEAT_SURFACE_TYPE;
  });
  const sessionLikeKeys = new Set(
    operationalMemories.map((memory) => {
      return (
        memory.frontmatter.sourceTurnId ??
        memory.frontmatter.created.slice(0, 13)
      );
    }),
  );
  if (sessionLikeKeys.size < 3) return null;

  const suggestedTags = uniqueTags(
    operationalMemories.flatMap((memory) =>
      (memory.frontmatter.tags ?? []).filter((tag) => DREAM_REFLECTION_TAGS.has(tag)),
    ),
  ).slice(0, 4);
  if (suggestedTags.length === 0) return null;

  const memoryContext = operationalMemories.slice(0, 6).map((memory) => {
    const preview = memory.content.replace(/\s+/g, " ").trim();
    const compactPreview =
      preview.length > 220 ? `${preview.slice(0, 220).trimEnd()}...` : preview;
    return `- (${memory.frontmatter.category}) ${compactPreview}`;
  });
  if (memoryContext.length < 3) return null;

  return {
    timestamp: now.toISOString(),
    suggestedTags,
    sessionLikeCount: sessionLikeKeys.size,
    memoryContext,
  };
}

export function parseDreamNarrativeResponse(
  raw: string,
  fallbackTags: string[],
): { title: string | null; body: string; tags: string[] } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const lines = trimmed.split(/\r?\n/);
  const explicitBodyIndex = lines.findIndex((line) => /^Body:\s*/i.test(line));

  let title: string | null = null;
  let parsedTags: string[] = [];
  let sawHeaderTags = false;
  let trailingTags: string[] = [];
  let bodyLines: string[] = [];

  if (explicitBodyIndex >= 0) {
    for (let index = 0; index < explicitBodyIndex; index++) {
      const line = lines[index] ?? "";
      const titleMatch = line.match(/^Title:\s*(.+)$/i);
      if (titleMatch && title === null) {
        title = titleMatch[1]?.trim() || null;
        continue;
      }
      const tagsMatch = line.match(/^Tags:\s*(.+)$/i);
      if (tagsMatch && parsedTags.length === 0) {
        sawHeaderTags = true;
        parsedTags =
          tagsMatch[1]
            ?.split(/\s+/)
            .map((tag) => tag.replace(/^#/, "").trim())
            .filter(Boolean) ?? [];
      }
    }

    let consumedTrailingTags = false;
    const trailingTagsIndex = findLastNonEmptyLineIndex(lines, explicitBodyIndex);
    if (trailingTagsIndex > explicitBodyIndex) {
      const trailingLine = lines[trailingTagsIndex] ?? "";
      const tagsMatch = trailingLine.match(/^Tags:\s*(.+)$/i);
      if (tagsMatch) {
        consumedTrailingTags = true;
        trailingTags =
          tagsMatch[1]
            ?.split(/\s+/)
            .map((tag) => tag.replace(/^#/, "").trim())
            .filter(Boolean) ?? [];
        if (parsedTags.length === 0) {
          parsedTags = trailingTags;
        }
      }
    }

    const explicitBodyLine = lines[explicitBodyIndex] ?? "";
    const inlineBody = explicitBodyLine.replace(/^Body:\s*/i, "").trim();
    if (inlineBody.length > 0) {
      bodyLines.push(inlineBody);
    }

    const bodyEnd = consumedTrailingTags ? trailingTagsIndex : lines.length;
    bodyLines.push(...lines.slice(explicitBodyIndex + 1, bodyEnd));
  } else {
    let bodyStarted = false;
    for (const line of lines) {
      if (!bodyStarted) {
        const titleMatch = line.match(/^Title:\s*(.+)$/i);
        if (titleMatch && title === null) {
          title = titleMatch[1]?.trim() || null;
          continue;
        }
        const tagsMatch = line.match(/^Tags:\s*(.+)$/i);
        if (tagsMatch && parsedTags.length === 0) {
          parsedTags =
            tagsMatch[1]
              ?.split(/\s+/)
              .map((tag) => tag.replace(/^#/, "").trim())
              .filter(Boolean) ?? [];
          continue;
        }
        if (line.trim().length === 0 && (title !== null || parsedTags.length > 0)) {
          continue;
        }
        bodyStarted = true;
      }
      bodyLines.push(line);
    }
  }

  const body = bodyLines.join("\n").trim();
  if (body.length === 0) return null;
  return {
    title,
    body,
    tags: uniqueTags(
      parsedTags.length > 0
        ? sawHeaderTags && trailingTags.length > 0
          ? [...parsedTags, ...trailingTags]
          : parsedTags
        : fallbackTags,
    ),
  };
}
