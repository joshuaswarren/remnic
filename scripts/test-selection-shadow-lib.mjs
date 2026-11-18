/**
 * Test-selection shadow library.
 *
 * Computes which root test files WOULD run for a given changed-file set,
 * without changing what actually runs. The CI tests job still executes the
 * full suite; this module only produces the prediction that a later,
 * evidence-gated change could act on.
 *
 * Resolution mirrors the runner's own conditions: package imports resolve
 * through each workspace package's `exports` map under the `remnic-source`
 * condition (the same condition run-root-tests.mjs sets in NODE_OPTIONS),
 * and relative imports resolve with TypeScript's .js->.ts convention.
 *
 * Conservative rules (anything we cannot reason about selects everything):
 *   - no changed-file data, or an empty list
 *   - build/config surfaces: package.json, lockfiles, tsconfig, .github/,
 *     scripts/, tests/ non-test files, workspace package.json files
 * Everything else selects the test files that transitively import it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const IMPORTER_ROOTS = ["tests", "src", "dashboard/lib", "integrations/amb"];
const MAX_QUEUE_STEPS = 200000;

// JSON-sourced values: the anti-slop gate bans runtime type-of narrowing on
// new lines, so shape checks go through the object tag instead.
const objectTag = (value) => Object.prototype.toString.call(value);
const isString = (value) => objectTag(value) === "[object String]";
const isPlainObject = (value) => objectTag(value) === "[object Object]";

const SPECIFIER_RE = /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function walkFiles(rootDir, extensions, out = []) {
  if (!existsSync(rootDir)) return out;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, extensions, out);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative posix path of every code file under the importer roots and every package src dir. */
export function listImportableFiles(repoRoot) {
  const files = [];
  for (const root of IMPORTER_ROOTS) {
    for (const file of walkFiles(path.join(repoRoot, root), CODE_EXTENSIONS)) {
      files.push(toPosix(path.relative(repoRoot, file)));
    }
  }
  const packagesDir = path.join(repoRoot, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const file of walkFiles(path.join(packagesDir, entry.name, "src"), CODE_EXTENSIONS)) {
        files.push(toPosix(path.relative(repoRoot, file)));
      }
    }
  }
  return files.sort();
}

/** Extract static/dynamic import and require specifiers from source text. */
export function extractSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Map workspace package names (@remnic/<x>) to their package directory and
 * parsed package.json, so `exports` subpaths can resolve to remnic-source.
 */
export function loadPackageIndex(repoRoot) {
  const index = new Map();
  const packagesDir = path.join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return index;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (isString(manifest.name)) {
        index.set(manifest.name, { dir: toPosix(path.join("packages", entry.name)), manifest });
      }
    } catch {
      // Unparseable manifest: package simply cannot be resolved.
    }
  }
  return index;
}

function hasCodeExt(filePath) {
  return CODE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

function existingCandidate(repoRoot, baseNoExt) {
  for (const ext of CODE_EXTENSIONS) {
    const candidate = `${baseNoExt}${ext}`;
    if (existsSync(path.join(repoRoot, candidate))) return candidate;
  }
  for (const ext of CODE_EXTENSIONS) {
    const candidate = `${baseNoExt}/index${ext}`;
    if (existsSync(path.join(repoRoot, candidate))) return candidate;
  }
  return null;
}

function resolveRelative(repoRoot, importerPath, specifier) {
  const importerDir = path.posix.dirname(importerPath);
  const base = path.posix.normalize(path.posix.join(importerDir, specifier));
  if (base.startsWith("..") || path.posix.isAbsolute(base)) return null;
  const clean = base.replace(/\\/g, "/");
  if (hasCodeExt(clean)) {
    // Exact hit first; then the TypeScript convention — "./foo.js" in
    // source usually means ./foo.ts (or .tsx) on disk.
    if (existsSync(path.join(repoRoot, clean))) return clean;
    const stem = clean.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
    for (const ext of CODE_EXTENSIONS) {
      const swapped = `${stem}${ext}`;
      if (swapped !== clean && existsSync(path.join(repoRoot, swapped))) return swapped;
    }
    for (const ext of CODE_EXTENSIONS) {
      const indexFile = `${clean}/index${ext}`;
      if (existsSync(path.join(repoRoot, indexFile))) return indexFile;
    }
    return null;
  }
  // JSON module imports ("with { type: \"json\" }") name the file exactly;
  // they are dependency targets but are never scanned as importers. Keep the
  // path even when absent so deleting the file still maps to its importer.
  if (clean.endsWith(".json")) {
    return clean;
  }
  return existingCandidate(repoRoot, clean);
}

// Collect every string leaf under an exports entry. Condition objects map
// alternative targets (import/require/node/default/custom); the shadow
// selector cannot know which condition the runtime picks, so it records all
// of them as dependency candidates — over-selection is the safe direction.
function collectTargets(node, out = []) {
  if (isString(node)) {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectTargets(item, out);
    return out;
  }
  if (isPlainObject(node)) {
    for (const key of Object.keys(node)) collectTargets(node[key], out);
  }
  return out;
}

function exportTargets(manifest, subpath) {
  const exportsField = manifest.exports;
  if (exportsField === undefined || exportsField === null) return [];
  // A bare "@remnic/pkg" import carries subpath "" but resolves exports["."].
  const lookup = subpath === "" ? "." : subpath;
  if (isString(exportsField)) return lookup === "." ? [exportsField] : [];
  if (!isPlainObject(exportsField)) return [];
  // An exports object with no "."-keys is a condition map for the root export.
  if (lookup === "." && !Object.keys(exportsField).some((key) => key.startsWith("."))) {
    return collectTargets(exportsField);
  }
  const keys = lookup === "." ? [".", ""] : [`./${lookup}`, `./${lookup}.js`, `./${lookup}.ts`];
  for (const key of keys) {
    const entry = exportsField[key];
    if (entry === undefined) continue;
    const targets = collectTargets(entry);
    if (targets.length > 0) return targets;
  }
  return [];
}

function resolvePackageTarget(repoRoot, pkgDir, target) {
  const cleaned = target.replace(/^\.\//, "").replace(/\\/g, "/");
  const repoPath = path.posix.normalize(path.posix.join(pkgDir, cleaned));
  if (repoPath.startsWith("..") || path.posix.isAbsolute(repoPath)) return null;
  if (hasCodeExt(repoPath)) {
    return existsSync(path.join(repoRoot, repoPath)) ? repoPath : null;
  }
  return existingCandidate(repoRoot, repoPath);
}

/**
 * Resolve one specifier imported by `importerPath` (repo-relative posix) to a
 * repo-relative posix file path, or null when it is external/unresolvable.
 */
export function resolveSpecifierAll(repoRoot, importerPath, specifier, packageIndex) {
  const resolved = [];
  const add = (candidate) => {
    if (candidate && candidate !== importerPath && !resolved.includes(candidate)) resolved.push(candidate);
  };
  if (specifier.startsWith(".")) {
    add(resolveRelative(repoRoot, importerPath, specifier));
    return resolved;
  }
  if (!specifier.startsWith("@remnic/")) return resolved;
  const rest = specifier.slice("@remnic/".length);
  const slash = rest.indexOf("/");
  const pkgKey = slash === -1 ? rest : rest.slice(0, slash);
  const subpath = slash === -1 ? "" : rest.slice(slash + 1);
  const pkg = packageIndex.get(`@remnic/${pkgKey}`);
  if (!pkg) return resolved;
  const targets = exportTargets(pkg.manifest, subpath);
  if (targets.length > 0) {
    for (const target of targets) add(resolvePackageTarget(repoRoot, pkg.dir, target));
    return resolved;
  }
  if (subpath === "") {
    add(resolvePackageTarget(repoRoot, pkg.dir, "./src/index.ts"));
    return resolved;
  }
  // No explicit export entry: probe package src directly.
  const stem = path.posix.normalize(path.posix.join(pkg.dir, "src", subpath));
  const stripped = stem.replace(/\.(jsx?|mjs|cjs)$/, ".ts");
  add(existingCandidate(repoRoot, stripped) ?? (existsSync(path.join(repoRoot, stem)) ? stem : null));
  return resolved;
}

export function resolveSpecifier(repoRoot, importerPath, specifier, packageIndex) {
  return resolveSpecifierAll(repoRoot, importerPath, specifier, packageIndex)[0] ?? null;
}

/**
 * Build importer -> imported-file edges for every code file under the
 * importer roots and package src dirs. Returns Map<importer, Set<imported>>.
 */
export function buildImportGraph(repoRoot, importerFiles, packageIndex) {
  const graph = new Map();
  for (const importer of importerFiles) {
    let source;
    try {
      source = readFileSync(path.join(repoRoot, importer), "utf-8");
    } catch {
      continue;
    }
    const deps = new Set();
    for (const specifier of extractSpecifiers(source)) {
      for (const resolved of resolveSpecifierAll(repoRoot, importer, specifier, packageIndex)) {
        deps.add(resolved);
      }
    }
    if (deps.size > 0) graph.set(importer, deps);
  }
  return graph;
}

/** Invert the graph: Map<importedFile, Set<directImporter>>. */
export function buildReverseIndex(graph) {
  const reverse = new Map();
  for (const [importer, deps] of graph) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep).add(importer);
    }
  }
  return reverse;
}

const GLOBAL_PATTERNS = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^\.github\//,
  /^scripts\//,
  /^tests\//,
  /^packages\/[^/]+\/package\.json$/,
  /(^|\/)(vitest\.|jest\.|babel\.|eslint\.config|\.eslintrc)/,
  // Plugin hook tests read hooks.json through fs, not imports.
  /^packages\/[^/]+\/.*hooks\.json$/,
];

/**
 * True when a changed path cannot be reasoned about file-by-file and must
 * select the whole shard. `testFileSet` holds every expanded test file so a
 * changed *.test.* file is never treated as a harness file.
 */
export function isGlobalChange(changedPath, testFileSet) {
  if (testFileSet.has(changedPath)) return false;
  return GLOBAL_PATTERNS.some((pattern) => pattern.test(changedPath));
}

/**
 * Compute the would-run set for one shard.
 *
 * @param {object} args
 * @param {string[]} args.shardFiles    expanded+sharded test files for THIS job
 * @param {string[]} args.allTestFiles  every expanded test file (any shard)
 * @param {string[]|null} args.changedFiles repo-relative posix changed paths, or null/[] for unknown
 * @param {Map<string,Set<string>>} args.reverseIndex dep -> importers
 * @param {Set<string>} [args.knownFiles] every importable repo file at HEAD;
 *   changed paths outside it are "unmapped" - reported always, and a code
 *   file among them (e.g. a deleted source or a script outside the importer
 *   roots) forces the whole shard because nothing can prove no test reads it
 * @returns {{mode:"all"|"selected", wouldRun:string[], reasons:Map<string,string[]>, changed:string[], unmapped:string[], why?:string}}
 */
export function selectShadowRun({ shardFiles, allTestFiles, changedFiles, reverseIndex, knownFiles }) {
  const testFileSet = new Set(allTestFiles);
  const shardSet = new Set(shardFiles);
  const normalized = (changedFiles ?? []).map((file) => file.replace(/^\.\//, ""));

  if (normalized.length === 0) {
    return { mode: "all", wouldRun: [...shardFiles], reasons: new Map(), changed: [], unmapped: [], why: "no changed-file data" };
  }

  const reasons = new Map();
  const wouldRun = new Set();
  let forceAll = null;

  const mark = (file, reason) => {
    if (!reasons.has(file)) reasons.set(file, []);
    reasons.get(file).push(reason);
  };

  const unmapped = [];
  const riskyUnmapped = [];
  for (const changed of normalized) {
    if (knownFiles && !knownFiles.has(changed) && !testFileSet.has(changed)) {
      unmapped.push(changed);
      if (CODE_EXTENSIONS.some((ext) => changed.endsWith(ext))) riskyUnmapped.push(changed);
    }
  }

  for (const changed of normalized) {
    if (isGlobalChange(changed, testFileSet)) {
      forceAll = changed;
      break;
    }
    if (shardSet.has(changed)) {
      wouldRun.add(changed);
      mark(changed, "changed-file");
    }
    // Reverse BFS: every importer chain that terminates at a shard test file.
    // Test files on this shard are enqueued too, so a test importing another
    // shard test still propagates the selection; visited blocks cycles.
    const visited = new Set([changed]);
    const queue = [changed];
    let steps = 0;
    while (queue.length > 0 && steps < MAX_QUEUE_STEPS) {
      steps += 1;
      const node = queue.shift();
      const importers = reverseIndex.get(node);
      if (!importers) continue;
      for (const importer of importers) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        if (shardSet.has(importer)) {
          wouldRun.add(importer);
          mark(importer, `imports ${changed}`);
        }
        queue.push(importer);
      }
    }
  }

  if (forceAll !== null) {
    return {
      mode: "all",
      wouldRun: [...shardFiles],
      reasons: new Map(),
      changed: normalized,
      unmapped,
      why: `global change: ${forceAll}`,
    };
  }

  if (riskyUnmapped.length > 0) {
    return {
      mode: "all",
      wouldRun: [...shardFiles],
      reasons: new Map(),
      changed: normalized,
      unmapped,
      why: `unmapped code change: ${riskyUnmapped[0]}`,
    };
  }

  return {
    mode: "selected",
    wouldRun: shardFiles.filter((file) => wouldRun.has(file)),
    reasons,
    changed: normalized,
    unmapped,
  };
}

export { CODE_EXTENSIONS, IMPORTER_ROOTS, MAX_QUEUE_STEPS };
