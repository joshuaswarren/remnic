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
  description?: string;
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
 * disables", "0 (disabled)". The window stops at a sentence boundary so a `0`
 * in one sentence cannot bind to "disable" in the next.
 */
export const ZERO_DISABLE_PATTERN = /\b0\b[^.\n]{0,40}?disabl/i;

export function isZeroDisableDoc(text: string): boolean {
  return ZERO_DISABLE_PATTERN.test(text);
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

interface GuardFlags {
  thresholdUse: boolean;
  zeroGuard: boolean;
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

/** True when the expression references the property (identifier, `x.prop`, `this.prop`). */
function referencesProperty(node: ts.Expression, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  if (ts.isPropertyAccessExpression(node)) return node.name.text === name;
  return false;
}

/** Does a subtree contain a comparison of `name` to the literal 0 or 1 (a zero short-circuit)? */
function subtreeHasZeroGuard(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(node) && isComparisonOperator(node.operatorToken.kind)) {
      const left = numericLiteralValue(node.left);
      const right = numericLiteralValue(node.right);
      if (
        (referencesProperty(node.left, name) && (right === 0 || right === 1)) ||
        (referencesProperty(node.right, name) && (left === 0 || left === 1))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
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

/** `Math.max(L, …)` / `Math.max(…, L)` with an integer floor L >= 1. */
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
    return value !== undefined && value >= 1;
  });
}

/**
 * Guard flags for a property, aggregated over every provided source. The
 * coercion scan is scoped to the property's own initializer (rename-immune);
 * the comparison scan is repo-wide by exact name so a consumer threshold shows
 * up even when the parser is clean.
 */
function analyzeGuards(sources: DisableValueSource[], name: string): GuardFlags {
  const flags: GuardFlags = { thresholdUse: false, zeroGuard: false, coercion: false };
  for (const source of sources) {
    const sf = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && isComparisonOperator(node.operatorToken.kind)) {
        const op = node.operatorToken.kind;
        const leftRef = referencesProperty(node.left, name);
        const rightRef = referencesProperty(node.right, name);
        const leftLit = numericLiteralValue(node.left);
        const rightLit = numericLiteralValue(node.right);
        if ((leftRef && (rightLit === 0 || rightLit === 1)) || (rightRef && (leftLit === 0 || leftLit === 1))) {
          flags.zeroGuard = true;
        }
        // Property used as a bound against a dynamic value: `X > prop`,
        // `X >= prop`, `prop < X`, `prop <= X` where X is not the 0/1 literal.
        const propOnRightBound =
          rightRef &&
          (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) &&
          leftLit !== 0 &&
          leftLit !== 1;
        const propOnLeftBound =
          leftRef &&
          (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) &&
          rightLit !== 0 &&
          rightLit !== 1;
        if (propOnRightBound || propOnLeftBound) {
          flags.thresholdUse = true;
        }
      }
      // Coercion is scoped to the property's own assignment initializer.
      const assignedName = propertyNodeName(node);
      if (assignedName === name) {
        const initializer =
          ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)
            ? (node as ts.PropertyAssignment).initializer
            : undefined;
        if (initializer && initializerCoercesZero(initializer, name)) {
          flags.coercion = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return flags;
}

/** Initializer clamps 0 up (`Math.max(1, …)`) or falsy-defaults it (`… || 5`) with no zero short-circuit. */
function initializerCoercesZero(initializer: ts.Expression, name: string): boolean {
  let coerces = false;
  const visit = (node: ts.Node): void => {
    if (coerces) return;
    if (ts.isCallExpression(node) && isFloorAboveZero(node)) {
      coerces = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      const rightLit = numericLiteralValue(node.right);
      if (rightLit !== undefined && rightLit !== 0) {
        coerces = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  // A short-circuit that preserves 0 inside the same initializer clears it.
  return coerces && !subtreeHasZeroGuard(initializer, name);
}

/**
 * Pure core: given source texts and manifest property maps, return every §33
 * violation (unsorted). No filesystem, no grandfather — the unit-test seam.
 */
export function findDisableValueViolations(input: {
  sources: DisableValueSource[];
  manifests: DisableValueManifest[];
}): { violations: DisableValueViolation[]; zeroDisableProperties: string[] } {
  const zeroDisable = new Set<string>();
  for (const source of input.sources) {
    for (const name of collectZeroDisablePropertiesFromSource(source)) zeroDisable.add(name);
  }
  for (const manifest of input.manifests) {
    for (const [name, prop] of Object.entries(manifest.properties)) {
      if (typeof prop?.description === "string" && isZeroDisableDoc(prop.description)) {
        zeroDisable.add(name);
      }
    }
  }

  const violations: DisableValueViolation[] = [];
  for (const name of zeroDisable) {
    for (const manifest of input.manifests) {
      const prop = manifest.properties[name];
      if (prop && numericSchema(prop) && typeof prop.minimum === "number" && prop.minimum >= 1) {
        violations.push({
          kind: "disable-value-schema-min",
          key: `${name}@${path.basename(manifest.path)}`,
          detail: `${name} is documented "0 disables" but configSchema of ${path.basename(manifest.path)} sets minimum ${prop.minimum} (must be 0 to honor the documented disable value)`,
        });
      }
    }

    const guard = analyzeGuards(input.sources, name);
    if (guard.coercion) {
      violations.push({
        kind: "disable-value-guard",
        key: name,
        detail: `${name} is documented "0 disables" but its parser coerces 0 away (Math.max floor >= 1 or falsy-default) with no zero short-circuit`,
      });
    } else if (guard.thresholdUse && !guard.zeroGuard) {
      violations.push({
        kind: "disable-value-guard",
        key: name,
        detail: `${name} is documented "0 disables" but is compared as a threshold (\`> ${name}\`/\`< ${name}\`) with no \`<= 0\`/\`=== 0\` short-circuit`,
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

function readSchemaProperties(manifestPath: string): Record<string, DisableValueSchemaProperty> {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    configSchema?: { properties?: Record<string, DisableValueSchemaProperty> };
  };
  return manifest.configSchema?.properties ?? {};
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
}): DisableValueCheckResult {
  const repoRoot = options.repoRoot;
  const sourceFiles = options.sourceFiles ?? [
    path.join(repoRoot, "packages", "remnic-core", "src", "types.ts"),
    path.join(repoRoot, "packages", "remnic-core", "src", "config.ts"),
  ];
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
    path: manifestPath,
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
