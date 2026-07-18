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

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
}

/** Flatten a configSchema into dotted paths + the set of OPAQUE prefixes. */
function flattenSchema(schema: JsonSchemaNode): { paths: Set<string>; opaque: Set<string> } {
  const paths = new Set<string>();
  const opaque = new Set<string>();
  const walk = (node: JsonSchemaNode, prefix: string[]): void => {
    const props = node.properties;
    if (!props || typeof props !== "object") {
      if (prefix.length > 0) opaque.add(prefix.join("."));
      return;
    }
    for (const [key, child] of Object.entries(props)) {
      const keyPath = [...prefix, key];
      paths.add(keyPath.join("."));
      if (child && typeof child === "object") walk(child, keyPath);
    }
  };
  walk(schema, []);
  return { paths, opaque };
}

/** A parsed path is schema-covered when the schema declares it or an opaque ancestor absorbs it. */
function coveredBySchema(keyPath: string, schema: { paths: Set<string>; opaque: Set<string> }): boolean {
  if (schema.paths.has(keyPath)) return true;
  const segments = keyPath.split(".");
  for (let i = segments.length - 1; i >= 1; i--) {
    const prefix = segments.slice(0, i).join(".");
    if (schema.opaque.has(prefix)) return true;
    // A declared ancestor WITHOUT nested properties also absorbs deeper paths.
    if (schema.paths.has(prefix) && !schema.paths.has(`${prefix}.${segments[i]}`)) {
      // Ancestor exists; whether it absorbs depends on it being opaque —
      // opaque set already covers that. A structured ancestor that simply
      // lacks this child is NOT coverage.
      break;
    }
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

  // B. Dead schema: a schema path whose top segment has no parsed counterpart
  //    at any depth (a structured schema deeper than parser reads is fine —
  //    the parser may hand the block to an opaque consumer). EVERY manifest
  //    participates (review finding: a key added to only one manifest must
  //    not pass because the primary happened to be clean).
  const parsedPrefixes = new Set<string>();
  for (const key of parsedKeys) {
    const segments = key.split(".");
    for (let i = 1; i <= segments.length; i++) {
      parsedPrefixes.add(segments.slice(0, i).join("."));
    }
  }
  for (const schema of schemas) {
    const manifestRel = path.relative(repoRoot, schema.manifestPath).split(path.sep).join("/");
    for (const schemaPath of schema.flat.paths) {
      // Dead when NO parsed key shares ANY ancestor segment — catches a
      // nested entry below an existing structured block that the parser
      // never reads (review finding).
      const segments = schemaPath.split(".");
      let hasParsedAncestor = false;
      for (let i = segments.length; i >= 1; i--) {
        if (parsedPrefixes.has(segments.slice(0, i).join("."))) {
          hasParsedAncestor = true;
          break;
        }
      }
      if (!hasParsedAncestor) {
        violations.push({
          kind: "dead-schema",
          key: schemaPath,
          detail: `schema path in ${manifestRel} has no corresponding parsed key at any depth (validator-implementation drift, §40)`,
        });
      }
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
    if (!docKey.includes(".")) continue; // single identifiers are too noisy — dotted paths only
    if (!knownTopLevel.has(docKey.split(".")[0])) continue;
    if (!parsedPrefixes.has(docKey) && !schemas.some((schema) => schema.flat.paths.has(docKey))) {
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

  // Grandfather manifest (decision C): fails if it grows; stale entries fail.
  const grandfathered: GrandfatherEntry[] = fs.existsSync(grandfatherPath)
    ? (JSON.parse(fs.readFileSync(grandfatherPath, "utf8")) as GrandfatherEntry[])
    : [];
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
