/**
 * LSP resolution pass — upgrades Phase A heuristic edges with real
 * definition-lookup results from language servers.
 *
 * Two halves (issue #1555 step 4):
 *
 *   1. **Planner** (pure): `planLspUpgrades(unresolvedCallSites, budget)`
 *      decides which call sites to query and in what order. Pure function —
 *      no side effects, no I/O. Deterministic output for deterministic input.
 *
 *   2. **Executor**: sends `textDocument/didOpen` + `textDocument/definition`
 *      for each planned request via the LSP client, maps returned locations
 *      back to graph nodes by file + half-open span containment (rule 35),
 *      and applies edge upgrades transactionally per batch. A mid-batch
 *      failure leaves zero partial upgrades (rule 25 — tested).
 *
 * Budgets (issue #1555): `maxRequestsPerRun` caps the worst case. Remaining
 * call sites keep their Phase A resolution. Everything degrades to Phase A
 * results with a tagged degradation surfaced in index_status.
 *
 * Files whose ingest failed are excluded (rule 44 — the executor never
 * queries for a file that isn't in the store).
 */

import path from "node:path";

import type { CodingGraphLanguage } from "@remnic/core";

import type { LspClient } from "./client.js";
import { uriToPath } from "./client.js";
import type { LspDegradation } from "./degradation.js";
import {
  buildLineOffsetMap,
  byteOffsetToPosition,
  positionToByteOffset,
  type LineOffsetMap,
} from "./byte-position.js";
import type { LspLocation } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// Input types — what the resolution pass consumes
// ──────────────────────────────────────────────────────────────────────────

/**
 * A call site that Phase A left unresolved or at low confidence. The
 * resolution pass will query the LSP server for its definition.
 */
export interface UnresolvedCallSite {
  /** Repo-relative file path of the CALLER (the file containing the call). */
  readonly filePath: string;
  readonly language: CodingGraphLanguage;
  /** Full file content — needed for byte↔position conversion. */
  readonly content: string;
  /** Byte offset of the callee name in the source (for the definition query position). */
  readonly calleeByteOffset: number;
  /** The callee name as extracted by Phase A (for logging/debugging). */
  readonly calleeName: string;
  /** The caller's qualified name (source node for the edge). */
  readonly srcQualifiedName: string;
}

/**
 * A planned LSP definition request — the planner's output. Each request
 * targets one call site at one position in one file.
 */
export interface PlannedLspRequest {
  readonly filePath: string;
  readonly language: CodingGraphLanguage;
  readonly content: string;
  readonly calleeName: string;
  readonly srcQualifiedName: string;
  /** LSP position derived from calleeByteOffset via line-offset map. */
  readonly position: { readonly line: number; readonly character: number };
}

/**
 * The planner's budget — how many requests can be sent this run.
 */
export interface LspBudget {
  readonly maxRequests: number;
}

/**
 * Result of the planner — the requests to send, plus how many call sites
 * were deferred due to budget exhaustion.
 */
export interface PlanResult {
  readonly requests: readonly PlannedLspRequest[];
  readonly budgetExhausted: number;
}

/**
 * A location that the LSP server returned, mapped to a byte offset in
 * a known file.
 */
export interface ResolvedLocation {
  readonly filePath: string;
  readonly startByte: number;
  readonly endByte: number;
}

/**
 * Result of the resolution pass.
 */
export interface ResolutionResult {
  /** Edges upgraded from heuristic → lsp with resolved dst node. */
  readonly upgraded: number;
  /** LSP returned no location or the location didn't map to an indexed node. */
  readonly unresolved: number;
  /** Call sites skipped because maxRequestsPerRun was reached. */
  readonly budgetExhausted: number;
  /** Degradation if the pass could not run (server crashed, protocol error). */
  readonly degradation?: LspDegradation;
}

// ──────────────────────────────────────────────────────────────────────────
// Node-location lookup — the seam between LSP locations and graph nodes.
// Implemented by the caller (the store-backed resolution executor) so
// the planner stays pure and testable without a database.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Look up a graph node by file path + byte span containment (rule 35 —
 * half-open). Returns the node's qualified name if exactly one node's
 * span contains the byte offset, or null if none/ambiguous.
 *
 * The executor provides this closure backed by the GraphStore; tests
 * inject a mock.
 */
export type NodeLocator = (
  filePath: string,
  byteOffset: number,
) => string | null;

/**
 * Context for mapping an LSP location to a graph node. Provides the
 * caller's file path and content (for same-file definitions), plus
 * optional workspace-root normalization and cross-file content resolution.
 */
export interface MapLocationContext {
  /** Repo-relative path of the caller file. */
  readonly callerFilePath: string;
  /** Full content of the caller file. */
  readonly callerContent: string;
  /** Workspace root for normalizing absolute LSP URIs to repo-relative paths. */
  readonly workspaceRoot?: string;
  /** Resolve content for a target file path (repo-relative). */
  readonly resolveContent?: (filePath: string) => string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Planner — pure function, no side effects
// ──────────────────────────────────────────────────────────────────────────

/**
 * Plan which call sites to resolve via LSP. Pure — deterministic output
 * for deterministic input. Orders requests by file path then byte offset
 * for predictable, reviewable batches (rule 38 — byte-stable ordering).
 *
 * Budget enforcement: at most `budget.maxRequests` requests are planned.
 * Excess call sites are counted in `budgetExhausted` so the caller can
 * surface the degradation.
 */
export function planLspUpgrades(
  callSites: readonly UnresolvedCallSite[],
  budget: LspBudget,
): PlanResult {
  // Sort for deterministic ordering (rule 38): by file path, then byte offset.
  const sorted = [...callSites].sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.calleeByteOffset - b.calleeByteOffset,
  );

  const max = Math.max(0, budget.maxRequests);
  const planned = sorted.slice(0, max);
  const exhausted = sorted.length - planned.length;

  // Pre-compute line-offset maps per unique file to avoid recomputation
  // in the executor. Group by content identity (same content → same map).
  const maps = new Map<string, LineOffsetMap>();
  const requests: PlannedLspRequest[] = planned.map((cs) => {
    let map = maps.get(cs.filePath);
    if (!map) {
      map = buildLineOffsetMap(cs.content);
      maps.set(cs.filePath, map);
    }
    const position = byteOffsetToPosition(cs.content, cs.calleeByteOffset, map);
    return {
      filePath: cs.filePath,
      language: cs.language,
      content: cs.content,
      calleeName: cs.calleeName,
      srcQualifiedName: cs.srcQualifiedName,
      position,
    };
  });

  return { requests, budgetExhausted: exhausted };
}

// ──────────────────────────────────────────────────────────────────────────
// Executor — sends definition requests, maps locations, applies upgrades
// ──────────────────────────────────────────────────────────────────────────

/**
 * Options for the resolution executor.
 */
export interface ResolveOptions {
  readonly client: LspClient;
  readonly nodeLocator: NodeLocator;
  /**
   * Warm-up retry delay in ms (issue #1933). Language servers (tsserver
   * in particular) load projects ASYNCHRONOUSLY after `didOpen`; a
   * definition request that arrives too early returns an EMPTY location
   * array — indistinguishable from "definitely no definition". Until the
   * server has proven warm (any non-empty response), an empty result is
   * retried ONCE after this delay. Default 2500. Set 0 to disable.
   */
  readonly warmupRetryDelayMs?: number;
  /**
   * Apply a batch of edge upgrades atomically. Called once per file batch.
   * MUST be transactional — if it throws, zero upgrades from this batch
   * persist (rule 25). Each upgrade is an edge `{srcQualifiedName,
   * dstQualifiedName, type: "CALLS", confidence, provenance: "lsp"}`.
   */
  readonly applyUpgrades: (
    upgrades: readonly EdgeUpgrade[],
  ) => Promise<void>;
  /**
   * Optional stale-edge reconciliation (issue #1895): after applying a
   * file batch's upgrades, the caller retires prior `lsp`-provenance
   * edges owned by that file whose `(src, dst, type)` keys the current
   * batch does NOT assert. When absent, stale lsp edges persist until
   * node pruning — the soft-fail path documented in #1894.
   */
  readonly reconcileLspEdges?: (
    filePath: string,
    assertedEdges: ReadonlyArray<{
      srcQualifiedName: string;
      dstQualifiedName: string;
      type: string;
    }>,
  ) => void;
  /**
   * Workspace root for resolving repo-relative file paths to absolute LSP
   * URIs and normalizing returned URIs back to repo-relative paths.
   */
  readonly workspaceRoot?: string;
  /**
   * Resolve the content of a target file by repo-relative path. Used for
   * cross-file definition positions — without this, cross-file byte-offset
   * conversion falls back to the caller's content (best-effort).
   */
  readonly resolveContent?: (filePath: string) => string | null;
}

/**
 * A single edge upgrade — the output of a successful definition lookup.
 */
export interface EdgeUpgrade {
  readonly srcQualifiedName: string;
  readonly dstQualifiedName: string;
  readonly type: string;
  readonly confidence: number;
  readonly provenance: "lsp";
}

/**
 * Map a {@link CodingGraphLanguage} to its LSP languageId string. Most
 * tier-1 languages use their own name; a few differ (tsx → typescriptreact,
 * bash → shellscript).
 */
const LANGUAGE_ID_MAP: Partial<Record<CodingGraphLanguage, string>> = {
  tsx: "typescriptreact",
  bash: "shellscript",
};

/**
 * Execute the resolution pass: for each planned request, send a
 * `textDocument/didOpen` + `textDocument/definition` query, map the
 * returned location to a graph node, and collect edge upgrades. Upgrades
 * are applied in file-batched transactions — a mid-batch failure leaves
 * zero partial upgrades.
 *
 * Never throws — degrades to Phase A results with a tagged degradation.
 */
export async function executeLspResolution(
  requests: readonly PlannedLspRequest[],
  options: ResolveOptions,
): Promise<ResolutionResult> {
  const { client, nodeLocator, applyUpgrades } = options;

  // Group requests by file for batched transactional application.
  const byFile = new Map<string, PlannedLspRequest[]>();
  for (const req of requests) {
    let batch = byFile.get(req.filePath);
    if (!batch) {
      batch = [];
      byFile.set(req.filePath, batch);
    }
    batch.push(req);
  }

  let upgraded = 0;
  let unresolved = 0;
  let degradation: LspDegradation | undefined;

  // Warm-up tracking (issue #1933): false until the server returns its
  // first NON-EMPTY definition, or until one warm-up retry has been paid.
  // tsserver answers pre-project-load requests with [] instead of an
  // error, so without the retry every first-run resolution silently
  // reports unresolved and Phase B never upgrades anything.
  let serverWarm = false;
  const warmupRetryDelayMs = options.warmupRetryDelayMs ?? 2_500;

  for (const [filePath, batchReqs] of byFile) {
    // Send all definition requests for this file, collecting upgrades.
    const upgrades: EdgeUpgrade[] = [];
    let batchFailed = false;
    // Track whether EVERY request in this file batch was processed to a
    // definitive result (resolved or definitively-not-found). A timeout,
    // request_error, or server-crash mid-batch makes the batch
    // non-exhaustive: reconciliation must NOT run because the asserted
    // set would be incomplete, deleting valid lsp edges for call sites
    // that were never queried (cursor High + codex P1 on #1914).
    let batchExhaustive = true;

    // Open the document with full text before querying definitions (LSP 3.17).
    // The server needs the content to answer definition requests accurately.
    const firstReq = batchReqs[0];
    client.didOpen({
      uri: filePathToUri(filePath, options.workspaceRoot),
      languageId: LANGUAGE_ID_MAP[firstReq.language] ?? firstReq.language,
      version: 1,
      text: firstReq.content,
    });

    for (let i = 0; i < batchReqs.length; i++) {
      const req = batchReqs[i];
      if (degradation) {
        // Server died in a previous batch — count remaining unattempted.
        unresolved += batchReqs.length - i;
        break;
      }

      let defResult = await client.definition({
        textDocument: { uri: filePathToUri(req.filePath, options.workspaceRoot) },
        position: req.position,
      });

      // Warm-up retry (issue #1933): an empty result from a not-yet-warm
      // server is indeterminate, not definitive. Pay ONE bounded delay,
      // re-ask, and treat the server as warm from then on — whatever the
      // retry returns is the real answer.
      if (defResult.ok && defResult.locations.length === 0 && !serverWarm && warmupRetryDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, warmupRetryDelayMs));
        serverWarm = true;
        const retryResult = await client.definition({
          textDocument: { uri: filePathToUri(req.filePath, options.workspaceRoot) },
          position: req.position,
        });
        defResult = retryResult;
      }
      if (defResult.ok && defResult.locations.length > 0) {
        serverWarm = true;
      }

      if (!defResult.ok) {
        // Distinguish "server problem" (stop the whole pass) from
        // "this particular definition returned nothing" (continue).
        if (
          defResult.degradation.code === "server_crashed" ||
          defResult.degradation.code === "protocol_error"
        ) {
          degradation = defResult.degradation;
          // Count this request plus all remaining unattempted requests
          // in this batch as unresolved for accurate reporting.
          unresolved += batchReqs.length - i;
          // Mark the batch failed so collected upgrades are NOT committed
          // (rule 25 — per-batch atomicity; a degraded batch must not
          // persist partial LSP edges).
          batchFailed = true;
          break;
        }
        // request_timeout / request_error — count as unresolved, continue.
        // request_timeout / request_error — count as unresolved.
        // The batch is non-exhaustive: this call site's LSP result is
        // indeterminate, so reconciliation for this file is suppressed.
        batchExhaustive = false;
        unresolved++;
        continue;
      }

      const dstQName = mapLocationToNode(
        defResult.locations,
        {
          callerFilePath: req.filePath,
          callerContent: req.content,
          workspaceRoot: options.workspaceRoot,
          resolveContent: options.resolveContent,
        },
        nodeLocator,
      );
      if (dstQName === null) {
        unresolved++;
        continue;
      }
      upgrades.push({
        srcQualifiedName: req.srcQualifiedName,
        dstQualifiedName: dstQName,
        type: "CALLS",
        confidence: 0.9,
        provenance: "lsp",
      });
    }

    if (batchFailed) {
      // The batch was poisoned — collected upgrades must NOT be committed.
      // Count them as unresolved for reporting accuracy.
      unresolved += upgrades.length;
      break;
    }

    // Apply upgrades transactionally per file batch, then reconcile stale
    // lsp edges for this file (issue #1895). If the apply throws, zero
    // upgrades from this batch persist (rule 25 — the applyUpgrades
    // callback MUST be transactional).
    try {
      if (upgrades.length > 0) {
        await applyUpgrades(upgrades);
        upgraded += upgrades.length;
      }
      // Reconcile ONLY when the batch was exhaustive (every call site
      // processed to a definitive result). A partial batch's asserted
      // set would be incomplete and retire valid edges for unprocessed
      // call sites (cursor High + codex P1 on #1914).
      if (batchExhaustive && options.reconcileLspEdges) {
        options.reconcileLspEdges(
          filePath,
          upgrades.map((u) => ({
            srcQualifiedName: u.srcQualifiedName,
            dstQualifiedName: u.dstQualifiedName,
            type: u.type,
          })),
        );
      }
    } catch {
      // The apply failed — degrade but don't crash. Upgrades from this
      // batch are lost (the callback's transaction rolled back). Edges
      // from already-applied batches survive (they were in separate
      // transactions — this is the documented per-batch isolation).
      // Count the lost upgrades as unresolved for reporting.
      unresolved += upgrades.length;
    }
  }

  return {
    upgraded,
    unresolved,
    budgetExhausted: 0, // set by the caller from the planner result
    degradation,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Location → node mapping (rule 35 — half-open span containment)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map an LSP definition location to a graph node's qualified name.
 *
 * Uses half-open span containment (rule 35): the location's start byte
 * must be within `[node.spanStart, node.spanEnd)` for the node to match.
 * If multiple locations are returned, the FIRST one that maps to a node
 * wins (LSP servers typically return the most relevant definition first).
 *
 * For same-file definitions, the caller's content is used for byte-offset
 * conversion (exact). For cross-file definitions, `context.resolveContent`
 * is used to fetch the target file's content; if unavailable, the caller's
 * content is used as a best-effort fallback.
 *
 * Returns null if no location maps to an indexed node.
 */
export function mapLocationToNode(
  locations: readonly LspLocation[],
  context: MapLocationContext,
  nodeLocator: NodeLocator,
): string | null {
  for (const loc of locations) {
    const filePath = normalizeLocationPath(loc.uri, context.workspaceRoot);

    // Resolve content for this location's file.
    let content: string;
    if (filePath === context.callerFilePath) {
      // Same file as the caller — use the caller's exact content.
      content = context.callerContent;
    } else if (context.resolveContent) {
      // Cross-file — use the content resolver for exact conversion.
      const resolved = context.resolveContent(filePath);
      if (resolved === null) continue; // file not indexed — skip
      content = resolved;
    } else {
      // Cross-file without a resolver — best-effort fallback to caller
      // content. The byte offset may be imprecise for files with different
      // line lengths or Unicode, but the half-open containment check
      // tolerates small offsets.
      content = context.callerContent;
    }

    const map = buildLineOffsetMap(content);
    const startByte = positionToByteOffset(content, loc.range.start, map);
    const qName = nodeLocator(filePath, startByte);
    if (qName !== null) return qName;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// URI helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Convert a repo-relative file path to a `file://` URI for LSP requests.
 * When `workspaceRoot` is provided, relative paths are resolved against
 * it to produce an absolute URI (e.g. `file:///workspace/src/a.ts`). LSP
 * servers do not reinterpret URIs relative to `rootUri`, so the URI must
 * be absolute.
 */
function filePathToUri(filePath: string, workspaceRoot?: string): string {
  const isAbsolute = filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
  if (isAbsolute) {
    return `file://${filePath.replace(/\\/g, "/")}`;
  }
  if (workspaceRoot) {
    const abs = path.join(workspaceRoot, filePath).replace(/\\/g, "/");
    return `file://${abs}`;
  }
  // No workspace root — best-effort for backward compatibility.
  return `file:///${filePath.replace(/\\/g, "/")}`;
}

/**
 * Normalize an LSP `Location.uri` to a repo-relative file path. Strips the
 * workspace root prefix so the result matches the store's canonical paths.
 * Without `workspaceRoot`, returns the absolute path from the URI.
 */
function normalizeLocationPath(uri: string, workspaceRoot?: string): string {
  const absPath = uriToPath(uri);
  if (workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const rel = path.relative(root, absPath);
    if (!rel.startsWith("..") && rel !== "") {
      return rel.replace(/\\/g, "/");
    }
  }
  return absPath;
}
