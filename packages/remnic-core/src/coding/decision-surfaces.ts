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

// ──────────────────────────────────────────────────────────────────────────
// Subcommands
// ──────────────────────────────────────────────────────────────────────────

export const DECISION_SUBCOMMANDS = [
  "list",
  "get",
  "record",
  "supersede",
] as const;

export type DecisionSubcommand = (typeof DECISION_SUBCOMMANDS)[number];

const SUBCOMMAND_VALUES = DECISION_SUBCOMMANDS as readonly string[];

/**
 * Type guard — narrows an unknown subcommand string to the
 * {@link DecisionSubcommand} union.
 */
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
// Gate predicate — rule 39: one predicate, identical on every surface
// ──────────────────────────────────────────────────────────────────────────

/**
 * The single decision-record surface gate. Returns `true` only when:
 *  1. `codingKnowledge.enabled` is on (the master Track A gate),
 *  2. `codingKnowledge.decisionRecords` is on (the feature switch), AND
 *  3. A coding context is attached (the session is project/branch scoped —
 *     decision records live *in* the coding namespace, rule 42).
 *
 * Every surface — MCP `engram.coding_decision`, HTTP
 * `POST /engram/v1/coding/decisions`, CLI `engram-access decision` — MUST call
 * this predicate (or the handler that embeds it) before dispatching. The
 * tool-visibility gate in the MCP constructor checks conditions 1–2 only
 * (coding context is per-session and cannot be evaluated at construction
 * time); the call-time gate checks all three.
 */
export function isDecisionRecordSurfaceEnabled(
  config: CodingKnowledgeConfig,
  codingContext: CodingContext | null | undefined,
): boolean {
  return (
    config.enabled === true &&
    config.decisionRecords === true &&
    codingContext != null
  );
}

/**
 * Config-only visibility gate — used by the MCP constructor to decide whether
 * to advertise `engram.coding_decision` in `tools/list`. When this returns
 * `false` the tools array is byte-identical to pre-feature (rule 39).
 */
export function isDecisionRecordSurfaceVisible(
  config: CodingKnowledgeConfig,
): boolean {
  return config.enabled === true && config.decisionRecords === true;
}

// ──────────────────────────────────────────────────────────────────────────
// Surface request / response shapes
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
  // get / supersede
  id?: string;
  // record
  title?: string;
  status?: string;
  context?: string;
  decision?: string;
  consequences?: string;
  entityRefs?: string[];
  // supersede
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
// Handler — the single implementation behind all three surfaces (rule 22)
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
  if (!isDecisionRecordSurfaceEnabled(ctx.codingKnowledge, codingContext)) {
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
    // Exclude lifecycle-retired memories. Any outer frontmatter.status other
    // than undefined/"active" (archived, superseded, forgotten, rejected,
    // quarantined, pending_review) means the generic memory lifecycle has
    // intervened — hide the decision until that resolves. The decision-specific
    // lifecycle marker lives in structuredAttributes.decisionStatus (review:
    // hide all non-active outer statuses from decisions).
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
  // Sealed-envelope write (issue #1989 PR4): operator/API-built decision
  // record — strict compose; envelope-owned fields ride the envelope, the
  // status/connector extras stay explicit.
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
    // Persist the decision lifecycle in BOTH places so generic
    // recall/search/maintenance (which read frontmatter.status) and the
    // decision list/get projection (which reads structuredAttributes) agree:
    //   - structuredAttributes.decisionStatus is the authoritative decision
    //     marker, mirrored from the serialized body (one source of truth);
    //   - frontmatter.status is set to "archived" for inactive decisions
    //     (rejected/superseded) so the outer memory pipeline excludes them
    //     from the active corpus exactly like a supersede does (review P2:
    //     persist inactive decision statuses in frontmatter).
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
  // The schema advertises `supersedesId` for MCP/HTTP clients that name it
  // explicitly; treat it as an alias for `id` when `id` is absent (review P2).
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
  // Rule 25: write the replacement BEFORE mutating the old record's status.
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
  // Sealed-envelope write (issue #1989 PR4): strict — see decisionRecord.
  // Mirror decisionRecord: persist structuredAttributes.decisionStatus on
  // the replacement so list/get projection and QMD indexing see the
  // authoritative marker (review: supersede omits decisionStatus attrs).
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
    // #1645: the replacement decision matched a tombstone (pending_review).
    // Don't archive the old record — superseding with a non-active
    // replacement retires the only active decision. Abort; old stays active.
    ctx.throwInputError(
      `replacement decision was tombstone-blocked (pending_review ${replacementId}) — keeping decision ${targetId} active`,
    );
  }
  // Mark the old record superseded: set BOTH frontmatter.status (so
  // recall/search/maintenance exclude it from the active corpus — review P2)
  // AND structuredAttributes.decisionStatus (the decision-specific lifecycle
  // marker used by list/get projection). The content body is not mutated.
  // Rule 25: the replacement is written BEFORE the old record is mutated so
  // a frontmatter-write failure leaves a harmless duplicate, not a missing
  // record. Best-effort: log the failure but don't roll back the replacement
  // (review: cursor partial-write thread).
  try {
    await storage.writeMemoryFrontmatter(oldMemory, {
      status: "archived",
      // Refresh the updated timestamp so the archive/supersede lifecycle event
      // and browse/maintenance sort key reflect when the decision was retired,
      // not when it was originally recorded (review: set updated timestamp when
      // retiring old decisions).
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
// Local helpers
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
