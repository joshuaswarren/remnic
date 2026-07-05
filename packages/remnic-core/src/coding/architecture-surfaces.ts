/**
 * Architecture-card surface contract + handler (issue #1548 Track A PR 3).
 *
 * Mirrors the decision-surfaces pattern (PR 2): one shared implementation
 * behind the MCP, HTTP, and CLI surfaces. All three transports dispatch
 * through the `coding_architecture` boundary operation, which calls
 * {@link handleCodingArchitecture} via the service delegate.
 *
 * Gate (rule 39): `codingKnowledge.enabled + architectureCard + coding
 * context` — one predicate, identical on every surface. The tools/list
 * visibility gate checks conditions 1–2 only (config-level).
 *
 * Persistence (rule 43): the card is written through the storage
 * manager's normal persist pipeline (writeMemory for the initial card,
 * updateMemory for refreshes) so catalog recording + reindex fire. No
 * direct `fs` writes of memory content. Each refresh snapshots the
 * prior content via page-versioning before overwriting (rule 25 —
 * preserve the old before the new is ready).
 *
 * Subcommands:
 *  - `get`: return the current architecture card (or not-found).
 *  - `refresh`: build a fresh card from the repo, persist it, and
 *    snapshot the prior version.
 */
import type {
  CodingKnowledgeConfig,
  CodingContext,
  MemoryFile,
  MemoryFrontmatter,
  MemoryStatus,
} from "../types.js";
import type { VersionTrigger, VersioningConfig } from "../page-versioning.js";
import { ARCHITECTURE_CARD_TRUNCATION_MARKER, type ArchitectureCardBuildResult } from "./architecture-card.js";
import { log } from "../logger.js";

// ──────────────────────────────────────────────────────────────────────────
// Subcommands
// ──────────────────────────────────────────────────────────────────────────

export const ARCHITECTURE_SUBCOMMANDS = ["get", "refresh"] as const;

export type ArchitectureSubcommand = (typeof ARCHITECTURE_SUBCOMMANDS)[number];

const SUBCOMMAND_VALUES = ARCHITECTURE_SUBCOMMANDS as readonly string[];

/** Type guard — narrows an unknown subcommand string. */
export function isArchitectureSubcommand(value: unknown): value is ArchitectureSubcommand {
  return typeof value === "string" && SUBCOMMAND_VALUES.includes(value);
}

/** Human-readable subcommand list for error messages (rule 51). */
export function formatArchitectureSubcommands(): string {
  return ARCHITECTURE_SUBCOMMANDS.join(", ");
}

// ──────────────────────────────────────────────────────────────────────────
// Gate predicates — rule 39: one predicate, identical on every surface
// ──────────────────────────────────────────────────────────────────────────

/**
 * The single architecture-card surface gate. Returns `true` only when:
 *  1. `codingKnowledge.enabled` is true,
 *  2. `codingKnowledge.architectureCard` is true,
 *  3. a coding context is attached (so a repo root is available).
 */
export function isArchitectureCardSurfaceEnabled(
  config: CodingKnowledgeConfig,
  codingContext: CodingContext | null | undefined,
): boolean {
  return (
    config.enabled === true &&
    config.architectureCard === true &&
    codingContext !== null &&
    codingContext !== undefined
  );
}

/**
 * Config-only visibility gate — used by the MCP constructor to decide
 * whether to advertise `engram.coding_architecture` in `tools/list`.
 * When this returns `false` the tools array is byte-identical to
 * pre-feature (rule 39).
 */
export function isArchitectureCardSurfaceVisible(
  config: CodingKnowledgeConfig,
): boolean {
  return config.enabled === true && config.architectureCard === true;
}

// ──────────────────────────────────────────────────────────────────────────
// Surface request / response shapes
// ──────────────────────────────────────────────────────────────────────────

/** Canonical surface request — one shape for all three transports. */
export interface ArchitectureSurfaceRequest {
  subcommand: ArchitectureSubcommand;
  sessionKey?: string;
  namespace?: string;
}

/** Surface response — discriminated union on `subcommand`. */
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
    };

// ──────────────────────────────────────────────────────────────────────────
// Storage contract — narrow subset of StorageManager
// ──────────────────────────────────────────────────────────────────────────

/** Tag identifying the architecture card memory (single card per namespace). */
export const ARCHITECTURE_CARD_TAG = "architecture-card";

/** Structured attribute marking a memory as the architecture card. */
export const ARCHITECTURE_CARD_KIND = "architecture";

/**
 * Structural subset of StorageManager the architecture handler reads or
 * writes. Kept narrow so the module stays decoupled from storage.ts and
 * is unit-testable with a stub.
 */
export interface ArchitectureSurfaceStorage {
  readonly dir: string;
  /** The resolved namespace — used for logging/observability. */
  readonly namespace: string;
  readAllMemories(): Promise<readonly MemoryFile[]>;
  writeMemory(
    category: "fact",
    content: string,
    options: {
      confidence?: number;
      tags?: string[];
      source?: string;
      status?: MemoryStatus;
      structuredAttributes?: Record<string, string>;
    },
  ): Promise<string>;
  updateMemory(
    id: string,
    newContent: string,
    options?: { supersedes?: string; lineage?: string[]; actor?: string },
  ): Promise<boolean>;
}

/**
 * Card-builder dependency. The handler delegates repo scanning to this
 * function so tests can inject a fixed card without touching the
 * filesystem.
 */
export type ArchitectureCardBuilder = (
  repoRoot: string,
) => Promise<ArchitectureCardBuildResult>;

/**
 * Page-versioning snapshot dependency. The handler calls this BEFORE
 * overwriting the card content so the prior version is preserved
 * (rule 25).
 */
export interface ArchitectureVersioningHook {
  /**
   * Snapshot the current content of the card memory before refresh.
   * Failures are logged but do not block the refresh (best-effort).
   */
  snapshotIfExists(memory: MemoryFile): Promise<void>;
}

/**
 * Dependencies the handler borrows from the service. The service
 * constructs this context per call; the handler never touches the
 * orchestrator directly.
 */
export interface ArchitectureSurfaceContext {
  readonly codingKnowledge: CodingKnowledgeConfig;
  getCodingContext(sessionKey: string): CodingContext | null;
  /** Resolve storage through the SAME namespace path as memory_store. */
  resolveStorage(request: ArchitectureSurfaceRequest): Promise<ArchitectureSurfaceStorage>;
  /** Build the architecture card from a repo root. */
  buildCard: ArchitectureCardBuilder;
  /** Snapshot the prior card version before refresh (rule 25). */
  versioning: ArchitectureVersioningHook;
  /** Throw the surface-appropriate input-validation error. */
  throwInputError(message: string): never;
}

// ──────────────────────────────────────────────────────────────────────────
// Handler — the single shared implementation behind all three surfaces
// ──────────────────────────────────────────────────────────────────────────

/**
 * The single shared implementation behind the MCP, HTTP, and CLI
 * architecture-card surfaces.
 *
 * Gate (rule 39): `codingKnowledge.enabled + architectureCard + coding
 * context`. Persistence (rule 43): cards are written through the storage
 * manager's normal persist pipeline. Refresh (rule 25): the prior card
 * is snapshotted via page-versioning BEFORE the content is overwritten.
 */
export async function handleCodingArchitecture(
  request: ArchitectureSurfaceRequest,
  ctx: ArchitectureSurfaceContext,
): Promise<ArchitectureSurfaceResponse> {
  const codingContext = request.sessionKey
    ? ctx.getCodingContext(request.sessionKey)
    : null;
  // Rule 39 + type-guard narrowing: check `codingContext` inline so TS
  // narrows it to CodingContext here, with no non-null assertion cast.
  if (
    codingContext === null ||
    !isArchitectureCardSurfaceEnabled(ctx.codingKnowledge, codingContext)
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
// Subcommand handlers
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
  return {
    subcommand: "get",
    found: true,
    card: {
      content: existing.content,
      generatedAt: existing.frontmatter.updated ?? existing.frontmatter.created,
      byteSize: Buffer.byteLength(existing.content, "utf-8"),
      // Derive truncation from the CONTENT marker, not a frontmatter tag —
      // the refresh update path changes content without rewriting tags, so
      // a tag-based check goes stale (cursor review: stale truncated tag).
      truncated: existing.content.includes(ARCHITECTURE_CARD_TRUNCATION_MARKER),
    },
  };
}

async function architectureRefresh(
  request: ArchitectureSurfaceRequest,
  ctx: ArchitectureSurfaceContext,
  codingContext: CodingContext,
): Promise<ArchitectureSurfaceResponse> {
  const repoRoot = codingContext.rootPath ?? codingContext.projectId;
  const buildResult = await ctx.buildCard(repoRoot);
  if (!buildResult.ok) {
    // A failed build is a tagged outcome, not a crash. Log the full detail
    // for operators; it may include absolute paths / raw I/O messages that
    // must NOT reach clients (cursor review: raw build errors reach clients).
    log.warn(
      `coding_architecture/refresh: card build failed (code=${buildResult.code}): ${buildResult.detail}`,
    );
    // Persist nothing on build failure — no stale card left behind (rule 44).
    // Client-facing error carries only the code.
    ctx.throwInputError(
      `coding_architecture refresh failed: card build returned ${buildResult.code}`,
    );
  }

  const storage = await ctx.resolveStorage(request);
  const cardContent = buildResult.card.content;
  const tags = [ARCHITECTURE_CARD_TAG];
  if (buildResult.card.truncated) tags.push("truncated");

  const existing = await findArchitectureCardMemory(storage);
  if (existing) {
    // rule 25: snapshot the prior content BEFORE overwriting.
    await ctx.versioning.snapshotIfExists(existing);
    const updated = await storage.updateMemory(existing.frontmatter.id, cardContent, {
      actor: "coding-architecture-refresh",
    });
    if (!updated) {
      log.warn(
        `coding_architecture/refresh: updateMemory returned false for id=${existing.frontmatter.id} — falling back to writeMemory`,
      );
      const memoryId = await storage.writeMemory("fact", cardContent, {
        confidence: 1.0,
        tags,
        source: "coding-architecture",
        structuredAttributes: { cardKind: ARCHITECTURE_CARD_KIND },
      });
      log.info(
        `access-write op=coding_architecture/refresh memoryId=${memoryId} (fallback write) byteSize=${buildResult.card.byteSize}`,
      );
      return {
        subcommand: "refresh",
        refreshed: true,
        memoryId,
        byteSize: buildResult.card.byteSize,
        truncated: buildResult.card.truncated,
      };
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

  // First card for this namespace — write a new memory.
  const memoryId = await storage.writeMemory("fact", cardContent, {
    confidence: 1.0,
    tags,
    source: "coding-architecture",
    structuredAttributes: { cardKind: ARCHITECTURE_CARD_KIND },
  });
  log.info(
    `access-write op=coding_architecture/refresh memoryId=${memoryId} (new) byteSize=${buildResult.card.byteSize}`,
  );
  return {
    subcommand: "refresh",
    refreshed: true,
    memoryId,
    byteSize: buildResult.card.byteSize,
    truncated: buildResult.card.truncated,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Local helpers
// ──────────────────────────────────────────────────────────────────────────

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
    // Require the cardKind structured attribute so a user-created fact that
    // merely happens to be tagged "architecture-card" is NOT mistaken for
    // the managed card and overwritten on refresh (codex review).
    if (m.frontmatter.structuredAttributes?.cardKind !== ARCHITECTURE_CARD_KIND) return false;
    // Any outer status other than undefined/"active" means retired.
    const outer = m.frontmatter.status;
    if (outer !== undefined && outer !== "active") return false;
    // Also skip cards archived via archivedAt without an explicit status
    // (cursor review: archived cards can still match the tag filter).
    if (m.frontmatter.archivedAt !== undefined && m.frontmatter.archivedAt !== null) return false;
    return true;
  });
  if (cards.length === 0) return null;
  // Most recently updated wins (deterministic tie-break by id).
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

/**
 * Build the page-versioning snapshot hook from operator config.
 *
 * - Skips entirely when versioning is disabled — no sidecars written for a
 *   feature the operator turned off (codex review: hardcoded config ignored
 *   operator settings).
 * - Reads the FULL file (frontmatter + body) from disk so a revert restores
 *   the complete memory, not just the body (codex review: snapshot was
 *   body-only).
 */
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
