/**
 * memory-extension-host/host-discovery.ts — Discover third-party memory extensions.
 *
 * Scans a root directory (typically ~/.remnic/memory_extensions/) for valid
 * extension subdirectories. Each extension must contain an instructions.md.
 * The discovery process is read-only and NEVER reads or executes files under
 * any extension's scripts/ directory.
 */

import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { LoggerBackend } from "../logger.js";
import type { PluginConfig } from "../types.js";
import type { DiscoveredExtension, ExtensionSchema } from "./types.js";

/** Total token budget for all discovered extension instructions combined. */
export const REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT = 5_000;

/** Per-extension instructions read cap, using the same 4 chars/token budget heuristic. */
export const REMNIC_EXTENSION_INSTRUCTIONS_BYTE_LIMIT =
  REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT * 4;

/** Optional schemas are metadata only; refuse unusually large schema files. */
export const REMNIC_EXTENSION_SCHEMA_BYTE_LIMIT = 64 * 1024;

/** Maximum number of example files collected per extension. */
const MAX_EXAMPLES_PER_EXTENSION = 10;

/** Slug validation: lowercase letters, digits, hyphens, 1-64 chars. */
const VALID_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const VALID_MEMORY_TYPES = new Set(["fact", "preference", "procedure", "reference"]);

/**
 * Discover all valid memory extensions under the given root directory.
 *
 * Returns extensions sorted by name. Skips entries with warnings when:
 * - The slug is invalid (not lowercase alphanumeric + hyphens, or > 64 chars)
 * - instructions.md is missing
 * - schema.json is malformed (extension still returned but schema is undefined)
 *
 * NEVER reads files under any extension's scripts/ directory.
 */
export async function discoverMemoryExtensions(
  root: string,
  log: Pick<LoggerBackend, "warn" | "debug">,
): Promise<DiscoveredExtension[]> {
  // If root doesn't exist, return empty silently (not even a warning).
  // Use lstat() for root — a symlinked extensions root could redirect
  // discovery to an untrusted directory tree (#428 P2).  When the root
  // IS a symlink, resolve it and verify it still lives under the parent
  // memory directory so that an attacker-controlled symlink can't point
  // discovery at /etc or another user's home.
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    return [];
  }
  if (rootStat.isSymbolicLink()) {
    // Resolve and verify the real path is inside the expected parent.
    let resolved: string;
    try {
      resolved = await realpath(root);
    } catch {
      return [];
    }
    // Normalize the parent path through realpath so that:
    // 1. Relative roots (e.g. "memory_extensions") become absolute (#431 Finding 1)
    // 2. Intermediate symlinks (e.g. macOS /var -> /private/var) are resolved (#431 Finding 2)
    let expectedParent: string;
    try {
      expectedParent = await realpath(path.resolve(path.dirname(root)));
    } catch {
      // Parent directory doesn't exist or is inaccessible — reject.
      return [];
    }
    if (!resolved.startsWith(expectedParent + path.sep) && resolved !== expectedParent) {
      log.warn?.(
        `[memory-extensions] root "${root}" is a symlink resolving outside the expected parent directory, skipping`,
      );
      return [];
    }
    // Re-check the resolved path is a directory.
    try {
      rootStat = await lstat(resolved);
    } catch {
      return [];
    }
  }
  if (!rootStat.isDirectory()) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const extensions: DiscoveredExtension[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry);

    // Must be a real directory (not a symlink) — lstat() blocks symlink
    // traversal that could escape the extensions root (#382 P2).
    let entryStat;
    try {
      entryStat = await lstat(entryPath);
    } catch {
      continue;
    }
    if (entryStat.isSymbolicLink()) {
      log.warn?.(
        `[memory-extensions] skipping "${entry}": symlinks are not followed for security`,
      );
      continue;
    }
    if (!entryStat.isDirectory()) continue;

    // Validate slug
    if (!VALID_SLUG_RE.test(entry)) {
      log.warn?.(
        `[memory-extensions] skipping "${entry}": invalid slug (must be lowercase alphanumeric + hyphens, 1-64 chars)`,
      );
      continue;
    }

    // Require instructions.md — reject symlinked files (#428 P1)
    const instructionsPath = path.join(entryPath, "instructions.md");
    if (await isSymlink(instructionsPath)) {
      log.warn?.(
        `[memory-extensions] skipping "${entry}": instructions.md is a symlink`,
      );
      continue;
    }
    let instructions: string;
    try {
      instructions = await readUtf8FileWithinLimit(
        instructionsPath,
        REMNIC_EXTENSION_INSTRUCTIONS_BYTE_LIMIT,
      );
    } catch (err) {
      const reason = err instanceof FileTooLargeError
        ? `instructions.md exceeds ${REMNIC_EXTENSION_INSTRUCTIONS_BYTE_LIMIT} bytes`
        : "missing instructions.md";
      log.warn?.(`[memory-extensions] skipping "${entry}": ${reason}`);
      continue;
    }

    // Read optional schema.json — reject symlinked files (#428 P1)
    let schema: ExtensionSchema | undefined;
    const schemaPath = path.join(entryPath, "schema.json");
    if (await isSymlink(schemaPath)) {
      log.warn?.(
        `[memory-extensions] "${entry}": schema.json is a symlink, ignoring schema`,
      );
    } else {
      try {
        const schemaRaw = await readUtf8FileWithinLimit(
          schemaPath,
          REMNIC_EXTENSION_SCHEMA_BYTE_LIMIT,
        );
        const parsed = JSON.parse(schemaRaw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          schema = validateSchema(parsed);
        } else {
          log.warn?.(
            `[memory-extensions] "${entry}": schema.json is not a valid object, ignoring schema`,
          );
        }
      } catch (err) {
        // File doesn't exist → fine, no warning needed
        if (isFileNotFoundError(err)) {
          // schema remains undefined
        } else if (err instanceof FileTooLargeError) {
          log.warn?.(
            `[memory-extensions] "${entry}": schema.json exceeds ${REMNIC_EXTENSION_SCHEMA_BYTE_LIMIT} bytes, ignoring schema`,
          );
        } else {
          log.warn?.(
            `[memory-extensions] "${entry}": malformed schema.json, ignoring schema`,
          );
        }
      }
    }

    // Collect examples/*.md (cap at MAX_EXAMPLES_PER_EXTENSION)
    // NEVER read from scripts/ directory
    const examplesPaths: string[] = [];
    const examplesDir = path.join(entryPath, "examples");
    try {
      const examplesStat = await lstat(examplesDir);
      if (examplesStat.isSymbolicLink()) {
        log.warn?.(
          `[memory-extensions] "${entry}": examples/ is a symlink, ignoring examples`,
        );
        throw new Error("skip symlinked examples directory");
      }
      if (!examplesStat.isDirectory()) {
        throw new Error("skip non-directory examples path");
      }
      const exampleEntries = await readdir(examplesDir);
      const mdFiles = exampleEntries
        .filter((f) => f.endsWith(".md"))
        .sort()
        .slice(0, MAX_EXAMPLES_PER_EXTENSION);
      for (const f of mdFiles) {
        const examplePath = path.join(examplesDir, f);
        const exampleStat = await lstat(examplePath);
        if (exampleStat.isSymbolicLink()) {
          log.warn?.(
            `[memory-extensions] "${entry}": examples/${f} is a symlink, ignoring example`,
          );
          continue;
        }
        if (!exampleStat.isFile()) {
          continue;
        }
        examplesPaths.push(examplePath);
      }
    } catch {
      // No examples dir — fine
    }

    extensions.push({
      name: entry,
      root: entryPath,
      instructionsPath,
      instructions,
      schema,
      examplesPaths,
    });
  }

  // Sort by name for deterministic ordering
  extensions.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

  return extensions;
}

class FileTooLargeError extends Error {
  constructor(filePath: string, limitBytes: number, actualBytes: number) {
    super(`${filePath} is ${actualBytes} bytes; limit is ${limitBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

async function readUtf8FileWithinLimit(filePath: string, limitBytes: number): Promise<string> {
  const stat = await lstat(filePath);
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
  if (stat.size > limitBytes) {
    throw new FileTooLargeError(filePath, limitBytes, stat.size);
  }
  return readFile(filePath, "utf-8");
}

function validateSchema(raw: Record<string, unknown>): ExtensionSchema {
  const memoryTypes: ExtensionSchema["memoryTypes"] = (() => {
    if (!Array.isArray(raw.memoryTypes)) return undefined;
    const valid = raw.memoryTypes.filter(
      (t): t is "fact" | "preference" | "procedure" | "reference" =>
        typeof t === "string" && VALID_MEMORY_TYPES.has(t),
    );
    return valid.length > 0 ? valid : undefined;
  })();

  const groupingHints: ExtensionSchema["groupingHints"] = (() => {
    if (!Array.isArray(raw.groupingHints)) return undefined;
    const valid = raw.groupingHints.filter(
      (h): h is string => typeof h === "string" && h.length > 0,
    );
    return valid.length > 0 ? valid : undefined;
  })();

  const version: ExtensionSchema["version"] =
    typeof raw.version === "string" && raw.version.length > 0
      ? raw.version
      : undefined;

  return {
    ...(memoryTypes ? { memoryTypes } : {}),
    ...(groupingHints ? { groupingHints } : {}),
    ...(version ? { version } : {}),
  };
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

/**
 * Returns true if the path exists and is a symlink.
 * Returns false if the path does not exist or is not a symlink.
 */
async function isSymlink(filePath: string): Promise<boolean> {
  try {
    const s = await lstat(filePath);
    return s.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve the memory extensions root directory from config.
 * If memoryExtensionsRoot is empty, derive from memoryDir by going up to
 * the Remnic home dir and appending memory_extensions.
 *
 * Moved here from semantic-consolidation.ts (#428 Finding 3) because this
 * is a generic config-to-path resolver with no consolidation logic.
 */
export function resolveExtensionsRoot(config: PluginConfig): string {
  if (config.memoryExtensionsRoot.length > 0) {
    return config.memoryExtensionsRoot;
  }
  // Default: memoryDir is typically ~/.openclaw/workspace/memory/local
  // Go up to the parent that owns the memory tree and append memory_extensions
  return path.join(path.dirname(config.memoryDir), "memory_extensions");
}
