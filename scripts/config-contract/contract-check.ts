/**
 * check-config-contract v2 — parser-derived contract comparisons
 * (issue #1990 PR2).
 *
 * The extractor (extract-parsed-keys.ts) derives the AUTHORITATIVE key set
 * from the parsers; this module requires every other surface to match:
 *
 *  - a parsed key path absent from BOTH plugin manifests' configSchema
 *    (packages/plugin-openclaw + packages/shim-openclaw-engram) fails as
 *    `missing-schema` — the exact #1923 class (codingKnowledge.lsp);
 *  - a schema key path with no corresponding parsed key fails as
 *    `dead-schema` (§40 validator-implementation consistency);
 *  - a dotted key documented in docs/config-reference.md that matches
 *    neither parsers nor schema fails as `documented-nonexistent`;
 *  - a parsed key never mentioned in the docs fails as `undocumented-key`
 *    (leaf-name mentions inside the docs count — block tables list leaves);
 *  - unparseable parser constructs surface as `unparseable-construct`.
 *
 * Grandfather manifest (umbrella decision C):
 * scripts/config-contract/grandfathered.json records accepted current
 * violations, each carrying the issue number tracking its removal. The
 * check FAILS when a violation is not grandfathered, and FAILS when a
 * manifest entry's violation no longer exists (staleness is a failure, not
 * a comfort — the manifest may only shrink).
 *
 * §33 disable-value checks and the v1 top-level parity checks live in
 * validate-config-contract.ts, which calls into this module — one npm
 * entry point (`npm run check-config-contract`), preserved.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  collectModuleParserFiles,
  extractParsedKeyPaths,
  extractRealConfigKeys,
} from "./extract-parsed-keys.js";

export interface ContractViolation {
  kind:
    | "missing-schema"
    | "dead-schema"
    | "documented-nonexistent"
    | "undocumented-key"
    | "unparseable-construct";
  key: string;
  detail: string;
}

export interface GrandfatherEntry {
  kind: ContractViolation["kind"];
  key: string;
  /** Issue tracking this entry's removal. */
  issue: string;
}

/**
 * Resolve the prior grandfather baseline for the shrink-only ban.
 *
 * Returns `baselineRequired` so the caller can FAIL CLOSED rather than run
 * open: a real Git checkout whose base ref is unavailable must not silently
 * skip the ban (a PR could then add a fresh exception and pass — issue #1990).
 * Synthetic fixtures (temp dirs with no Git work tree) and the PR that first
 * introduces the manifest legitimately have no baseline to compare against.
 */
function readPreviousGrandfatherKeys(
  repoRoot: string,
  grandfatherPath: string,
  baseRef: string,
): { keys: Set<string> | null; baselineRequired: boolean } {
  const relativePath = path.relative(repoRoot, grandfatherPath);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return { keys: null, baselineRequired: false };
  }
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
  // No Git work tree → synthetic fixture / standalone export: nothing to compare.
  if (!insideWorkTree) return { keys: null, baselineRequired: false };

  // A real checkout MUST be able to resolve the base, or the ban is meaningless.
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
    content = execFileSync("git", ["-C", repoRoot, "show", `${base}:${relativePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // The manifest did not exist at the base → this PR introduces it; the
    // initial population is not a "new exception" to ban.
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
        .filter(
          (entry): entry is Partial<GrandfatherEntry> =>
            !!entry && typeof entry === "object" && !Array.isArray(entry),
        )
        .map((entry) => `${entry.kind}:${entry.key}`),
    ),
    baselineRequired: true,
  };
}

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
}

/** Flatten a configSchema into dotted paths + prefixes for arbitrary objects. */
function flattenSchema(schema: JsonSchemaNode): {
  paths: Set<string>;
  opaque: Set<string>;
  arrayPrefixes: Set<string>;
  compositionTolerated: Set<string>;
} {
  const paths = new Set<string>();
  const opaque = new Set<string>();
  const arrayPrefixes = new Set<string>();
  const compositionTolerated = new Set<string>();
  const walk = (node: JsonSchemaNode, prefix: string[], fromAlternative = false): void => {
    // anyOf/oneOf branches are ALTERNATIVE shapes: their declared props are
    // recorded (so a parsed key matching one is schema-covered) but marked
    // composition-tolerated so the dead-schema pass does not demand a parser
    // counterpart. allOf is an INTERSECTION — enforced like normal properties.
    // Opacity is NOT applied to the parent prefix, so a real sibling property of
    // a block that also carries an anyOf branch still surfaces drift (#1990).
    for (const branchName of ["anyOf", "oneOf"]) {
      const branches = node[branchName];
      if (Array.isArray(branches)) {
        for (const branch of branches) {
          if (branch && typeof branch === "object") walk(branch as JsonSchemaNode, prefix, true);
        }
      }
    }
    const allOfBranches = node.allOf;
    if (Array.isArray(allOfBranches)) {
      for (const branch of allOfBranches) {
        if (branch && typeof branch === "object") walk(branch as JsonSchemaNode, prefix, fromAlternative);
      }
    }
    const schemaType = node.type;
    const isObjectType =
      schemaType === "object" || (Array.isArray(schemaType) && schemaType.includes("object"));
    const props = node.properties;
    const addl = node.additionalProperties;
    const isTypedMap =
      isObjectType &&
      !!addl &&
      typeof addl === "object" &&
      !Array.isArray(addl) &&
      !!(addl as JsonSchemaNode).properties;
    // Genuine free-form object (additionalProperties allowed, no declared child
    // shape) → opaque. A typed map flattens its value fields under `*` below.
    if (
      prefix.length > 0 &&
      isObjectType &&
      node.additionalProperties !== false &&
      !props &&
      !isTypedMap
    ) {
      opaque.add(prefix.join("."));
    }
    // Array item objects flatten their declared fields under the array key so
    // item-field drift surfaces (issue #1990 review): `recallPipeline` items
    // declare fields under items.properties → recallPipeline.<field>.
    const isArrayType =
      schemaType === "array" || (Array.isArray(schemaType) && schemaType.includes("array"));
    const items = node.items;
    if (prefix.length > 0 && isArrayType && items && typeof items === "object" && !Array.isArray(items)) {
      arrayPrefixes.add(prefix.join("."));
      walk(items as JsonSchemaNode, prefix, fromAlternative);
    }
    // Map-shaped objects (scopeProfiles / teams) flatten their value fields under
    // a `*` wildcard. Tracked like an array prefix: when the parser never reads
    // the map values statically (dynamic Object.entries), the wildcard paths are
    // skipped in dead-schema rather than false-flagged.
    if (prefix.length > 0 && isTypedMap) {
      arrayPrefixes.add(prefix.join("."));
      walk(addl as JsonSchemaNode, [...prefix, "*"], fromAlternative);
    }
    if (!props || typeof props !== "object") return;
    for (const [key, child] of Object.entries(props)) {
      const keyPath = [...prefix, key].join(".");
      paths.add(keyPath);
      if (fromAlternative) compositionTolerated.add(keyPath);
      if (child && typeof child === "object") walk(child, [...prefix, key], fromAlternative);
    }
  };
  walk(schema, []);
  return { paths, opaque, arrayPrefixes, compositionTolerated };
}

/** A parsed path is schema-covered when declared or absorbed by an arbitrary object. */
function coveredBySchema(keyPath: string, schema: { paths: Set<string>; opaque: Set<string> }): boolean {
  if (schema.paths.has(keyPath)) return true;
  const segments = keyPath.split(".");
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    if (schema.opaque.has(segments.slice(0, i).join("."))) return true;
  }
  return false;
}

function isUnderOpaqueSchema(keyPath: string, schema: { opaque: Set<string> }): boolean {
  const segments = keyPath.split(".");
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    if (schema.opaque.has(segments.slice(0, i).join("."))) return true;
  }
  return false;
}

/**
 * True when a schema item path lives under an array whose items the parser never
 * parses (no parsed key below the array key). Such arrays are pass-through: the
 * parser hands the raw array on and the items are consumed downstream, so their
 * declared item fields are not parser drift and must not be dead-schema-flagged
 * (issue #1990). Arrays whose items ARE parsed (e.g. recallPipeline) keep full
 * dead-schema enforcement so a bogus item property still surfaces.
 */
function isUnderUnparsedArray(
  keyPath: string,
  arrayPrefixes: Set<string>,
  parsedKeys: Set<string>,
): boolean {
  const segments = keyPath.split(".");
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    const ancestor = segments.slice(0, i).join(".");
    if (!arrayPrefixes.has(ancestor)) continue;
    const prefix = `${ancestor}.`;
    const parserParsesItems = [...parsedKeys].some((parsed) => parsed.startsWith(prefix));
    if (!parserParsesItems) return true;
  }
  return false;
}


/** Backticked dotted identifiers mentioned in the docs (array-item `key[].field` → `key.field`). */
function collectDocsKeys(docsText: string): Set<string> {
  const out = new Set<string>();
  const re = /`([A-Za-z_$][\w$]*(?:\[\])?(?:\.[A-Za-z_$][\w$]*(?:\[\])?)*)`/g;
  for (const match of docsText.matchAll(re)) {
    out.add(match[1].replaceAll("[]", ""));
  }
  return out;
}

/**
 * Backticked identifiers grouped by the heading-delimited doc section they
 * appear in. A bare leaf may only document a nested key when the leaf and the
 * key's block co-occur in the SAME section — a generic `enabled` cell under one
 * block must not document `otherBlock.enabled` (issue #1990 review).
 */
function collectDocsSections(docsText: string): Array<Set<string>> {
  const re = /`([A-Za-z_$][\w$]*(?:\[\])?(?:\.[A-Za-z_$][\w$]*(?:\[\])?)*)`/g;
  const sections: Array<Set<string>> = [];
  let current = new Set<string>();
  sections.push(current);
  for (const line of docsText.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      current = new Set<string>();
      sections.push(current);
    }
    for (const match of line.matchAll(re)) {
      const identifier = match[1].replaceAll("[]", "");
      current.add(identifier);
      current.add(identifier.split(".").pop() as string);
    }
  }
  return sections;
}

/**
 * JSON.parse keeps only the last value for a repeated object member, so a
 * doubled `meetings` (or `meetings.*`) schema key would otherwise look unique
 * after parse. Walk the raw text and fail closed on the first duplicate.
 */
export function findFirstDuplicateJsonMember(raw: string): { key: string; path: string } | null {
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  let found: { key: string; path: string } | null = null;
  let aborted = false;

  const skipWs = (): void => {
    while (i < raw.length) {
      const c = raw[i];
      if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") break;
      i += 1;
    }
  };

  const parseString = (): string | null => {
    i += 1;
    let start = i;
    let out = "";
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') {
        out += raw.slice(start, i);
        i += 1;
        return out;
      }
      if (c === "\\") {
        out += raw.slice(start, i);
        i += 1;
        if (i >= raw.length) return null;
        const esc = raw[i];
        i += 1;
        if (esc === "u") {
          const hex = raw.slice(i, i + 4);
          if (hex.length < 4) return null;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "t") out += "\t";
        else if (esc === "b") out += "\b";
        else if (esc === "f") out += "\f";
        else out += esc;
        start = i;
        continue;
      }
      i += 1;
    }
    return null;
  };

  const parseValue = (path: string): void => {
    if (found || aborted) return;
    skipWs();
    if (i >= raw.length) {
      aborted = true;
      return;
    }
    const c = raw[i];
    if (c === "{") {
      parseObject(path);
      return;
    }
    if (c === "[") {
      parseArray(path);
      return;
    }
    if (c === '"') {
      if (parseString() === null) aborted = true;
      return;
    }
    if (raw.startsWith("true", i)) {
      i += 4;
      return;
    }
    if (raw.startsWith("false", i)) {
      i += 5;
      return;
    }
    if (raw.startsWith("null", i)) {
      i += 4;
      return;
    }
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(i));
    if (num) {
      i += num[0].length;
      return;
    }
    aborted = true;
  };

  const parseObject = (path: string): void => {
    i += 1;
    skipWs();
    if (raw[i] === "}") {
      i += 1;
      return;
    }
    const seen = new Set<string>();
    while (i < raw.length && !found && !aborted) {
      skipWs();
      if (raw[i] !== '"') {
        aborted = true;
        return;
      }
      const key = parseString();
      if (key === null) {
        aborted = true;
        return;
      }
      const keyPath = path ? `${path}.${key}` : key;
      if (seen.has(key)) {
        found = { key, path: keyPath };
        return;
      }
      seen.add(key);
      skipWs();
      if (raw[i] !== ":") {
        aborted = true;
        return;
      }
      i += 1;
      parseValue(keyPath);
      if (found || aborted) return;
      skipWs();
      if (raw[i] === "}") {
        i += 1;
        return;
      }
      if (raw[i] === ",") {
        i += 1;
        continue;
      }
      aborted = true;
      return;
    }
  };

  const parseArray = (path: string): void => {
    i += 1;
    skipWs();
    if (raw[i] === "]") {
      i += 1;
      return;
    }
    while (i < raw.length && !found && !aborted) {
      parseValue(path);
      if (found || aborted) return;
      skipWs();
      if (raw[i] === "]") {
        i += 1;
        return;
      }
      if (raw[i] === ",") {
        i += 1;
        continue;
      }
      aborted = true;
      return;
    }
  };

  parseValue("");
  return found;
}


export interface ContractCheckResult {
  violations: ContractViolation[];
  staleGrandfatherEntries: GrandfatherEntry[];
  grandfatheredActive: number;
}

export function runContractCheck(options: {
  repoRoot: string;
  /** Overrides for tests/fixtures. */
  entryFile?: string;
  entryFunction?: string;
  includeFiles?: string[];
  manifestPaths?: string[];
  docsPath?: string;
  grandfatherPath?: string;
  /**
   * Enforce the shrink-only grandfather ban against the Git base (default
   * true). The CLI gate keeps this on; surface-only unit tests that must run
   * in a shallow checkout (no `origin/main`) opt out.
   */
  checkGrandfatherBaseline?: boolean;
  /**
   * Git ref for the shrink-only baseline (default env
   * REMNIC_CONFIG_CONTRACT_BASE_REF ?? "origin/main"). CI sets the PR's actual
   * base branch so a fork whose origin/main predates the manifest cannot skip
   * the ban (issue #1990 review).
   */
  baselineRef?: string;
}): ContractCheckResult {
  const repoRoot = options.repoRoot;
  const manifestPaths = options.manifestPaths ?? [
    path.join(repoRoot, "packages", "plugin-openclaw", "openclaw.plugin.json"),
    path.join(repoRoot, "packages", "shim-openclaw-engram", "openclaw.plugin.json"),
    path.join(repoRoot, "openclaw.plugin.json"),
  ];
  const docsPath = options.docsPath ?? path.join(repoRoot, "docs", "config-reference.md");
  const grandfatherPath =
    options.grandfatherPath ?? path.join(repoRoot, "scripts", "config-contract", "grandfathered.json");

  const hasParserOverride =
    options.entryFile !== undefined ||
    options.entryFunction !== undefined ||
    options.includeFiles !== undefined;
  const extraction = hasParserOverride
    ? extractParsedKeyPaths({
        repoRoot,
        entryFile: options.entryFile ?? path.join(repoRoot, "packages", "remnic-core", "src", "config.ts"),
        entryFunction: options.entryFunction ?? "parseConfig",
        includeFiles: options.includeFiles ?? collectModuleParserFiles(repoRoot),
      })
    : extractRealConfigKeys(repoRoot);
  const parsedKeys = new Set(extraction.keys);

  const schemas = manifestPaths.map((manifestPath) => {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const duplicate = findFirstDuplicateJsonMember(raw);
    if (duplicate) {
      const manifestRel = path.relative(repoRoot, manifestPath).split(path.sep).join("/");
      throw new Error(`${manifestRel}: duplicate JSON member "${duplicate.key}" at ${duplicate.path}`);
    }
    const manifest = JSON.parse(raw) as {
      configSchema?: JsonSchemaNode;
    };
    return {
      manifestPath,
      flat: flattenSchema(manifest.configSchema ?? {}),
    };
  });

  const docsText = fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : "";
  const docsKeys = collectDocsKeys(docsText);
  const docsSections = collectDocsSections(docsText);

  const violations: ContractViolation[] = [];

  // A. Parsed key must be schema-covered in EVERY manifest. Emit one violation
  // per missing manifest, keyed `<key>@<manifest>`, so a path already
  // grandfathered for one manifest does not suppress the same drift newly
  // appearing in another (issue #1990 review).
  for (const key of parsedKeys) {
    for (const schema of schemas) {
      if (coveredBySchema(key, schema.flat)) continue;
      const manifestRel = path.relative(repoRoot, schema.manifestPath).split(path.sep).join("/");
      violations.push({
        kind: "missing-schema",
        key: `${key}@${manifestRel}`,
        detail: `parsed key ${key} absent from configSchema of ${manifestRel}`,
      });
    }
  }

  // B. Dead schema: a schema path must have a parser counterpart at the same
  // path or below it. Matching an arbitrary parsed ancestor is too broad:
  // `block.enabled` must not make a manifest-only `block.typo` appear live.
  // Opaque schema branches absorb their documented properties; closed schema
  // branches still require a parser counterpart for every declared path.
  for (const schema of schemas) {
    const manifestRel = path.relative(repoRoot, schema.manifestPath).split(path.sep).join("/");
    for (const schemaPath of schema.flat.paths) {
      if (isUnderOpaqueSchema(schemaPath, schema.flat)) continue;
      if (isUnderUnparsedArray(schemaPath, schema.flat.arrayPrefixes, parsedKeys)) continue;
      // anyOf/oneOf alternative-shape props: recorded/covered but not required to
      // have a parser counterpart (issue #1990 review).
      if (schema.flat.compositionTolerated.has(schemaPath)) continue;
      const hasParsedCounterpart = [...parsedKeys].some(
        (parsedKey) => parsedKey === schemaPath || parsedKey.startsWith(`${schemaPath}.`),
      );
      if (!hasParsedCounterpart) {
        violations.push({
          kind: "dead-schema",
          key: `${schemaPath}@${manifestRel}`,
          detail: `schema path ${schemaPath} in ${manifestRel} has no corresponding parsed key at this path or below (validator-implementation drift, §40)`,
        });
      }
    }
  }

  const parsedPrefixes = new Set<string>();
  for (const key of parsedKeys) {
    const segments = key.split(".");
    for (let i = 1; i <= segments.length; i++) {
      parsedPrefixes.add(segments.slice(0, i).join("."));
    }
  }

  // C. Docs parity. Only dotted paths whose FIRST segment is a known
  //    top-level config key participate — everything else in backticks is
  //    filenames, host config, or prose (signal over noise).
  const knownTopLevel = new Set<string>();
  for (const key of parsedKeys) knownTopLevel.add(key.split(".")[0]);
  for (const schema of schemas) {
    for (const schemaPath of schema.flat.paths) knownTopLevel.add(schemaPath.split(".")[0]);
  }
  for (const docKey of docsKeys) {
    if (!docKey.includes(".")) continue;
    if (!knownTopLevel.has(docKey.split(".")[0])) continue;
    // An opaque schema block (additionalProperties, no listed children) absorbs
    // any deeper documented path the same way it absorbs parsed ones — don't
    // flag a documented-nonexistent under a legitimately-open block (review).
    if (
      !parsedPrefixes.has(docKey) &&
      !schemas.some((schema) => coveredBySchema(docKey, schema.flat))
    ) {
      violations.push({
        kind: "documented-nonexistent",
        key: docKey,
        detail: "documented in docs/config-reference.md but matches neither parsers nor schema",
      });
    }
  }
  const docsKeyList = [...docsKeys];
  for (const key of parsedKeys) {
    const leaf = key.split(".").pop() as string;
    const topSegment = key.split(".")[0];
    // Documented when: mentioned by full path; implied by a documented
    // DEEPER path (documenting `codingKnowledge.enabled` documents the
    // `codingKnowledge` block); or — for nested keys only — by leaf name
    // WHEN the docs also mention the key's top-level block (review
    // finding: a generic \`enabled\` cell must not document every
    // *.enabled key across unrelated blocks).
    const leafDocumented = docsSections.some(
      (section) => section.has(leaf) && (key === topSegment || section.has(topSegment)),
    );
    const documented =
      docsKeys.has(key) ||
      leafDocumented ||
      docsKeyList.some((docKey) => docKey.startsWith(`${key}.`));
    if (!documented) {
      violations.push({
        kind: "undocumented-key",
        key,
        detail: "parsed key never mentioned in docs/config-reference.md (full path, leaf, or deeper path)",
      });
    }
  }

  // D. Loud unparseables ride the same manifest.
  for (const entry of extraction.unparseable) {
    violations.push({
      kind: "unparseable-construct",
      // Stable construct id (line-independent) so an unrelated edit above the
      // construct does not restyle its grandfather key (issue #1990 review).
      key: entry.id,
      detail: `${entry.file}:${entry.line} — ${entry.reason}`,
    });
  }

  // Deduplicate (kind+key) and sort for determinism (§12).
  const seen = new Set<string>();
  const uniqueViolations = violations
    .filter((violation) => {
      const dedupeKey = `${violation.kind}:${violation.key}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));

  // Grandfather entries are a constrained exception list, not an arbitrary
  // suppression mechanism. Reject unknown violation kinds and empty keys
  // before building the suppression index.
  const validViolationKinds = new Set<ContractViolation["kind"]>([
    "missing-schema",
    "dead-schema",
    "documented-nonexistent",
    "undocumented-key",
    "unparseable-construct",
  ]);
  const rawGrandfathered: unknown = fs.existsSync(grandfatherPath)
    ? JSON.parse(fs.readFileSync(grandfatherPath, "utf8"))
    : [];
  if (!Array.isArray(rawGrandfathered)) {
    throw new Error(`${grandfatherPath}: grandfather manifest must be a JSON array`);
  }
  const grandfathered: GrandfatherEntry[] = rawGrandfathered.map((entry, index) => {
    const candidate = entry as Partial<GrandfatherEntry>;
    if (
      !candidate ||
      !validViolationKinds.has(candidate.kind as ContractViolation["kind"]) ||
      typeof candidate.key !== "string" ||
      candidate.key.trim().length === 0 ||
      typeof candidate.issue !== "string" ||
      candidate.issue.trim().length === 0
    ) {
      throw new Error(
        `${grandfatherPath}[${index}]: grandfather entry must carry { kind, key, issue } with a non-empty tracking issue`,
      );
    }
    return candidate as GrandfatherEntry;
  });

  const baseRef =
    options.baselineRef ?? process.env.REMNIC_CONFIG_CONTRACT_BASE_REF ?? "origin/main";
  const { keys: previousGrandfatherKeys, baselineRequired } =
    options.checkGrandfatherBaseline === false
      ? { keys: null, baselineRequired: false }
      : readPreviousGrandfatherKeys(repoRoot, grandfatherPath, baseRef);
  if (baselineRequired && !previousGrandfatherKeys) {
    throw new Error(
      `${grandfatherPath}: cannot resolve the shrink-only grandfather baseline ` +
        `(git merge-base HEAD ${baseRef}). Fetch the PR base branch so newly added exceptions ` +
        "can be rejected; refusing to run the contract check open.",
    );
  }
  if (previousGrandfatherKeys) {
    for (const [index, entry] of grandfathered.entries()) {
      const entryKey = `${entry.kind}:${entry.key}`;
      if (!previousGrandfatherKeys.has(entryKey)) {
        throw new Error(
          `${grandfatherPath}[${index}]: new grandfather entry ${entryKey} is not allowed; ` +
            "fix the contract drift or remove the exception",
        );
      }
    }
  }

  const grandfatherIndex = new Set(grandfathered.map((entry) => `${entry.kind}:${entry.key}`));
  const activeViolations = uniqueViolations.filter(
    (violation) => !grandfatherIndex.has(`${violation.kind}:${violation.key}`),
  );
  const currentIndex = new Set(uniqueViolations.map((violation) => `${violation.kind}:${violation.key}`));
  const staleGrandfatherEntries = grandfathered.filter(
    (entry) => !currentIndex.has(`${entry.kind}:${entry.key}`),
  );

  return {
    violations: activeViolations,
    staleGrandfatherEntries,
    grandfatheredActive: grandfathered.length - staleGrandfatherEntries.length,
  };
}
