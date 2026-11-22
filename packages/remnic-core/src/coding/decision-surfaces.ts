/**
 * Decision-record surface contract + handler (issue #1548 Track A PR 2).
 *
 * Rule 39: one gate predicate, checked identically on every surface. Rule 22
 * spirit: one implementation behind three thin wirings. The service holds
 * only a thin delegate that builds a {@link DecisionSurfaceContext} and calls
 * {@link handleCodingDecision}; the handler logic lives here so the
 * access-service god file gains thin wiring only.
 *
 * No orchestrator imports (rule 11 — no shared mutable state). No circular
 * dependency on access-service.ts: validation errors are thrown via
 * `ctx.throwInputError`, which the service wires to EngramAccessInputError.
 */
import type { CodingKnowledgeConfig, CodingContext, MemoryFile, MemoryFrontmatter, MemoryStatus } from "../types.js";
import {
  ACTIVE_DECISION_STATUSES,
  DEFAULT_DECISION_STATUS,
  isDecisionStatus,
  parseDecisionRecord,
  serializeDecisionRecord,
  type DecisionRecord,
  type DecisionStatus,
} from "./decision-records.js";
import { log } from "../logger.js";
import { composeMemoryEnvelope, type SealedMemoryEnvelope } from "../write-envelope.js";
import type { MemoryWriteResult } from "../storage.js";
import { isCodingKnowledgeFeatureEnabled } from "./coding-knowledge-config.js";

// ──────────────────────────────────────────────────────────────────────────

export const DECISION_SUBCOMMANDS = [
  "list",
  "get",
  "record",
  "supersede",
] as const;

export type DecisionSubcommand = (typeof DECISION_SUBCOMMANDS)[number];

const SUBCOMMAND_VALUES = DECISION_SUBCOMMANDS as readonly string[];

export function isDecisionSubcommand(value: unknown): value is DecisionSubcommand {
  return typeof value === "string" && SUBCOMMAND_VALUES.includes(value);
}

/**
 * Human-readable subcommand list for error messages (rule 51 — list valid
 * options so the caller can correct rather than guess).
 */
export function formatDecisionSubcommands(): string {
  return DECISION_SUBCOMMANDS.join(", ");
}


// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Canonical surface request — one shape for all three transports. The
 * `subcommand` field selects which operation runs; the remaining fields are
 * optional depending on the subcommand.
 *
 * `sessionKey` identifies the session whose coding context scopes the
 * operation. `namespace` overrides the coding-scoped namespace (same
 * precedence as `memory_store` — explicit namespace wins).
 */
export interface DecisionSurfaceRequest {
  subcommand: DecisionSubcommand;
  sessionKey?: string;
  namespace?: string;
  id?: string;
  title?: string;
  status?: string;
  context?: string;
  decision?: string;
  consequences?: string;
  entityRefs?: string[];
  supersedesId?: string;
}

/**
 * Surface response — a discriminated union on `subcommand`. Each surface
 * serializes this to its transport-appropriate shape.
 */
export type DecisionSurfaceResponse =
  | { subcommand: "list"; records: DecisionSurfaceRecord[]; count: number }
  | { subcommand: "get"; found: boolean; record?: DecisionSurfaceRecord }
  | { subcommand: "record"; memoryId: string; status: string }
  | {
      subcommand: "supersede";
      supersededMemoryId: string;
      replacementMemoryId: string;
    };

/**
 * Flattened record projection surfaced to clients. Stored as markdown +
 * frontmatter memory files (category `"decision"`) — this shape is the
 * read-side projection, not the storage format.
 */
export interface DecisionSurfaceRecord {
  id: string;
  title: string;
  status: string;
  context?: string;
  decision?: string;
  consequences?: string;
  entityRefs: string[];
  supersedes?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Structural subset of StorageManager the decision handler reads or writes.
 * Kept narrow so the module stays decoupled from storage.ts and is
 * unit-testable with a stub.
 */
export interface DecisionSurfaceStorage {
  readonly dir: string;
  /** The resolved namespace — used for catalog write recording. */
  readonly namespace: string;
  readAllMemories(): Promise<readonly MemoryFile[]>;
  getMemoryById(id: string): Promise<MemoryFile | null>;
  /**
   * Sealed-envelope write entry point (issue #1989 PR4). The envelope owns
   * content/category/tags/attributes; the outer lifecycle status (set to
   * "archived" for inactive decisions so generic recall/search/maintenance
   * exclude them — review P2) stays a per-write extra.
   */
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { status?: MemoryStatus },
  ): Promise<MemoryWriteResult>;
  writeMemoryFrontmatter(
    memory: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
  ): Promise<unknown>;
}

/**
 * Dependencies the handler borrows from the service. The service constructs
 * this context per call; the handler never touches the orchestrator directly.
 * `throwInputError` lets the handler raise the surface-appropriate error
 * class without importing access-service.ts (no circular dependency).
 */
export interface DecisionSurfaceContext {
  readonly codingKnowledge: CodingKnowledgeConfig;
  getCodingContext(sessionKey: string): CodingContext | null;
  /** Resolve storage through the SAME namespace path as memory_store
   *  (principal ACL + coding overlay + default fallback). The #1522 storage
   *  chokepoint records the catalog write automatically on every
   *  storage.writeMemory, so the handler does NOT touch the catalog itself. */
  resolveStorage(request: DecisionSurfaceRequest): Promise<DecisionSurfaceStorage>;
  /** Throw the surface-appropriate input-validation error. */
  throwInputError(message: string): never;
  /** Server-resolved connector identity for provenance stamping. */
  readonly sourceConnector?: string;
}

/**
 * The single shared implementation behind the MCP, HTTP, and CLI
 * decision-record surfaces. All three transports dispatch through the
 * `coding_decision` boundary operation, which calls this function via the
 * service delegate.
 *
 * Gate (rule 39): `codingKnowledge.enabled + decisionRecords + coding
 * context`. Persistence (rule 43): records are written through the storage
 * manager's normal persist pipeline with category `"decision"` — no direct
 * `fs` writes of memory content. Supersede (rule 25): the replacement is
 * written BEFORE the old record's `structuredAttributes.decisionStatus` is
 * set to `"superseded"` — the structuredAttribute is the authoritative
 * lifecycle marker; content is never rewritten.
 */
export async function handleCodingDecision(
  request: DecisionSurfaceRequest,
  ctx: DecisionSurfaceContext,
): Promise<DecisionSurfaceResponse> {
  const codingContext = request.sessionKey
    ? ctx.getCodingContext(request.sessionKey)
    : null;
  if (!isCodingKnowledgeFeatureEnabled(ctx.codingKnowledge, "decisionRecords", codingContext)) {
    ctx.throwInputError(
      "coding_decision requires codingKnowledge.enabled, codingKnowledge.decisionRecords, and an attached coding context",
    );
  }
  switch (request.subcommand) {
    case "list":
      return decisionList(request, ctx);
    case "get":
      return decisionGet(request, ctx);
    case "record":
      return decisionRecord(request, ctx);
    case "supersede":
      return decisionSupersede(request, ctx);
  }
}

async function decisionList(
  request: DecisionSurfaceRequest,
  ctx: DecisionSurfaceContext,
): Promise<DecisionSurfaceResponse> {
  const storage = await ctx.resolveStorage(request);
  const memories = await storage.readAllMemories();
  const records: DecisionSurfaceRecord[] = [];
  for (const m of memories) {
    if (m.frontmatter.category !== "decision") continue;
    const memStatus = m.frontmatter.status;
    if (memStatus && memStatus !== "active") continue;
    const parsed = safeParseDecisionRecord(m.content);
    if (!parsed) continue;
    const structStatus = m.frontmatter.structuredAttributes?.decisionStatus;
    const effectiveStatus = structStatus ?? parsed.status;
    records.push({
      id: m.frontmatter.id,
      title: parsed.title,
      status: effectiveStatus,
      entityRefs: parsed.entityRefs,
      supersedes: parsed.supersedes,
    });
  }
  const visible = records.filter((r) =>
    ACTIVE_DECISION_STATUSES.has(r.status as DecisionStatus),
  );
  return { subcommand: "list", records: visible, count: visible.length };
}

async function decisionGet(
  request: DecisionSurfaceRequest,
  ctx: DecisionSurfaceContext,
): Promise<DecisionSurfaceResponse> {
  if (!request.id?.trim()) {
    ctx.throwInputError("id is required for the 'get' subcommand");
  }
  const storage = await ctx.resolveStorage(request);
  const memory = await storage.getMemoryById(request.id!);
  if (!memory || memory.frontmatter.category !== "decision") {
    return { subcommand: "get", found: false };
  }
  const parsed = safeParseDecisionRecord(memory.content);
  if (!parsed) {
    return { subcommand: "get", found: false };
  }
  const structStatus = memory.frontmatter.structuredAttributes?.decisionStatus;
  return {
    subcommand: "get",
    found: true,
    record: {
      id: memory.frontmatter.id,
      title: parsed.title,
      status: structStatus ?? parsed.status,
      context: parsed.context,
      decision: parsed.decision,
      consequences: parsed.consequences,
      entityRefs: parsed.entityRefs,
      supersedes: parsed.supersedes,
    },
  };
}

async function decisionRecord(
  request: DecisionSurfaceRequest,
  ctx: DecisionSurfaceContext,
): Promise<DecisionSurfaceResponse> {
  if (!request.title?.trim()) {
    ctx.throwInputError("title is required for the 'record' subcommand");
  }
  if (!request.decision?.trim()) {
    ctx.throwInputError("decision is required for the 'record' subcommand");
  }
  const status: DecisionStatus = request.status?.trim()
    ? isDecisionStatus(request.status)
      ? request.status
      : raiseInvalidStatus(request.status, ctx)
    : DEFAULT_DECISION_STATUS;
  const record: DecisionRecord = {
    id: "",
    title: request.title.trim(),
    status,
    context: request.context?.trim() ?? "",
    decision: request.decision.trim(),
    consequences: request.consequences?.trim() ?? "",
    entityRefs: request.entityRefs ?? [],
  };
  const content = serializeDecisionRecord(record);
  const storage = await ctx.resolveStorage(request);
  const isActive = ACTIVE_DECISION_STATUSES.has(status);
  const decisionEnvelope = composeMemoryEnvelope(
    {
      content,
      category: "decision",
      confidence: 1.0,
      tags: ["decision-record"],
      structuredAttributes: { decisionStatus: status },
      ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}),
    },
    { source: "coding-decision" },
  );
  const { id: memoryId } = await storage.writeSealedMemory(decisionEnvelope, {
    status: isActive ? undefined : "archived",
  });
  log.info(
    `access-write op=coding_decision/record memoryId=${memoryId} status=${status}`,
  );
  return { subcommand: "record", memoryId, status };
}

async function decisionSupersede(
  request: DecisionSurfaceRequest,
  ctx: DecisionSurfaceContext,
): Promise<DecisionSurfaceResponse> {
  const targetId = request.id?.trim() || request.supersedesId?.trim();
  if (!targetId) {
    ctx.throwInputError(
      "id (or supersedesId) is required for the 'supersede' subcommand (the record being superseded)",
    );
  }
  if (!request.title?.trim()) {
    ctx.throwInputError(
      "title is required for the 'supersede' subcommand (the replacement record)",
    );
  }
  if (!request.decision?.trim()) {
    ctx.throwInputError("decision is required for the 'supersede' subcommand");
  }
  const storage = await ctx.resolveStorage(request);
  const oldMemory = await storage.getMemoryById(targetId);
  if (!oldMemory || oldMemory.frontmatter.category !== "decision") {
    ctx.throwInputError(`decision record not found: ${targetId}`);
  }
  const oldParsed = safeParseDecisionRecord(oldMemory.content);
  if (!oldParsed) {
    ctx.throwInputError(
      `decision record is corrupted and cannot be superseded: ${targetId}`,
    );
  }
  const replacement: DecisionRecord = {
    id: "",
    title: request.title.trim(),
    status: "accepted",
    context: request.context?.trim() ?? "",
    decision: request.decision.trim(),
    consequences: request.consequences?.trim() ?? "",
    entityRefs: request.entityRefs ?? [],
    supersedes: targetId,
  };
  const replacementContent = serializeDecisionRecord(replacement);
  const { id: replacementId, tombstoneBlocked: replacementBlocked } = await storage.writeSealedMemory(
    composeMemoryEnvelope(
      {
        content: replacementContent,
        category: "decision",
        confidence: 1.0,
        tags: ["decision-record"],
        structuredAttributes: { decisionStatus: "accepted" },
        ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}),
      },
      { source: "coding-decision" },
    ),
    {},
  );
  if (replacementBlocked) {
    ctx.throwInputError(
      `replacement decision was tombstone-blocked (pending_review ${replacementId}) — keeping decision ${targetId} active`,
    );
  }
  try {
    await storage.writeMemoryFrontmatter(oldMemory, {
      status: "archived",
      updated: new Date().toISOString(),
      structuredAttributes: {
        ...(oldMemory.frontmatter.structuredAttributes ?? {}),
        decisionStatus: "superseded",
      },
    });
  } catch (err) {
    log.warn(
      `coding_decision/supersede: replacement ${replacementId} written but old record ${targetId} status update failed — old record will still appear until retried: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log.info(
    `access-write op=coding_decision/supersede superseded=${targetId} replacement=${replacementId}`,
  );
  return {
    subcommand: "supersede",
    supersededMemoryId: targetId,
    replacementMemoryId: replacementId,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

function safeParseDecisionRecord(content: string): DecisionRecord | null {
  try {
    return parseDecisionRecord(content);
  } catch {
    return null;
  }
}

function raiseInvalidStatus(value: string, ctx: DecisionSurfaceContext): never {
  ctx.throwInputError(
    `invalid decision status "${value}". Valid options: proposed, accepted, superseded, rejected`,
  );
}
