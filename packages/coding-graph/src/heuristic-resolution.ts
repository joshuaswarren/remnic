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
 *       1. a same-file symbol VISIBLE from the call site under lexical
 *         scoping approximated by span containment: the caller's own
 *         nested symbols first, then each enclosing scope's children out
 *         to the file level. Innermost match wins (shadowing); a nested
 *         symbol under an unrelated parent is not visible (codex P2 on
 *         #1894). Confidence {@link HEURISTIC_CONFIDENCE_SAME_FILE}.
 *       2. an import-bound name (`imports[].importedNames`) whose module
 *         specifier is RELATIVE ("./", "../") — i.e. resolvable inside
 *         the repo. External-package imports (lodash, node:fs) never
 *         bind: emitting their bare names would let the store's
 *         qualified-name fallback attach them to unrelated in-repo
 *         symbols (codex P2 on #1894). Confidence
 *         {@link HEURISTIC_CONFIDENCE_IMPORT_BOUND}; the store's
 *         cross-file/full-DB resolution finds the exporting file.
 *     A bare name with neither anchor (e.g. `console.log`'s `log`) is
 *     skipped — emitting it would delegate a guess, not evidence.
 *   - Ambiguity is dropped conservatively (same policy as the store's
 *     pass-2): a bare name matching two symbols in the SAME scope level
 *     resolves to neither; the next candidate is tried.
 *
 * Final id resolution (batch map + full-DB dst fallback + ambiguity
 * drops) stays in `GraphStore.upsertFileEdges`; this module never touches
 * the DB. Every file in the output carries an explicit `edges` array —
 * `[]` asserts "this parse supports no heuristic edges" so stale edges
 * from a prior version of the file are cleaned up. Paired with the
 * store's provenance-scoped stale delete (`assertedEdgeProvenances`),
 * re-derivation never destroys `trace`/`lsp` edges (rule 25).
 */
import { posix } from "node:path";

import type { EdgeIR, FileIR, StoreFileIR } from "./graph-store.js";

/**
 * Languages where a method call on the enclosing instance REQUIRES an
 * explicit receiver (this./self.) — a bare identifier call can never mean
 * a sibling method, so class-like scopes are excluded from bare-call
 * resolution. Implicit-this languages (Java, C#, Kotlin, Swift, Ruby,
 * PHP, C++, Go methods via receivers, ...) keep their class scopes.
 */
const EXPLICIT_RECEIVER_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "tsx",
  "javascript",
  "python",
  // PHP method dispatch requires $this->/self:: — both arrive as
  // member_call_expression (memberAccess) — so a bare helper() inside a
  // method never means a sibling method (codex review round 12).
  "php",
]);

/** Confidence for a call resolved to a unique same-file symbol. */
export const HEURISTIC_CONFIDENCE_SAME_FILE = 0.9;
/** Confidence for a call resolved through an import binding. */
export const HEURISTIC_CONFIDENCE_IMPORT_BOUND = 0.8;

/**
 * The provenance scope reindex asserts for derived edges: ONLY its own
 * heuristic derivations. Each provenance layer owns its lifecycle
 * (issue #1894 review rounds 3/7/8): `lsp` rows include member-dispatch
 * resolutions Phase A deliberately never re-asserts, so including `lsp`
 * here would retire still-valid method-call edges on every edit of their
 * file. Vanished-call `lsp` rows are the LSP pass's job to retire when it
 * re-derives from the current parse (its edges die with their src nodes on
 * symbol pruning regardless). `trace` (runtime observation) and semantic
 * edges are likewise never this scope's to touch. The store's update guard
 * separately ensures a re-asserted key never DOWNGRADES an lsp row.
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
  /** Member/property calls — Phase B (LSP) territory, never bare-bound. */
  readonly skippedMemberAccess: number;
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
 */
export function deriveHeuristicEdges(
  batch: readonly FileIR[],
): HeuristicResolutionResult {
  let callSites = 0;
  let resolved = 0;
  let skippedUnresolved = 0;
  let skippedAmbiguous = 0;
  let skippedNoEnclosingSymbol = 0;
  let skippedMemberAccess = 0;

  const files: ResolvedFileIR[] = [];

  for (const ir of batch) {
    // Lexical-scope approximation from span containment: each symbol's
    // parent is the innermost OTHER symbol strictly containing its span;
    // no parent = file level (empty-string key).
    const parentOf = new Map<string, string>();
    const kindOf = new Map<string, string>();
    for (const sym of ir.symbols) kindOf.set(sym.qualifiedName, sym.kind);
    for (const sym of ir.symbols) {
      let parent: { qualifiedName: string; size: number } | undefined;
      for (const other of ir.symbols) {
        if (other === sym) continue;
        const contains =
          other.span.startByte <= sym.span.startByte &&
          sym.span.endByte <= other.span.endByte;
        const identical =
          other.span.startByte === sym.span.startByte &&
          other.span.endByte === sym.span.endByte;
        if (!contains || identical) continue;
        const size = other.span.endByte - other.span.startByte;
        if (!parent || size < parent.size) {
          parent = { qualifiedName: other.qualifiedName, size };
        }
      }
      parentOf.set(sym.qualifiedName, parent ? parent.qualifiedName : "");
    }
    // scope level (parent qualifiedName or "" = file) → name → matches.
    const scopeByName = new Map<string, Map<string, { qualifiedName: string; count: number }>>();
    for (const sym of ir.symbols) {
      const level = parentOf.get(sym.qualifiedName) ?? "";
      let names = scopeByName.get(level);
      if (!names) {
        names = new Map();
        scopeByName.set(level, names);
      }
      const prior = names.get(sym.name);
      if (prior) {
        prior.count += 1;
      } else {
        names.set(sym.name, { qualifiedName: sym.qualifiedName, count: 1 });
      }
    }
    // name → repo-relative extension-stripped target path. Only relative
    // specifiers bind (an external package's names must never resolve to
    // in-repo symbols); the hint travels on the edge so the store resolves
    // the dst ONLY within the declared target file (#1894 review).
    const importBindings = new Map<
      string,
      Array<{ exported: string; hint: string; enclosing: string | undefined; invisible?: boolean }>
    >();
    for (const imp of ir.imports) {
      // Two relative-import spellings bind (cursor review on #1894):
      //  - path style ("./x", "../x") — JS/TS and friends;
      //  - Python dot style (".models", "..parent.sub") — one leading dot
      //    is the current package, each extra dot goes one level up, and
      //    interior dots are path separators.
      let specifier: string | undefined;
      if (imp.module.startsWith("./") || imp.module.startsWith("../")) {
        specifier = imp.module;
      } else if (ir.language === "python" && imp.module.startsWith(".")) {
        const dots = (/^\.+/.exec(imp.module))?.[0].length ?? 1;
        const rest = imp.module.slice(dots).replace(/\./g, "/");
        specifier = `${"../".repeat(dots - 1)}${rest}` || ".";
      }
      if (specifier === undefined) continue;
      const joined = posix.join(posix.dirname(ir.path), specifier);
      // Strip any trailing slash BEFORE extension-stripping: a pure
      // parent-package import (python "from .. import x") joins to
      // "pkg/" and the store's hint patterns match "pkg" /
      // "pkg/__init__.<ext>", never "pkg/" (codex review round 10).
      const hint = joined.replace(/\/+$/, "").replace(/\.[cm]?[jt]sx?$/, "");
      // A normalized hint still starting with "../" escapes the repo root:
      // files.path values are canonical (no ".." segments), so such an
      // edge could never resolve — skip the binding here so the call site
      // is honestly counted as unresolved instead of emitting a
      // guaranteed-dead edge (cursor review on #1894).
      if (hint.startsWith("../")) continue;
      // Alias-aware (codex review on #1894): call sites use the LOCAL
      // identifier; the dst in the target file is the EXPORTED name.
      // Fallback semantics sharpened across rounds 9 and 12: an ABSENT
      // bindings field means a pre-bindings emitter (or hand-built IR) —
      // fall back to importedNames as local===exported. An EXPLICIT empty
      // array is the parser saying "no call-bindable names" (default /
      // namespace imports whose exported symbol Phase A cannot know) and
      // must NOT re-bind through the fallback.
      const bindings =
        imp.bindings ?? imp.importedNames.map((name) => ({ exported: name, local: name }));
      // A function-local import binds only within its enclosing symbol
      // (codex review round 12): find the innermost symbol containing the
      // import's span; undefined = file level (binds everywhere).
      let enclosing: { qualifiedName: string; size: number } | undefined;
      for (const sym of ir.symbols) {
        if (sym.span.startByte > imp.span.startByte || imp.span.endByte > sym.span.endByte) continue;
        const size = sym.span.endByte - sym.span.startByte;
        if (!enclosing || size < enclosing.size) {
          enclosing = { qualifiedName: sym.qualifiedName, size };
        }
      }
      // A local name can be imported in more than one scope (codex review
      // round 13); keep them all and choose the innermost matching one at
      // the call site. Class-body imports are class attributes and are NOT
      // bare-call-visible, so a class-kind enclosing is filtered out at
      // lookup time.
      const enclosingKind =
        enclosing === undefined ? undefined : kindOf.get(enclosing.qualifiedName);
      const visible =
        enclosingKind === undefined ||
        (enclosingKind !== "class" &&
          enclosingKind !== "interface" &&
          enclosingKind !== "enum");
      for (const b of bindings) {
        const list = importBindings.get(b.local) ?? [];
        list.push({
          exported: b.exported,
          hint,
          enclosing: visible ? enclosing?.qualifiedName : undefined,
          // A class-body import is genuinely invisible: store it with a
          // sentinel that can never match an ancestor chain.
          invisible: !visible,
        });
        importBindings.set(b.local, list);
      }
    }

    const edges: EdgeIR[] = [];
    const seenKeys = new Set<string>();

    for (const site of ir.callSites) {
      callSites += 1;

      // Member/property calls (obj.save()) never bind bare names in
      // Phase A: the receiver decides the target, and only Phase B (LSP)
      // can resolve dispatch (codex review on #1894).
      if (site.memberAccess === true) {
        skippedMemberAccess += 1;
        continue;
      }

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

      // Visible scope levels for this call site, innermost first: the
      // caller's own children, then each ancestor's children, ending at
      // the file level. Symbols nested under unrelated parents are never
      // consulted. In EXPLICIT-receiver languages (JS/TS/Python),
      // class-like ancestors are NOT bare-call scopes (codex review
      // round 8): a bare helper() inside a method cannot mean the
      // sibling method C.helper — that call would be
      // this.helper()/self.helper(), i.e. a member access Phase A
      // skips. Implicit-this languages (Java/C#/Kotlin/Swift/Ruby/...)
      // DO allow an unqualified call to target a same-type method, so
      // their class scopes contribute (codex review round 11).
      // Function/method/module ancestors always contribute.
      const excludeClassScopes = EXPLICIT_RECEIVER_LANGUAGES.has(ir.language);
      const scopeLevels: string[] = [src.qualifiedName];
      // Full ancestor chain (class levels included) — used for
      // function-local import visibility, which is lexical containment,
      // not bare-call scoping.
      const ancestorChain = new Set<string>([src.qualifiedName]);
      let cursor: string | undefined = src.qualifiedName;
      while (cursor !== undefined && cursor !== "") {
        cursor = parentOf.get(cursor) ?? "";
        if (cursor !== "") ancestorChain.add(cursor);
        if (excludeClassScopes) {
          const kind = cursor === "" ? undefined : kindOf.get(cursor);
          if (kind === "class" || kind === "interface" || kind === "enum") continue;
        }
        scopeLevels.push(cursor);
      }

      // dst: first candidate with in-IR evidence. Ambiguity is tracked
      // PER CANDIDATE (cursor review on #1894): an ambiguous same-file
      // match for candidate A must not block candidate B's import
      // binding.
      let dstQualifiedName: string | undefined;
      let dstPathHint: string | undefined;
      let confidence = 0;
      let sawAmbiguous = false;
      for (const candidate of site.calleeNameCandidates) {
        let candidateAmbiguous = false;
        for (const level of scopeLevels) {
          const match = scopeByName.get(level)?.get(candidate);
          if (!match) continue;
          if (match.count === 1) {
            dstQualifiedName = match.qualifiedName;
            confidence = HEURISTIC_CONFIDENCE_SAME_FILE;
          } else {
            candidateAmbiguous = true;
          }
          break; // innermost level with the name decides (shadowing).
        }
        if (dstQualifiedName !== undefined) break;
        if (candidateAmbiguous) {
          sawAmbiguous = true;
          continue;
        }
        const candidates = importBindings.get(candidate);
        if (candidates !== undefined) {
          // Innermost visible binding wins (codex review round 13):
          // a function-local import shadows a same-name file-level one
          // inside that function; class-body imports are never visible.
          let chosen: { exported: string; hint: string } | undefined;
          let chosenDepth = -1;
          for (const c of candidates) {
            if (c.invisible) continue;
            if (c.enclosing === undefined) {
              if (chosenDepth < 0) { chosen = c; chosenDepth = 0; }
              continue;
            }
            if (ancestorChain.has(c.enclosing)) {
              const depth = [...ancestorChain].indexOf(c.enclosing);
              if (chosenDepth < 0 || depth < chosenDepth) { chosen = c; chosenDepth = depth; }
            }
          }
          if (chosen) {
            dstQualifiedName = chosen.exported;
            dstPathHint = chosen.hint;
            confidence = HEURISTIC_CONFIDENCE_IMPORT_BOUND;
            break;
          }
        }
      }
      if (dstQualifiedName === undefined) {
        if (sawAmbiguous) skippedAmbiguous += 1;
        else skippedUnresolved += 1;
        continue;
      }

      resolved += 1;
      // The hint is part of edge identity (codex review on #1894): two
      // aliased imports of the same exported name from different modules
      // resolve to different nodes at the store, so both must survive.
      const key = `${src.qualifiedName}\u0000${dstQualifiedName}\u0000${dstPathHint ?? ""}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      edges.push({
        srcQualifiedName: src.qualifiedName,
        dstQualifiedName,
        type: "CALLS",
        confidence,
        provenance: "heuristic",
        ...(dstPathHint !== undefined
          ? { dstPathHint, dstImporterLanguage: ir.language }
          : {}),
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
      skippedMemberAccess,
    },
  };
}
