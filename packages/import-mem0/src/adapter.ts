// ---------------------------------------------------------------------------
// mem0 importer adapter (issue #568 slice 5)
// ---------------------------------------------------------------------------
//
// The mem0 adapter is API-driven rather than file-driven. Two call patterns
// are supported:
//
//   1. CLI: `remnic import --adapter mem0 --rate-limit 2`
//      - No `--file`, so the CLI passes `undefined` as the input.
//      - The adapter reads `MEM0_API_KEY` + optional `MEM0_BASE_URL` from env
//        and walks the paginated API using `fetchAllMem0Memories`.
//
//   2. Record/replay tests: callers pass a JSON string (replay fixture) OR
//      a pre-fetched `Mem0Memory[]` directly via parse. In this mode no
//      network I/O happens.
//
// Adapters are pure by contract (parse MUST NOT call the orchestrator), so
// the API fetch lives in `parse`. This mirrors the file-reading importers
// where parse does the I/O of decoding JSON — here it's HTTP instead.

import type {
  ImportedMemory,
  ImporterAdapter,
  ImporterParseOptions,
  ImporterTransformOptions,
  ImporterWriteResult,
  ImporterWriteTarget,
  RunImportOptions,
} from "@remnic/core";
import { defaultWriteMemoriesToOrchestrator } from "@remnic/core";

import { fetchAllMem0Memories, type Mem0ClientOptions } from "./client.js";
import { parseMem0Export, type ParsedMem0Export } from "./parser.js";
import { MEM0_SOURCE_LABEL, transformMem0Export } from "./transform.js";

/**
 * Test-only backdoor used by `adapter.test.ts` to inject a fake fetch without
 * exposing the ImporterAdapter surface to client-options plumbing at runtime.
 * Cleared after each test.
 */
let overrideClientOptionsForTesting:
  | Partial<Mem0ClientOptions>
  | undefined;

/** Visible for tests. */
export function setMem0ClientOptionsForTesting(
  options: Partial<Mem0ClientOptions> | undefined,
): void {
  overrideClientOptionsForTesting = options;
}

export const adapter: ImporterAdapter<ParsedMem0Export> = {
  name: "mem0",
  sourceLabel: MEM0_SOURCE_LABEL,

  async parse(
    input: unknown,
    options?: ImporterParseOptions,
  ): Promise<ParsedMem0Export> {
    // Replay / in-memory path: caller supplied JSON or an array already.
    if (input !== undefined && input !== null) {
      return parseMem0Export(input, {
        ...(options?.strict !== undefined ? { strict: options.strict } : {}),
        ...(options?.filePath !== undefined
          ? { filePath: options.filePath }
          : {}),
      });
    }

    // Live path: pull from the API.
    const apiKey = overrideClientOptionsForTesting?.apiKey ?? process.env.MEM0_API_KEY;
    if (!apiKey) {
      throw new Error(
        "mem0 import requires an API key. Set MEM0_API_KEY in your environment " +
          "or pass a replay fixture via --file <export.json>.",
      );
    }
    const baseUrl =
      overrideClientOptionsForTesting?.baseUrl ?? process.env.MEM0_BASE_URL;
    // Self-hosted mem0-oss exposes `/memories/` without the `/v1` prefix.
    // Let operators override via MEM0_LIST_PATH so those deployments work
    // without patching. Codex review on PR #602.
    const listPath =
      overrideClientOptionsForTesting?.listPath ?? process.env.MEM0_LIST_PATH;
    const legacyGet =
      overrideClientOptionsForTesting?.legacyGet ??
      parseBooleanEnv(process.env.MEM0_LEGACY_GET);
    const filters =
      overrideClientOptionsForTesting?.filters ?? parseJsonObjectEnv("MEM0_FILTERS", process.env.MEM0_FILTERS);
    const importedFromPath = baseUrl ?? "https://api.mem0.ai";
    // Forward the validated CLI `--rate-limit` (now carried through
    // ImporterParseOptions.rateLimit by runImporter) into the fetch client
    // so `remnic import --adapter mem0 --rate-limit 2` actually throttles.
    // Cursor review on PR #602 — the original wiring silently ignored it.
    const rateLimit =
      typeof options?.rateLimit === "number" ? options.rateLimit : undefined;
    const memories = await fetchAllMem0Memories({
      apiKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(listPath !== undefined ? { listPath } : {}),
      ...(legacyGet !== undefined ? { legacyGet } : {}),
      ...(filters !== undefined ? { filters } : {}),
      ...(rateLimit !== undefined ? { rateLimit } : {}),
      ...(overrideClientOptionsForTesting?.fetchImpl
        ? { fetchImpl: overrideClientOptionsForTesting.fetchImpl }
        : {}),
      ...(overrideClientOptionsForTesting?.sleep
        ? { sleep: overrideClientOptionsForTesting.sleep }
        : {}),
    });
    return { memories, importedFromPath };
  },

  transform(
    parsed: ParsedMem0Export,
    options?: ImporterTransformOptions,
  ): ImportedMemory[] {
    return transformMem0Export(parsed, {
      ...(options?.maxMemories !== undefined
        ? { maxMemories: options.maxMemories }
        : {}),
    });
  },

  async writeTo(
    target: ImporterWriteTarget,
    memories: ImportedMemory[],
    _options: RunImportOptions,
  ): Promise<ImporterWriteResult> {
    return defaultWriteMemoriesToOrchestrator(target, memories);
  },
};

/** Alias kept for symmetry with other @remnic/import-* packages. */
export const mem0Adapter = adapter;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`MEM0_LEGACY_GET must be a boolean-like value, got ${value}`);
}

function parseJsonObjectEnv(name: string, value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`${name} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
