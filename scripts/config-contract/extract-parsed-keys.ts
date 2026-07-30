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
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export interface UnparseableConstruct {
  file: string;
  line: number;
  reason: string;
  /**
   * Stable identity keyed by construct text + reason, NOT file:line — so an
   * unrelated edit above the construct does not restyle its grandfather key
   * (issue #1990 review). `line` remains for human-readable reporting only.
   */
  id: string;
}

export interface ExtractedConfigKeys {
  /** Sorted, flattened key paths accepted by the parsers. */
  keys: string[];
  /** Constructs the walker could not derive keys from — loud, not silent. */
  unparseable: UnparseableConstruct[];
  /**
   * Confirmed JavaScript value-member calls excluded from accepted parser keys.
   * Kept for review visibility rather than silently discarded.
   */
  ambiguousValueMembers: string[];
}

/** Helper names that wrap the raw input without changing its shape. */
const SHAPE_PRESERVING_WRAPPERS = new Set([
  "requireObject",
  "asRecord",
  "toRecord",
]);
const JS_VALUE_MEMBERS = new Set([
  "length", "trim", "toLowerCase", "toUpperCase", "slice", "split", "join", "map",
  "filter", "some", "every", "includes", "find", "flatMap", "forEach",
  "toString", "startsWith", "endsWith", "replace", "concat",
  "keys", "values", "entries", "hasOwnProperty",
]);
/**
 * Array methods that take a per-item callback. When the receiver is a config
 * input array, the callback reads item fields, so the extractor follows it to
 * surface `<arrayKey>.<itemField>` keys (issue #1990 review).
 */
const ARRAY_CALLBACK_METHODS = new Set(["map", "flatMap", "forEach", "filter"]);
/**
 * Array-returning transforms that preserve item shape. Unwrapped to find the
 * underlying array when following a callback after a chain like
 * `arr.filter(...).map(fn)` (issue #1990 review).
 */
const ARRAY_CHAIN_METHODS = new Set(["map", "flatMap", "filter", "slice", "concat"]);

interface AliasInfo {
  /** Path prefix segments from the parser input to this alias ("" = root). */
  prefix: string[];
}

function relPath(repoRoot: string, fileName: string): string {
  return path.relative(repoRoot, fileName).split(path.sep).join("/");
}

/**
 * Name of a parser function node, for scope-qualifying unparseable ids. Uses the
 * declaration name (program source files have no parent pointers, so an upward
 * walk is unavailable); anonymous functions yield "".
 */
function functionName(fn: ts.Node): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  return "";
}

/**
 * Record a loud unparseable construct with a stable, line-independent id
 * (`<relFile>#<hash(scope + reason + normalized construct text)>`). Keying by
 * scope-qualified construct identity means a grandfather entry survives edits
 * that merely shift line numbers, and two identical constructs in different
 * parser functions do not collide (issue #1990 review).
 */
function pushUnparseable(
  out: { unparseable: UnparseableConstruct[] },
  repoRoot: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  reason: string,
  scope: string,
): void {
  const file = relPath(repoRoot, sourceFile.fileName);
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const normalized = node.getText(sourceFile).replace(/\s+/g, " ").trim();
  const hash = createHash("sha1").update(`${scope}\u0000${reason}\u0000${normalized}`).digest("hex").slice(0, 12);
  out.unparseable.push({ file, line: pos.line + 1, reason, id: `${file}#${hash}` });
}

export function resolveStaticStringSet(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  beforePosition: number,
  seen = new Set<string>(),
): string[] | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return resolveStaticStringSet(expression.expression, sourceFile, beforePosition, seen);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: string[] = [];
    for (const element of expression.elements) {
      if (!ts.isExpression(element)) return null;
      const resolved = resolveStaticStringSet(element, sourceFile, beforePosition, seen);
      if (!resolved) return null;
      values.push(...resolved);
    }
    return values;
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "join" &&
    expression.arguments.length <= 1
  ) {
    const values = resolveStaticStringSet(expression.expression.expression, sourceFile, beforePosition, seen);
    const separator = expression.arguments[0];
    if (!values || (separator && !ts.isStringLiteral(separator))) return null;
    return [values.join(separator?.text ?? ",")];
  }
  if (!ts.isIdentifier(expression) || seen.has(expression.text)) return null;
  seen.add(expression.text);
  let best: ts.VariableDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === expression.text &&
      node.initializer &&
      node.getStart(sourceFile) <= beforePosition &&
      (!best || node.getStart(sourceFile) > best.getStart(sourceFile))
    ) {
      best = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const initializer = (best as ts.VariableDeclaration | null)?.initializer;
  return initializer
    ? resolveStaticStringSet(initializer, sourceFile, beforePosition, seen)
    : null;
}

function findEnclosingForOf(sourceFile: ts.SourceFile, target: ts.Node): ts.ForOfStatement | null {
  let best: ts.ForOfStatement | null = null;
  const targetStart = target.getStart(sourceFile);
  const targetEnd = target.getEnd();
  const visit = (node: ts.Node): void => {
    if (
      ts.isForOfStatement(node) &&
      node.getStart(sourceFile) <= targetStart &&
      node.getEnd() >= targetEnd &&
      (!best || node.getEnd() - node.getStart(sourceFile) < best.getEnd() - best.getStart(sourceFile))
    ) {
      best = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return best;
}

/**
 * Extract the keys a single parser function reads from its raw input.
 * Returns path segments relative to the parser's input object.
 */
function extractParserKeys(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  out: { keys: Set<string>; unparseable: UnparseableConstruct[]; ambiguousValueMembers: Set<string> },
  prefix: string[] = [],
  recursion: { program: ts.Program; depth: number; seen: Set<string> } | null = null,
  // param name -> literal string value, for helpers that receive key names as
  // string-literal arguments and read `cfg[keyParam]` (issue #1990 review).
  literalBindings: Map<string, string> = new Map(),
): void {
  if (!fn.body) return;
  const param = fn.parameters[0];
  if (!param || !ts.isIdentifier(param.name)) return;
  const scopeName = functionName(fn);

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
      // `cfg[keyParam]` where keyParam is bound to a string literal at the call
      // site (issue #1990 review): resolve it to that literal key segment.
      if (
        ts.isElementAccessExpression(current) &&
        current.argumentExpression &&
        ts.isIdentifier(current.argumentExpression) &&
        literalBindings.has(current.argumentExpression.text)
      ) {
        segments.unshift(literalBindings.get(current.argumentExpression.text) as string);
        current = current.expression;
        continue;
      }
      break;
    }
    if (ts.isIdentifier(current)) {
      const info = aliases.get(current.text);
      if (info) return { info, segments };
    }
    return null;
  };

  // Follow a per-item array callback (named helper or inline function) with the
  // array-key prefix so `<arrayKey>.<itemField>` keys surface (issue #1990).
  const followArrayItemCallback = (itemPrefix: string[], callback: ts.Node): void => {
    if (!recursion || recursion.depth >= 6) return;
    if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
      extractParserKeys(callback, sourceFile, repoRoot, out, itemPrefix, {
        program: recursion.program,
        depth: recursion.depth + 1,
        seen: recursion.seen,
      });
      return;
    }
    if (ts.isIdentifier(callback)) {
      const recursionKey = `map:${callback.text}@${itemPrefix.join(".")}`;
      if (recursion.seen.has(recursionKey)) return;
      recursion.seen.add(recursionKey);
      const helper = findFunctionForCall(recursion.program, callback.text, 0);
      if (helper) {
        extractParserKeys(helper.fn, helper.sourceFile, repoRoot, out, itemPrefix, {
          program: recursion.program,
          depth: recursion.depth + 1,
          seen: recursion.seen,
        });
      }
    }
  };

  // Resolve the underlying array alias through a shape-preserving transform
  // chain (`arr.filter(...).map(fn)`). Returns null when `expr` is not itself a
  // chain, so the direct-array path keeps its existing handling.
  const resolveArrayChainReceiver = (
    expr: ts.Expression,
  ): { info: AliasInfo; segments: string[] } | null => {
    let recv: ts.Expression = expr;
    while (
      ts.isCallExpression(recv) &&
      ts.isPropertyAccessExpression(recv.expression) &&
      ARRAY_CHAIN_METHODS.has(recv.expression.name.text)
    ) {
      recv = recv.expression.expression;
    }
    return recv === expr ? null : resolveAliasChain(recv);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression;
      if (
        JS_VALUE_MEMBERS.has(method.name.text) &&
        !(
          ts.isPropertyAccessExpression(method.expression) &&
          ts.isIdentifier(method.expression.expression) &&
          method.expression.expression.text === "Object"
        )
      ) {
        const resolved = resolveAliasChain(method.expression);
        if (resolved) {
          const methodPath = [...prefix, ...resolved.info.prefix, ...resolved.segments, method.name.text].join(".");
          out.ambiguousValueMembers.add(methodPath);
          if (resolved.segments.length > 0) {
            out.keys.add([...prefix, ...resolved.info.prefix, ...resolved.segments].join("."));
          }
          // Array item-field traversal: `alias.arrayKey.map(parseItemFn)` — the
          // callback reads each item's fields, so recurse into it with the
          // array-key prefix so item-field drift surfaces (issue #1990 review).
          if (
            recursion &&
            recursion.depth < 6 &&
            resolved.info.prefix.length + resolved.segments.length > 0 &&
            ARRAY_CALLBACK_METHODS.has(method.name.text) &&
            node.arguments.length >= 1
          ) {
            followArrayItemCallback(
              [...prefix, ...resolved.info.prefix, ...resolved.segments],
              node.arguments[0],
            );
          }
          for (const argument of node.arguments) visit(argument);
          return;
        }
      }
    }
    // Array callback after a shape-preserving transform chain:
    // `arr.filter(...).map(fn)` — the outer receiver is a transform call that the
    // direct resolveAliasChain leaves null, so resolve the underlying array
    // through the chain and follow the callback with its prefix. No early return:
    // forEachChild still visits the inner transform's own callback so no existing
    // `arr.map(fn).filter(...)` traversal is lost (issue #1990 review).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ARRAY_CALLBACK_METHODS.has(node.expression.name.text) &&
      node.arguments.length >= 1 &&
      !resolveAliasChain(node.expression.expression)
    ) {
      const arrayReceiver = resolveArrayChainReceiver(node.expression.expression);
      if (arrayReceiver && arrayReceiver.info.prefix.length + arrayReceiver.segments.length > 0) {
        followArrayItemCallback(
          [...prefix, ...arrayReceiver.info.prefix, ...arrayReceiver.segments],
          node.arguments[0],
        );
      }
    }
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
      const isMethodCallee =
        node.parent !== undefined &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node;
      const resolved = resolveAliasChain(node.expression);
      if (
        (isMethodCallee || node.name.text === "length") &&
        JS_VALUE_MEMBERS.has(node.name.text)
      ) {
        if (resolved) {
          const methodPath = [...prefix, ...resolved.info.prefix, ...resolved.segments, node.name.text].join(".");
          out.ambiguousValueMembers.add(methodPath);
          if (resolved.segments.length > 0) {
            out.keys.add([...prefix, ...resolved.info.prefix, ...resolved.segments].join("."));
          }
        }
        return;
      }
      if (resolved) {
        recordKey([...resolved.info.prefix, ...resolved.segments], node.name.text);
        return;
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const resolved = resolveAliasChain(node.expression);
      if (resolved) {
        const argument =
          node.argumentExpression && ts.isAsExpression(node.argumentExpression)
            ? node.argumentExpression.expression
            : node.argumentExpression;
        if (argument && ts.isStringLiteral(argument)) {
          recordKey([...resolved.info.prefix, ...resolved.segments], argument.text);
        } else if (argument && ts.isIdentifier(argument) && literalBindings.has(argument.text)) {
          recordKey(
            [...resolved.info.prefix, ...resolved.segments],
            literalBindings.get(argument.text) as string,
          );
        } else if (argument && ts.isIdentifier(argument)) {
          const ancestor = findEnclosingForOf(sourceFile, node);
          if (
            ancestor &&
            ts.isVariableDeclarationList(ancestor.initializer) &&
            ancestor.initializer.declarations.length === 1 &&
            ts.isIdentifier(ancestor.initializer.declarations[0].name) &&
            ancestor.initializer.declarations[0].name.text === argument.text
          ) {
            const loopKeys = resolveStaticStringSet(
              ancestor.expression,
              sourceFile,
              node.getStart(sourceFile),
            );
            if (loopKeys) {
              for (const key of loopKeys) {
                recordKey([...resolved.info.prefix, ...resolved.segments], key);
              }
              return;
            }
          }
          const keys = resolveStaticStringSet(argument, sourceFile, node.getStart(sourceFile));
          if (keys) {
            for (const key of keys) recordKey([...resolved.info.prefix, ...resolved.segments], key);
            return;
          }
          pushUnparseable(
            out,
            repoRoot,
            sourceFile,
            node,
            "computed element access on parser input — key not statically derivable",
            scopeName,
          );
        } else {
          pushUnparseable(
            out,
            repoRoot,
            sourceFile,
            node,
            "computed element access on parser input — key not statically derivable",
            scopeName,
          );
        }
        return;
      }
    }

    // Helper delegation: `helperFn(alias.sub, …)` — the helper reads keys
    // of the sub-block, so recurse into its body with the sub-path prefix
    // (depth- and cycle-guarded). This covers nested block helpers
    // (`parseFusionSettings(raw.fusion)`), non-parse-named readers
    // (`buildRecallPipelineConfig(cfg)`), and helper chains
    // (`readLspField` → `parseLspConfig`) — review findings on #1990.
    if (recursion && recursion.depth < 6 && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helperName = node.expression.text;
      // Key-name arguments passed as string literals bind to the helper's
      // params so `cfg[keyParam]` resolves (issue #1990 review). The literal
      // signature also keys the dedup so distinct-literal calls to the same
      // reader (readFlatOrNestedConfig(cfg, "a", …) vs (cfg, "b", …)) are all
      // followed instead of collapsing to one.
      const literalArgs = node.arguments
        .map((arg) => (ts.isStringLiteral(arg) ? arg.text : ""))
        .join(",");
      for (let argIndex = 0; argIndex < node.arguments.length; argIndex++) {
        const resolved = resolveAliasChain(node.arguments[argIndex]);
        if (!resolved) continue;
        const argPrefix = [...prefix, ...resolved.info.prefix, ...resolved.segments];
        const recursionKey = `${helperName}@${argIndex}@${argPrefix.join(".")}@${literalArgs}`;
        if (recursion.seen.has(recursionKey)) continue;
        recursion.seen.add(recursionKey);
        const helper = findFunctionForCall(recursion.program, helperName, argIndex);
        if (helper) {
          const bindings = new Map<string, string>(literalBindings);
          for (let i = 0; i < node.arguments.length; i++) {
            const arg = node.arguments[i];
            const helperParam = helper.fn.parameters[i];
            if (!arg || !helperParam || !ts.isIdentifier(helperParam.name)) continue;
            if (ts.isStringLiteral(arg)) {
              bindings.set(helperParam.name.text, arg.text);
            } else if (ts.isIdentifier(arg) && literalBindings.has(arg.text)) {
              // Propagate a binding one hop further (readFlatOrNestedConfig →
              // readNestedConfig passes its own key params on).
              bindings.set(helperParam.name.text, literalBindings.get(arg.text) as string);
            }
          }
          extractParserKeys(
            helper.fn,
            helper.sourceFile,
            repoRoot,
            out,
            argPrefix,
            { program: recursion.program, depth: recursion.depth + 1, seen: recursion.seen },
            bindings,
          );
        }
        // Reading the sub-block to hand it over is itself a key read.
        if (resolved.segments.length > 0) {
          out.keys.add([...prefix, ...resolved.info.prefix, ...resolved.segments].join("."));
        }
      }
      // Fall through: forEachChild below still records direct accesses in
      // other arguments (handled by the property-access branch).
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
        pushUnparseable(
          out,
          repoRoot,
          sourceFile,
          node,
          `Object.${node.expression.name.text}() over parser input — dynamic key set`,
          scopeName,
        );
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  // visit(fn.body) — not forEachChild — so an expression-bodied arrow
  // (`(item) => item.trim()`) is handled at the top expression, routing
  // value-member calls to ambiguousValueMembers instead of recording a false
  // `item.trim` key. Block bodies fall through to forEachChild unchanged.
  visit(fn.body);

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
      // walkSchemaObject handled every NESTED z.object at its correct
      // depth — do not descend, or nested keys would re-record at the
      // outer prefix (review finding).
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

/**
 * Locate a callable for helper recursion. Only functions whose parameter at
 * the argument position exists participate — a call forwarding an alias to
 * a validation helper's MESSAGE argument must not recurse.
 */
function findFunctionForCall(
  program: ts.Program,
  name: string,
  argIndex: number,
): { fn: ts.FunctionDeclaration; sourceFile: ts.SourceFile } | null {
  const found = findFunction(program, name);
  if (!found) return null;
  if (found.fn.parameters.length <= argIndex) return null;
  return found;
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

  const out = {
    keys: new Set<string>(),
    unparseable: [] as UnparseableConstruct[],
    ambiguousValueMembers: new Set<string>(),
  };
  const recursion = { program, depth: 0, seen: new Set<string>() };

  // 1) Walk the entry parser body itself (direct cfg.* reads land at root).
  extractParserKeys(entry.fn, entry.sourceFile, repoRoot, out, [], recursion);

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
            extractParserKeys(helper.fn, helper.sourceFile, repoRoot, out, delegated.argSegments, recursion);
          } else {
          pushUnparseable(
            out,
            repoRoot,
            entry.sourceFile,
            prop,
            `delegated parser ${delegated.helperName} not found in program`,
            functionName(entry.fn),
          );
          }
        }
      } else if (ts.isSpreadAssignment(prop)) {
        const delegated = delegatedParserCall(prop.expression);
        if (delegated) {
          const helper = findFunction(program, delegated.helperName);
          if (helper) {
            extractParserKeys(helper.fn, helper.sourceFile, repoRoot, out, delegated.argSegments, recursion);
          } else {
            // Same loudness as the property-assignment branch (review
            // finding: spread-only delegations failed quietly).
            pushUnparseable(
              out,
              repoRoot,
              entry.sourceFile,
              prop,
              `delegated parser ${delegated.helperName} not found in program`,
              functionName(entry.fn),
            );
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
              extractParserKeys(helper.fn, helper.sourceFile, repoRoot, out, segments, recursion);
            }
          }
        }
      }
      ts.forEachChild(node, visitCalls);
    };
    ts.forEachChild(entry.fn.body, visitCalls);
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

  return {
    keys: [...out.keys].sort(),
    unparseable,
    ambiguousValueMembers: [...out.ambiguousValueMembers].sort(),
  };
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
  // cfg → root; cfg.block → ["block"]; cfg.block.sub → ["block","sub"];
  // casts and ?? {} / || {} fallbacks unwrap via unwrapArgument; ELEMENT
  // ACCESS (cfg["block"]) is accepted too (review finding).
  const segments: string[] = [];
  let a: ts.Expression = unwrapArgument(arg);
  for (;;) {
    if (ts.isPropertyAccessExpression(a)) {
      segments.unshift(a.name.text);
      a = unwrapArgument(a.expression);
      continue;
    }
    if (ts.isElementAccessExpression(a) && a.argumentExpression && ts.isStringLiteral(a.argumentExpression)) {
      segments.unshift(a.argumentExpression.text);
      a = unwrapArgument(a.expression);
      continue;
    }
    break;
  }
  if (!ts.isIdentifier(a)) return null;
  return { helperName: current.expression.text, argSegments: segments };
}

/** Unwrap parens, casts, non-null, and `?? {}`/`|| {}` fallbacks. */
function unwrapArgument(arg: ts.Expression): ts.Expression {
  let current: ts.Expression = arg;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      current = current.left;
      continue;
    }
    return current;
  }
}

/** Segments of an argument rooted at one of the entry input names. */
function rootedArgumentSegments(arg: ts.Expression, rootNames: Set<string>): string[] | null {
  const segments: string[] = [];
  let a: ts.Expression = unwrapArgument(arg);
  for (;;) {
    if (ts.isPropertyAccessExpression(a)) {
      segments.unshift(a.name.text);
      a = unwrapArgument(a.expression);
      continue;
    }
    if (ts.isElementAccessExpression(a) && a.argumentExpression && ts.isStringLiteral(a.argumentExpression)) {
      segments.unshift(a.argumentExpression.text);
      a = unwrapArgument(a.expression);
      continue;
    }
    break;
  }
  if (ts.isIdentifier(a) && rootNames.has(a.text)) return segments;
  return null;
}

export function extractRealConfigKeys(repoRoot: string): ExtractedConfigKeys {
  const core = extractParsedKeyPaths({
    repoRoot,
    entryFile: path.join(repoRoot, "packages", "remnic-core", "src", "config.ts"),
    entryFunction: "parseConfig",
    includeFiles: collectModuleParserFiles(repoRoot),
  });
  const openClaw = extractParsedKeyPaths({
    repoRoot,
    entryFile: path.join(repoRoot, "packages", "plugin-openclaw", "src", "bridge.ts"),
    entryFunction: "parseOpenClawBridgeConfig",
  });
  return {
    keys: [...new Set([...core.keys, ...openClaw.keys])].sort(),
    unparseable: [...core.unparseable, ...openClaw.unparseable],
    ambiguousValueMembers: [
      ...new Set([...core.ambiguousValueMembers, ...openClaw.ambiguousValueMembers]),
    ].sort(),
  };
}

// ---------------------------------------------------------------------------
// CLI entry: print the extraction for the REAL config surface as sorted JSON.
// ---------------------------------------------------------------------------
const invokedDirectly =
  process.argv[1] !== undefined &&
  // pathToFileURL normalizes drive letters and separators on every
  // platform — `URL.pathname` comparison broke on Windows (review finding).
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const repoRoot = process.cwd();
  const result = extractRealConfigKeys(repoRoot);
  // Omit the volatile `line` from the committed snapshot: the stable `id`
  // identifies each construct, so an unrelated edit that merely shifts lines no
  // longer forces snapshot churn / a preflight failure (issue #1990 review).
  const snapshot = {
    ...result,
    unparseable: result.unparseable.map(({ file, reason, id }) => ({ file, reason, id })),
  };
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
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
      // Files that export a parse*Config function participate; so do *config.ts
      // module files that export any parse* helper (e.g. scope-profile-config.ts
      // exports parseScopeProfiles/parseScopeTeams, not parse*Config) — otherwise
      // parseConfig's delegated calls to them go unresolved (issue #1990 review).
      // Scoping the broader match to *config.ts keeps the program within the CI
      // <60s budget.
      const text = fs.readFileSync(full, "utf8");
      const exportsConfigParser =
        /export function parse[A-Z]\w*Config?\s*\(/.test(text) || /function parse[A-Z]\w*Config\s*\(/.test(text);
      const isConfigModule = /config\.ts$/.test(entry.name);
      const exportsAnyParser = /export function parse[A-Z]\w*\s*\(/.test(text);
      if (exportsConfigParser || (isConfigModule && exportsAnyParser)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}
