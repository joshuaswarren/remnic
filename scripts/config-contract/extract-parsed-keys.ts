import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export interface UnparseableConstruct {
  file: string;
  line: number;
  reason: string;
  id: string;
}

export interface ExtractedConfigKeys {
  keys: string[];
  unparseable: UnparseableConstruct[];
  ambiguousValueMembers: string[];
  keyMultiplicity: Record<string, number>;
}

type ParseSink = {
  keys: Set<string>;
  unparseable: UnparseableConstruct[];
  ambiguousValueMembers: Set<string>;
  parseSites: Map<string, Set<string>>;
};

function noteParseSite(out: ParseSink, prefixPath: string, siteId: string): void {
  if (!prefixPath) return;
  const sites = out.parseSites.get(prefixPath);
  if (sites) sites.add(siteId);
  else out.parseSites.set(prefixPath, new Set([siteId]));
}

function keyMultiplicityFromSites(
  keys: Iterable<string>,
  parseSites: Map<string, Set<string>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) {
    let max = 1;
    for (const [prefixPath, sites] of parseSites) {
      if (sites.size > 1 && (key === prefixPath || key.startsWith(`${prefixPath}.`))) {
        max = Math.max(max, sites.size);
      }
    }
    if (max > 1) out[key] = max;
  }
  return out;
}

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
const ARRAY_CALLBACK_METHODS = new Set(["map", "flatMap", "forEach", "filter"]);
const ARRAY_CHAIN_METHODS = new Set(["map", "flatMap", "filter", "slice", "concat"]);
const DYNAMIC_KEY_ITERATION_METHODS: Record<string, true> = {
  keys: true,
  entries: true,
  values: true,
  getOwnPropertyNames: true,
};
const OPAQUE_BLOCK_PASSTHROUGH: Record<string, true> = {
  localLlmHeaders: true, // #2964 - additionalProperties: {type: string} in every manifest
};

interface AliasInfo {
  prefix: string[];
}

function relPath(repoRoot: string, fileName: string): string {
  return path.relative(repoRoot, fileName).split(path.sep).join("/");
}

function functionName(fn: ts.Node): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  return "";
}
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
  const id = `${file}#${hash}`;
  if (out.unparseable.some((entry) => entry.id === id)) return;
  out.unparseable.push({ file, line: pos.line + 1, reason, id });
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

function extractParserKeys(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  out: ParseSink,
  prefix: string[] = [],
  recursion: { program: ts.Program; depth: number; seen: Set<string> } | null = null,
  literalBindings: Map<string, string> = new Map(),
): void {
  if (!fn.body) return;
  const param = fn.parameters[0];
  if (!param || !ts.isIdentifier(param.name)) return;
  const scopeName = functionName(fn);

  const aliases = new Map<string, AliasInfo>();
  const localFunctions = new Map<
    string,
    {
      fn: ts.ArrowFunction | ts.FunctionExpression;
      literalBindings: Set<string>;
      unboundVisited: boolean;
    }
  >();

  aliases.set(param.name.text, { prefix: [] });
  const visitLocalFunctionBody = (
    localFunction: {
      fn: ts.ArrowFunction | ts.FunctionExpression;
      literalBindings: Set<string>;
      unboundVisited: boolean;
    },
    literalKey?: string,
  ): void => {
    const keyParameter = localFunction.fn.parameters[0]?.name;
    if (!keyParameter || !ts.isIdentifier(keyParameter)) return;
    const previousAlias = aliases.get(keyParameter.text);
    aliases.delete(keyParameter.text);
    const previousBinding = literalBindings.get(keyParameter.text);
    if (literalKey !== undefined) literalBindings.set(keyParameter.text, literalKey);
    for (const parameter of localFunction.fn.parameters) {
      if (parameter.initializer) visit(parameter.initializer);
    }
    visit(localFunction.fn.body);
    if (previousBinding === undefined) {
      literalBindings.delete(keyParameter.text);
    } else {
      literalBindings.set(keyParameter.text, previousBinding);
    }
    if (previousAlias === undefined) {
      aliases.delete(keyParameter.text);
    } else {
      aliases.set(keyParameter.text, previousAlias);
    }
  };


  const recordKey = (aliasPrefix: string[], key: string): void => {
    out.keys.add([...prefix, ...aliasPrefix, key].join("."));
  };

  const resolveAliasChain = (
    expr: ts.Expression,
  ): { info: AliasInfo; segments: string[] } | null => {
    let current: ts.Expression = expr;
    const segments: string[] = [];
    for (;;) {
      if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isConditionalExpression(current)) {
        const viaTrue = resolveAliasChain(current.whenTrue);
        if (viaTrue) return { info: viaTrue.info, segments: [...viaTrue.segments, ...segments] };
        const viaFalse = resolveAliasChain(current.whenFalse);
        if (viaFalse) return { info: viaFalse.info, segments: [...viaFalse.segments, ...segments] };
        return null;
      }
      if (
        ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        current = current.left;
        continue;
      }
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
      const helper = findFunctionForCall(recursion.program, callback.text, 0, sourceFile);
      if (helper) {
        extractParserKeys(helper.fn, helper.sourceFile, repoRoot, out, itemPrefix, {
          program: recursion.program,
          depth: recursion.depth + 1,
          seen: recursion.seen,
        });
      }
    }
  };

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
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const localParameter = node.initializer.parameters[0]?.name;
      if (localParameter && ts.isIdentifier(localParameter)) {
        localFunctions.set(node.name.text, {
          fn: node.initializer,
          literalBindings: new Set<string>(),
          unboundVisited: false,
        });
        return;
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const resolved = resolveAliasChain(node.initializer);
      if (resolved) {
        if (resolved.segments.length > 0) {
          out.keys.add([...prefix, ...resolved.info.prefix, ...resolved.segments].join("."));
        }
        aliases.set(node.name.text, {
          prefix: [...resolved.info.prefix, ...resolved.segments],
        });
        ts.forEachChild(node, visit);
        return;
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const resolved = resolveAliasChain(node.initializer);
      if (resolved) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken) continue;
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
        ts.forEachChild(node.right, visit);
        return;
      }
    }

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
    let handledLocalFunctionCall = false;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const localFunction = localFunctions.get(node.expression.text);
      const keyParameter = localFunction?.fn.parameters[0]?.name;
      if (localFunction && keyParameter && ts.isIdentifier(keyParameter)) {
        handledLocalFunctionCall = true;
        const keyArgument = node.arguments[0];
        const hasLiteralBinding =
          keyArgument !== undefined &&
          ts.isStringLiteral(keyArgument);
        if (hasLiteralBinding) {
          const literalKey = keyArgument.text;
          noteParseSite(
            out,
            [...prefix, literalKey].join("."),
            `${relPath(repoRoot, sourceFile.fileName)}:${node.getStart(sourceFile)}`,
          );
          if (!localFunction.literalBindings.has(literalKey)) {
            localFunction.literalBindings.add(literalKey);
            visitLocalFunctionBody(localFunction, literalKey);
          }
        } else if (!localFunction.unboundVisited) {
          localFunction.unboundVisited = true;
          visitLocalFunctionBody(localFunction);
        }
      }
    }

    if (
      !handledLocalFunctionCall &&
      recursion &&
      recursion.depth < 6 &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const helperName = node.expression.text;
      const literalArgs = node.arguments
        .map((arg) => (ts.isStringLiteral(arg) ? arg.text : ""))
        .join(",");
      for (let argIndex = 0; argIndex < node.arguments.length; argIndex++) {
        const resolved = resolveAliasChain(node.arguments[argIndex]);
        if (!resolved) continue;
        const argPrefix = [...prefix, ...resolved.info.prefix, ...resolved.segments];
        const recursionKey = `${helperName}@${argIndex}@${argPrefix.join(".")}@${literalArgs}`;
        if (/^parse[A-Z]\w*Config/.test(helperName)) {
          noteParseSite(
            out,
            argPrefix.join("."),
            `${relPath(repoRoot, sourceFile.fileName)}:${node.getStart(sourceFile)}`,
          );
        }
        if (recursion.seen.has(recursionKey)) continue;
        recursion.seen.add(recursionKey);
        const helper = findFunctionForCall(recursion.program, helperName, argIndex, sourceFile);
        if (helper) {
          const bindings = new Map<string, string>(literalBindings);
          for (let i = 0; i < node.arguments.length; i++) {
            const arg = node.arguments[i];
            const helperParam = helper.fn.parameters[i];
            if (!arg || !helperParam || !ts.isIdentifier(helperParam.name)) continue;
            if (ts.isStringLiteral(arg)) {
              bindings.set(helperParam.name.text, arg.text);
            } else if (ts.isIdentifier(arg) && literalBindings.has(arg.text)) {
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
        if (resolved.segments.length > 0) {
          out.keys.add([...prefix, ...resolved.info.prefix, ...resolved.segments].join("."));
        }
      }
      // Fall through: forEachChild below still records direct accesses in
      // other arguments (handled by the property-access branch).
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      DYNAMIC_KEY_ITERATION_METHODS[node.expression.name.text] === true &&
      node.arguments.length === 1
    ) {
      const resolved = resolveAliasChain(node.arguments[0]);
      if (resolved) {
        const iteratedPath = [...prefix, ...resolved.info.prefix, ...resolved.segments].join(".");
        if (OPAQUE_BLOCK_PASSTHROUGH[iteratedPath] === true) {
          out.keys.add(iteratedPath);
          return;
        }
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

  visit(fn.body);
  for (const localFunction of localFunctions.values()) {
    const keyParameter = localFunction.fn.parameters[0]?.name;
    if (
      localFunction.unboundVisited ||
      localFunction.literalBindings.size > 0 ||
      !keyParameter ||
      !ts.isIdentifier(keyParameter)
    ) {
      continue;
    }
    localFunction.unboundVisited = true;
    visitLocalFunctionBody(localFunction);
  }

  extractZodObjectKeys(fn.body, prefix, out);
}

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
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

function findFunctionForCall(
  program: ts.Program,
  name: string,
  argIndex: number,
  preferredFile?: ts.SourceFile,
): { fn: ts.FunctionDeclaration; sourceFile: ts.SourceFile } | null {
  const found = findFunction(program, name, preferredFile);
  if (!found) return null;
  if (found.fn.parameters.length <= argIndex) return null;
  return found;
}

function findFunction(
  program: ts.Program,
  name: string,
  preferredFile?: ts.SourceFile,
): { fn: ts.FunctionDeclaration; sourceFile: ts.SourceFile } | null {
  const files = preferredFile
    ? [preferredFile, ...program.getSourceFiles().filter((file) => file !== preferredFile)]
    : [...program.getSourceFiles()];
  for (const sourceFile of files) {
    if (sourceFile.isDeclarationFile) continue;
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) {
        return { fn: stmt, sourceFile };
      }
    }
  }
  return null;
}

export function extractParsedKeyPaths(options: {
  repoRoot: string;
  entryFile: string;
  entryFunction: string;
  includeFiles?: string[];
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

  const out: ParseSink = {
    keys: new Set<string>(),
    unparseable: [] as UnparseableConstruct[],
    ambiguousValueMembers: new Set<string>(),
    parseSites: new Map(),
  };
  const recursion = { program, depth: 0, seen: new Set<string>() };

  extractParserKeys(entry.fn, entry.sourceFile, repoRoot, out, [], recursion);

  const returns: ts.ReturnStatement[] = [];
  const collectReturns = (node: ts.Node): void => {
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

  const seen = new Set<string>();
  const unparseable = out.unparseable
    .filter((u) => {
      const key = `${u.file}:${u.line}:${u.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.reason.localeCompare(b.reason));

  const keys = [...out.keys].sort();
  return {
    keys,
    unparseable,
    ambiguousValueMembers: [...out.ambiguousValueMembers].sort(),
    keyMultiplicity: keyMultiplicityFromSites(keys, out.parseSites),
  };
}

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
  const keyMultiplicity: Record<string, number> = { ...core.keyMultiplicity };
  for (const [key, count] of Object.entries(openClaw.keyMultiplicity)) {
    const merged = Math.max(keyMultiplicity[key] ?? 1, count);
    if (merged > 1) keyMultiplicity[key] = merged;
  }
  return {
    keys: [...new Set([...core.keys, ...openClaw.keys])].sort(),
    unparseable: [...core.unparseable, ...openClaw.unparseable],
    ambiguousValueMembers: [
      ...new Set([...core.ambiguousValueMembers, ...openClaw.ambiguousValueMembers]),
    ].sort(),
    keyMultiplicity,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const repoRoot = process.cwd();
  const result = extractRealConfigKeys(repoRoot);
  const snapshot = {
    keys: result.keys,
    unparseable: result.unparseable.map(({ file, reason, id }) => ({ file, reason, id })),
    ambiguousValueMembers: result.ambiguousValueMembers,
  };
  if (snapshot.keys.length === 0) {
    throw new Error("extract-parsed-keys: refused to emit an empty key list");
  }
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    const target = path.join(repoRoot, "scripts", "config-contract", "parsed-keys.snapshot.json");
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, target);
  } else {
    process.stdout.write(json);
  }
}


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
