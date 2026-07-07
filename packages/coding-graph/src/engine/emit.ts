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
import { buildUtf16ToByteOffsetMap, utf16ToByte } from "./utf16-offsets.js";

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
  /** Go receiver type (e.g. "Server" from `func (s *Server) Start()`). */
  readonly receiverType?: string;
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
      let receiverType = "";
      for (const cap of match.captures) {
        const k = kindFromCapture(cap.name);
        if (k) {
          kind = k;
          defNode = cap.node;
        } else if (cap.name === "name") {
          nameNode = cap.node;
        } else if (cap.name === "__receiver.type") {
          receiverType = cap.node.text;
        }
      }
      if (!kind || !defNode || !nameNode) continue;
      rawDefs.push({
        kind,
        name: nameNode.text,
        startByte: defNode.startIndex,
        endByte: defNode.endIndex,
        receiverType: receiverType || undefined,
      });
    }

    // Deduplicate: a function_item inside an impl block matches both the
    // general function_item pattern and the impl-scoped method pattern.
    // Keep the method version (which carries the receiver type for parent
    // qualification). Same startByte+endByte+name guarantees it's the same
    // AST node matched by two query patterns, not two distinct definitions.
    const seen = new Map<string, RawDef>();
    for (const def of rawDefs) {
      const key = `${def.startByte}:${def.endByte}:${def.name}`;
      const existing = seen.get(key);
      if (!existing || (def.receiverType && !existing.receiverType)) {
        seen.set(key, def);
      }
    }
    const deduped = [...seen.values()];
    deduped.sort((a, b) => a.startByte - b.startByte || a.name.localeCompare(b.name));

    // The stack stores each def's computed qualifiedName so that nested
    // definitions inside a receiver-qualified method (e.g. Config.new.helper)
    // get the full parent chain, not just the short method name.
    const stack: { endByte: number; qualifiedName: string }[] = [];
    const symbols: SymbolIR[] = [];
    for (const def of deduped) {
      while (stack.length > 0 && stack[stack.length - 1].endByte <= def.startByte) {
        stack.pop();
      }
      // Go/Rust methods sit outside their receiver struct, so byte-span
      // nesting cannot determine the parent. Use the captured receiver
      // type instead.
      // The last stack entry's qualifiedName already contains the full
      // ancestor chain (e.g. "Server.start"), so use it directly rather
      // than joining all entries (which would duplicate ancestors).
      const parentQualifiedName =
        def.receiverType ??
        (stack.length > 0 ? stack[stack.length - 1].qualifiedName : undefined);
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
      stack.push({ endByte: def.endByte, qualifiedName });
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
    // Group by (statement-start + module) so multi-module statements like
    // Python `import os, sys` produce separate import entries rather than
    // collapsing to a single module. Single-module statements like
    // `import { foo, bar } from "module"` still group correctly because
    // all captures share the same module.
    const groups = new Map<
      string,
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

      const key = `${stmtStart}:${moduleText}`;
      const existing = groups.get(key);
      if (existing) {
        for (const n of names) existing.names.add(n);
      } else {
        groups.set(key, {
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
    // Dedup a CommonJS pair overlap (#1659 review): a pair
    // `{ key: value }` whose value is an identifier is matched by BOTH
    // the value-identifier pattern (captures the real symbol) AND the
    // non-identifier fallback (captures the key). The fallback's
    // #not-match? regex is ASCII-only, so a Unicode identifier value
    // (e.g. Universität) defeats it and both patterns fire on the same
    // pair, duplicating the export. web-tree-sitter's query regex
    // engine does not support \p{L}, so dedup here: if a pair already
    // exported its value identifier, drop the spurious key capture.
    const valueExportedPairs = new Set<number>();
    const pairOf = (node: TSNode): TSNode | null => {
      let cur: TSNode | null = node;
      for (let i = 0; i < 5 && cur; i++) {
        if (cur.type === "pair") return cur;
        cur = cur.parent;
      }
      return null;
    };
    for (const cap of captures) {
      if (cap.name !== "export.name") continue;
      const pair = pairOf(cap.node);
      if (pair && cap.node.type === "identifier") {
        valueExportedPairs.add(pair.id);
      }
    }
    const exports: ExportIR[] = [];
    for (const cap of captures) {
      if (cap.name !== "export.name") continue;
      const pair = pairOf(cap.node);
      if (
        pair &&
        cap.node.type === "property_identifier" &&
        valueExportedPairs.has(pair.id)
      ) {
        continue; // value identifier is the real export; drop the alias key
      }
      exports.push({
        name: cap.node.text,
        span: { startByte: cap.node.startIndex, endByte: cap.node.endIndex },
      });
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


// Common HTTP client variable names that should NOT produce routes.
// These objects have methods named get/post/etc. that match the route
// verb pattern but are client-side calls, not server route registrations.
// Without this exclusion, httpClient.get("/api", opts, cb) would produce
// a spurious route with handler=cb, marking cb as is_route_handler and
// hiding it from dead-code detection (chatgpt-codex-connector #1688 P2).
const HTTP_CLIENT_OBJECT_PATTERNS = /^(http|https|client|httpClient|axios|fetch|request|req|res|\$|superagent|got)$/;

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
      let argsNode: TSNode | null = null;
      let routeObject = "";
      for (const cap of match.captures) {
        if (cap.name === "route.verb") {
          verb = cap.node.text.toUpperCase();
          startByte = cap.node.parent?.startIndex ?? cap.node.startIndex;
          // Extract the receiver object name for the HTTP-client exclusion.
          const memberExpr = cap.node.parent;
          const objectNode = memberExpr?.childForFieldName("object");
          if (objectNode) {
            // Normalize nested receivers to their tail property so a call
            // like this.client.get("/api", opts, cb) is caught by the HTTP-
            // client exclusion. objectNode.text for `this.client` is
            // "this.client", which misses the ^client$ pattern; descend to
            // the rightmost property (chatgpt-codex-connector #1688 P2:
            // 'Normalize receiver names before client-route filtering').
            let receiver = objectNode;
            for (
              let prop = receiver.childForFieldName("property");
              prop;
              prop = receiver.childForFieldName("property")
            ) {
              receiver = prop;
            }
            routeObject = receiver.text;
          }
        } else if (cap.name === "route.path") {
          pathTemplate = cleanModuleSpecifier(cap.node.text);
        } else if (cap.name === "route.handler") {
          // Python route handlers (function names) and legacy JS patterns.
          handler = cap.node.type === "identifier"
            ? cap.node.text
            : (findHandlerName(cap.node) ?? "anonymous");
          endByte = cap.node.endIndex;
        } else if (cap.name === "route.args") {
          argsNode = cap.node;
          endByte = cap.node.endIndex;
        }
      }
      // Extract handler from the last argument when we captured the args
      // node (JS routes). Handles middleware: handler is the LAST arg (#1659 #5).
      if (argsNode) {
        handler = extractHandlerFromArgs(argsNode);
      }
      // Guards: (1) path-prefix — routes start with "/" or "*";
      // (2) HTTP-client exclusion — objects named http/client/axios/etc.
      // are clients, not routers. Together these filter the most common
      // non-route call expressions that match the verb+string-arg pattern
      // (chatgpt-codex-connector #1688 P2: 'Reject client callbacks').
      const isRoutePath = pathTemplate.startsWith("/") || pathTemplate.startsWith("*");
      const isHttpClient = HTTP_CLIENT_OBJECT_PATTERNS.test(routeObject);
      if (verb && pathTemplate && handler && isRoutePath && !isHttpClient) {
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
 * Extract the route handler name from the LAST argument of an arguments
 * node. Handles middleware: app.get("/path", requireAuth, getUsers) →
 * handler=getUsers (the last arg), not requireAuth (issue #1659 #5).
 */
function extractHandlerFromArgs(argsNode: TSNode): string {
  // Collect the real (non-comment) named args, skipping trailing inline/
  // block comments. tree-sitter treats comments as named children, so
  // `app.get("/users", getUsers /* auth */)` would otherwise select the
  // comment as the last arg, miss the real handler, and leave it
  // un-protected by the route-handler exclusion (a false dead-code hit).
  // (chatgpt-codex-connector #1659 review: 'Skip comments when selecting
  // route handler'.)
  const realArgs: TSNode[] = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    if (child && child.type !== "comment") realArgs.push(child);
  }
  if (realArgs.length < 2) return "";
  const lastArg = realArgs[realArgs.length - 1]!;
  if (lastArg.type === "identifier") {
    return lastArg.text;
  }
  if (lastArg.type === "function_expression") {
    return findHandlerName(lastArg) ?? "anonymous";
  }
  if (lastArg.type === "arrow_function") {
    return "anonymous";
  }
  // Non-handler last arg (object, number, call expression, etc.) —
  // not a route handler. Return empty so the caller skips the route
  // (cursor Bugbot: 'Spurious routes from client calls').
  return "";
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
 *
 * `contentStr` is the UTF-8 string that was passed to the parser. It is used
 * to build a UTF-16→byte offset map so all spans are converted from UTF-16
 * code-unit offsets (what web-tree-sitter returns) to UTF-8 byte offsets
 * (what on-disk files use). For ASCII-only content the two are identical;
 * multibyte content (comments, strings, identifiers) needs the conversion
 * (issue #1659 item 3).
 */
export function emitFileIR(
  filePath: string,
  lang: CodingGraphLanguage,
  content: Uint8Array,
  root: TSNode,
  language: Language,
  contentStr: string,
): FileIR {
  const symbols = extractSymbols(root, language, lang);
  const imports = extractImports(root, language, lang);
  const exports = extractExports(root, language, lang);
  const callSites = extractCallSites(root, language, lang);
  const routes = extractRoutes(root, language, lang);

  // Convert UTF-16 code-unit offsets → UTF-8 byte offsets (issue #1659 #3).
  // Spans are readonly, so rebuild each object with converted offsets.
  const offsetMap = buildUtf16ToByteOffsetMap(contentStr);
  const convSymbols = symbols.map((s) => ({
    ...s,
    span: {
      startByte: utf16ToByte(offsetMap, s.span.startByte),
      endByte: utf16ToByte(offsetMap, s.span.endByte),
    },
  }));
  const convImports = imports.map((i) => ({
    ...i,
    span: {
      startByte: utf16ToByte(offsetMap, i.span.startByte),
      endByte: utf16ToByte(offsetMap, i.span.endByte),
    },
  }));
  const convExports = exports.map((e) => ({
    ...e,
    span: {
      startByte: utf16ToByte(offsetMap, e.span.startByte),
      endByte: utf16ToByte(offsetMap, e.span.endByte),
    },
  }));
  const convCallSites = callSites.map((c) => ({
    ...c,
    span: {
      startByte: utf16ToByte(offsetMap, c.span.startByte),
      endByte: utf16ToByte(offsetMap, c.span.endByte),
    },
  }));
  const convRoutes = routes.map((r) => ({
    ...r,
    span: {
      startByte: utf16ToByte(offsetMap, r.span.startByte),
      endByte: utf16ToByte(offsetMap, r.span.endByte),
    },
  }));

  return {
    path: filePath,
    language: lang,
    contentHash: hashContent(content),
    symbols: convSymbols,
    imports: convImports,
    exports: convExports,
    callSites: convCallSites,
    routes: convRoutes,
  };
}
