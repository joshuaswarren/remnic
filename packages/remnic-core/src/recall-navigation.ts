/**
 * Recall navigation (issue #1956) — session-scoped follow-up tools over
 * already-served recall results.
 *
 * Composes existing primitives; owns no new storage and no new link types:
 *   - authority: the session's last `windowSnapshots` recall id sets
 *     (`RecallHandleHistoryStore`, the same ring `resolveMemoryHandle` reads)
 *   - isolation: every read resolves through the caller's resolved readable
 *     namespace and ONE storage instance (pattern 30 — no arbitrary-id
 *     fishing across namespaces)
 *   - disclosure: `planDisclosureStep` enforces strictly-deeper expansion;
 *     rendering reuses `shapeMemorySummary` (single formatter, rule 22)
 *   - links: frontmatter `links` via `selectTraverseNeighbors`
 *   - budget: per-call character cap drawn from the recall character budget,
 *     with per-item disclosure/token spend reported through the SAME
 *     disclosure accounting X-ray aggregates (`estimateRecallTokens` +
 *     `summarizeDisclosureTokens`).
 *
 * Unknown, expired (outside the window), or foreign ids are rejected with a
 * typed error naming the constraint (pattern 39) — never reinterpreted.
 */

import { EngramAccessInputError, shapeMemorySummary, type EngramAccessMemorySummary } from "./access-service.js";
import { estimateRecallTokens, summarizeDisclosureTokens, type RecallXrayDisclosureSummary } from "./recall-xray.js";
import { assertIdInNavigationWindow } from "./recall-navigate-window.js";
import { parseNavigateLinkType } from "./recall-navigate-link.js";
import { planDisclosureStep } from "./recall-navigate-disclosure.js";
import { selectTraverseNeighbors, DEFAULT_TRAVERSE_LIMIT, type TraverseNeighbor } from "./recall-navigate-traverse.js";
import { renderNavigationResult } from "./recall-navigation-renderer.js";
import type { RecallNavigationConfig } from "./recall-navigation-config.js";
import type { MemoryFile, RecallDisclosure } from "./types.js";

/** Navigation reads touch only these storage members. */
export type NavigationStorage = Pick<StorageManagerLike, "dir" | "getMemoryById" | "readMemoriesWindow">;

/** Structural stand-in so this module does not import StorageManager directly. */
interface StorageManagerLike {
  dir: string;
  getMemoryById(id: string): Promise<MemoryFile | null>;
  readMemoriesWindow(options?: { maxMemories?: number }): Promise<{ memories: MemoryFile[] }>;
}

/** Injected seams; the service supplies live wiring, tests supply doubles. */
export interface RecallNavigationDeps {
  readonly config: RecallNavigationConfig;
  /** Per-call character cap for the assembled response payload. */
  readonly recallBudgetChars: number;
  /** Served-id sets for a session, newest snapshot first. */
  readonly recentServedIds: (sessionKey: string, depth: number) => ReadonlyArray<readonly string[]>;
  readonly resolveReadableNamespace: (namespace: string | undefined, principal?: string) => string;
  readonly getStorage: (namespace: string) => Promise<NavigationStorage>;
}

export type NavigationAction = "expand" | "traverse" | "entity_neighbors";

export interface RecallNavigationRequest {
  readonly action: NavigationAction;
  /** Memory id (or `[m:xxxx]` handle) served to this session's recent recalls. */
  readonly memoryId: string;
  /** Session whose recall window authorizes the id. Required. */
  readonly sessionKey: string;
  readonly namespace?: string;
  readonly authenticatedPrincipal?: string;
  /** expand: target depth. Must be strictly deeper than the chunk default. */
  readonly disclosure?: RecallDisclosure;
  /** traverse: optional relation filter. */
  readonly relation?: string;
  /** traverse / entity_neighbors: optional result cap. */
  readonly limit?: number;
}

export interface NavigationItem {
  readonly memoryId: string;
  readonly path: string;
  readonly disclosure: RecallDisclosure;
  readonly estimatedTokens: number;
  readonly preview: string;
  /** Present when the disclosure level carries full content (expand). */
  readonly content?: string;
  /** Relation edge that produced this neighbor (traverse only). */
  readonly linkType?: string;
}

export type RecallNavigationError =
  | "disabled"
  | "not_served"
  | "not_found"
  | "not_deeper"
  | "unknown_level"
  | "unknown_relation"
  | "invalid_limit";

export type RecallNavigationResult =
  | {
      ok: true;
      action: NavigationAction;
      memoryId: string;
      namespace: string;
      items: NavigationItem[];
      truncated: boolean;
      budget: { chars: number; used: number };
      disclosureSpend: RecallXrayDisclosureSummary;
      rendered: string;
    }
  | {
      ok: false;
      action: NavigationAction;
      error: RecallNavigationError;
      message: string;
      rendered: string;
    };

function toNavigationItem(
  summary: EngramAccessMemorySummary,
  extras: { linkType?: string } = {},
): NavigationItem {
  const item: {
    memoryId: string;
    path: string;
    disclosure: RecallDisclosure;
    estimatedTokens: number;
    preview: string;
    content?: string;
    linkType?: string;
  } = {
    memoryId: summary.id,
    path: summary.path,
    disclosure: summary.disclosure ?? "chunk",
    estimatedTokens: estimateRecallTokens(summary.content ?? summary.preview),
    preview: summary.preview,
    };
  if (summary.content !== undefined) item.content = summary.content;
  if (extras.linkType !== undefined) item.linkType = extras.linkType;
  return item;
}

/** Greedy budget fill: keeps whole items while they fit; the cap is a hard ceiling. */
function applyBudget(
  items: NavigationItem[],
  budgetChars: number,
): { items: NavigationItem[]; truncated: boolean; used: number } {
  const kept: NavigationItem[] = [];
  let used = 0;
  for (const item of items) {
    const cost = item.preview.length + (item.content !== undefined ? item.content.length : 0);
    if (used + cost > budgetChars) {
      if (kept.length === 0 && cost > budgetChars && item.content !== undefined) {
        // Single oversized expansion: shrink preview to a fifth of the
        // budget and content to the remainder, so the combined payload
        // respects the cap rather than returning nothing.
        const previewLen = Math.min(item.preview.length, Math.floor(budgetChars / 5));
        const contentLen = Math.max(0, budgetChars - previewLen);
        kept.push({
          ...item,
          preview: item.preview.slice(0, previewLen),
          content: item.content.slice(0, contentLen),
        });
        used = previewLen + Math.min(item.content.length, contentLen);
        return { items: kept, truncated: true, used };
      }
      return { items: kept, truncated: true, used };
    }
    kept.push(item);
    used += cost;
  }
  return { items: kept, truncated: false, used };
}

function errorResult(
  request: RecallNavigationRequest,
  error: RecallNavigationError,
  message: string,
): RecallNavigationResult {
  return { ok: false, action: request.action, error, message, rendered: renderNavigationResult({ ok: false, action: request.action, error, message }) };
}

function successResult(
  request: RecallNavigationRequest,
  extras: { memoryId: string; namespace: string; items: NavigationItem[]; truncated: boolean; budgetChars: number; used: number },
): RecallNavigationResult {
  const disclosureSpend = summarizeDisclosureTokens(
    extras.items.map((item) => ({ disclosure: item.disclosure, estimatedTokens: item.estimatedTokens })),
  );
  const result: RecallNavigationResult = {
    ok: true,
    action: request.action,
    memoryId: extras.memoryId,
    namespace: extras.namespace,
    items: extras.items,
    truncated: extras.truncated,
    budget: { chars: extras.budgetChars, used: extras.used },
    disclosureSpend,
    rendered: "",
  };
  return { ...result, rendered: renderNavigationResult(result) };
}

function clampLimit(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return Math.min(DEFAULT_TRAVERSE_LIMIT, ceiling);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new EngramAccessInputError(
      `memory navigation: limit must be a positive integer; got ${JSON.stringify(requested)}`,
    );
  }
  return Math.min(requested, ceiling);
}

/**
 * Run one navigation step. Throws {@link EngramAccessInputError} for caller
 * faults (missing sessionKey, malformed limit); returns typed errors for
 * domain refusals so MCP/HTTP/CLI render the constraint instead of a stack.
 */
export async function runRecallNavigation(
  deps: RecallNavigationDeps,
  request: RecallNavigationRequest,
): Promise<RecallNavigationResult> {
  if (!deps.config.enabled) {
    return errorResult(request, "disabled", "memory navigation is disabled; set recallNavigation.enabled");
  }
  const sessionKey = request.sessionKey?.trim() ?? "";
  if (sessionKey.length === 0) {
    throw new EngramAccessInputError(
      "memory navigation requires a sessionKey: navigation authority is scoped to the session's recent recalls",
    );
  }
  if (request.limit !== undefined) {
    // Validate at the seam so every surface reports the same fault.
    clampLimit(request.limit, deps.config.maxNeighbors);
  }
  const windowSnapshots = deps.config.windowSnapshots;
  const authority = assertIdInNavigationWindow({
    snapshots: deps.recentServedIds(sessionKey, windowSnapshots).map((servedIds) => ({ servedIds })),
    memoryId: request.memoryId,
    windowSnapshots,
  });
  if (!authority.ok) {
    return errorResult(
      request,
      "not_served",
      `memory ${request.memoryId} was not served to session ${sessionKey} within the last ${windowSnapshots} recall snapshots; run recall first`,
    );
  }
  const memoryId = authority.memoryId;
  const namespace = deps.resolveReadableNamespace(request.namespace, request.authenticatedPrincipal);
  const storage = await deps.getStorage(namespace);
  const memory = await storage.getMemoryById(memoryId);
  if (!memory) {
    return errorResult(
      request,
      "not_found",
      `memory ${memoryId} was not found in namespace ${namespace}; navigation never crosses the resolved namespace`,
    );
  }

  if (request.action === "expand") {
    const target = request.disclosure ?? "raw";
    const step = planDisclosureStep({ from: "chunk", to: target });
    if (!step.ok) {
      const message =
        step.error === "unknown_level"
          ? `unknown disclosure level ${JSON.stringify(target)}; valid: chunk, section, raw`
          : `disclosure ${JSON.stringify(target)} is not deeper than the chunk level already served; expansion must go deeper (chunk → section → raw)`;
      return errorResult(request, step.error, message);
    }
    const summary = shapeMemorySummary(memory, storage.dir, target);
    const budgeted = applyBudget([toNavigationItem(summary)], deps.recallBudgetChars);
    return successResult(request, { memoryId, namespace, ...budgeted, budgetChars: deps.recallBudgetChars });
  }

  if (request.action === "traverse") {
    if (request.relation !== undefined) {
      const parsedRelation = parseNavigateLinkType(request.relation);
      if (!parsedRelation.ok) {
        return errorResult(
          request,
          "unknown_relation",
          `unknown relation ${JSON.stringify(request.relation)}; valid: supports, contradicts, elaborates, causes, caused_by, supersedes, follows, references, related`,
        );
      }
    }
    const links: TraverseNeighbor[] = (memory.frontmatter.links ?? []).map((link) => ({
      targetId: link.targetId,
      linkType: link.linkType,
    }));
    const selection = selectTraverseNeighbors({
      links,
      relation: request.relation,
      limit: clampLimit(request.limit, deps.config.maxNeighbors),
    });
    if (!selection.ok) {
      return errorResult(request, selection.error, `traverse refused: ${selection.error}`);
    }
    const items: NavigationItem[] = [];
    for (const neighbor of selection.neighbors) {
      // Neighbors resolve through the SAME namespace storage: a link pointing
      // at a memory in another namespace simply is not found here, so a stale
      // or foreign edge can never leak content across namespaces.
      const neighborMemory = await storage.getMemoryById(neighbor.targetId);
      if (!neighborMemory) continue;
      items.push(toNavigationItem(shapeMemorySummary(neighborMemory, storage.dir, "chunk"), { linkType: neighbor.linkType }));
    }
    const budgeted = applyBudget(items, deps.recallBudgetChars);
    return successResult(request, { memoryId, namespace, ...budgeted, budgetChars: deps.recallBudgetChars });
  }

  // entity_neighbors: memories sharing the source memory's entityRef, capped
  // by limit, rendered at chunk depth. No entityRef → no neighbors (empty is
  // an honest answer, not an error).
  const entityRef = memory.frontmatter.entityRef?.trim();
  if (!entityRef) {
    return successResult(request, { memoryId, namespace, items: [], truncated: false, used: 0, budgetChars: deps.recallBudgetChars });
  }
  const window = await storage.readMemoriesWindow();
  const candidates: NavigationItem[] = [];
  for (const candidate of window.memories) {
    if (candidate.frontmatter.id === memoryId) continue;
    if (candidate.frontmatter.entityRef?.trim() !== entityRef) continue;
    candidates.push(toNavigationItem(shapeMemorySummary(candidate, storage.dir, "chunk")));
    if (candidates.length >= clampLimit(request.limit, deps.config.maxNeighbors)) break;
  }
  const budgeted = applyBudget(candidates, deps.recallBudgetChars);
  return successResult(request, { memoryId, namespace, ...budgeted, budgetChars: deps.recallBudgetChars });
}
