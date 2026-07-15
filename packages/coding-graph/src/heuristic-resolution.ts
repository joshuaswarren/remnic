/**
 * Phase A heuristic edge resolution (issue #1891).
 *
 * The parser engine emits raw call candidates (`FileIR.callSites`); the
 * graph store persists only pre-resolved `EdgeIR[]`. This module is the
 * bridge the docs call "Phase A — heuristic": a PURE function that derives
 * CALLS edge assertions from a freshly parsed batch, using only evidence
 * present in the IR itself:
 *
 *   - src: the innermost same-file symbol whose span contains the call
 *     site (half-open spans, rule 35). Top-level calls (no enclosing
 *     symbol) are skipped and counted — module-level side effects are not
 *     a caller symbol.
 *   - dst, in candidate order:
 *       1. the unique same-file symbol with that bare name
 *         (confidence {@link HEURISTIC_CONFIDENCE_SAME_FILE});
 *       2. an import-bound name (`imports[].importedNames`), emitted by
 *         bare name for the store's cross-file/full-DB resolution
 *         (confidence {@link HEURISTIC_CONFIDENCE_IMPORT_BOUND}).
 *     A bare name with neither anchor (e.g. `console.log`'s `log`) is
 *     skipped — emitting it would delegate a guess, not evidence, and the
 *     store's dst fallback would happily attach it to any same-named
 *     symbol anywhere in the graph.
 *   - Ambiguity is dropped conservatively (same policy as the store's
 *     pass-2): a bare name matching two same-file symbols resolves to
 *     neither; the next candidate is tried.
 *
 * Final id resolution (batch map + full-DB dst fallback + ambiguity
 * drops) stays in `GraphStore.upsertFileEdges`; this module never touches
 * the DB. Every file in the output carries an explicit `edges` array —
 * `[]` asserts "this parse supports no heuristic edges" so stale edges
 * from a prior version of the file are cleaned up. Paired with the
 * store's provenance-scoped stale delete (`assertedEdgeProvenances`),
 * re-derivation never destroys `trace`/`lsp` edges (rule 25).
 */
import type { EdgeIR, FileIR, StoreFileIR } from "./graph-store.js";

/** Confidence for a call resolved to a unique same-file symbol. */
export const HEURISTIC_CONFIDENCE_SAME_FILE = 0.9;
/** Confidence for a call resolved through an import binding. */
export const HEURISTIC_CONFIDENCE_IMPORT_BOUND = 0.8;

/**
 * The provenance scope reindex asserts for derived edges: a fresh parse
 * contradicts only heuristic derivations, never trace/lsp edges.
 */
export const HEURISTIC_PROVENANCE_SCOPE = ["heuristic"] as const;

/** Per-batch resolution counters — surfaced by callers for observability. */
export interface HeuristicResolutionStats {
  /** Total call sites examined across the batch. */
  readonly callSites: number;
  /** Call sites that produced an edge assertion. */
  readonly resolved: number;
  /** Call sites whose candidates matched nothing (no evidence). */
  readonly skippedUnresolved: number;
  /** Call sites whose best candidate was ambiguous in-file. */
  readonly skippedAmbiguous: number;
  /** Call sites with no enclosing symbol (module-level calls). */
  readonly skippedNoEnclosingSymbol: number;
}

/** A FileIR enriched with the store-consumable edge assertions. */
export type ResolvedFileIR = StoreFileIR & { readonly edges: readonly EdgeIR[] };

export interface HeuristicResolutionResult {
  readonly files: readonly ResolvedFileIR[];
  readonly stats: HeuristicResolutionStats;
}

/**
 * Derive CALLS edge assertions for a freshly parsed batch. Pure and
 * deterministic: output order follows input order (files, then call
 * sites), so repeated runs over the same IR are byte-identical (rule 38).
 */
export function deriveHeuristicEdges(
  batch: readonly FileIR[],
): HeuristicResolutionResult {
  let callSites = 0;
  let resolved = 0;
  let skippedUnresolved = 0;
  let skippedAmbiguous = 0;
  let skippedNoEnclosingSymbol = 0;

  const files: ResolvedFileIR[] = [];

  for (const ir of batch) {
    // Bare-name → symbols map for this file. Names binding more than one
    // symbol are ambiguous and resolve to nothing (conservative drop).
    const byName = new Map<string, { qualifiedName: string; count: number }>();
    for (const sym of ir.symbols) {
      const prior = byName.get(sym.name);
      if (prior) {
        prior.count += 1;
      } else {
        byName.set(sym.name, { qualifiedName: sym.qualifiedName, count: 1 });
      }
    }
    const importedNames = new Set<string>();
    for (const imp of ir.imports) {
      for (const name of imp.importedNames) importedNames.add(name);
    }

    const edges: EdgeIR[] = [];
    const seenKeys = new Set<string>();

    for (const site of ir.callSites) {
      callSites += 1;

      // src: innermost enclosing symbol (smallest containing span).
      let src: { qualifiedName: string; size: number } | undefined;
      for (const sym of ir.symbols) {
        if (sym.span.startByte > site.span.startByte || site.span.endByte > sym.span.endByte) continue;
        const size = sym.span.endByte - sym.span.startByte;
        if (!src || size < src.size) {
          src = { qualifiedName: sym.qualifiedName, size };
        }
      }
      if (!src) {
        skippedNoEnclosingSymbol += 1;
        continue;
      }

      // dst: first candidate with in-IR evidence.
      let dstQualifiedName: string | undefined;
      let confidence = 0;
      let sawAmbiguous = false;
      for (const candidate of site.calleeNameCandidates) {
        const local = byName.get(candidate);
        if (local) {
          if (local.count === 1) {
            dstQualifiedName = local.qualifiedName;
            confidence = HEURISTIC_CONFIDENCE_SAME_FILE;
            break;
          }
          sawAmbiguous = true;
          continue;
        }
        if (importedNames.has(candidate)) {
          dstQualifiedName = candidate;
          confidence = HEURISTIC_CONFIDENCE_IMPORT_BOUND;
          break;
        }
      }
      if (dstQualifiedName === undefined) {
        if (sawAmbiguous) skippedAmbiguous += 1;
        else skippedUnresolved += 1;
        continue;
      }

      resolved += 1;
      const key = `${src.qualifiedName}\u0000${dstQualifiedName}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      edges.push({
        srcQualifiedName: src.qualifiedName,
        dstQualifiedName,
        type: "CALLS",
        confidence,
        provenance: "heuristic",
      });
    }

    files.push({ ...ir, edges });
  }

  return {
    files,
    stats: {
      callSites,
      resolved,
      skippedUnresolved,
      skippedAmbiguous,
      skippedNoEnclosingSymbol,
    },
  };
}
