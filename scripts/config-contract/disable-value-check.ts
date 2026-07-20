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

/** Nearest enclosing function/method scope (or the SourceFile), so a threshold's guard is checked in its own scope, not repo-wide. */
function enclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

/** A `obj.name <op> 0|1` short-circuit somewhere within a scope. */
function scopeHasZeroGuardFor(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(node) && isComparisonOperator(node.operatorToken.kind)) {
      const leftName = propertyAccessName(node.left);
      const rightName = propertyAccessName(node.right);
      const leftLit = numericLiteralValue(node.left);
      const rightLit = numericLiteralValue(node.right);
      if (
        (leftName === name && (rightLit === 0 || rightLit === 1)) ||
        (rightName === name && (leftLit === 0 || leftLit === 1))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** Any comparison of any operand to the literal 0 or 1 — a zero-aware short-circuit in a parser initializer. */
function subtreeHasZeroComparison(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(node) && isComparisonOperator(node.operatorToken.kind)) {
      const leftLit = numericLiteralValue(node.left);
      const rightLit = numericLiteralValue(node.right);
      if (leftLit === 0 || leftLit === 1 || rightLit === 0 || rightLit === 1) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Initializer clamps 0 up (`Math.max(1, …)`) or falsy-defaults it (`… || 5`) with no zero-aware short-circuit. */
function initializerCoercesZero(initializer: ts.Expression): boolean {
  let coerces = false;
  const visit = (node: ts.Node): void => {
    if (coerces) return;
    if (ts.isCallExpression(node) && isFloorAboveZero(node)) {
      coerces = true;
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const rightLit = numericLiteralValue(node.right);
      if (rightLit !== undefined && rightLit !== 0) {
        coerces = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  // A comparison to 0/1 anywhere in the initializer means the parser already
  // branches on the disable value (e.g. `raw <= 0 ? 0 : Math.max(1, raw)`).
  return coerces && !subtreeHasZeroComparison(initializer);
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
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && isComparisonOperator(node.operatorToken.kind)) {
        const op = node.operatorToken.kind;
        const leftName = propertyAccessName(node.left);
        const rightName = propertyAccessName(node.right);
        const leftLit = numericLiteralValue(node.left);
        const rightLit = numericLiteralValue(node.right);
        // Property as a bound against a dynamic value: `X > prop` / `X >= prop` / `prop < X` / `prop <= X`.
        const boundName =
          rightName &&
          flags.has(rightName) &&
          (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) &&
          leftLit !== 0 &&
          leftLit !== 1
            ? rightName
            : leftName &&
                flags.has(leftName) &&
                (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) &&
                rightLit !== 0 &&
                rightLit !== 1
              ? leftName
              : undefined;
        if (boundName && !scopeHasZeroGuardFor(enclosingScope(node), boundName)) {
          flags.get(boundName)!.thresholdUnguarded = true;
        }
      }
      const assignedName = propertyNodeName(node);
      if (assignedName && flags.has(assignedName)) {
        const initializer = ts.isPropertyAssignment(node)
          ? node.initializer
          : ts.isPropertyDeclaration(node)
            ? node.initializer
            : undefined;
        if (initializer && initializerCoercesZero(initializer)) flags.get(assignedName)!.coercion = true;
      }
      // Parser values computed in a same-named local and returned via shorthand.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && flags.has(node.name.text) && node.initializer) {
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
    } else if (guard.thresholdUnguarded) {
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
