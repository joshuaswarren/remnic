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
  issue: string;
}

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
    content = execFileSync("git", ["-C", repoRoot, "show", `${base}:${relativePath}`], {
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
    if (
      prefix.length > 0 &&
      isObjectType &&
      node.additionalProperties !== false &&
      !props &&
      !isTypedMap
    ) {
      opaque.add(prefix.join("."));
    }
    const isArrayType =
      schemaType === "array" || (Array.isArray(schemaType) && schemaType.includes("array"));
    const items = node.items;
    if (prefix.length > 0 && isArrayType && items && typeof items === "object" && !Array.isArray(items)) {
      arrayPrefixes.add(prefix.join("."));
      walk(items as JsonSchemaNode, prefix, fromAlternative);
    }
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


function collectDocsKeys(docsText: string): Set<string> {
  const out = new Set<string>();
  const re = /`([A-Za-z_$][\w$]*(?:\[\])?(?:\.[A-Za-z_$][\w$]*(?:\[\])?)*)`/g;
  for (const match of docsText.matchAll(re)) {
    out.add(match[1].replaceAll("[]", ""));
  }
  return out;
}

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

  for (const schema of schemas) {
    const manifestRel = path.relative(repoRoot, schema.manifestPath).split(path.sep).join("/");
    for (const schemaPath of schema.flat.paths) {
      if (isUnderOpaqueSchema(schemaPath, schema.flat)) continue;
      if (isUnderUnparsedArray(schemaPath, schema.flat.arrayPrefixes, parsedKeys)) continue;
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

  const knownTopLevel = new Set<string>();
  for (const key of parsedKeys) knownTopLevel.add(key.split(".")[0]);
  for (const schema of schemas) {
    for (const schemaPath of schema.flat.paths) knownTopLevel.add(schemaPath.split(".")[0]);
  }
  for (const docKey of docsKeys) {
    if (!docKey.includes(".")) continue;
    if (!knownTopLevel.has(docKey.split(".")[0])) continue;
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

  for (const entry of extraction.unparseable) {
    violations.push({
      kind: "unparseable-construct",
      key: entry.id,
      detail: `${entry.file}:${entry.line} — ${entry.reason}`,
    });
  }

  const seen = new Set<string>();
  const uniqueViolations = violations
    .filter((violation) => {
      const dedupeKey = `${violation.kind}:${violation.key}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));

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
