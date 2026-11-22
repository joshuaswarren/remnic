import { codingContextLocalRoot } from "../access-coding-context-resolution.js";
import type {
  CodingKnowledgeConfig,
  CodingContext,
  MemoryFile,
  MemoryFrontmatter,
  MemoryStatus,
} from "../types.js";
import type { VersionTrigger, VersioningConfig } from "../page-versioning.js";
import type { MemoryWriteResult } from "../storage.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import { ARCHITECTURE_CARD_TRUNCATION_MARKER, type ArchitectureCardBuildResult } from "./architecture-card.js";
import { log } from "../logger.js";
import { composeMemoryEnvelope, type SealedMemoryEnvelope } from "../write-envelope.js";
import { isCodingKnowledgeFeatureEnabled } from "./coding-knowledge-config.js";

// ──────────────────────────────────────────────────────────────────────────

export const ARCHITECTURE_SUBCOMMANDS = ["get", "refresh"] as const;

export type ArchitectureSubcommand = (typeof ARCHITECTURE_SUBCOMMANDS)[number];

const SUBCOMMAND_VALUES = ARCHITECTURE_SUBCOMMANDS as readonly string[];

export function isArchitectureSubcommand(value: unknown): value is ArchitectureSubcommand {
  return typeof value === "string" && SUBCOMMAND_VALUES.includes(value);
}

export function formatArchitectureSubcommands(): string {
  return ARCHITECTURE_SUBCOMMANDS.join(", ");
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/** Canonical surface request — one shape for all three transports. */
export interface ArchitectureSurfaceRequest {
  subcommand: ArchitectureSubcommand;
  sessionKey?: string;
  namespace?: string;
}

export type ArchitectureSurfaceResponse =
  | {
      subcommand: "get";
      found: boolean;
      card?: {
        content: string;
        generatedAt: string;
        byteSize: number;
        truncated: boolean;
      };
    }
  | {
      subcommand: "refresh";
      refreshed: boolean;
      memoryId: string;
      byteSize: number;
      truncated: boolean;
      buildCode?: string;
      /**
       * Present when the refresh was tombstone-blocked (#1579): the new card
       * content landed pending_review (no active overwrite). Callers/UI surface
       * this so operators see why the active card didn't update (#1645).
       */
      blockedReason?: string;
      /** The tombstone id that blocked the write, when `blockedReason` is set. */
      blockedBy?: string;
    };

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/** Tag identifying the architecture card memory (single card per namespace). */
export const ARCHITECTURE_CARD_TAG = "architecture-card";

/** Structured attribute marking a memory as the architecture card. */
export const ARCHITECTURE_CARD_KIND = "architecture";

export interface ArchitectureSurfaceStorage {
  readonly dir: string;
  /** The resolved namespace — used for logging/observability. */
  readonly namespace: string;
  readAllMemories(): Promise<readonly MemoryFile[]>;
  /** Sealed-envelope write entry point (issue #1989 PR4). */
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { status?: MemoryStatus },
  ): Promise<MemoryWriteResult>;
  updateMemory(
    id: string,
    newContent: string,
    options?: { supersedes?: string; lineage?: string[]; actor?: string; sourceConnector?: string },
  ): Promise<boolean>;
}

export type ArchitectureCardBuilder = (
  repoRoot: string,
) => Promise<ArchitectureCardBuildResult>;

export interface ArchitectureVersioningHook {
  /**
   * Snapshot the current content of the card memory before refresh.
   * Failures are logged but do not block the refresh (best-effort).
   */
  snapshotIfExists(memory: MemoryFile): Promise<void>;
}

export interface ArchitectureSurfaceContext {
  readonly codingKnowledge: CodingKnowledgeConfig;
  getCodingContext(sessionKey: string): CodingContext | null;
  resolveStorage(request: ArchitectureSurfaceRequest): Promise<ArchitectureSurfaceStorage>;
  buildCard: ArchitectureCardBuilder;
  versioning: ArchitectureVersioningHook;
  throwInputError(message: string): never;
  /** Server-resolved connector identity for provenance. */
  readonly sourceConnector?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export async function handleCodingArchitecture(
  request: ArchitectureSurfaceRequest,
  ctx: ArchitectureSurfaceContext,
): Promise<ArchitectureSurfaceResponse> {
  const codingContext = request.sessionKey
    ? ctx.getCodingContext(request.sessionKey)
    : null;
  if (
    codingContext === null ||
    !isCodingKnowledgeFeatureEnabled(ctx.codingKnowledge, "architectureCard", codingContext)
  ) {
    ctx.throwInputError(
      "coding_architecture requires codingKnowledge.enabled, codingKnowledge.architectureCard, and an attached coding context",
    );
  }
  switch (request.subcommand) {
    case "get":
      return architectureGet(request, ctx);
    case "refresh":
      return architectureRefresh(request, ctx, codingContext);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────


async function architectureGet(
  request: ArchitectureSurfaceRequest,
  ctx: ArchitectureSurfaceContext,
): Promise<ArchitectureSurfaceResponse> {
  const storage = await ctx.resolveStorage(request);
  const existing = await findArchitectureCardMemory(storage);
  if (!existing) {
    return { subcommand: "get", found: false };
  }
  const content = stripAttributesSuffix(existing.content);
  return {
    subcommand: "get",
    found: true,
    card: {
      content,
      generatedAt: existing.frontmatter.updated ?? existing.frontmatter.created,
      byteSize: Buffer.byteLength(content, "utf-8"),
      truncated: content.includes(ARCHITECTURE_CARD_TRUNCATION_MARKER),
    },
  };
}

async function architectureRefresh(
  request: ArchitectureSurfaceRequest,
  ctx: ArchitectureSurfaceContext,
  codingContext: CodingContext,
): Promise<ArchitectureSurfaceResponse> {
  const repoRoot = codingContextLocalRoot(codingContext);
  const storage = await ctx.resolveStorage(request);
  const buildResult = await ctx.buildCard(repoRoot);
  if (!buildResult.ok) {
    log.warn(
      `coding_architecture/refresh: card build failed (code=${buildResult.code}): ${buildResult.detail}`,
    );
    ctx.throwInputError(
      `coding_architecture refresh failed: card build returned ${buildResult.code}`,
    );
  }

  const cardContent = buildResult.card.content;
  const tags = [ARCHITECTURE_CARD_TAG];
  if (buildResult.card.truncated) tags.push("truncated");

  const existing = await findArchitectureCardMemory(storage);
  if (existing) {
    await ctx.versioning.snapshotIfExists(existing);
    const updated = await storage.updateMemory(existing.frontmatter.id, cardContent, {
      actor: "coding-architecture-refresh",
      ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}),
    });
    if (!updated) {
      log.warn(
        `coding_architecture/refresh: updateMemory returned false for id=${existing.frontmatter.id} — falling back to writeMemory`,
      );
      const fallbackWrite = await storage.writeSealedMemory(
        composeMemoryEnvelope(
          {
            content: cardContent,
            category: "fact",
            confidence: 1.0,
            tags,
            structuredAttributes: { cardKind: ARCHITECTURE_CARD_KIND },
            ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}),
          },
          { source: "coding-architecture" },
        ),
        {},
      );
      log.info(
        `access-write op=coding_architecture/refresh memoryId=${fallbackWrite.id} (fallback write) byteSize=${buildResult.card.byteSize}`,
      );
      return refreshResponse(fallbackWrite, buildResult.card);
    }
    log.info(
      `access-write op=coding_architecture/refresh memoryId=${existing.frontmatter.id} (updated) byteSize=${buildResult.card.byteSize}`,
    );
    return {
      subcommand: "refresh",
      refreshed: true,
      memoryId: existing.frontmatter.id,
      byteSize: buildResult.card.byteSize,
      truncated: buildResult.card.truncated,
    };
  }

  const newWrite = await storage.writeSealedMemory(
    composeMemoryEnvelope(
      {
        content: cardContent,
        category: "fact",
        confidence: 1.0,
        tags,
        structuredAttributes: { cardKind: ARCHITECTURE_CARD_KIND },
        ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}),
      },
      { source: "coding-architecture" },
    ),
    {},
  );
  log.info(
    `access-write op=coding_architecture/refresh memoryId=${newWrite.id} (new) byteSize=${buildResult.card.byteSize}`,
  );
  return refreshResponse(newWrite, buildResult.card);
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the refresh response from a write outcome, surfacing a
 * tombstone block (#1579) as `refreshed:false` + a blocked reason so
 * callers/UI see why the active card didn't update (#1645). Mirrors the
 * guard pattern in wearables/memory-gen.ts: a blocked write lands
 * pending_review (no active copy) and must NOT report `refreshed:true`.
 */
function refreshResponse(
  writeResult: MemoryWriteResult,
  card: { byteSize: number; truncated: boolean },
): ArchitectureSurfaceResponse {
  if (writeResult.tombstoneBlocked) {
    return {
      subcommand: "refresh",
      refreshed: false,
      memoryId: writeResult.id,
      byteSize: card.byteSize,
      truncated: card.truncated,
      blockedReason: "tombstone-blocked",
      ...(writeResult.blockedBy !== undefined ? { blockedBy: writeResult.blockedBy } : {}),
    };
  }
  return {
    subcommand: "refresh",
    refreshed: true,
    memoryId: writeResult.id,
    byteSize: card.byteSize,
    truncated: card.truncated,
  };
}

/**
 * Find the existing architecture-card memory in the namespace, if any.
 * Identified by the `architecture-card` tag + `cardKind=architecture`
 * structured attribute. A single card per namespace is the invariant;
 * if multiple exist (race), the most recently updated wins.
 */
export async function findArchitectureCardMemory(
  storage: ArchitectureSurfaceStorage,
): Promise<MemoryFile | null> {
  const memories = await storage.readAllMemories();
  const cards = memories.filter((m) => {
    if (m.frontmatter.category !== "fact") return false;
    const tags = m.frontmatter.tags ?? [];
    if (!tags.includes(ARCHITECTURE_CARD_TAG)) return false;
    if (m.frontmatter.structuredAttributes?.cardKind !== ARCHITECTURE_CARD_KIND) return false;
    const outer = m.frontmatter.status;
    if (outer !== undefined && outer !== "active") return false;
    if (m.frontmatter.archivedAt !== undefined && m.frontmatter.archivedAt !== null) return false;
    return true;
  });
  if (cards.length === 0) return null;
  cards.sort((a, b) => {
    const aUpdated = a.frontmatter.updated ?? a.frontmatter.created;
    const bUpdated = b.frontmatter.updated ?? b.frontmatter.created;
    if (aUpdated !== bUpdated) return bUpdated.localeCompare(aUpdated);
    return b.frontmatter.id.localeCompare(a.frontmatter.id);
  });
  return cards[0] ?? null;
}

/**
 * Build a {@link MemoryFrontmatter}-shaped patch that marks a memory as
 * the architecture card. Exported for test fixtures.
 */
export function architectureCardFrontmatterMarker(): Partial<MemoryFrontmatter> {
  return {
    tags: [ARCHITECTURE_CARD_TAG],
  };
}

/** Page-version snapshot writer (decoupled type — matches page-versioning.createVersion's call). */
type CreatePageVersion = (
  pagePath: string,
  content: string,
  trigger: VersionTrigger,
  config: VersioningConfig,
  logger: undefined,
  note: string,
  memoryDir: string,
) => Promise<unknown>;

export function createArchitectureVersioningHook(
  enabled: boolean,
  maxVersionsPerPage: number,
  sidecarDir: string,
  memoryDir: string,
  readFile: (path: string) => Promise<string>,
  writeVersion: CreatePageVersion,
): ArchitectureVersioningHook {
  return {
    async snapshotIfExists(memory) {
      if (!enabled) return;
      try {
        const fullContent = await readFile(memory.path);
        await writeVersion(
          memory.path,
          fullContent,
          "manual",
          { enabled: true, maxVersionsPerPage, sidecarDir },
          undefined,
          "architecture-card-refresh",
          memoryDir,
        );
      } catch {
        // Best-effort — a snapshot failure does not block the refresh.
      }
    },
  };
}
