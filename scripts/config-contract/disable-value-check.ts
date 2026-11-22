import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type DisableValueViolationKind = "disable-value-schema-min" | "disable-value-guard";

export interface DisableValueViolation {
  kind: DisableValueViolationKind;
  key: string;
  detail: string;
}

export interface DisableValueGrandfatherEntry {
  kind: DisableValueViolationKind;
  key: string;
  issue: string;
}

export interface DisableValueSource {
  path: string;
  text: string;
}

export interface DisableValueSchemaProperty {
  type?: string | string[];
  minimum?: number;
  exclusiveMinimum?: number;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  properties?: Record<string, DisableValueSchemaProperty>;
  items?: { properties?: Record<string, DisableValueSchemaProperty> };
  anyOf?: DisableValueSchemaProperty[];
  oneOf?: DisableValueSchemaProperty[];
  allOf?: DisableValueSchemaProperty[];
}

export interface DisableValueManifest {
  path: string;
  properties: Record<string, DisableValueSchemaProperty>;
}

export interface DisableValueCheckResult {
  violations: DisableValueViolation[];
  staleGrandfatherEntries: DisableValueGrandfatherEntry[];
  grandfatheredActive: number;
  zeroDisableProperties: string[];
}

export const ZERO_DISABLE_PATTERN = /\b0\b[^.]{0,40}?disabl/i;

function normalizeDocText(text: string): string {
  return text
    .replace(/\/\*\*?|\*\/|^\s*\*|\/\//gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isZeroDisableDoc(text: string): boolean {
  return ZERO_DISABLE_PATTERN.test(normalizeDocText(text));
}

function propertyNodeName(node: ts.Node): string | undefined {
  if (
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node)
  ) {
    const name = node.name;
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
  }
  return undefined;
}

function leadingCommentText(fullText: string, node: ts.Node): string {
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) ?? [];
  return ranges.map((range) => fullText.slice(range.pos, range.end)).join("\n");
}

export function collectZeroDisablePropertiesFromSource(source: DisableValueSource): Set<string> {
  const sf = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
  const fullText = sf.getFullText();
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    const name = propertyNodeName(node);
    if (name && isZeroDisableDoc(leadingCommentText(fullText, node))) {
      found.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function numericSchema(prop: DisableValueSchemaProperty): boolean {
  const type = prop.type;
  if (type === undefined) return typeof prop.minimum === "number";
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => t === "number" || t === "integer");
}

function isNumericConstrained(prop: DisableValueSchemaProperty): boolean {
  return (
    numericSchema(prop) ||
    Boolean(prop.anyOf) ||
    Boolean(prop.oneOf) ||
    Array.isArray(prop.enum) ||
    prop.const !== undefined ||
    typeof prop.exclusiveMinimum === "number"
  );
}

function zeroRejectionReason(prop: DisableValueSchemaProperty): string | undefined {
  if (typeof prop.minimum === "number" && prop.minimum > 0) return `minimum ${prop.minimum}`;
  if (typeof prop.exclusiveMinimum === "number" && prop.exclusiveMinimum >= 0) {
    return `exclusiveMinimum ${prop.exclusiveMinimum}`;
  }
  if (prop.const !== undefined && prop.const !== 0) return `const ${JSON.stringify(prop.const)}`;
  if (Array.isArray(prop.enum) && !prop.enum.includes(0)) return `enum ${JSON.stringify(prop.enum)}`;
  if (prop.allOf && prop.allOf.length > 0) {
    for (const branch of prop.allOf) {
      const reason = zeroRejectionReason(branch);
      if (reason !== undefined) return `allOf ${reason}`;
    }
  }
  const branches = prop.anyOf ?? prop.oneOf;
  if (branches && branches.length > 0) {
    const isOneOf = prop.anyOf === undefined && prop.oneOf !== undefined;
    let rejection: string | undefined;
    let zeroAdmittingCount = 0;
    for (const branch of branches) {
      const reason = zeroRejectionReason(branch);
      if (reason === undefined) {
        if (isNumericConstrained(branch)) zeroAdmittingCount += 1;
      } else {
        rejection = rejection ?? reason;
      }
    }
    if (isOneOf ? zeroAdmittingCount === 1 : zeroAdmittingCount >= 1) return undefined;
    if (isOneOf && zeroAdmittingCount >= 2) {
      return `oneOf admits 0 in ${zeroAdmittingCount} branches (exactly one must match)`;
    }
    return rejection ?? "no branch admits 0";
  }
  return undefined;
}

interface GuardFlags {
  thresholdUnguarded: boolean;
  coercion: boolean;
}

function numericLiteralValue(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) {
    return Number(node.text.replace(/_/g, ""));
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text.replace(/_/g, ""));
  }
  return undefined;
}

function isComparisonOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.GreaterThanToken ||
    kind === ts.SyntaxKind.GreaterThanEqualsToken ||
    kind === ts.SyntaxKind.LessThanToken ||
    kind === ts.SyntaxKind.LessThanEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function isInequalityOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.GreaterThanToken ||
    kind === ts.SyntaxKind.GreaterThanEqualsToken ||
    kind === ts.SyntaxKind.LessThanToken ||
    kind === ts.SyntaxKind.LessThanEqualsToken
  );
}

function isFloorAboveZero(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "max" ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Math"
  ) {
    return false;
  }
  return node.arguments.some((arg) => {
    const value = numericLiteralValue(arg);
    return value !== undefined && value > 0;
  });
}

function accessPath(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(node)) {
    const base = accessPath(node.expression);
    return base ? `${base}.${node.name.text}` : undefined;
  }
  return undefined;
}

function propertyAccess(node: ts.Expression): { leaf: string; path: string } | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const path = accessPath(node);
  return path ? { leaf: node.name.text, path } : undefined;
}

function destructuredConfigField(operand: ts.Identifier): { field: string; sourcePath: string } | undefined {
  const scope = enclosingScope(operand);
  const name = operand.text;
  let result: { field: string; sourcePath: string } | undefined;
  const visit = (node: ts.Node): void => {
    if (result) return;
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const sourcePath = accessPath(node.initializer);
      if (sourcePath !== undefined) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === name) {
            const field =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            result = { field, sourcePath };
            return;
          }
        }
      }
    }
    ts.forEachChild(node, (child) => {
      if (!isFunctionScope(child)) visit(child);
    });
  };
  visit(scope);
  return result;
}

function destructuredAliasesInScope(operand: ts.Expression, fullPath: string, leaf: string): string[] {
  const root = fullPath.split(".")[0];
  const scope = enclosingScope(operand);
  const aliases: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const src = ts.isIdentifier(node.initializer) ? node.initializer.text : undefined;
      if (src === root) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            const field =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            if (field === leaf) aliases.push(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, (child) => {
      if (!isFunctionScope(child)) visit(child);
    });
  };
  visit(scope);
  return aliases;
}

function isFunctionScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function enclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionScope(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function localInitializer(name: string, scope: ts.Node): ts.Expression | undefined {
  let init: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (init) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      init = node.initializer;
      return;
    }
    ts.forEachChild(node, (child) => {
      if (!isFunctionScope(child)) visit(child);
    });
  };
  visit(scope);
  return init;
}

function refersToLocal(expr: ts.Expression, name: string, scope: ts.Node, seen: Set<string>): boolean {
  if (ts.isParenthesizedExpression(expr)) return refersToLocal(expr.expression, name, scope, seen);
  if (!ts.isIdentifier(expr)) return false;
  if (expr.text === name) return true;
  if (seen.has(expr.text)) return false;
  seen.add(expr.text);
  const init = localInitializer(expr.text, scope);
  return init ? refersToLocal(init, name, scope, seen) : false;
}

function expressionEmitsField(expr: ts.Expression, name: string, scope: ts.Node, seen: Set<string>): boolean {
  if (ts.isParenthesizedExpression(expr)) return expressionEmitsField(expr.expression, name, scope, seen);
  if (ts.isIdentifier(expr)) {
    if (seen.has(expr.text)) return false;
    seen.add(expr.text);
    const init = localInitializer(expr.text, scope);
    return init ? expressionEmitsField(init, name, scope, seen) : false;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.some((prop) => {
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.name.text === name) return true;
        if (seen.has(prop.name.text)) return false;
        seen.add(prop.name.text);
        const init = localInitializer(prop.name.text, scope);
        return init ? expressionEmitsField(init, name, scope, seen) : false;
      }
      if (ts.isPropertyAssignment(prop)) {
        const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
        if (key === name && refersToLocal(prop.initializer, name, scope, new Set())) return true;
        return expressionEmitsField(prop.initializer, name, scope, seen);
      }
      return false;
    });
  }
  return false;
}

function localReturnedViaShorthand(decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  const name = decl.name.text;
  const scope = enclosingScope(decl);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isReturnStatement(node) && node.expression && expressionEmitsField(node.expression, name, scope, new Set())) {
      found = true;
      return;
    }
    ts.forEachChild(node, (child) => {
      if (!isFunctionScope(child)) visit(child);
    });
  };
  visit(scope);
  return found;
}

type Tri = true | false | "unknown";

function evalConditionAt(node: ts.Node, guardedPath: string, value: number): Tri {
  if (ts.isParenthesizedExpression(node)) return evalConditionAt(node.expression, guardedPath, value);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = evalConditionAt(node.operand, guardedPath, value);
    return inner === "unknown" ? "unknown" : !inner;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = evalConditionAt(node.left, guardedPath, value);
      const r = evalConditionAt(node.right, guardedPath, value);
      if (l === false || r === false) return false;
      if (l === true && r === true) return true;
      return "unknown";
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = evalConditionAt(node.left, guardedPath, value);
      const r = evalConditionAt(node.right, guardedPath, value);
      if (l === true || r === true) return true;
      if (l === false && r === false) return false;
      return "unknown";
    }
    if (isComparisonOperator(op)) {
      const leftPath = accessPath(node.left);
      const rightPath = accessPath(node.right);
      const leftLit = numericLiteralValue(node.right);
      const rightLit = numericLiteralValue(node.left);
      if (leftPath === guardedPath && leftLit !== undefined) {
        const r = satisfiesComparison(op, true, leftLit, value);
        return r === undefined ? "unknown" : r;
      }
      if (rightPath === guardedPath && rightLit !== undefined) {
        const r = satisfiesComparison(op, false, rightLit, value);
        return r === undefined ? "unknown" : r;
      }
    }
  }
  return "unknown";
}

function pathGuardKind(condition: ts.Node, guardedPath: string): "active" | "disabling" | undefined {
  const atZero = evalConditionAt(condition, guardedPath, 0);
  if (atZero === "unknown") return undefined;
  const atPositive = evalConditionAt(condition, guardedPath, 2);
  if (atZero === false && atPositive !== false) return "active";
  if (atZero === true && atPositive !== true) return "disabling";
  return undefined;
}

function isDescendant(ancestor: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function branchAlwaysExits(node: ts.Statement): boolean {
  if (
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isBreakStatement(node) ||
    ts.isContinueStatement(node)
  ) {
    return true;
  }
  if (ts.isBlock(node)) {
    return node.statements.some((s) => branchAlwaysExits(s));
  }
  return false;
}

function enclosingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isStatement(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function precedingGuardClauseExits(use: ts.Node, guardedPath: string): boolean {
  let stmt = enclosingStatement(use);
  while (stmt) {
    const container = stmt.parent;
    const list = container && (ts.isBlock(container) || ts.isSourceFile(container)) ? container.statements : undefined;
    if (list) {
      const idx = list.indexOf(stmt);
      for (let i = 0; i < idx; i++) {
        const s = list[i];
        if (
          ts.isIfStatement(s) &&
          !s.elseStatement &&
          pathGuardKind(s.expression, guardedPath) === "disabling" &&
          branchAlwaysExits(s.thenStatement)
        ) {
          return true;
        }
      }
    }
    if (container && container.parent && isFunctionScope(container.parent)) break;
    stmt = container ? enclosingStatement(container) : undefined;
  }
  return false;
}

function orConditionBranchExits(orExpr: ts.Node): boolean {
  let node: ts.Node = orExpr;
  while (node.parent) {
    const parent = node.parent;
    if (ts.isIfStatement(parent) && node === parent.expression) {
      return !parent.elseStatement && branchAlwaysExits(parent.thenStatement);
    }
    const boolChain =
      ts.isParenthesizedExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken));
    if (!boolChain) return false;
    node = parent;
  }
  return false;
}

function guardShortCircuitsUse(use: ts.Node, guardedPath: string): boolean {
  let node: ts.Node = use;
  const useScope = enclosingScope(use);
  while (node.parent) {
    const parent = node.parent;
    if (isFunctionScope(parent) && parent !== useScope) break;
    if (ts.isBinaryExpression(parent) && node === parent.right) {
      if (
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        pathGuardKind(parent.left, guardedPath) === "active"
      ) {
        return true;
      }
      if (
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        pathGuardKind(parent.left, guardedPath) === "disabling" &&
        orConditionBranchExits(parent)
      ) {
        return true;
      }
    }
    if (ts.isIfStatement(parent)) {
      if (isDescendant(parent.thenStatement, use) && pathGuardKind(parent.expression, guardedPath) === "active") {
        return true;
      }
      if (
        parent.elseStatement &&
        isDescendant(parent.elseStatement, use) &&
        pathGuardKind(parent.expression, guardedPath) === "disabling"
      ) {
        return true;
      }
    }
    if (ts.isConditionalExpression(parent)) {
      if (node === parent.whenTrue && pathGuardKind(parent.condition, guardedPath) === "active") return true;
      if (node === parent.whenFalse && pathGuardKind(parent.condition, guardedPath) === "disabling") return true;
    }
    node = parent;
  }
  return precedingGuardClauseExits(use, guardedPath);
}

function satisfiesComparison(
  op: ts.SyntaxKind,
  valueOnLeft: boolean,
  lit: number,
  value: number,
): boolean | undefined {
  const a = valueOnLeft ? value : lit;
  const b = valueOnLeft ? lit : value;
  switch (op) {
    case ts.SyntaxKind.GreaterThanToken:
      return a > b;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return a >= b;
    case ts.SyntaxKind.LessThanToken:
      return a < b;
    case ts.SyntaxKind.LessThanEqualsToken:
      return a <= b;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return a === b;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return a !== b;
  }
  return undefined;
}

function operandText(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return accessPath(node);
  return undefined;
}

function zeroCaseBranch(condition: ts.Expression): { branch: "whenTrue" | "whenFalse"; valueText: string | undefined } | undefined {
  let node: ts.Expression = condition;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isBinaryExpression(node) || !isComparisonOperator(node.operatorToken.kind)) return undefined;
  const leftLit = numericLiteralValue(node.left);
  const rightLit = numericLiteralValue(node.right);
  let lit: number | undefined;
  let valueOnLeft = true;
  if (rightLit === 0 || rightLit === 1) {
    lit = rightLit;
    valueOnLeft = true;
  } else if (leftLit === 0 || leftLit === 1) {
    lit = leftLit;
    valueOnLeft = false;
  }
  if (lit === undefined) return undefined;
  const satisfied = satisfiesComparison(node.operatorToken.kind, valueOnLeft, lit, 0);
  if (satisfied === undefined) return undefined;
  const valueNode = valueOnLeft ? node.left : node.right;
  return { branch: satisfied ? "whenTrue" : "whenFalse", valueText: operandText(valueNode) };
}

function subtreeReferencesText(root: ts.Node, text: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && operandText(node) === text) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function clampIsZeroPreserved(clamp: ts.Node): boolean {
  let node: ts.Node = clamp;
  while (node.parent) {
    const parent = node.parent;
    if (ts.isConditionalExpression(parent)) {
      const info = zeroCaseBranch(parent.condition);
      if (info) {
        const zeroBranch = info.branch === "whenTrue" ? parent.whenTrue : parent.whenFalse;
        const clampBranch = info.branch === "whenTrue" ? parent.whenFalse : parent.whenTrue;
        if (
          node === clampBranch &&
          numericLiteralValue(zeroBranch) === 0 &&
          info.valueText !== undefined &&
          subtreeReferencesText(clamp, info.valueText)
        ) {
          return true;
        }
      }
    }
    node = parent;
  }
  return false;
}

function initializerCoercesZero(initializer: ts.Expression): boolean {
  let coerces = false;
  const visit = (node: ts.Node): void => {
    if (coerces) return;
    if (ts.isCallExpression(node) && isFloorAboveZero(node) && !clampIsZeroPreserved(node)) {
      coerces = true;
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const rightLit = numericLiteralValue(node.right);
      if (rightLit !== undefined && rightLit !== 0 && !clampIsZeroPreserved(node)) {
        coerces = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  return coerces;
}

function analyzeAllGuards(sources: DisableValueSource[], zeroDisable: Set<string>): Map<string, GuardFlags> {
  const flags = new Map<string, GuardFlags>();
  for (const name of zeroDisable) flags.set(name, { thresholdUnguarded: false, coercion: false });
  for (const source of sources) {
    const sf = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
    const operandBound = (operand: ts.Expression): { leaf: string; paths: string[] } | undefined => {
      if (ts.isIdentifier(operand)) {
        const destructured = destructuredConfigField(operand);
        if (destructured) {
          return {
            leaf: destructured.field,
            paths: [operand.text, `${destructured.sourcePath}.${destructured.field}`],
          };
        }
      }
      const access = propertyAccess(operand);
      if (!access) return undefined;
      const aliases = destructuredAliasesInScope(operand, access.path, access.leaf);
      return { leaf: access.leaf, paths: [access.path, ...aliases] };
    };
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && isInequalityOperator(node.operatorToken.kind)) {
        const left = operandBound(node.left);
        const right = operandBound(node.right);
        const leftLit = numericLiteralValue(node.left);
        const rightLit = numericLiteralValue(node.right);
        const bounds = [
          right && flags.has(right.leaf) && leftLit !== 0 && leftLit !== 1 ? right : undefined,
          left && flags.has(left.leaf) && rightLit !== 0 && rightLit !== 1 ? left : undefined,
        ];
        for (const bound of bounds) {
          if (bound && !bound.paths.some((guardPath) => guardShortCircuitsUse(node, guardPath))) {
            flags.get(bound.leaf)!.thresholdUnguarded = true;
          }
        }
      }
      const assignedName = propertyNodeName(node);
      if (assignedName && flags.has(assignedName)) {
        const initializer = ts.isPropertyAssignment(node)
          ? node.initializer
          : ts.isPropertyDeclaration(node)
            ? node.initializer
            : undefined;
        const resolved =
          initializer && ts.isIdentifier(initializer)
            ? localInitializer(initializer.text, enclosingScope(node))
            : initializer;
        if (resolved && initializerCoercesZero(resolved)) flags.get(assignedName)!.coercion = true;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        flags.has(node.name.text) &&
        node.initializer &&
        localReturnedViaShorthand(node)
      ) {
        if (initializerCoercesZero(node.initializer)) flags.get(node.name.text)!.coercion = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return flags;
}

interface FlatSchemaEntry {
  path: string;
  leaf: string;
  prop: DisableValueSchemaProperty;
}

function flattenManifestProperties(
  properties: Record<string, DisableValueSchemaProperty>,
  prefix = "",
): FlatSchemaEntry[] {
  const out: FlatSchemaEntry[] = [];
  for (const [leaf, prop] of Object.entries(properties)) {
    const dotted = prefix ? `${prefix}.${leaf}` : leaf;
    out.push({ path: dotted, leaf, prop });
    if (prop.properties) out.push(...flattenManifestProperties(prop.properties, dotted));
    if (prop.items?.properties) out.push(...flattenManifestProperties(prop.items.properties, `${dotted}[]`));
  }
  return out;
}

export function findDisableValueViolations(input: {
  sources: DisableValueSource[];
  manifests: DisableValueManifest[];
}): { violations: DisableValueViolation[]; zeroDisableProperties: string[] } {
  const jsDocLeaves = new Set<string>();
  for (const source of input.sources) {
    for (const name of collectZeroDisablePropertiesFromSource(source)) jsDocLeaves.add(name);
  }
  const zeroDisable = new Set<string>(jsDocLeaves);
  const flattenedByManifest = input.manifests.map((manifest) => ({
    manifest,
    entries: flattenManifestProperties(manifest.properties),
  }));
  const schemaEntries = flattenedByManifest.flatMap(({ entries }) => entries);
  const perManifestLeafCount = new Map<string, Map<string, number>>();
  for (const { manifest, entries } of flattenedByManifest) {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.leaf, (counts.get(entry.leaf) ?? 0) + 1);
    perManifestLeafCount.set(manifest.path, counts);
  }
  const leafDisableStats = new Map<string, { zeroDisable: number; plainNumeric: number }>();
  for (const entry of schemaEntries) {
    const stats = leafDisableStats.get(entry.leaf) ?? { zeroDisable: 0, plainNumeric: 0 };
    if (typeof entry.prop.description === "string" && isZeroDisableDoc(entry.prop.description)) {
      stats.zeroDisable += 1;
    } else if (numericSchema(entry.prop) || entry.prop.anyOf || entry.prop.oneOf) {
      stats.plainNumeric += 1;
    }
    leafDisableStats.set(entry.leaf, stats);
  }
  for (const [leaf, stats] of leafDisableStats) {
    if (stats.zeroDisable > 0 && stats.plainNumeric === 0) zeroDisable.add(leaf);
  }

  const violations: DisableValueViolation[] = [];
  for (const { manifest, entries } of flattenedByManifest) {
    for (const entry of entries) {
      const documented =
        isZeroDisableDoc(entry.prop.description ?? "") ||
        (jsDocLeaves.has(entry.leaf) && (entry.path === entry.leaf || perManifestLeafCount.get(manifest.path)!.get(entry.leaf) === 1));
      const rejection = zeroRejectionReason(entry.prop);
      if (documented && rejection !== undefined) {
        violations.push({
          kind: "disable-value-schema-min",
          key: `${entry.path}@${manifest.path}`,
          detail: `${entry.path} is documented "0 disables" but configSchema of ${manifest.path} sets ${rejection} (must admit 0 to honor the documented disable value)`,
        });
      }
    }
  }

  const guards = analyzeAllGuards(input.sources, zeroDisable);
  for (const name of [...zeroDisable].sort()) {
    const guard = guards.get(name);
    if (!guard) continue;
    if (guard.coercion || guard.thresholdUnguarded) {
      const reasons: string[] = [];
      if (guard.coercion) {
        reasons.push("its parser coerces 0 away (Math.max floor > 0 or falsy-default) with no zero short-circuit");
      }
      if (guard.thresholdUnguarded) {
        reasons.push(
          `it is compared as a threshold (\`obj.${name} >\`/\`< obj.${name}\`) with no \`<= 0\`/\`=== 0\` short-circuit`,
        );
      }
      violations.push({
        kind: "disable-value-guard",
        key: name,
        detail: `${name} is documented "0 disables" but ${reasons.join("; and ")}`,
      });
    }
  }

  return { violations, zeroDisableProperties: [...zeroDisable].sort() };
}

const VALID_KIND: Record<string, true> = {
  "disable-value-schema-min": true,
  "disable-value-guard": true,
};

function loadGrandfather(grandfatherPath: string): DisableValueGrandfatherEntry[] {
  const raw: unknown = fs.existsSync(grandfatherPath)
    ? JSON.parse(fs.readFileSync(grandfatherPath, "utf8"))
    : [];
  if (!Array.isArray(raw)) {
    throw new Error(`${grandfatherPath}: disable-value grandfather manifest must be a JSON array`);
  }
  return raw.map((entry, index) => {
    const candidate = entry as Partial<DisableValueGrandfatherEntry>;
    if (
      !candidate ||
      !VALID_KIND[candidate.kind as string] ||
      typeof candidate.key !== "string" ||
      candidate.key.trim().length === 0 ||
      typeof candidate.issue !== "string" ||
      candidate.issue.trim().length === 0
    ) {
      throw new Error(
        `${grandfatherPath}[${index}]: entry must carry { kind, key, issue } with a non-empty tracking issue`,
      );
    }
    return candidate as DisableValueGrandfatherEntry;
  });
}

function readBaselineGrandfather(
  repoRoot: string,
  grandfatherPath: string,
  baseRef: string,
): { keys: Set<string> | null; baselineRequired: boolean } {
  const rel = path.relative(repoRoot, grandfatherPath);
  if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { keys: null, baselineRequired: false };
  }
  const relPosix = rel.split(path.sep).join("/");
  let insideWorkTree = false;
  try {
    insideWorkTree =
      execFileSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true";
  } catch {
    insideWorkTree = false;
  }
  if (!insideWorkTree) return { keys: null, baselineRequired: false };

  let base = "";
  try {
    base = execFileSync("git", ["-C", repoRoot, "merge-base", "HEAD", baseRef], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return { keys: null, baselineRequired: true };
  }
  if (!base) return { keys: null, baselineRequired: true };

  let content: string;
  try {
    content = execFileSync("git", ["-C", repoRoot, "show", `${base}:${relPosix}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { keys: null, baselineRequired: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { keys: null, baselineRequired: true };
  }
  if (!Array.isArray(parsed)) return { keys: null, baselineRequired: true };
  return {
    keys: new Set(
      parsed
        .filter((e): e is DisableValueGrandfatherEntry => Boolean(e) && typeof (e as DisableValueGrandfatherEntry).kind === "string")
        .map((e) => `${e.kind}:${e.key}`),
    ),
    baselineRequired: true,
  };
}

export function assertGrandfatherShrinkOnly(
  current: DisableValueGrandfatherEntry[],
  baseline: Set<string> | null,
  grandfatherPath = "disable-value-grandfathered.json",
): void {
  if (!baseline) return;
  for (const entry of current) {
    const key = `${entry.kind}:${entry.key}`;
    if (!baseline.has(key)) {
      throw new Error(
        `${grandfatherPath}: new exception ${key} is not allowed — the manifest is shrink-only; fix the §33 drift instead of suppressing it`,
      );
    }
  }
}

function readSchemaProperties(manifestPath: string): Record<string, DisableValueSchemaProperty> {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    configSchema?: { properties?: Record<string, DisableValueSchemaProperty> };
  };
  return manifest.configSchema?.properties ?? {};
}

function collectCoreSourceFiles(dirPath: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectCoreSourceFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

export function runDisableValueCheck(options: {
  repoRoot: string;
  sourceFiles?: string[];
  manifestPaths?: string[];
  grandfatherPath?: string;
  checkGrandfatherBaseline?: boolean;
  baselineRef?: string;
}): DisableValueCheckResult {
  const repoRoot = options.repoRoot;
  const sourceFiles =
    options.sourceFiles ?? collectCoreSourceFiles(path.join(repoRoot, "packages", "remnic-core", "src"));
  const manifestPaths = (
    options.manifestPaths ?? [
      path.join(repoRoot, "openclaw.plugin.json"),
      path.join(repoRoot, "packages", "plugin-openclaw", "openclaw.plugin.json"),
      path.join(repoRoot, "packages", "shim-openclaw-engram", "openclaw.plugin.json"),
    ]
  ).filter((manifestPath) => fs.existsSync(manifestPath));
  const grandfatherPath =
    options.grandfatherPath ??
    path.join(repoRoot, "scripts", "config-contract", "disable-value-grandfathered.json");

  const sources: DisableValueSource[] = sourceFiles
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ path: file, text: fs.readFileSync(file, "utf8") }));
  const manifests: DisableValueManifest[] = manifestPaths.map((manifestPath) => ({
    path: path.relative(repoRoot, manifestPath).split(path.sep).join("/"),
    properties: readSchemaProperties(manifestPath),
  }));

  const { violations, zeroDisableProperties } = findDisableValueViolations({ sources, manifests });
  const unique = violations
    .filter((violation, index, all) => {
      const key = `${violation.kind}:${violation.key}`;
      return all.findIndex((other) => `${other.kind}:${other.key}` === key) === index;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));

  const grandfathered = loadGrandfather(grandfatherPath);
  if (options.checkGrandfatherBaseline !== false) {
    const baseRef = options.baselineRef ?? process.env.REMNIC_CONFIG_CONTRACT_BASE_REF ?? "origin/main";
    const relPosix = path.relative(repoRoot, grandfatherPath).split(path.sep).join("/");
    const { keys, baselineRequired } = readBaselineGrandfather(repoRoot, grandfatherPath, baseRef);
    if (baselineRequired && keys === null) {
      throw new Error(
        `${relPosix}: cannot resolve the shrink-only baseline (git merge-base HEAD ${baseRef} or the base manifest JSON). ` +
          "Fetch the PR base branch; refusing to run the §33 check open.",
      );
    }
    assertGrandfatherShrinkOnly(grandfathered, keys, relPosix);
  }
  const grandfatherIndex = new Set(grandfathered.map((entry) => `${entry.kind}:${entry.key}`));
  const currentIndex = new Set(unique.map((violation) => `${violation.kind}:${violation.key}`));

  const activeViolations = unique.filter(
    (violation) => !grandfatherIndex.has(`${violation.kind}:${violation.key}`),
  );
  const staleGrandfatherEntries = grandfathered.filter(
    (entry) => !currentIndex.has(`${entry.kind}:${entry.key}`),
  );

  return {
    violations: activeViolations,
    staleGrandfatherEntries,
    grandfatheredActive: grandfathered.length - staleGrandfatherEntries.length,
    zeroDisableProperties,
  };
}
