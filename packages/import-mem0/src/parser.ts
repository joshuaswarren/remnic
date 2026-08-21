// ---------------------------------------------------------------------------
// mem0 parser (issue #568 slice 5)
// ---------------------------------------------------------------------------
//
// Unlike the file-based importers, mem0 pulls data directly from an API. The
// "parse" step therefore either:
//
//   1. Accepts an already-fetched `Mem0Memory[]` (the adapter's primary path,
//      after the API client pulls everything down).
//   2. Accepts a JSON string / parsed object for record/replay fixtures so
//      tests and offline flows don't need network access.
//
// Non-object entries are dropped in non-strict mode (CLAUDE.md rule 51
// applies only to user-facing CLI inputs; parser leniency here protects
// against server-side schema drift without crashing the import).

import type { Mem0Memory } from "./client.js";

export interface ParsedMem0Export {
  memories: Mem0Memory[];
  /** Provenance — API endpoint URL or replay fixture path. */
  importedFromPath?: string;
}

export interface Mem0ParseOptions {
  strict?: boolean;
  filePath?: string;
}

/**
 * Parse a mem0 payload. Accepts:
 *   - a `Mem0Memory[]` (already fetched)
 *   - a JSON string
 *   - an object like `{ results: [...] }` or `{ memories: [...] }` or
 *     `{ all_pages: [...] }` (combined replay fixture)
 */
export function parseMem0Export(
  input: unknown,
  options: Mem0ParseOptions = {},
): ParsedMem0Export {
  const raw = coerceJson(input);
  const memories: Mem0Memory[] = [];

  if (Array.isArray(raw)) {
    appendMemories(memories, raw, options);
    return withFilePath(memories, options.filePath);
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    let recognizedTopLevelShape = false;
    for (const key of ["results", "memories", "all_pages"] as const) {
      const v = obj[key];
      if (Array.isArray(v)) {
        recognizedTopLevelShape = true;
        appendMemories(memories, v, options);
      }
    }
    // `pages`: an array of page responses (replay fixture for multi-page
    // pulls). We flatten each page's `results` / `memories`.
    const pages = obj.pages;
    if (Array.isArray(pages)) {
      recognizedTopLevelShape = true;
      for (const page of pages) {
        if (page && typeof page === "object") {
          const p = page as Record<string, unknown>;
          for (const key of ["results", "memories"] as const) {
            const v = p[key];
            if (Array.isArray(v)) appendMemories(memories, v, options);
          }
        }
      }
    }
    if (!recognizedTopLevelShape) {
      throw new Error(
        "mem0 export object must contain a results, memories, all_pages, or pages array",
      );
    }
    return withFilePath(memories, options.filePath);
  }

  throw new Error(
    `mem0 export must be an array or recognized object; received ${describePayloadType(raw)}`,
  );
}

function appendMemories(
  dest: Mem0Memory[],
  src: unknown[],
  options: Mem0ParseOptions,
): void {
  for (const entry of src) {
    if (!entry || typeof entry !== "object") {
      if (options.strict) throw new Error("mem0 entry must be an object");
      continue;
    }
    const record = entry as Mem0Memory;
    if (typeof record.id !== "string" || record.id.length === 0) {
      if (options.strict) throw new Error("mem0 entry missing id");
      continue;
    }
    dest.push(record);
  }
}

function withFilePath(
  memories: Mem0Memory[],
  importedFromPath: string | undefined,
): ParsedMem0Export {
  return {
    memories,
    ...(importedFromPath !== undefined ? { importedFromPath } : {}),
  };
}

function coerceJson(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch (err) {
      throw new Error(
        `mem0 payload is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return input;
}

function describePayloadType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Extract the memory body, preferring explicit `memory` then `content` then `text`. */
export function extractMemoryBody(entry: Mem0Memory): string | undefined {
  for (const candidate of [entry.memory, entry.content, entry.text]) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}
