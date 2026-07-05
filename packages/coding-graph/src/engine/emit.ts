/**
 * FileIR emitter — runs tree-sitter queries against a parsed tree and
 * assembles the neutral intermediate representation.
 *
 * Determinism (rule 38): every collection is sorted before it leaves this
 * module. Sort keys are chosen so output is byte-identical across runs:
 *   symbols   → (startByte, name)
 *   imports   → (startByte, module)
 *   exports   → (startByte, name)
 *   callSites → (startByte, firstCandidate)
 *   routes    → (startByte, pathTemplate)
 */
import { createHash } from "node:crypto";
import { Query, type Language, type Node as TSNode } from "web-tree-sitter";
import type {
  CallSiteIR,
  ExportIR,
  FileIR,
  ImportIR,
  RouteIR,
  SymbolIR,
} from "@remnic/core/coding/coding-graph-types";
import type { CodingGraphLanguage } from "@remnic/core";

import {
  EXTRACTORS,
  kindFromCapture,
  type DefKind,
} from "./extractors.js";

// ---------------------------------------------------------------------------
// Content hashing — SHA-256 of the raw bytes (rule 23).
// ---------------------------------------------------------------------------

export function hashContent(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Module-specifier cleanup — strips quotes/brackets from the captured text.
// ---------------------------------------------------------------------------

function cleanModuleSpecifier(raw: string): string {
  let s = raw.trim();
  // Strip C/C++ system includes: <stdio.h>
  if (s.startsWith("<") && s.endsWith(">")) return s.slice(1, -1);
  // Strip double/single/backtick quotes.
  if (s.length >= 2) {
    const f = s[0];
    const l = s[s.length - 1];
    if ((f === '"' || f === "'" || f === "`") && f === l) return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Symbol extraction with qualified-name computation.
//
// Qualified names are computed via a nesting stack: definitions are sorted by
// startByte; for each definition we pop the stack until the top contains the
// current definition's start byte. The qualified name is the join of the
// stack's names plus the current name. This correctly handles sibling methods
// in a class, nested classes, etc.
// ---------------------------------------------------------------------------

interface RawDef {
  readonly kind: DefKind;
  readonly name: string;
  readonly startByte: number;
  readonly endByte: number;
}

function extractSymbols(root: TSNode, language: Language, lang: CodingGraphLanguage): SymbolIR[] {
  const extractor = EXTRACTORS[lang];
  const query = new Query(language, extractor.definitionsQuery);
  try {
    const matches = query.matches(root);

    const rawDefs: RawDef[] = [];
    for (const match of matches) {
      let kind: DefKind | null = null;
      let nameNode: TSNode | null = null;
      let defNode: TSNode | null = null;
      for (const cap of match.captures) {
        const k = kindFromCapture(cap.name);
        if (k) {
          kind = k;
          defNode = cap.node;
        } else if (cap.name === "name") {
          nameNode = cap.node;
        }
      }
      if (!kind || !defNode || !nameNode) continue;
      rawDefs.push({
        kind,
        name: nameNode.text,
        startByte: defNode.startIndex,
        endByte: defNode.endIndex,
      });
    }

    rawDefs.sort((a, b) => a.startByte - b.startByte || a.name.localeCompare(b.name));

    const stack: RawDef[] = [];
    const symbols: SymbolIR[] = [];
    for (const def of rawDefs) {
      while (stack.length > 0 && stack[stack.length - 1].endByte <= def.startByte) {
        stack.pop();
      }
      const parentQualifiedName =
        stack.length > 0 ? stack.map((d) => d.name).join(".") : undefined;
      const qualifiedName = parentQualifiedName
        ? `${parentQualifiedName}.${def.name}`
        : def.name;
      const symbol: SymbolIR = parentQualifiedName
        ? {
            kind: def.kind,
            name: def.name,
            qualifiedName,
            span: { startByte: def.startByte, endByte: def.endByte },
            parentQualifiedName,
          }
        : {
            kind: def.kind,
            name: def.name,
            qualifiedName,
            span: { startByte: def.startByte, endByte: def.endByte },
          };
      symbols.push(symbol);
      stack.push(def);
    }
    return symbols;
  } finally {
    query.delete();
  }
}

// ---------------------------------------------------------------------------
// Import extraction — group captures by @__import.stmt node.
// ---------------------------------------------------------------------------

function extractImports(root: TSNode, language: Language, lang: CodingGraphLanguage): ImportIR[] {
  const extractor = EXTRACTORS[lang];
  if (!extractor.importsQuery) return [];
  const query = new Query(language, extractor.importsQuery);
  try {
    const matches = query.matches(root);

    // Group by import-statement node start index (unique per node in tree).
    const groups = new Map<
      number,
      { module: string; names: Set<string>; startByte: number; endByte: number }
    >();

    for (const match of matches) {
      let moduleText = "";
      let stmtStart = -1;
      let stmtEnd = -1;
      const names: string[] = [];

      for (const cap of match.captures) {
        if (cap.name === "import.module") {
          moduleText = cleanModuleSpecifier(cap.node.text);
        } else if (cap.name === "import.name") {
          names.push(cap.node.text);
        } else if (cap.name === "__import.stmt") {
          stmtStart = cap.node.startIndex;
          stmtEnd = cap.node.endIndex;
        }
      }

      if (stmtStart < 0) {
        // Fallback: use the first capture's parent chain to find an import node.
        const firstCap = match.captures[0];
        if (firstCap) {
          stmtStart = firstCap.node.startIndex;
          stmtEnd = firstCap.node.endIndex;
        } else {
          continue;
        }
      }

      const existing = groups.get(stmtStart);
      if (existing) {
        if (moduleText && !existing.module) existing.module = moduleText;
        for (const n of names) existing.names.add(n);
      } else {
        groups.set(stmtStart, {
          module: moduleText,
          names: new Set(names),
          startByte: stmtStart,
          endByte: stmtEnd,
        });
      }
    }

    return Array.from(groups.values())
      .map((g) => ({
        module: g.module,
        importedNames: Array.from(g.names).sort(),
        span: { startByte: g.startByte, endByte: g.endByte },
      }))
      .sort((a, b) => a.span.startByte - b.span.startByte || a.module.localeCompare(b.module));
  } finally {
    query.delete();
  }
}

// ---------------------------------------------------------------------------
// Export extraction.
// ---------------------------------------------------------------------------

function extractExports(root: TSNode, language: Language, lang: CodingGraphLanguage): ExportIR[] {
  const extractor = EXTRACTORS[lang];
  if (!extractor.exportsQuery) return [];
  const query = new Query(language, extractor.exportsQuery);
  try {
    const captures = query.captures(root);
    const exports: ExportIR[] = [];
    for (const cap of captures) {
      if (cap.name === "export.name") {
        exports.push({
          name: cap.node.text,
          span: { startByte: cap.node.startIndex, endByte: cap.node.endIndex },
        });
      }
    }
    return exports.sort(
      (a, b) => a.span.startByte - b.span.startByte || a.name.localeCompare(b.name),
    );
  } finally {
    query.delete();
  }
}

// ---------------------------------------------------------------------------
// Call-site extraction.
// ---------------------------------------------------------------------------

function extractCallSites(root: TSNode, language: Language, lang: CodingGraphLanguage): CallSiteIR[] {
  const extractor = EXTRACTORS[lang];
  if (!extractor.callSitesQuery) return [];
  const query = new Query(language, extractor.callSitesQuery);
  try {
    const captures = query.captures(root);
    const callSites: CallSiteIR[] = [];
    for (const cap of captures) {
      if (cap.name === "call.callee") {
        callSites.push({
          calleeNameCandidates: [cap.node.text],
          span: { startByte: cap.node.startIndex, endByte: cap.node.endIndex },
        });
      }
    }
    return callSites.sort(
      (a, b) => a.span.startByte - b.span.startByte ||
        (a.calleeNameCandidates[0] ?? "").localeCompare(b.calleeNameCandidates[0] ?? ""),
    );
  } finally {
    query.delete();
  }
}

// ---------------------------------------------------------------------------
// Route extraction (Express/Fastify/Flask/etc.).
// ---------------------------------------------------------------------------

function extractRoutes(root: TSNode, language: Language, lang: CodingGraphLanguage): RouteIR[] {
  const extractor = EXTRACTORS[lang];
  if (!extractor.routesQuery) return [];
  const query = new Query(language, extractor.routesQuery);
  try {
    const matches = query.matches(root);
    const routes: RouteIR[] = [];
    for (const match of matches) {
      let verb = "";
      let pathTemplate = "";
      let handler = "";
      let startByte = 0;
      let endByte = 0;
      for (const cap of match.captures) {
        if (cap.name === "route.verb") {
          verb = cap.node.text.toUpperCase();
          startByte = cap.node.parent?.startIndex ?? cap.node.startIndex;
        } else if (cap.name === "route.path") {
          pathTemplate = cleanModuleSpecifier(cap.node.text);
        } else if (cap.name === "route.handler") {
          // For JS: the handler is an arrow_function/function_expression node.
          // Its name is the first identifier parameter or "anonymous".
          const nameNode = findHandlerName(cap.node);
          handler = nameNode ?? "anonymous";
          endByte = cap.node.endIndex;
        }
      }
      if (verb && pathTemplate) {
        routes.push({
          verb,
          pathTemplate,
          handlerQualifiedName: handler,
          span: { startByte, endByte },
        });
      }
    }
    return routes.sort(
      (a, b) => a.span.startByte - b.span.startByte || a.pathTemplate.localeCompare(b.pathTemplate),
    );
  } finally {
    query.delete();
  }
}

/**
 * Try to find a handler name from a function/arrow expression node.
 * For named function expressions: `(function foo() {})` → "foo".
 * For arrow functions assigned to a variable, the variable name is not in this node;
 * the caller would need the parent. For now, return "anonymous" unless we find a name.
 */
function findHandlerName(node: TSNode): string | null {
  // function_expression may have a name child (identifier)
  for (const child of node.namedChildren) {
    if (child && child.type === "identifier") return child.text;
  }
  // Python function_definition has a name field
  const nameChild = node.childForFieldName("name");
  if (nameChild) return nameChild.text;
  return null;
}

// ---------------------------------------------------------------------------
// Top-level emitter.
// ---------------------------------------------------------------------------

/**
 * Assemble a FileIR from a parsed tree. All collections are sorted for
 * deterministic output (rule 38).
 */
export function emitFileIR(
  filePath: string,
  lang: CodingGraphLanguage,
  content: Uint8Array,
  root: TSNode,
  language: Language,
): FileIR {
  const symbols = extractSymbols(root, language, lang);
  const imports = extractImports(root, language, lang);
  const exports = extractExports(root, language, lang);
  const callSites = extractCallSites(root, language, lang);
  const routes = extractRoutes(root, language, lang);
  return {
    path: filePath,
    language: lang,
    contentHash: hashContent(content),
    symbols,
    imports,
    exports,
    callSites,
    routes,
  };
}
