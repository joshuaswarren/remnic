// ---------------------------------------------------------------------------
// Shared importer base (issue #568)
// ---------------------------------------------------------------------------
//
// The importer adapters defined by issue #568 (`@remnic/import-chatgpt`,
// `@remnic/import-claude`, `@remnic/import-gemini`, `@remnic/import-mem0`) all
// follow the same three-step shape:
//
//   1. parse(input)          — turn a raw file / API payload into a
//                              source-specific intermediate structure.
//   2. transform(parsed)     — flatten that structure into a uniform list of
//                              `ImportedMemory` records with provenance
//                              attached (sourceLabel, importedFromPath,
//                              importedAt).
//   3. writeTo(orchestrator) — hand each memory to the orchestrator via
//                              `ingestBulkImportBatch`. Dry-run mode stops
//                              after transform() and never calls writeTo().
//
// This file defines the shared `ImporterAdapter` interface plus a thin
// `runImporter` helper that handles batching, dry-run plan reporting, and
// progress callbacks so every adapter does not reimplement the same loop.
//
// The existing lower-level `BulkImportSourceAdapter` (weclone-shaped: produces
// turn-structured transcripts) remains untouched and continues to drive
// `runBulkImportCliCommand`. Importer adapters are the higher-level surface
// intended for the four memory sources in #568 — they emit *memories*
// (intent-level content) rather than raw conversation turns.

import { validateImportTurn, type ImportTurn } from "../bulk-import/types.js";

/**
 * A single imported memory record with provenance.
 *
 * Every importer MUST attach a truthful `sourceLabel` (e.g. `"chatgpt"`,
 * `"claude"`, `"gemini"`, `"mem0"`) and MAY attach the export's origin path or
 * URL in `importedFromPath`. `importedAt` is always set by `runImporter` so
 * adapters do not need to timestamp records themselves.
 */
export interface ImportedMemory {
  /**
   * The user-facing memory content. This is the string that will eventually
   * land in the memory store (after extraction / orchestrator processing).
   */
  content: string;
  /**
   * Source-specific identifier for idempotent re-imports. Optional — when
   * present, adapters SHOULD use the source's stable id (e.g. ChatGPT memory
   * uuid); when absent, the orchestrator's own content hashing provides dedup.
   */
  sourceId?: string;
  /**
   * Source-specific timestamp at which the memory was originally created or
   * last updated. ISO 8601. Optional — adapters fall back to `importedAt`
   * when the source does not expose a creation timestamp.
   */
  sourceTimestamp?: string;
  /**
   * Human-readable short label identifying the origin platform
   * (`"chatgpt"`, `"claude"`, `"gemini"`, `"mem0"`). Required so the
   * orchestrator can attribute recalled memories correctly.
   */
  sourceLabel: string;
  /**
   * Path to the export file the memory was parsed from, OR the endpoint URL
   * for API-based imports. Optional but strongly recommended so users can
   * trace a memory back to the file they imported.
   */
  importedFromPath?: string;
  /**
   * ISO 8601 timestamp set by `runImporter` immediately before writeTo().
   * Adapters MAY populate this themselves; `runImporter` will fill in the
   * current wall-clock time when absent.
   */
  importedAt?: string;
  /**
   * Adapter-specific raw metadata preserved for debugging / future rehydration
   * (e.g. conversation id, thread id, tags). Must be JSON-serializable;
   * adapters MUST NOT stash functions or circular references here.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Options threaded through every importer run. Adapters receive this object
 * from `runImporter`; the top-level CLI populates it from `--dry-run`,
 * `--batch-size`, and `--rate-limit` flags.
 */
export interface RunImportOptions {
  /**
   * When true, parse + transform but skip writeTo(). `runImporter` prints a
   * summary of what WOULD have been imported and returns early.
   */
  dryRun?: boolean;
  /**
   * Target batch size for writeTo(). Adapters that chunk memories into
   * smaller orchestrator calls should honor this. Defaults to
   * `DEFAULT_IMPORT_BATCH_SIZE` when undefined. Values outside the valid
   * range throw from `validateImportBatchSize`.
   */
  batchSize?: number;
  /**
   * Optional rate limit for API-backed importers (mem0). Expressed as
   * requests-per-second. Adapters that do not hit an external API may ignore
   * this. When provided, `validateImportRateLimit` enforces the positive-
   * finite contract.
   */
  rateLimit?: number;
  /**
   * Invoked after every chunk of memories is processed. `total` is the full
   * count of memories produced by `transform`; `processed` counts memories
   * already ingested (or skipped in dry-run mode). Adapters SHOULD call this
   * incrementally — `runImporter` itself calls it once per batch.
   */
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportProgress {
  processed: number;
  total: number;
  /** Current phase for human-readable logging. */
  phase: "parse" | "transform" | "write" | "dry-run";
}

/**
 * Interface every importer package implements.
 *
 * The three-method surface intentionally mirrors the issue #568 spec:
 *
 *   - `parse(input)`: raw payload → intermediate representation.
 *   - `transform(parsed)`: intermediate representation → `ImportedMemory[]`.
 *   - `writeTo(target, memories, options)`: actually commit to the
 *     orchestrator (or whatever target the host provides).
 *
 * Adapters MAY keep `parse` and `transform` separate (e.g. ChatGPT conversions
 * that need to split saved-memories from conversation summaries) or collapse
 * them into a single operation — what matters is that the combined pipeline
 * produces an array of `ImportedMemory` records with correct provenance.
 *
 * `Parsed` is generic so strongly-typed intermediate shapes survive through
 * the adapter's own code without leaking to callers of `runImporter`.
 */
export interface ImporterAdapter<Parsed = unknown> {
  /** Short stable name used by `remnic import --adapter <name>`. */
  name: string;
  /** Human-readable label surfaced in CLI output and source attribution. */
  sourceLabel: string;

  /**
   * Parse a raw payload (file contents, API response, etc.) into the adapter
   * intermediate representation. Pure — MUST NOT call the orchestrator.
   */
  parse(input: unknown, options?: ImporterParseOptions): Parsed | Promise<Parsed>;

  /**
   * Flatten parsed input into an array of importable memories. Pure — MUST
   * NOT call the orchestrator. Provenance fields (`sourceLabel`,
   * `importedFromPath`) should be populated here.
   */
  transform(parsed: Parsed, options?: ImporterTransformOptions): ImportedMemory[] | Promise<ImportedMemory[]>;

  /**
   * Commit the transformed memories to the orchestrator (or equivalent
   * target). `runImporter` only invokes this when dryRun is false.
   *
   * Adapters typically call `orchestrator.ingestBulkImportBatch` once per
   * batch after converting `ImportedMemory` records into `ImportTurn` shapes.
   */
  writeTo(
    target: ImporterWriteTarget,
    memories: ImportedMemory[],
    options: RunImportOptions,
  ): Promise<ImporterWriteResult>;
}

/**
 * Shape of the "target" passed to `writeTo`.
 *
 * This is intentionally narrower than the full `Orchestrator` class: importer
 * adapters only need to push `ImportTurn[]` batches and read the active
 * bulk-import namespace. Narrowing keeps test doubles simple (the slice-1
 * integration test uses a pure in-memory mock) and prevents adapters from
 * reaching into orchestrator internals that would make them harder to move
 * between host environments.
 */
export interface ImporterWriteTarget {
  ingestBulkImportBatch(
    turns: ImportTurn[],
    options?: { deadlineMs?: number },
  ): Promise<void>;
  bulkImportWriteNamespace?(): string;
}

export interface ImporterWriteResult {
  memoriesIngested: number;
  /** Optional: adapter-surfaced duplicates or skipped entries. */
  skipped?: number;
}

/** Options forwarded to `parse`. Adapter-specific; additive by design. */
export interface ImporterParseOptions {
  strict?: boolean;
  /** Source path passed through for provenance. */
  filePath?: string;
  /**
   * Requests-per-second throttle, forwarded from the top-level
   * `RunImportOptions.rateLimit`. Only meaningful for API-backed importers
   * (mem0) — file-based adapters ignore it. `runImporter` copies this
   * through automatically so CLI users never have to stash it on
   * `parseOptions` themselves. Cursor review on PR #602.
   */
  rateLimit?: number;
}

/** Options forwarded to `transform`. */
export interface ImporterTransformOptions {
  /** When true, adapters that normally skip bulk conversations should include them. */
  includeConversations?: boolean;
  /** Maximum number of memories to emit. Primarily for tests. */
  maxMemories?: number;
  /** Adapter-specific minimum source text length for importers that filter tiny prompts. */
  minPromptLength?: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export const DEFAULT_IMPORT_BATCH_SIZE = 25;
const MIN_IMPORT_BATCH_SIZE = 1;
const MAX_IMPORT_BATCH_SIZE = 500;

/**
 * Coerce and validate the caller-supplied batch size. CLAUDE.md rule 14/51:
 * reject invalid CLI input rather than silently defaulting.
 */
export function validateImportBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_IMPORT_BATCH_SIZE;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `batchSize must be a finite number, received ${String(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new Error(`batchSize must be an integer, received ${value}`);
  }
  if (value < MIN_IMPORT_BATCH_SIZE || value > MAX_IMPORT_BATCH_SIZE) {
    throw new Error(
      `batchSize must be between ${MIN_IMPORT_BATCH_SIZE} and ${MAX_IMPORT_BATCH_SIZE}, ` +
        `received ${value}`,
    );
  }
  return value;
}

/**
 * Validate the `--rate-limit` (requests per second) value used by API
 * importers. Zero / negative / non-finite values throw — the CLI must reject
 * them rather than silently import at unlimited speed.
 */
export function validateImportRateLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `rateLimit must be a finite number (requests per second), received ${String(value)}`,
    );
  }
  if (value <= 0) {
    throw new Error(
      `rateLimit must be greater than 0 (requests per second), received ${value}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Orchestration helpers
// ---------------------------------------------------------------------------

/**
 * Convert an `ImportedMemory` into an `ImportTurn` suitable for
 * `orchestrator.ingestBulkImportBatch`. The resulting turn is always
 * `role="user"` because every downstream source (saved memories, personal
 * context, mem0 entries) represents a first-person statement rather than an
 * assistant response.
 *
 * Keeps provenance on the turn via `participantName` so the extraction
 * pipeline's transcript renderer labels the speaker with the source platform.
 */
export function importedMemoryToTurn(memory: ImportedMemory): ImportTurn {
  const timestamp =
    typeof memory.sourceTimestamp === "string" && memory.sourceTimestamp.length > 0
      ? memory.sourceTimestamp
      : (memory.importedAt ?? new Date().toISOString());
  return {
    role: "user",
    content: memory.content,
    timestamp,
    participantName: memory.sourceLabel,
    ...(memory.sourceId !== undefined ? { participantId: memory.sourceId } : {}),
    importProvenance: {
      sourceLabel: memory.sourceLabel,
      ...(memory.sourceId !== undefined ? { sourceId: memory.sourceId } : {}),
      ...(memory.sourceTimestamp !== undefined ? { sourceTimestamp: memory.sourceTimestamp } : {}),
      ...(memory.importedFromPath !== undefined ? { importedFromPath: memory.importedFromPath } : {}),
      ...(memory.importedAt !== undefined ? { importedAt: memory.importedAt } : {}),
      ...(memory.metadata !== undefined ? { metadata: memory.metadata } : {}),
    },
  };
}

function invalidImportedMemoryError(
  adapterName: string,
  index: number,
  issues: string[],
): Error {
  return new Error(
    `Importer '${adapterName}' produced invalid memory at index ${index}: ${issues.join("; ")}`,
  );
}

function validateImportedMemory(
  memory: ImportedMemory,
  adapterName: string,
  index: number,
): void {
  const issues: string[] = [];
  if (typeof memory.sourceLabel !== "string" || memory.sourceLabel.trim().length === 0) {
    issues.push("sourceLabel must be a non-empty string");
  }
  issues.push(
    ...validateImportTurn(importedMemoryToTurn(memory), index).map(
      (issue) => issue.message,
    ),
  );
  if (issues.length > 0) {
    throw invalidImportedMemoryError(adapterName, index, issues);
  }
}

export interface RunImporterResult {
  adapter: string;
  sourceLabel: string;
  /**
   * Total memories produced by `transform`. In dry-run mode this is the same
   * as the number of memories that WOULD have been written.
   */
  memoriesPlanned: number;
  /**
   * Number of memories actually handed to writeTo(). Always zero in dry-run
   * mode.
   */
  memoriesWritten: number;
  batchesProcessed: number;
  dryRun: boolean;
  /** Mirrors the importedAt stamped on every memory. */
  importedAt: string;
}

/**
 * Orchestrate `parse → transform → writeTo` for an adapter. This is the
 * default pipeline used by the CLI; adapters are free to implement their own
 * orchestration when they need per-record rate-limiting or streaming parses
 * that would not fit in the "produce full array before writing" shape.
 *
 * Mutates the supplied memory records by filling in `importedAt` when the
 * adapter did not set it (CLAUDE.md rule 38: records are written in insertion
 * order to keep the provenance log stable).
 */
export async function runImporter<Parsed>(
  adapter: ImporterAdapter<Parsed>,
  input: unknown,
  target: ImporterWriteTarget,
  options: RunImportOptions & {
    parseOptions?: ImporterParseOptions;
    transformOptions?: ImporterTransformOptions;
  } = {},
): Promise<RunImporterResult> {
  const batchSize = validateImportBatchSize(options.batchSize);
  validateImportRateLimit(options.rateLimit);

  const importedAt = new Date().toISOString();
  const dryRun = options.dryRun === true;
  const onProgress = options.onProgress;

  // Phase 1 — parse. Forward the validated rateLimit so API-backed adapters
  // (mem0) can throttle their own fetches. Caller-supplied parseOptions
  // takes precedence so tests can still override.
  onProgress?.({ processed: 0, total: 0, phase: "parse" });
  const parseOptions: ImporterParseOptions = {
    ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
    ...(options.parseOptions ?? {}),
  };
  const parsed = await adapter.parse(input, parseOptions);

  // Phase 2 — transform
  onProgress?.({ processed: 0, total: 0, phase: "transform" });
  const memoriesRaw = await adapter.transform(parsed, options.transformOptions);
  if (!Array.isArray(memoriesRaw)) {
    throw new Error(
      `Importer '${adapter.name}' transform() returned a non-array. ` +
        "Adapters must produce ImportedMemory[].",
    );
  }
  const memories = memoriesRaw.map((memory, index) => {
    if (memory === null || typeof memory !== "object") {
      throw invalidImportedMemoryError(adapter.name, index, [
        "memory must be an object",
      ]);
    }
    const record = memory as ImportedMemory;
    const sourceLabel =
      typeof record.sourceLabel === "string" && record.sourceLabel.trim().length > 0
        ? record.sourceLabel.trim()
        : adapter.sourceLabel.trim();
    return {
      ...record,
      sourceLabel,
      importedAt: record.importedAt ?? importedAt,
    };
  });
  memories.forEach((memory, index) => validateImportedMemory(memory, adapter.name, index));

  // Phase 3 — write (or dry-run plan)
  if (dryRun) {
    onProgress?.({
      processed: memories.length,
      total: memories.length,
      phase: "dry-run",
    });
    return {
      adapter: adapter.name,
      sourceLabel: adapter.sourceLabel,
      memoriesPlanned: memories.length,
      memoriesWritten: 0,
      batchesProcessed: 0,
      dryRun: true,
      importedAt,
    };
  }

  let batchesProcessed = 0;
  let memoriesWritten = 0;
  for (let i = 0; i < memories.length; i += batchSize) {
    const batch = memories.slice(i, i + batchSize);
    const result = await adapter.writeTo(target, batch, options);
    memoriesWritten += result.memoriesIngested;
    batchesProcessed += 1;
    onProgress?.({
      processed: Math.min(i + batch.length, memories.length),
      total: memories.length,
      phase: "write",
    });
  }

  return {
    adapter: adapter.name,
    sourceLabel: adapter.sourceLabel,
    memoriesPlanned: memories.length,
    memoriesWritten,
    batchesProcessed,
    dryRun: false,
    importedAt,
  };
}

/**
 * Default `writeTo` implementation for importers that want to hand every
 * memory to `orchestrator.ingestBulkImportBatch` without custom routing.
 * Adapters that need per-record rate-limiting or conversation-thread linking
 * are free to implement their own `writeTo`.
 */
export async function defaultWriteMemoriesToOrchestrator(
  target: ImporterWriteTarget,
  memories: ImportedMemory[],
): Promise<ImporterWriteResult> {
  if (memories.length === 0) {
    return { memoriesIngested: 0 };
  }
  memories.forEach((memory, index) =>
    validateImportedMemory(memory, "defaultWriteMemoriesToOrchestrator", index),
  );
  const turns = memories.map(importedMemoryToTurn);
  await target.ingestBulkImportBatch(turns);
  return { memoriesIngested: memories.length };
}
