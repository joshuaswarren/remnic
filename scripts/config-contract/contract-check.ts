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
import { collectModuleParserFiles, extractParsedKeyPaths } from "./extract-parsed-keys.js";

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

function readPreviousGrandfatherKeys(repoRoot: string, grandfatherPath: string): Set<string> | null {
  const relativePath = path.relative(repoRoot, grandfatherPath);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return null;
  try {
    const base = execFileSync("git", ["-C", repoRoot, "merge-base", "HEAD", "origin/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!base) return null;
    const content = execFileSync("git", ["-C", repoRoot, "show", `${base}:${relativePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return null;
    return new Set(
      parsed
        .filter(
          (entry): entry is Partial<GrandfatherEntry> =>
            !!entry && typeof entry === "object" && !Array.isArray(entry),
        )
        .map((entry) => `${entry.kind}:${entry.key}`),
    );
  } catch {
    // Synthetic fixtures and standalone source exports have no Git base.
    return null;
  }
}

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
}

/** Flatten a configSchema into dotted paths + prefixes for arbitrary objects. */
function flattenSchema(schema: JsonSchemaNode): { paths: Set<string>; opaque: Set<string> } {
  const paths = new Set<string>();
  const opaque = new Set<string>();
  const walk = (node: JsonSchemaNode, prefix: string[], fromComposition = false): void => {
    for (const branchName of ["anyOf", "oneOf", "allOf"]) {
      const branches = node[branchName];
      if (Array.isArray(branches)) {
        for (const branch of branches) {
          if (branch && typeof branch === "object") {
            walk(branch as JsonSchemaNode, prefix, true);
          }
        }
      }
    }
    const schemaType = node.type;
    const isObjectType =
      schemaType === "object" || (Array.isArray(schemaType) && schemaType.includes("object"));
    const props = node.properties;
    if (
      prefix.length > 0 &&
      isObjectType &&
      node.additionalProperties !== false &&
      (!props || fromComposition)
    ) {
      opaque.add(prefix.join("."));
    }
    if (!props || typeof props !== "object") return;
    for (const [key, child] of Object.entries(props)) {
      const keyPath = [...prefix, key];
      paths.add(keyPath.join("."));
      if (child && typeof child === "object") walk(child, keyPath);
    }
  };
  walk(schema, []);
  return { paths, opaque };
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


/** Backticked dotted identifiers mentioned in the docs. */
function collectDocsKeys(docsText: string): Set<string> {
  const out = new Set<string>();
  const re = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[A-Za-z_$][\w$]*)`/g;
  for (const match of docsText.matchAll(re)) {
    out.add(match[1]);
  }
  return out;
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

  const extraction = extractParsedKeyPaths({
    repoRoot,
    entryFile: options.entryFile ?? path.join(repoRoot, "packages", "remnic-core", "src", "config.ts"),
    entryFunction: options.entryFunction ?? "parseConfig",
    includeFiles: options.includeFiles ?? collectModuleParserFiles(repoRoot),
  });
  const parsedKeys = new Set(extraction.keys);

  const schemas = manifestPaths.map((manifestPath) => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      configSchema?: JsonSchemaNode;
    };
    return {
      manifestPath,
      flat: flattenSchema(manifest.configSchema ?? {}),
    };
  });

  const docsText = fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : "";
  const docsKeys = collectDocsKeys(docsText);
  const docsLeaves = new Set([...docsKeys].map((key) => key.split(".").pop() as string));

  const violations: ContractViolation[] = [];

  // A. Parsed key must be schema-covered in EVERY manifest.
  for (const key of parsedKeys) {
    const missingFrom = schemas
      .filter((schema) => !coveredBySchema(key, schema.flat))
      .map((schema) => path.relative(repoRoot, schema.manifestPath).split(path.sep).join("/"));
    if (missingFrom.length > 0) {
      violations.push({
        kind: "missing-schema",
        key,
        detail: `parsed key absent from configSchema of: ${missingFrom.join(", ")}`,
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
      const hasParsedCounterpart = [...parsedKeys].some(
        (parsedKey) => parsedKey === schemaPath || parsedKey.startsWith(`${schemaPath}.`),
      );
      if (!hasParsedCounterpart) {
        violations.push({
          kind: "dead-schema",
          key: schemaPath,
          detail: `schema path in ${manifestRel} has no corresponding parsed key at this path or below (validator-implementation drift, §40)`,
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
    const leafDocumented =
      docsLeaves.has(leaf) && (key === topSegment || docsKeys.has(topSegment));
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
      key: `${entry.file}:${entry.line}`,
      detail: entry.reason,
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

  const previousGrandfatherKeys = readPreviousGrandfatherKeys(repoRoot, grandfatherPath);
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
