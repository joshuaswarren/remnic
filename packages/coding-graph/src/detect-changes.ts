/**
 * detect_changes + blast radius for the coding-graph (issue #1553).
 *
 * Maps the current diff (staged + unstaged + committed-since-last-index)
 * hunks to symbols whose spans overlap the changed line ranges — against
 * a FRESH parse of the changed files, never against stale stored spans.
 *
 * Blast radius: reverse BFS from affected symbols over inbound
 * CALLS / IMPORTS / USES_TYPE edges with a depth cap. Risk classification
 * is a deterministic rubric (no LLM in the loop):
 *
 *   ┌──────────────┬──────────────────────────────────────────────────┐
 *   │ Risk         │ Criterion                                       │
 *   ├──────────────┼──────────────────────────────────────────────────┤
 *   │ "direct"     │ The symbol itself is in a changed hunk (depth 0).│
 *   │ "near"       │ 1 hop away from a directly-changed symbol.       │
 *   │ "transitive" │ 2+ hops away.                                   │
 *   └──────────────┴──────────────────────────────────────────────────┘
 *
 * Fan-in escalation: when an affected symbol has ≥ FAN_IN_ESCALATION
 * inbound edges, its risk is escalated one level (near→direct,
 * transitive→near) because high-fan-in symbols concentrate blast radius.
 *
 * Half-open interval semantics (rule 35): a hunk range `[startLine, endLine)`
 * overlaps a symbol span `[symStartLine, symEndLine)` iff
 *   `startLine < symEndLine && symStartLine < endLine`.
 * Boundary lines (exact hit on startLine or endLine-1) are tested.
 */
import { nodeIdFor, type GraphStore, type TraverseHit } from "./graph-store.js";
import type { DiffHunk } from "./git-invoker.js";
import type { SymbolIR, FileIR } from "@remnic/core";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

/** Risk classification rubric — deterministic, no LLM. */
export type RiskLevel = "direct" | "near" | "transitive";

/** A symbol affected by the current diff, with its blast-radius classification. */
export interface AffectedSymbol {
  /** Qualified name of the symbol. */
  readonly qualifiedName: string;
  /** Simple name of the symbol. */
  readonly name: string;
  /** Symbol kind (function, class, method, ...). */
  readonly label: string;
  /** Repo-relative file path. */
  readonly filePath: string;
  /** Risk level from the deterministic rubric. */
  readonly risk: RiskLevel;
  /** BFS depth from the nearest directly-changed symbol (0 = direct). */
  readonly depth: number;
  /** Total inbound edge count (fan-in) at the time of classification. */
  readonly fanIn: number;
}

/** Result of detect_changes. */
export type DetectChangesResult =
  | { readonly ok: true; readonly affected: readonly AffectedSymbol[] }
  | { readonly ok: false; readonly code: "git_error" | "store_error" };

/**
 * Result of computeBlastRadius. A backend/store failure during traversal is
 * surfaced as `{ ok: false; code: "store_error" }` rather than masked as an
 * empty result — the blast-radius computation is unreliable when the store
 * cannot be read (rule 22; cursor Bugbot: 'computeBlastRadius masks traverse
 * failures'). `{ ok: true; affected: [] }` is a genuinely empty blast radius.
 */
export type BlastRadiusResult =
  | { ok: true; affected: readonly AffectedSymbol[] }
  | { ok: false; code: "store_error" };

// ──────────────────────────────────────────────────────────────────────────
// Constants — the risk rubric
// ──────────────────────────────────────────────────────────────────────────

/**
 * Edge types traversed for blast-radius computation. These represent
 * "depends on" relationships — an inbound edge of any of these types
 * means the source symbol is affected when the destination changes.
 */
export const BLAST_RADIUS_EDGE_TYPES = [
  "CALLS",
  "IMPORTS",
  "USES_TYPE",
] as const;

/**
 * Fan-in threshold for risk escalation. When an affected symbol has this
 * many or more inbound edges, its risk is escalated one level because
 * high-fan-in symbols concentrate blast radius.
 */
export const FAN_IN_ESCALATION_THRESHOLD = 5;

/** Maximum BFS depth for blast-radius traversal. */
export const DEFAULT_BLAST_RADIUS_DEPTH = 3;

/**
 * Failure codes that indicate a backend/store problem (rule 22), as opposed
 * to a logical no-result (unknown_start / ambiguous_start / invalid_query).
 * Used by computeBlastRadius to decide whether to surface a traverse failure
 * or merely skip the symbol.
 */
const STORE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "db_locked",
  "db_corrupt",
  "db_error",
  "store_closed",
]);
function isStoreFailureCode(code: string): boolean {
  return STORE_FAILURE_CODES.has(code);
}

// ──────────────────────────────────────────────────────────────────────────
// Line-range overlap (rule 35: half-open intervals on both sides)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Byte offset → 1-based line number. Walks the content counting newlines
 * up to (but not including) the byte offset. Used to convert symbol spans
 * (byte offsets) to line ranges for hunk-overlap comparison.
 *
 * Returns `{ startLine, endLine }` where both are 1-based and `endLine`
 * is exclusive (half-open — rule 35). A symbol that starts at byte 0 on
 * line 1 and ends at byte 10 (still line 1) has `{ 1, 2 }`.
 */
export function byteSpanToLines(
  content: Uint8Array,
  startByte: number,
  endByte: number,
): { startLine: number; endLine: number } {
  let line = 1;
  let startLine = 1;
  let endLine = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (i === startByte) startLine = line;
    if (content[i] === 0x0a) line += 1;
    if (i === endByte - 1 && content[i] === 0x0a) {
      // endByte is exclusive; if the last byte is a newline, the symbol
      // ends at the start of the next line.
      endLine = line;
    } else if (i + 1 === endByte) {
      endLine = line + (content[i] === 0x0a ? 0 : 1);
    }
  }
  // Handle edge case: startByte or endByte at content boundary.
  if (startByte >= content.length) startLine = line;
  if (endByte > content.length) endLine = line + 1;
  return { startLine, endLine };
}

/**
 * Half-open overlap test (rule 35): two ranges `[aStart, aEnd)` and
 * `[bStart, bEnd)` overlap iff `aStart < bEnd && bStart < aEnd`.
 *
 * Boundary case: a hunk starting exactly at `symEndLine` does NOT overlap
 * (the symbol ends before the hunk starts). A hunk ending exactly at
 * `symStartLine` does NOT overlap (the hunk ends before the symbol starts).
 */
export function rangesOverlap(
  a: { startLine: number; endLine: number },
  b: { startLine: number; endLine: number },
): boolean {
  return a.startLine < b.endLine && b.startLine < a.endLine;
}

// ──────────────────────────────────────────────────────────────────────────
// detect_changes — map hunks → symbols → blast radius
// ──────────────────────────────────────────────────────────────────────────

/**
 * Classify risk from BFS depth + fan-in. Deterministic rubric:
 *   - depth 0 → "direct"
 *   - depth 1 → "near"
 *   - depth 2+ → "transitive"
 *   - fanIn ≥ threshold escalates one level (capped at "direct")
 */
export function classifyRisk(depth: number, fanIn: number): RiskLevel {
  let base: RiskLevel;
  if (depth === 0) base = "direct";
  else if (depth === 1) base = "near";
  else base = "transitive";
  // Fan-in escalation: high-fan-in symbols are more dangerous.
  if (fanIn >= FAN_IN_ESCALATION_THRESHOLD) {
    if (base === "near") base = "direct";
    else if (base === "transitive") base = "near";
  }
  return base;
}

/**
 * Find symbols whose line ranges overlap any hunk in the given file.
 * Uses a FRESH parse (never stale stored spans). Returns the set of
 * directly-affected qualified names.
 */
export function findDirectlyAffectedSymbols(
  hunksByPath: ReadonlyMap<string, readonly DiffHunk[]>,
  freshIRs: ReadonlyMap<string, FileIR>,
  contentsByPath: ReadonlyMap<string, Uint8Array>,
): Set<string> {
  // Returns NODE IDS (not qualified names). Node identity is the full
  // (qualifiedName, filePath, label) triple, so two files that emit the
  // same qualifiedName produce distinct ids and downstream traversal
  // resolves unambiguously by id instead of returning 'ambiguous_start'
  // (chatgpt-codex-connector: 'Preserve node identity for direct
  // blast-radius hits').
  const affected = new Set<string>();
  for (const [filePath, hunks] of hunksByPath) {
    const ir = freshIRs.get(filePath);
    if (!ir) continue;
    const content = contentsByPath.get(filePath);
    if (!content) continue;
    for (const sym of ir.symbols) {
      const symLines = byteSpanToLines(
        content,
        sym.span.startByte,
        sym.span.endByte,
      );
      for (const hunk of hunks) {
        if (rangesOverlap(symLines, hunk.newRange)) {
          affected.add(nodeIdFor({ qualifiedName: sym.qualifiedName, filePath, label: sym.kind }));
          break;
        }
      }
    }
  }
  return affected;
}

/**
 * Compute blast radius from a set of directly-affected symbols using the
 * store's `traverse` primitive (direction: incoming). Reuses the existing
 * BFS — does NOT write a second traversal (rule 22 spirit).
 *
 * Returns affected symbols with their risk classification. Byte-stable:
 * the same diff + graph always produces the same output.
 */
export function computeBlastRadius(
  store: GraphStore,
  directlyAffected: ReadonlySet<string>,
  maxDepth: number = DEFAULT_BLAST_RADIUS_DEPTH,
): BlastRadiusResult {
  if (directlyAffected.size === 0) return { ok: true, affected: [] };

  // Collect all reachable symbols via inbound traversal from each
  // directly-affected symbol. We traverse from the affected symbol
  // OUTWARD via incoming edges — meaning "who depends on me".
  const hitByDepth = new Map<string, number>();
  const hitMeta = new Map<
    string,
    { qualifiedName: string; name: string; label: string; filePath: string }
  >();

  for (const qname of directlyAffected) {
    const result = store.traverse({
      start: qname,
      direction: "incoming",
      edgeTypes: [...BLAST_RADIUS_EDGE_TYPES],
      maxDepth,
    });
    if (!result.ok) {
      // A backend failure (db_locked/corrupt/error/store_closed) means the
      // blast-radius computation is unreliable — surface it instead of
      // conflating it with "no inbound edges" (rule 22). A logical failure
      // (unknown_start/ambiguous_start/invalid_query) means this symbol
      // contributes no traversal, so skip it without aborting the set.
      if (isStoreFailureCode(result.code)) {
        return { ok: false, code: "store_error" };
      }
      continue;
    }
    for (const hit of result.hits) {
      const existing = hitByDepth.get(hit.nodeId);
      // Keep the minimum depth (closest to a directly-affected symbol).
      if (existing === undefined || hit.depth < existing) {
        hitByDepth.set(hit.nodeId, hit.depth);
        hitMeta.set(hit.nodeId, {
          qualifiedName: hit.qualifiedName,
          name: hit.name,
          label: hit.label,
          filePath: hit.filePath,
        });
      }
    }
  }

  // Build the result with risk classification.
  const out: AffectedSymbol[] = [];
  for (const [nodeId, depth] of hitByDepth) {
    const meta = hitMeta.get(nodeId);
    if (!meta) continue;
    // Compute fan-in: count inbound edges of the blast-radius types.
    // A separate traverse at depth 1 gives us the inbound neighbors.
    const inboundResult = store.traverse({
      start: nodeId,
      direction: "incoming",
      edgeTypes: [...BLAST_RADIUS_EDGE_TYPES],
      maxDepth: 1,
    });
    let fanIn: number;
    if (inboundResult.ok) {
      fanIn = inboundResult.hits.filter((h) => h.depth > 0).length;
    } else if (isStoreFailureCode(inboundResult.code)) {
      // Same discipline as the main loop: a store failure on the fan-in
      // read makes the classification unreliable — surface it (rule 22).
      return { ok: false, code: "store_error" };
    } else {
      // Logical failure (unknown_start/...): this node has no resolvable
      // inbound neighbors — fan-in is 0 for risk classification only.
      fanIn = 0;
    }
    const risk = classifyRisk(depth, fanIn);
    // filePath comes straight from the traverse hit (joined from
    // files.path in the store) — resolving via searchGraph by short
    // name would attach the wrong path when a simple name is declared
    // in more than one file (cursor Bugbot: 'Blast radius wrong file
    // path').
    out.push({
      qualifiedName: meta.qualifiedName,
      name: meta.name,
      label: meta.label,
      filePath: meta.filePath,
      risk,
      depth,
      fanIn,
    });
  }

  // Sort for byte-stability: by risk, then qualifiedName, then filePath,
  // then nodeId. A total order is required so two symbols that share a
  // qualifiedName across files (different filePaths / node ids) still
  // sort deterministically (cursor Bugbot: 'Blast radius sort not
  // byte-stable').
  const riskOrder: Record<RiskLevel, number> = {
    direct: 0,
    near: 1,
    transitive: 2,
  };
  // Build a (qualifiedName   filePath) -> nodeId lookup so the comparator
  // can resolve each AffectedSymbol back to its node id for the final
  // tiebreaker.
  const nodeIdByQFile = new Map<string, string>();
  for (const [nodeId, depth] of hitByDepth) {
    const m = hitMeta.get(nodeId);
    if (m) nodeIdByQFile.set(`${m.qualifiedName}\0${m.filePath}\0${m.label}`, nodeId);
    void depth;
  }
  out.sort((a, b) => {
    const riskDiff = riskOrder[a.risk] - riskOrder[b.risk];
    if (riskDiff !== 0) return riskDiff;
    const qCmp = a.qualifiedName.localeCompare(b.qualifiedName);
    if (qCmp !== 0) return qCmp;
    const fCmp = a.filePath.localeCompare(b.filePath);
    if (fCmp !== 0) return fCmp;
    // Node identity is (qualifiedName, filePath, label); include label so two
    // distinct nodes sharing qualifiedName+filePath do not collapse to one key
    // (chatgpt-codex-connector: 'Include label in blast-radius tiebreaker').
    const lCmp = a.label.localeCompare(b.label);
    if (lCmp !== 0) return lCmp;
    const aId = nodeIdByQFile.get(`${a.qualifiedName}\0${a.filePath}\0${a.label}`) ?? "";
    const bId = nodeIdByQFile.get(`${b.qualifiedName}\0${b.filePath}\0${b.label}`) ?? "";
    return aId.localeCompare(bId);
  });

  return { ok: true, affected: out };
}
