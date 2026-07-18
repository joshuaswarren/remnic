/**
 * check-config-contract v2 — parser-walking key extractor (issue #1990 PR1).
 *
 * Derives the AUTHORITATIVE set of accepted config key paths from the
 * PARSERS themselves (`parseConfig` in packages/remnic-core/src/config.ts and
 * every module parser it delegates to), so a key that exists only in parser
 * code — the exact class reviewers caught on PR #1923 (`codingKnowledge.lsp`
 * parsed but absent from the manifests) — becomes CI-visible.
 *
 * Strategy (issue #1990, hybrid):
 *  - Hand-rolled parsers (all current production parsers): TypeScript
 *    compiler API. Within each parser we track the raw-input parameter and
 *    its ALIASES (`const raw = requireObject(value, …)`,
 *    `value as Record<string, unknown>`, `const sub = raw.fusion`, …) and
 *    collect property accesses on them. An alias minted from `raw.fusion`
 *    carries the `fusion.` path prefix, so nested blocks flatten to
 *    `wearables.fusion.enabled`-style paths.
 *  - Zod-based parsers: static walk of `z.object({ … })` literals in the
 *    parser body (deterministic; no runtime import side effects).
 *  - Anything the walker genuinely cannot see (computed keys, dynamic
 *    `Object.keys` loops) is reported LOUDLY as an unparseable construct
 *    with file:line — never silently skipped. The contract check (PR2)
 *    surfaces these; the grandfather manifest tracks accepted ones.
 *
 * Output is sorted (§12 determinism) — the committed snapshot doubles as a
 * config-surface change detector in review.
 *
 * v1 checks key PRESENCE only. Type/enum parity is a follow-up (issue
 * #1990 non-goal).
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface UnparseableConstruct {
  file: string;
  line: number;
  reason: string;
}

export interface ExtractedConfigKeys {
  /** Sorted, flattened key paths accepted by the parsers. */
  keys: string[];
  /** Constructs the walker could not derive keys from — loud, not silent. */
  unparseable: UnparseableConstruct[];
}

/** Helper names that wrap the raw input without changing its shape. */
const SHAPE_PRESERVING_WRAPPERS = new Set([
  "requireObject",
  "asRecord",
  "toRecord",
]);

/**
 * Identifier names whose call results are NOT config-key reads even when the
 * raw alias is an argument (validation/coercion helpers receive the VALUE of
 * a key, and the key itself was already recorded by the property access).
 */
function isRecordLike(node: ts.Expression): node is ts.Identifier {
  return ts.isIdentifier(node);
}

interface AliasInfo {
  /** Path prefix segments from the parser input to this alias ("" = root). */
  prefix: string[];
}

function relPath(repoRoot: string, fileName: string): string {
  return path.relative(repoRoot, fileName).split(path.sep).join("/");
}

/**
 * Extract the keys a single parser function reads from its raw input.
 * Returns path segments relative to the parser's input object.
 */
function extractParserKeys(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  out: { keys: Set<string>; unparseable: UnparseableConstruct[] },
  prefix: string[] = [],
): void {
  if (!fn.body) return;
  const param = fn.parameters[0];
  if (!param || !ts.isIdentifier(param.name)) return;

  // alias name -> path prefix relative to the parser input
  const aliases = new Map<string, AliasInfo>();
  aliases.set(param.name.text, { prefix: [] });

  const recordKey = (aliasPrefix: string[], key: string): void => {
    out.keys.add([...prefix, ...aliasPrefix, key].join("."));
  };

  /** Try to resolve an expression to an alias + extra path segments. */
  const resolveAliasChain = (
    expr: ts.Expression,
  ): { info: AliasInfo; segments: string[] } | null => {
    // Unwrap parens, as-casts, non-null assertions, and shape-preserving calls.
    let current: ts.Expression = expr;
    const segments: string[] = [];
    for (;;) {
      if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
        current = current.expression;
        continue;
      }
      // `cond ? (raw as Record<…>) : {}` — the truthy arm carries the input.
      if (ts.isConditionalExpression(current)) {
        const viaTrue = resolveAliasChain(current.whenTrue);
        if (viaTrue) return { info: viaTrue.info, segments: [...viaTrue.segments, ...segments] };
        const viaFalse = resolveAliasChain(current.whenFalse);
        if (viaFalse) return { info: viaFalse.info, segments: [...viaFalse.segments, ...segments] };
        return null;
      }
      // `raw ?? {}` / `raw || {}` — the left side carries the input.
      if (
        ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        current = current.left;
        continue;
      }
      // `{ ...baseCfg, x: 1 }` — a spread of an alias keeps the alias root.
      if (ts.isObjectLiteralExpression(current)) {
        for (const prop of current.properties) {
          if (ts.isSpreadAssignment(prop)) {
            const viaSpread = resolveAliasChain(prop.expression);
            if (viaSpread) return { info: viaSpread.info, segments: [...viaSpread.segments, ...segments] };
          }
        }
        return null;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        SHAPE_PRESERVING_WRAPPERS.has(current.expression.text) &&
        current.arguments.length >= 1
      ) {
        current = current.arguments[0];
        continue;
      }
      if (ts.isPropertyAccessExpression(current) || (ts.isPropertyAccessChain(current) && current.name)) {
        segments.unshift(current.name.text);
        current = current.expression;
        continue;
      }
      if (
        ts.isElementAccessExpression(current) &&
        current.argumentExpression &&
        ts.isStringLiteral(current.argumentExpression)
      ) {
        segments.unshift(current.argumentExpression.text);
        current = current.expression;
        continue;
      }
      break;
    }
    if (isRecordLike(current)) {
      const info = aliases.get(current.text);
      if (info) return { info, segments };
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    // Alias creation: const X = <expr resolving to alias(+segments)>
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const resolved = resolveAliasChain(node.initializer);
      if (resolved) {
        // The segments read to mint the alias are themselves key reads.
        if (resolved.segments.length > 0) {
          out.keys.add([...prefix, ...resolved.info.prefix, ...resolved.segments].join("."));
        }
        aliases.set(node.name.text, {
          prefix: [...resolved.info.prefix, ...resolved.segments],
        });
        ts.forEachChild(node, visit);
        return;
      }
      // Destructuring: const { a, b: renamed } = raw;
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const resolved = resolveAliasChain(node.initializer);
      if (resolved) {
        for (const element of node.name.elements) {
          const propName = element.propertyName ?? element.name;
          if (ts.isIdentifier(propName)) {
            recordKey([...resolved.info.prefix, ...resolved.segments], propName.text);
            if (ts.isIdentifier(element.name)) {
              aliases.set(element.name.text, {
                prefix: [...resolved.info.prefix, ...resolved.segments, propName.text],
              });
            }
          }
        }
        return;
      }
    }

    // Assignment minting: `cfg = baseCfg` / `cfg = { ...baseCfg, … }`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const resolved = resolveAliasChain(node.right);
      if (resolved) {
        aliases.set(node.left.text, {
          prefix: [...resolved.info.prefix, ...resolved.segments],
        });
        // Still record any key reads inside the right side (spread donors
        // were handled by resolveAliasChain; explicit props may read keys).
        ts.forEachChild(node.right, visit);
        return;
      }
    }

    // Property access on an alias: raw.key / raw?.key / raw["key"]
    if (ts.isPropertyAccessExpression(node)) {
      const resolved = resolveAliasChain(node.expression);
      if (resolved) {
        const isMethodCallee =
          node.parent !== undefined &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node;
        if (isMethodCallee) {
          // `cfg.codexHome.trim()` — trim is a METHOD; the key is the chain
          // before it. Record the chain segments only (when any exist).
          if (resolved.segments.length > 0) {
            out.keys.add([...prefix, ...resolved.info.prefix, ...resolved.segments].join("."));
          }
        } else {
          recordKey([...resolved.info.prefix, ...resolved.segments], node.name.text);
        }
        // Do NOT recurse into node.expression (it would double-count the
        // chain), but the chain segments were already recorded above.
        return;
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const resolved = resolveAliasChain(node.expression);
      if (resolved) {
        if (node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
          recordKey([...resolved.info.prefix, ...resolved.segments], node.argumentExpression.text);
        } else {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          out.unparseable.push({
            file: relPath(repoRoot, sourceFile.fileName),
            line: pos.line + 1,
            reason: "computed element access on parser input — key not statically derivable",
          });
        }
        return;
      }
    }

    // Dynamic iteration over the raw input: Object.keys(raw) / for..in raw
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      ["keys", "entries", "values"].includes(node.expression.name.text) &&
      node.arguments.length === 1
    ) {
      const resolved = resolveAliasChain(node.arguments[0]);
      if (resolved) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        out.unparseable.push({
          file: relPath(repoRoot, sourceFile.fileName),
          line: pos.line + 1,
          reason: `Object.${node.expression.name.text}() over parser input — dynamic key set`,
        });
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(fn.body, visit);

  // Zod arm: static walk of z.object({ … }) literals in the body.
  extractZodObjectKeys(fn.body, prefix, out);
}

/** Collect keys from `z.object({ key: … })` literals (static, no runtime). */
function extractZodObjectKeys(
  body: ts.Node,
  prefix: string[],
  out: { keys: Set<string>; unparseable: UnparseableConstruct[] },
): void {
  const walkSchemaObject = (obj: ts.ObjectLiteralExpression, pathPrefix: string[]): void => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = prop.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
      const keyPath = [...pathPrefix, name.text];
      out.keys.add(keyPath.join("."));
      // Nested z.object({...}) — descend through any call chain
      // (z.object(...).optional() etc.) looking for object literals.
      const findNested = (expr: ts.Node): void => {
        if (ts.isCallExpression(expr)) {
          const callee = expr.expression;
          const isZodObject =
            ts.isPropertyAccessExpression(callee) && callee.name.text === "object";
          if (isZodObject && expr.arguments.length === 1 && ts.isObjectLiteralExpression(expr.arguments[0])) {
            walkSchemaObject(expr.arguments[0], keyPath);
            return;
          }
        }
        ts.forEachChild(expr, findNested);
      };
      findNested(prop.initializer);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "object" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z" &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      walkSchemaObject(node.arguments[0], prefix);
      // continue walking — a body may hold several schemas
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

function findFunction(
  program: ts.Program,
  name: string,
): { fn: ts.FunctionDeclaration; sourceFile: ts.SourceFile } | null {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) {
        return { fn: stmt, sourceFile };
      }
    }
  }
  return null;
}

/**
 * Extract flattened config key paths from an entry parser (`parseConfig`).
 *
 * Walks the entry parser's return object literal:
 *  - `key: parse…(cfg.key)`  → delegated block: the helper's keys land
 *    under the `key.` prefix.
 *  - `...parse…(cfg)`        → root-level helper: its raw reads land at
 *    the root.
 *  - `key: <expr reading cfg.…>` → the read paths land at the root.
 * Then walks the entry parser's own body for direct reads.
 */
export function extractParsedKeyPaths(options: {
  repoRoot: string;
  /** Entry file containing the root parser (config.ts). */
  entryFile: string;
  /** Root parser function name. */
  entryFunction: string;
  /** Extra files to include in the program (module parsers). */
  includeFiles?: string[];
  /**
   * Local names the entry parser re-binds its input to (`cfg`, `baseCfg`).
   * Explicit and documented: if these drift, extraction shrinks and the
   * committed snapshot fails LOUDLY in review — preferred over guessing.
   */
  entryAliases?: string[];
}): ExtractedConfigKeys {
  const { repoRoot, entryFile, entryFunction } = options;
  const rootNames = [entryFile, ...(options.includeFiles ?? [])];
  const program = ts.createProgram({
    rootNames,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: false,
      noEmit: true,
      skipLibCheck: true,
    },
  });

  const entry = findFunction(program, entryFunction);
  if (!entry) {
    throw new Error(`extract-parsed-keys: could not find function ${entryFunction} in ${entryFile}`);
  }

  const out = { keys: new Set<string>(), unparseable: [] as UnparseableConstruct[] };

  // 1) Walk the entry parser body itself (direct cfg.* reads land at root).
  extractParserKeys(entry.fn, entry.sourceFile, repoRoot, out, []);

  // 2) Delegations from the return object literal.
  const returns: ts.ReturnStatement[] = [];
  const collectReturns = (node: ts.Node): void => {
    // Do not descend into nested function bodies — their returns are not
    // parseConfig's.
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, collectReturns);
  };
  if (entry.fn.body) ts.forEachChild(entry.fn.body, collectReturns);

  for (const ret of returns) {
    if (!ret.expression || !ts.isObjectLiteralExpression(ret.expression)) continue;
    for (const prop of ret.expression.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
        const delegated = delegatedParserCall(prop.initializer);
        if (delegated) {
          const helper = findFunction(program, delegated.helperName);
          if (helper) {
            extractParserKeys(helper.fn, helper.sourceFile, repoRoot, out, delegated.argSegments);
          } else {
            const pos = entry.sourceFile.getLineAndCharacterOfPosition(prop.getStart(entry.sourceFile));
            out.unparseable.push({
              file: relPath(repoRoot, entry.sourceFile.fileName),
              line: pos.line + 1,
              reason: `delegated parser ${delegated.helperName} not found in program`,
            });
          }
        }
      } else if (ts.isSpreadAssignment(prop)) {
        const delegated = delegatedParserCall(prop.expression);
        if (delegated) {
          const helper = findFunction(program, delegated.helperName);
          if (helper) {
            extractParserKeys(helper.fn, helper.sourceFile, repoRoot, out, delegated.argSegments);
          }
        }
      }
    }
  }

  // 3) Also walk parse* helpers invoked with input-derived arguments
  //    anywhere in the entry body (e.g. a const assigned before the return:
  //    `const wearables = parseWearablesConfig(cfg.wearables)`). The entry
  //    input may travel through local aliases (`baseCfg`, `cfg`), so resolve
  //    arguments against the same alias names extractParserKeys discovered —
  //    approximated here by the well-known entry alias names plus the param.
  const entryParam = entry.fn.parameters[0];
  const entryParamName = entryParam && ts.isIdentifier(entryParam.name) ? entryParam.name.text : null;
  if (entryParamName && entry.fn.body) {
    const rootNamesForArgs = new Set([entryParamName, ...(options.entryAliases ?? ["cfg", "baseCfg"])]);
    const visitCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^parse[A-Z]/.test(node.expression.text)) {
        const arg = node.arguments[0];
        if (arg) {
          const segments = rootedArgumentSegments(arg, rootNamesForArgs);
          if (segments !== null) {
            const helper = findFunction(program, node.expression.text);
            if (helper) {
              extractParserKeys(helper.fn, helper.sourceFile, repoRoot, out, segments);
            }
          }
        }
      }
      ts.forEachChild(node, visitCalls);
    };
    ts.forEachChild(entry.fn.body, visitCalls);
  }

  // Post-filter: drop trailing JS VALUE-MEMBER names (string/array/object
  // methods and properties) that leak through syntax variants the callee
  // check misses (optional chains, casts, `.length`). Deny-list applies
  // ONLY when the parent path was itself recorded — a real nested key's
  // parent block read always records too, so this never drops a genuine
  // leaf that has no recorded parent.
  const JS_VALUE_MEMBERS = new Set([
    "trim", "toLowerCase", "toUpperCase", "slice", "split", "join", "map",
    "filter", "some", "every", "includes", "find", "flatMap", "forEach",
    "length", "toString", "startsWith", "endsWith", "replace", "concat",
    "keys", "values", "entries", "hasOwnProperty",
  ]);
  for (const key of [...out.keys]) {
    const segments = key.split(".");
    if (segments.length < 2) continue;
    const tail = segments[segments.length - 1];
    const parent = segments.slice(0, -1).join(".");
    if (JS_VALUE_MEMBERS.has(tail) && out.keys.has(parent)) {
      out.keys.delete(key);
    }
  }

  // De-duplicate unparseable entries (same file:line:reason) and sort both.
  const seen = new Set<string>();
  const unparseable = out.unparseable
    .filter((u) => {
      const key = `${u.file}:${u.line}:${u.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.reason.localeCompare(b.reason));

  return { keys: [...out.keys].sort(), unparseable };
}

/** Match `parseXxx(cfg.block…)` / `parseXxx(cfg)` initializers. */
function delegatedParserCall(
  expr: ts.Expression,
): { helperName: string; argSegments: string[] } | null {
  let current: ts.Expression = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  if (!ts.isCallExpression(current)) return null;
  if (!ts.isIdentifier(current.expression)) return null;
  if (!/^parse[A-Z]/.test(current.expression.text)) return null;
  const arg = current.arguments[0];
  if (!arg) return null;
  // cfg → root; cfg.block → ["block"]; cfg.block.sub → ["block","sub"]
  const segments: string[] = [];
  let a: ts.Expression = arg;
  while (ts.isPropertyAccessExpression(a)) {
    segments.unshift(a.name.text);
    a = a.expression;
  }
  if (!ts.isIdentifier(a)) return null;
  return { helperName: current.expression.text, argSegments: segments };
}

/** Segments of an argument rooted at one of the entry input names. */
function rootedArgumentSegments(arg: ts.Expression, rootNames: Set<string>): string[] | null {
  const segments: string[] = [];
  let a: ts.Expression = arg;
  while (ts.isPropertyAccessExpression(a)) {
    segments.unshift(a.name.text);
    a = a.expression;
  }
  if (ts.isIdentifier(a) && rootNames.has(a.text)) return segments;
  return null;
}

// ---------------------------------------------------------------------------
// CLI entry: print the extraction for the REAL config surface as sorted JSON.
// ---------------------------------------------------------------------------
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const repoRoot = process.cwd();
  const result = extractParsedKeyPaths({
    repoRoot,
    entryFile: path.join(repoRoot, "packages", "remnic-core", "src", "config.ts"),
    entryFunction: "parseConfig",
    includeFiles: collectModuleParserFiles(repoRoot),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/** All module-parser files the real extraction should include. */
export function collectModuleParserFiles(repoRoot: string): string[] {
  const src = path.join(repoRoot, "packages", "remnic-core", "src");
  const out: string[] = [];
  const stack = [src];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) {
        continue;
      }
      // Only files that export a parse*Config function participate — keeps
      // the program small enough for the CI <60s budget.
      const text = fs.readFileSync(full, "utf8");
      if (/export function parse[A-Z]\w*Config?\s*\(/.test(text) || /function parse[A-Z]\w*Config\s*\(/.test(text)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}
