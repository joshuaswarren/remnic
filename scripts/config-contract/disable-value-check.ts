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
  properties?: Record<string, DisableValueSchemaProperty>;
  items?: { properties?: Record<string, DisableValueSchemaProperty> };
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

/** Name accessed as `obj.name` — config reads in consumers. Bare identifiers are excluded to avoid renamed-local false positives. */
function propertyAccessName(node: ts.Expression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
}

/**
 * One pass per source collecting guard flags for every zero-disable property
 * at once. Comparisons match config reads written `obj.prop` (threshold use vs
 * zero short-circuit); the coercion scan is scoped to a property's own
 * initializer, so a parser clamp is caught rename-immune.
 */
function analyzeAllGuards(sources: DisableValueSource[], zeroDisable: Set<string>): Map<string, GuardFlags> {
  const flags = new Map<string, GuardFlags>();
  for (const name of zeroDisable) flags.set(name, { thresholdUse: false, zeroGuard: false, coercion: false });
  for (const source of sources) {
    const sf = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && isComparisonOperator(node.operatorToken.kind)) {
        const op = node.operatorToken.kind;
        const leftName = propertyAccessName(node.left);
        const rightName = propertyAccessName(node.right);
        const leftLit = numericLiteralValue(node.left);
        const rightLit = numericLiteralValue(node.right);
        if (leftName && flags.has(leftName) && (rightLit === 0 || rightLit === 1)) {
          flags.get(leftName)!.zeroGuard = true;
        }
        if (rightName && flags.has(rightName) && (leftLit === 0 || leftLit === 1)) {
          flags.get(rightName)!.zeroGuard = true;
        }
        // Property used as a bound against a dynamic value: `X > prop` / `X >= prop`.
        if (
          rightName &&
          flags.has(rightName) &&
          (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) &&
          leftLit !== 0 &&
          leftLit !== 1
        ) {
          flags.get(rightName)!.thresholdUse = true;
        }
        // `prop < X` / `prop <= X`.
        if (
          leftName &&
          flags.has(leftName) &&
          (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) &&
          rightLit !== 0 &&
          rightLit !== 1
        ) {
          flags.get(leftName)!.thresholdUse = true;
        }
      }
      const assignedName = propertyNodeName(node);
      if (assignedName && flags.has(assignedName)) {
        const initializer = ts.isPropertyAssignment(node)
          ? node.initializer
          : ts.isPropertyDeclaration(node)
            ? node.initializer
            : undefined;
        if (initializer && initializerCoercesZero(initializer, assignedName)) {
          flags.get(assignedName)!.coercion = true;
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
  const zeroDisable = new Set<string>();
  for (const source of input.sources) {
    for (const name of collectZeroDisablePropertiesFromSource(source)) zeroDisable.add(name);
  }
  const flattenedByManifest = input.manifests.map((manifest) => ({
    manifest,
    entries: flattenManifestProperties(manifest.properties),
  }));
  for (const { entries } of flattenedByManifest) {
    for (const entry of entries) {
      if (typeof entry.prop.description === "string" && isZeroDisableDoc(entry.prop.description)) {
        zeroDisable.add(entry.leaf);
      }
    }
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
        (entry.path === entry.leaf && zeroDisable.has(entry.leaf));
      if (documented && numericSchema(entry.prop) && typeof entry.prop.minimum === "number" && entry.prop.minimum >= 1) {
        violations.push({
          kind: "disable-value-schema-min",
          key: `${entry.path}@${manifest.path}`,
          detail: `${entry.path} is documented "0 disables" but configSchema of ${manifest.path} sets minimum ${entry.prop.minimum} (must be 0 to honor the documented disable value)`,
        });
      }
    }
  }

  const guards = analyzeAllGuards(input.sources, zeroDisable);
  for (const name of [...zeroDisable].sort()) {
    const guard = guards.get(name);
    if (!guard) continue;
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
        detail: `${name} is documented "0 disables" but is compared as a threshold (\`obj.${name} >\`/\`< obj.${name}\`) with no \`<= 0\`/\`=== 0\` short-circuit`,
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
