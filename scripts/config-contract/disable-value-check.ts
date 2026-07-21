/**
 * §33 disable-value check (issue #2070).
 *
 * AGENTS.md §33 ("Config Schema-Code Consistency — Schema Minimums Must Honor
 * Documented Disable Values"): when a config property documents "0 disables" /
 * "set to 0 to disable" semantics, both the JSON schema AND the parser must
 * accept 0. PR #399 shipped a property documented as "set to 0 to disable"
 * whose schema had `minimum: 1` and whose parser clamped with
 * `Math.max(1, …)`, silently overriding a user who followed the docs.
 *
 * This is a static check — no LLM, no runtime. It runs inside
 * `npm run check-config-contract` (via validate-config-contract.ts), which is
 * the single entry point contract-check.ts's header promises.
 *
 * Two rename-immune sub-checks over the config surface:
 *
 *   - schema-min: a documented zero-disable property whose configSchema entry
 *     is numeric with `minimum >= 1` (the exact PR #399 class). Keyed by the
 *     literal property name in both the docs and the manifest, so it carries
 *     no false positives from renamed runtime locals.
 *   - guard: the property's runtime handling coerces 0 away — a parser clamp
 *     (`Math.max(1, …)`) or falsy-default (`… || 5`) inside the property's own
 *     initializer that has no zero short-circuit, or a consumer threshold
 *     comparison (`queued > threshold`) with no `<= 0` / `=== 0` guard.
 *
 * Violations that already exist on `main` are recorded in
 * disable-value-grandfathered.json (a SEPARATE manifest from
 * grandfathered.json, whose contract-check consumer rejects foreign violation
 * kinds). The manifest is shrink-only: an entry that no longer violates is a
 * failure, not a comfort, so fixing a property forces removing its exception.
 */
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
  /** Issue tracking this entry's removal. */
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

/**
 * A literal `0` within a short window before "disabl(e|es|ed)" — matches
 * "0 disables", "set to 0 to disable", "0 to disable the gate", "<= 0
 * disables", "0 (disabled)". The window stops at a sentence boundary (`.`) so a
 * `0` in one sentence cannot bind to "disable" in the next. Runs on normalized
 * text (comment markers stripped, whitespace collapsed), so phrasing wrapped
 * across JSDoc lines still matches.
 */
export const ZERO_DISABLE_PATTERN = /\b0\b[^.]{0,40}?disabl/i;

/** Strip JSDoc/line-comment markers and collapse whitespace so wrapped phrasing reads as one line. */
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

/** Property names in a single source file whose leading comment/JSDoc documents zero-disable. */
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

/** A numeric branch/schema that is constrained enough to express whether it admits 0. */
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

/**
 * A short reason a numeric schema rejects the value 0 (so it cannot honor a
 * documented disable value), or undefined when it admits 0 (or isn't numeric).
 * Considers `minimum` (ANY value > 0, fractional included), `exclusiveMinimum`,
 * `enum`, `const`, and `anyOf`/`oneOf`. Parent constraints apply IN ADDITION to
 * any combinator (JSON Schema allOf): the field admits 0 only when the parent
 * admits 0 AND some branch admits 0.
 */
function zeroRejectionReason(prop: DisableValueSchemaProperty): string | undefined {
  if (typeof prop.minimum === "number" && prop.minimum > 0) return `minimum ${prop.minimum}`;
  if (typeof prop.exclusiveMinimum === "number" && prop.exclusiveMinimum >= 0) {
    return `exclusiveMinimum ${prop.exclusiveMinimum}`;
  }
  if (prop.const !== undefined && prop.const !== 0) return `const ${JSON.stringify(prop.const)}`;
  if (Array.isArray(prop.enum) && !prop.enum.includes(0)) return `enum ${JSON.stringify(prop.enum)}`;
  const branches = prop.anyOf ?? prop.oneOf;
  if (branches && branches.length > 0) {
    // Parent admits 0 here (nothing rejected above). Count branches that admit 0:
    // anyOf admits 0 when >= 1 branch does; oneOf requires EXACTLY one (two
    // matching branches make 0 invalid under oneOf).
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

/** `Math.max(L, …)` / `Math.max(…, L)` with a positive floor L > 0 (a fractional floor like 0.1 coerces 0 too). */
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

/** Full dotted access path (`config.backlogThreshold`, `this.cap`), or undefined for anything that isn't a plain member access. */
function accessPath(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(node)) {
    const base = accessPath(node.expression);
    return base ? `${base}.${node.name.text}` : undefined;
  }
  return undefined;
}

/** The config property (leaf) an operand reads as `obj.leaf`, plus its full path for guard matching. Bare identifiers are excluded to avoid renamed-local false positives. */
function propertyAccess(node: ts.Expression): { leaf: string; path: string } | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const path = accessPath(node);
  return path ? { leaf: node.name.text, path } : undefined;
}

/**
 * If bare identifier `operand` was destructured from a config object
 * (`const { field } = config` / `const { field: alias } = config`) within its
 * OWN enclosing function, the config field leaf it maps to. Scoped to the
 * operand's function so a `const { cap } = config` in one function does not make
 * an unrelated `cap` in a sibling function look like that config field.
 * Restricted to destructuring off a plain object reference (identifier or member
 * access) to avoid binding unrelated call-result locals.
 */
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

/** A function-like scope node (excludes SourceFile). */
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

/** Nearest enclosing function/method scope (or the SourceFile), so a threshold's guard is checked in its own scope, not repo-wide. */
function enclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionScope(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

/** The `const name = <initializer>` initializer for `name` within `scope`, if any. */
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

/** True when `expr` is the local identifier `name` or a pure alias chain to it (`const b = name`). */
function refersToLocal(expr: ts.Expression, name: string, scope: ts.Node, seen: Set<string>): boolean {
  if (ts.isParenthesizedExpression(expr)) return refersToLocal(expr.expression, name, scope, seen);
  if (!ts.isIdentifier(expr)) return false;
  if (expr.text === name) return true;
  if (seen.has(expr.text)) return false;
  seen.add(expr.text);
  const init = localInitializer(expr.text, scope);
  return init ? refersToLocal(init, name, scope, seen) : false;
}

/**
 * Does `expr` emit config field `name` into a returned value UNDER THE KEY
 * `name` — via a same-named shorthand (`return { name }`), a `name: <value>`
 * property, or a nested/aliased container that itself emits it
 * (`const p = { name }; return { p }`)? A same-named local returned under a
 * DIFFERENT key (`return { requested: name }`) does NOT count — that binds the
 * value to another config key, not `name`. `seen` breaks alias cycles.
 */
function expressionEmitsField(expr: ts.Expression, name: string, scope: ts.Node, seen: Set<string>): boolean {
  if (ts.isParenthesizedExpression(expr)) return expressionEmitsField(expr.expression, name, scope, seen);
  if (ts.isIdentifier(expr)) {
    // Follow a container alias (`const p = { name }; return p`); a bare identifier
    // is not itself an emission under key `name`.
    if (seen.has(expr.text)) return false;
    seen.add(expr.text);
    const init = localInitializer(expr.text, scope);
    return init ? expressionEmitsField(init, name, scope, seen) : false;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.some((prop) => {
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.name.text === name) return true;
        // `{ container }` where container = { name }: follow the alias.
        if (seen.has(prop.name.text)) return false;
        seen.add(prop.name.text);
        const init = localInitializer(prop.name.text, scope);
        return init ? expressionEmitsField(init, name, scope, seen) : false;
      }
      if (ts.isPropertyAssignment(prop)) {
        const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
        // `name: <value>` emits the local only when the VALUE is that local (or a
        // pure alias to it) — `{ name: otherValue }` binds another value to the key.
        if (key === name && refersToLocal(prop.initializer, name, scope, new Set())) return true;
        // Otherwise only a nested container can still emit `name` deeper.
        return expressionEmitsField(prop.initializer, name, scope, seen);
      }
      return false;
    });
  }
  return false;
}

/** True when the parsed local `decl` flows into its scope's return value — directly, via a same-named shorthand, or through nested/aliased returned objects. A returned config field, not a helper local passed elsewhere. */
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

/**
 * Three-valued truth of a boolean condition when `guardedPath` holds `value`.
 * A comparison of `guardedPath` to a numeric literal evaluates concretely; every
 * other operand (a different path, a call, a bare flag like `force`) is "unknown"
 * and propagates through `&&`/`||`/`!`. This is what lets the guard classifier
 * respect boolean operators: `force && cap <= 0` is "unknown" at value 0, so it
 * is not accepted as a disable guard for `cap`.
 */
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

/**
 * How a condition treats the disable value for `guardedPath`, keyed on the value
 * at 0: "disabling" when 0 makes the condition definitely TRUE (it fires when
 * disabled) and a positive value does not force it true (`x <= 0`, `x === 0`,
 * and feature-gated `!enabled || x <= 0`); "active" when 0 makes it definitely
 * FALSE (the branch cannot run while disabled) and a positive value does not
 * force it false (`x > 0`, `x !== 0`, `enabled && x > 0`). An unknown value at 0
 * (`force && x <= 0` — the zero check is itself gated), `>= 0` (true for both),
 * and conditions independent of `guardedPath` yield undefined.
 */
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

/** A statement that unconditionally leaves the current block (return/throw/break/continue), directly or as a block's first exit. */
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

/** The nearest ancestor that is a statement (its parent holds a statement list). */
function enclosingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isStatement(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/** A preceding `if (<disabling guard>) <exit>` guard clause in the use's block or an ancestor block. */
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
    stmt = container ? enclosingStatement(container) : undefined;
  }
  return false;
}

/**
 * True when a boolean `||`/`&&`/paren expression is (part of) an if-condition
 * whose then-branch always exits (return/throw/break/continue). Used so a
 * disabling `||` conjunct only counts as a guard when disabling short-circuits
 * to an exit, not to running an action.
 */
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

/** A disable guard actually short-circuits the threshold use: a preceding guard clause, an `&&`/`||` conjunct, or an enclosing active/else branch. */
function guardShortCircuitsUse(use: ts.Node, guardedPath: string): boolean {
  let node: ts.Node = use;
  while (node.parent) {
    const parent = node.parent;
    if (ts.isBinaryExpression(parent) && node === parent.right) {
      // `cfg.x > 0 && use` — the use only runs when the guard is active.
      if (
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        pathGuardKind(parent.left, guardedPath) === "active"
      ) {
        return true;
      }
      // `cfg.x <= 0 || use` — a disabling left operand short-circuits, but only
      // PROTECTS when the whole `||` is an if-condition whose branch EXITS
      // (`if (cfg.x <= 0 || used > cfg.x) return`). In an action context
      // (`if (cfg.x <= 0 || used > cfg.x) flush()`) the disable value TRIGGERS
      // the action, so it is not a guard.
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

/** Evaluate `<value> <op> <lit>` (or the mirror `<lit> <op> <value>`) for a concrete value. */
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

/** Identifier or member-access text of an operand (`raw`, `cfg.raw`), for tying a ternary condition to its clamped value. */
function operandText(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return accessPath(node);
  return undefined;
}

/**
 * For a condition that is a BARE comparison of a single value to 0/1: which
 * ternary branch runs when the value is 0, plus the compared value's text. A
 * comparison gated by `&&`/`||` (`flag && raw <= 0`) is NOT a zero-preserving
 * test — the branch can run with the value at 0 when the gate flips — so only
 * the whole top-level comparison (parens unwrapped) qualifies.
 */
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

/** Does a subtree reference an operand with the given identifier/access text? */
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

/**
 * True when `clamp` runs only for a non-zero value: it sits in the clamp branch
 * of an enclosing ternary whose zero case yields literal 0 and whose condition
 * tests the value the clamp operates on (`raw <= 0 ? 0 : Math.max(1, raw)`).
 * Checked PER clamp site, so a separate zero-preserving ternary elsewhere in the
 * initializer (`(raw <= 0 ? 0 : raw) + Math.max(1, raw)`) does not mask a clamp
 * that still coerces 0.
 */
function clampIsZeroPreserved(clamp: ts.Node): boolean {
  let node: ts.Node = clamp;
  while (node.parent) {
    const parent = node.parent;
    if (ts.isConditionalExpression(parent)) {
      const info = zeroCaseBranch(parent.condition);
      if (info) {
        const zeroBranch = info.branch === "whenTrue" ? parent.whenTrue : parent.whenFalse;
        const clampBranch = info.branch === "whenTrue" ? parent.whenFalse : parent.whenTrue;
        // Require a VERIFIED same-value tie: the zero branch yields 0 and the
        // CLAMP NODE ITSELF operates on the exact value the condition tested
        // (not merely somewhere in the branch — `legacy <= 0 ? 0 : Math.max(1, rawCap) + legacy`
        // clamps rawCap, not legacy, and must still be flagged). If the tested
        // value can't be named (e.g. `coerceNumber(x) <= 0`), fail closed.
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

/** Initializer clamps 0 up (`Math.max(1, …)`) or falsy-defaults it (`… || 5`) at a site that is not confined to the non-zero branch of a zero-preserving ternary. */
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

/**
 * One pass per source collecting guard flags for every zero-disable property at
 * once. A threshold comparison (`obj.prop` as a bound) is unguarded only when
 * its OWN enclosing function lacks a `obj.prop <op> 0|1` short-circuit — a guard
 * in a different consumer does not vouch for it. Coercion is caught in a
 * property's own initializer AND in a local of the same name (parser values
 * returned via shorthand).
 */
function analyzeAllGuards(sources: DisableValueSource[], zeroDisable: Set<string>): Map<string, GuardFlags> {
  const flags = new Map<string, GuardFlags>();
  for (const name of zeroDisable) flags.set(name, { thresholdUnguarded: false, coercion: false });
  for (const source of sources) {
    const sf = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
    const operandBound = (operand: ts.Expression): { leaf: string; paths: string[] } | undefined => {
      if (ts.isIdentifier(operand)) {
        const destructured = destructuredConfigField(operand);
        if (destructured) {
          // A guard may reference the alias (`cap <= 0`) or the full config path
          // (`config.cap <= 0`); accept either.
          return {
            leaf: destructured.field,
            paths: [operand.text, `${destructured.sourcePath}.${destructured.field}`],
          };
        }
      }
      const access = propertyAccess(operand);
      return access ? { leaf: access.leaf, paths: [access.path] } : undefined;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && isInequalityOperator(node.operatorToken.kind)) {
        const left = operandBound(node.left);
        const right = operandBound(node.right);
        const leftLit = numericLiteralValue(node.left);
        const rightLit = numericLiteralValue(node.right);
        // A property is a threshold bound in ANY inequality ordering (`prop > X`,
        // `X > prop`, `prop < X`, `X < prop`, …) as long as the other operand is
        // a dynamic value, not the 0/1 disable literal (that side is a guard).
        const bounds = [
          right && flags.has(right.leaf) && leftLit !== 0 && leftLit !== 1 ? right : undefined,
          left && flags.has(left.leaf) && rightLit !== 0 && rightLit !== 1 ? left : undefined,
        ];
        for (const bound of bounds) {
          // Guarded when a disable check on ANY of the bound's access paths (the
          // property path, or a destructured alias / its full config path) actually
          // short-circuits this use — not merely present in the function.
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
        // Resolve an aliased local initializer (`const parsed = Math.max(1, raw); { maxItems: parsed }`)
        // to its declaration so a coercion routed through a differently named local is still caught.
        const resolved =
          initializer && ts.isIdentifier(initializer)
            ? localInitializer(initializer.text, enclosingScope(node))
            : initializer;
        if (resolved && initializerCoercesZero(resolved)) flags.get(assignedName)!.coercion = true;
      }
      // Parser value computed in a same-named local AND returned via shorthand
      // (a config field being assembled) — not an unrelated runtime helper local.
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
  /** Dotted path from the configSchema root (`procedural.minOccurrences`, `foo[].bar`). */
  path: string;
  leaf: string;
  prop: DisableValueSchemaProperty;
}

/** Flatten a configSchema property map into dotted paths, recursing objects and array items. */
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

/**
 * Pure core: given source texts and manifest property maps, return every §33
 * violation (unsorted). No filesystem, no grandfather — the unit-test seam.
 */
export function findDisableValueViolations(input: {
  sources: DisableValueSource[];
  manifests: DisableValueManifest[];
}): { violations: DisableValueViolation[]; zeroDisableProperties: string[] } {
  // Leaves documented via source JSDoc are real top-level config field names; a
  // schema *description* documents only the entry at its own path, so it must
  // not vouch for an unrelated top-level entry sharing the leaf.
  const jsDocLeaves = new Set<string>();
  for (const source of input.sources) {
    for (const name of collectZeroDisablePropertiesFromSource(source)) jsDocLeaves.add(name);
  }
  const zeroDisable = new Set<string>(jsDocLeaves);
  const flattenedByManifest = input.manifests.map((manifest) => ({
    manifest,
    entries: flattenManifestProperties(manifest.properties),
  }));
  // A schema *description* contributes its leaf to the leaf-keyed guard scan only
  // when the leaf is unambiguously zero-disable: another numeric (or combinator)
  // entry sharing the leaf without the zero-disable contract would poison that
  // unrelated field's consumer scan, so such a leaf is left out (schema-min still
  // keys by full dotted path, so nested docs are still checked there).
  const schemaEntries = flattenedByManifest.flatMap(({ entries }) => entries);
  const schemaLeafCount = new Map<string, number>();
  for (const entry of schemaEntries) schemaLeafCount.set(entry.leaf, (schemaLeafCount.get(entry.leaf) ?? 0) + 1);
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
  // schema-min over every flattened entry (nested blocks included). An entry is
  // zero-disable via its own schema description at any depth, or via a top-level
  // leaf documented in a source JSDoc — never a nested leaf coinciding with an
  // unrelated top-level name.
  for (const { manifest, entries } of flattenedByManifest) {
    for (const entry of entries) {
      const documented =
        isZeroDisableDoc(entry.prop.description ?? "") ||
        (jsDocLeaves.has(entry.leaf) && (entry.path === entry.leaf || schemaLeafCount.get(entry.leaf) === 1));
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

/**
 * Resolve the grandfather baseline for the shrink-only ban, mirroring the v2
 * contract checker. `baselineRequired` lets the caller FAIL CLOSED rather than
 * run open: a real Git checkout whose base ref or baseline JSON cannot be
 * resolved must not silently skip the ban. A missing Git work tree (unit
 * fixture) and the PR that first introduces the manifest legitimately have no
 * baseline (`keys: null, baselineRequired: false`).
 */
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
    // Absent at the base → this PR introduces the manifest; not a new exception.
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

/** Reject any exception not present in the baseline — the manifest may only shrink. No-op when baseline is null. */
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

/** Every non-test, non-declaration `.ts` under a directory (the runtime consumers to scan for guards). */
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

/**
 * Filesystem wiring: read the config surface (declarations + parser) and every
 * present manifest, run the core, then apply the shrink-only grandfather.
 */
export function runDisableValueCheck(options: {
  repoRoot: string;
  sourceFiles?: string[];
  manifestPaths?: string[];
  grandfatherPath?: string;
  /** Enforce the shrink-only grandfather ban against the git base (default true). Unit tests on non-git dirs opt out. */
  checkGrandfatherBaseline?: boolean;
  /** Git ref for the shrink-only baseline (default env REMNIC_CONFIG_CONTRACT_BASE_REF ?? "origin/main"). */
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
