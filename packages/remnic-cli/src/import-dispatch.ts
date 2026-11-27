// `remnic import` command dispatcher (issue #568, slice 1)
//
// This module is the top-level CLI entry for optional memory importers
// (ChatGPT, Claude, Gemini, Mem0, Supermemory). Slice 1 wires ONLY the infrastructure —
// actual source adapters land in follow-up slices and are discovered via the
// computed-specifier loader in `optional-importer.ts`. Running
// `remnic import --adapter chatgpt ...` today will therefore surface a clean
// "optional package not installed" hint rather than a bare MODULE_NOT_FOUND.
//
//   `--flag` without a following value; rule 51 — reject invalid input with
//   a list of valid options instead of silently defaulting):
//
//   --file <path>          Required unless the adapter accepts an API-only
//                          input (mem0). Expanded via ~.
//   --dry-run              Parse + transform only; no writes, no API calls.
//   --batch-size <n>       Memories per orchestrator batch. Rejects non-
//                          integers and values outside [1, 500].
//   --rate-limit <rps>     API-backed importers only. Rejects <= 0.
//   --include-conversations Adapter hint forwarded into transform().
//   --help, -h             Print usage.

import fs from "node:fs";

import {
  runImporter,
  validateImportBatchSize,
  validateImportRateLimit,
  type ImporterAdapter,
  type ImporterWriteTarget,
  type RunImporterResult,
  type RunImportOptions,
  type ImporterParseOptions,
  type ImporterTransformOptions,
} from "@remnic/core";

import {
  detectBundleEntries,
  type DetectedBundleEntry,
} from "./import-bundle-detect.js";
import {
  isSupportedImporterName,
  loadImporterModule,
  SUPPORTED_IMPORTERS,
  type SupportedImporterName,
} from "./optional-importer.js";
import { expandTilde } from "./path-utils.js";
import { readZipEntries } from "./zip-entries.js";

export interface ImportDispatchArgs {
  adapter: SupportedImporterName;
  file?: string;
  dryRun: boolean;
  batchSize?: number;
  rateLimit?: number;
  includeConversations: boolean;
}

/**
 * Separate args struct for `remnic import --all-from-bundle <dir>` (slice 7).
 * Unlike single-adapter mode, bundle mode derives the adapter from files
 * discovered in the directory and does not accept `--adapter`.
 */
export interface ImportBundleArgs {
  bundleDir: string;
  dryRun: boolean;
  batchSize?: number;
  rateLimit?: number;
  includeConversations: boolean;
}

export interface ImportDispatchIO {
  readFile: (path: string) => Promise<string>;
  /** Raw bytes of a file; the ChatGPT importer reads its export ZIP through this. */
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  loadAdapter: (name: SupportedImporterName) => Promise<ImporterAdapter<unknown>>;
  runImporter: typeof runImporter;
  /**
   * Lazy factory for the write target. Called only when the run requires
   * writes (dryRun === false). Keeping it lazy means `--dry-run` and
   * `--help` invocations can complete without booting a full orchestrator
   * — critical for CLI responsiveness and for I/O minimisation.
   *
   * Disposal is the caller's responsibility (see `cmdImport`'s `dispose`
   * parameter). We deliberately do NOT expose `disposeWriteTarget` on the
   * IO interface because `runImportCommand` has no hook to call it — all
   * IO cleanup is owned by `cmdImport`, which tracks whether the target
   * was actually constructed before invoking dispose.
   */
  getWriteTarget: () => Promise<ImporterWriteTarget>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const IMPORT_USAGE = `remnic import — Bring memory from ChatGPT, Claude, Gemini, Mem0, Supermemory, or OKF

Usage:
  remnic import --adapter <name> --file <path> [options]
  remnic import okf <dir> [options]

Required:
  --adapter <name>            One of: ${SUPPORTED_IMPORTERS.join(" | ")}
  --file <path>               Path to a text/JSON source export, or an OKF directory.
                              Archives must be unpacked first.

Options:
  --dry-run                   Parse and transform only; do not write memories.
  --batch-size <n>            Memories per orchestrator batch (default 25).
  --rate-limit <rps>          Requests per second for API importers.
  --include-conversations     Adapter hint: opt into conversation imports
                              (e.g. ChatGPT bulk conversation summaries).
  --help, -h                  Show this help.

Bulk mode (slice 7):
  remnic import --all-from-bundle <dir>
                              Auto-detect ChatGPT / Claude / Takeout /
                              mem0 exports inside <dir> and run each
                              matching adapter. Replaces --adapter/--file.

Install the adapter you need:

  npm install -g @remnic/import-chatgpt
  npm install -g @remnic/import-okf
`;

/**
 * Parse `remnic import ...` flags into a structured args object. Throws with
 * a user-facing message on missing values, unknown adapters, or invalid
 * numeric inputs — callers should catch and print `err.message`.
 *
 * Exported for testability so slice-1 tests can validate the flag contract
 * without booting the full CLI.
 */
export function parseImportArgs(rest: readonly string[]): ImportDispatchArgs {
  const args = [...rest];

  let adapter = takeValue(args, "--adapter");
  if (!adapter && args[0] && !args[0].startsWith("--") && isSupportedImporterName(args[0])) {
    adapter = args.shift() as typeof adapter;
  }
  if (!adapter) {
    throw new Error(
      `--adapter <name> is required. Valid values: ${SUPPORTED_IMPORTERS.join(", ")}`,
    );
  }
  if (!isSupportedImporterName(adapter)) {
    throw new Error(
      `Unknown importer '${adapter}'. Valid values: ${SUPPORTED_IMPORTERS.join(", ")}`,
    );
  }

  // flags. If we consumed boolean flags first via splice, then an argv like
  // `--batch-size --dry-run 10` would first collapse to `--batch-size 10`,
  // silently accepting `10` as the batch-size value — violating rule 14's
  // "bare value flag must be rejected" contract. By taking value flags
  // first, `takeValue` sees the adjacent `--dry-run` token and correctly
  // rejects it as a missing value. Cursor bugbot flagged this on PR #583.
  const fileRaw = takeOptionalValue(args, "--file");
  let file = fileRaw !== undefined ? expandTilde(fileRaw) : undefined;


  const batchSizeRaw = takeOptionalValue(args, "--batch-size");
  let batchSize: number | undefined;
  if (batchSizeRaw !== undefined) {
    const parsed = Number(batchSizeRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `--batch-size must be an integer. Received '${batchSizeRaw}'.`,
      );
    }
    batchSize = validateImportBatchSize(parsed);
  }

  const rateLimitRaw = takeOptionalValue(args, "--rate-limit");
  let rateLimit: number | undefined;
  if (rateLimitRaw !== undefined) {
    const parsed = Number(rateLimitRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `--rate-limit must be a positive number (requests per second). Received '${rateLimitRaw}'.`,
      );
    }
    rateLimit = validateImportRateLimit(parsed);
  }

  // adjacent value tokens, any remaining standalone flags are genuine
  // booleans.
  const dryRun = consumeFlag(args, "--dry-run");
  const includeConversations = consumeFlag(args, "--include-conversations");
  if (file === undefined && args[0] && !args[0].startsWith("--")) {
    file = expandTilde(args.shift() as string);
  }
  rejectLeftoverImportArgs(args, "remnic import");


  return {
    adapter,
    file,
    dryRun,
    batchSize,
    rateLimit,
    includeConversations,
  };
}

function rejectLeftoverImportArgs(args: readonly string[], command: string): void {
  const unknownFlags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (unknownFlags.length > 0 || positional.length > 0) {
    const labels = [
      ...unknownFlags.map((flag) => `flag ${flag}`),
      ...positional.map((arg) => `positional argument '${arg}'`),
    ];
    throw new Error(
      `Unknown argument(s) for '${command}': ${labels.join(", ")}. ` +
        `Run '${command} --help' for the full option list.`,
    );
  }
}

/**
 * Execute `remnic import` given already-parsed args. The IO parameter is
 * injected so tests can assert on the CLI's behaviour without touching the
 * filesystem or loading real importer packages.
 */
export async function runImportCommand(
  args: ImportDispatchArgs,
  io: ImportDispatchIO,
): Promise<RunImporterResult> {
  const chatgptZip = args.adapter === "chatgpt" && !!args.file && isZipFilePath(args.file);
  if (args.file && !chatgptZip && (isZipFilePath(args.file) || /\.(tgz|tar\.gz)$/i.test(args.file))) {
    throw new Error(
      `unpack first: archive imports are not supported ('${args.file}'). Extract the archive, then pass the directory.`,
    );
  }
  const adapter = await io.loadAdapter(args.adapter);

  let input: unknown;
  if (chatgptZip) {
    input = await readChatGPTExportZip(args.file!, io);
  } else if (args.adapter === "okf") {
    if (!args.file) {
      throw new Error("OKF import requires a directory path (remnic import okf <dir>)");
    }
    input = args.file;
  } else if (args.file) {
    try {
      input = await io.readFile(args.file);
    } catch (err) {
      throw new Error(
        `Failed to read --file '${args.file}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    input = undefined;
  }


  const parseOptions: ImporterParseOptions = {
    filePath: args.file,
  };
  const transformOptions: ImporterTransformOptions = {
    includeConversations: args.includeConversations,
  };
  const runOptions: RunImportOptions & {
    parseOptions?: ImporterParseOptions;
    transformOptions?: ImporterTransformOptions;
  } = {
    dryRun: args.dryRun,
    ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
    ...(args.rateLimit !== undefined ? { rateLimit: args.rateLimit } : {}),
    parseOptions,
    transformOptions,
    onProgress: (progress) => {
      if (progress.phase === "write") {
        io.stdout(
          `  progress: ${progress.processed}/${progress.total} memories written`,
        );
      }
    },
  };

  // getWriteTarget() may construct an Orchestrator instance, which opens
  // cache / watcher handles that are wasted work when writes are skipped.
  // Cursor review on PR #583 flagged the non-lazy version.
  let target: ImporterWriteTarget;
  if (args.dryRun) {
    target = dryRunWriteTarget();
  } else {
    target = await io.getWriteTarget();
  }
  const result = await io.runImporter(adapter, input, target, runOptions);

  if (result.dryRun) {
    io.stdout(
      `Dry-run: would import ${result.memoriesPlanned} memories from '${result.sourceLabel}'.`,
    );
    io.stdout("(no memories were written; re-run without --dry-run to commit)");
  } else {
    io.stdout(
      `Imported ${result.memoriesWritten} memories from '${result.sourceLabel}' ` +
        `(${result.batchesProcessed} batch${result.batchesProcessed === 1 ? "" : "es"}).`,
    );
  }
  return result;
}

const CHATGPT_ZIP_KEYS = new Map<string, ChatGPTZipKey>([
  ["memory.json", "memory"],
  ["memories.json", "memories"],
  ["user.json", "user"],
  ["conversations.json", "conversations"],
]);

type ExportJson = string | number | boolean | null | ExportJson[] | { [key: string]: ExportJson };
type ChatGPTZipKey = "memory" | "memories" | "user" | "conversations";
type ChatGPTZipBundle = Partial<Record<ChatGPTZipKey, ExportJson>>;

/**
 * The raw ChatGPT data-export ZIP, read without a manual unzip: the known JSON
 * files (at any depth) become the bundle object the ChatGPT parser accepts.
 */
async function readChatGPTExportZip(file: string, io: ImportDispatchIO): Promise<ChatGPTZipBundle> {
  let bytes: Uint8Array;
  try {
    bytes = await (io.readFileBytes ?? ((p: string) => fs.promises.readFile(p)))(file);
  } catch (err) {
    throw new Error(`Failed to read --file '${file}': ${err instanceof Error ? err.message : String(err)}`);
  }
  const base = (name: string) => name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const entries = readZipEntries(bytes, (name) => CHATGPT_ZIP_KEYS.has(base(name)));
  const bundle: ChatGPTZipBundle = {};
  for (const [name, data] of entries) {
    const key = CHATGPT_ZIP_KEYS.get(base(name));
    if (key === undefined) continue;
    let value: ExportJson;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch (err) {
      throw new Error(`'${name}' in '${file}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    mergeChatGPTZipSection(bundle, key, value);
  }
  if (Object.keys(bundle).length === 0) {
    throw new Error(`'${file}' holds none of ${[...CHATGPT_ZIP_KEYS.keys()].join(", ")}; is it a ChatGPT data export?`);
  }
  return bundle;
}

/**
 * An export file can hold its section directly (memory.json as an array) or
 * wrapped in an object with the same keys the parser reads ({"memory": [...]}).
 * Wrapped sections merge in; a bare value lands under the file's own key.
 */
function mergeChatGPTZipSection(bundle: ChatGPTZipBundle, key: ChatGPTZipKey, value: ExportJson): void {
  if (key === "user" || !(value instanceof Object) || Array.isArray(value)) {
    bundle[key] = value;
    return;
  }
  let merged = false;
  for (const section of CHATGPT_ZIP_KEYS.values()) {
    if (section in value) {
      bundle[section] = value[section];
      merged = true;
    }
  }
  if (!merged) bundle[key] = value;
}

function isZipFilePath(filePath: string): boolean {
  return pathExtension(filePath) === ".zip";
}

function pathExtension(filePath: string): string {
  const normalized = filePath.trim().toLowerCase();
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const base = normalized.slice(lastSlash + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

// ---------------------------------------------------------------------------
// Bundle mode (slice 7): --all-from-bundle <dir>
// ---------------------------------------------------------------------------

/**
 * Parse `remnic import --all-from-bundle <dir> [options]`. Returns a struct
 * with the bundle directory path (tilde-expanded) and the shared import
 * options. Throws with a user-facing error on missing / malformed args.
 *
 * When `--all-from-bundle` is not present in the args, returns `undefined`
 * so the caller can fall back to single-adapter mode.
 */
export function parseImportBundleArgs(
  rest: readonly string[],
): ImportBundleArgs | undefined {
  const args = [...rest];
  if (!args.includes("--all-from-bundle")) return undefined;

  const rawDir = takeValue(args, "--all-from-bundle");
  if (!rawDir) {
    throw new Error(
      "--all-from-bundle <dir> requires a directory path. Example: " +
        "remnic import --all-from-bundle ~/chatgpt-export",
    );
  }
  const bundleDir = expandTilde(rawDir);

  // rather than silently ignoring (CLAUDE.md rule 51).
  for (const incompatible of ["--adapter", "--file"] as const) {
    if (args.includes(incompatible)) {
      throw new Error(
        `${incompatible} is not valid with --all-from-bundle. Use one or the other.`,
      );
    }
  }

  const batchSizeRaw = takeOptionalValue(args, "--batch-size");
  let batchSize: number | undefined;
  if (batchSizeRaw !== undefined) {
    const parsed = Number(batchSizeRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `--batch-size must be an integer. Received '${batchSizeRaw}'.`,
      );
    }
    batchSize = validateImportBatchSize(parsed);
  }

  const rateLimitRaw = takeOptionalValue(args, "--rate-limit");
  let rateLimit: number | undefined;
  if (rateLimitRaw !== undefined) {
    const parsed = Number(rateLimitRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `--rate-limit must be a positive number. Received '${rateLimitRaw}'.`,
      );
    }
    rateLimit = validateImportRateLimit(parsed);
  }

  const dryRun = consumeFlag(args, "--dry-run");
  const includeConversations = consumeFlag(args, "--include-conversations");

  rejectLeftoverImportArgs(args, "remnic import --all-from-bundle");

  return {
    bundleDir,
    dryRun,
    batchSize,
    rateLimit,
    includeConversations,
  };
}

export interface BundleImportOutcome {
  results: RunImporterResult[];
  /** Number of detected entries that threw during their per-file run. */
  failedCount: number;
}

/**
 * Execute a bundle import. For each detected file we run the single-adapter
 * pipeline via `runImportCommand`, accumulating the per-adapter results and
 * returning a summary. Failures on individual entries do NOT abort the
 * remaining imports — each is surfaced to stderr and the walk continues so
 * a bad chatgpt file doesn't block claude + gemini imports that would have
 * succeeded. The return value reports how many entries failed so callers
 * can signal a non-zero exit status to automation (Codex review on
 * PR #610).
 */
export async function runBundleImportCommand(
  args: ImportBundleArgs,
  io: ImportDispatchIO,
  detector: (dir: string) => DetectedBundleEntry[] = detectBundleEntries,
): Promise<BundleImportOutcome> {
  const entries = detector(args.bundleDir);
  if (entries.length === 0) {
    io.stdout(
      `No known exports found in '${args.bundleDir}'. Supported filenames: ` +
        "memory.json, projects.json, conversations.json, My Activity.json, mem0.json.",
    );
    return { results: [], failedCount: 0 };
  }

  io.stdout(
    `Detected ${entries.length} import${entries.length === 1 ? "" : "s"} in '${args.bundleDir}':`,
  );
  for (const entry of entries) {
    io.stdout(`  - ${entry.adapter} → ${entry.filePath}`);
  }

  const results: RunImporterResult[] = [];
  let failedCount = 0;
  for (const entry of entries) {
    io.stdout("");
    io.stdout(`Running '${entry.adapter}' adapter on ${entry.filePath} ...`);
    const perEntryArgs: ImportDispatchArgs = {
      adapter: entry.adapter,
      file: entry.filePath,
      dryRun: args.dryRun,
      ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
      ...(args.rateLimit !== undefined ? { rateLimit: args.rateLimit } : {}),
      // top-level flag overrides when the user passed it explicitly.
      includeConversations:
        args.includeConversations || entry.includeConversations === true,
    };
    try {
      const result = await runImportCommand(perEntryArgs, io);
      results.push(result);
    } catch (err) {
      failedCount += 1;
      io.stderr(
        `  adapter '${entry.adapter}' failed on ${entry.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { results, failedCount };
}

/**
 * Write target used during `--dry-run`. `runImporter` short-circuits before
 * invoking `writeTo`, but adapters may still pass this target around; every
 * method throws to make accidental writes from a dry-run path loud rather
 * than silent.
 */
function dryRunWriteTarget(): ImporterWriteTarget {
  return {
    async ingestBulkImportBatch() {
      throw new Error(
        "dry-run import: ingestBulkImportBatch was called despite dryRun being set. " +
          "Adapters MUST NOT write in dry-run mode.",
      );
    },
    bulkImportWriteNamespace() {
      return "dry-run";
    },
  };
}

/**
 * Top-level CLI entry: `remnic import ...`. Reads `rest` from the CLI switch
 * statement. Uses `process.stdout` / `process.stderr` via the supplied io.
 *
 * `targetFactory` is invoked lazily only for non-dry-run invocations — this
 * keeps `--dry-run` and missing-adapter install-hint paths from spinning up
 * the orchestrator (Cursor review on PR #583).
 */
export async function cmdImport(
  rest: string[],
  targetFactory: () => Promise<ImporterWriteTarget>,
  disposeTarget?: () => Promise<void>,
  ioOverrides: Partial<Pick<ImportDispatchIO, "loadAdapter" | "readFile" | "readFileBytes" | "runImporter">> = {},
): Promise<RunImporterResult | RunImporterResult[] | undefined> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(IMPORT_USAGE);
    return undefined;
  }

  // instead of single-adapter parse. We detect it BEFORE parseImportArgs
  // because `--adapter` is not required in bundle mode.
  let bundleArgs: ImportBundleArgs | undefined;
  try {
    bundleArgs = parseImportBundleArgs(rest);
  } catch (err) {
    process.stderr.write(
      (err instanceof Error ? err.message : String(err)) + "\n",
    );
    process.exitCode = 1;
    return undefined;
  }

  let parsed: ImportDispatchArgs | undefined;
  if (!bundleArgs) {
    try {
      parsed = parseImportArgs(rest);
    } catch (err) {
      process.stderr.write(
        (err instanceof Error ? err.message : String(err)) + "\n",
      );
      process.exitCode = 1;
      return undefined;
    }
  }

  // target construction starts, even if the factory rejects before resolving.
  // An install-hint miss (loadAdapter throws) must NOT trigger dispose —
  // there's nothing to dispose and disposing may itself throw, masking the
  // original error.
  //
  // Cursor review on PR #610 — memoize the materialized target across all
  // calls to `getWriteTarget`. `runBundleImportCommand` invokes
  // `runImportCommand` once per detected bundle entry and each invocation
  // calls `io.getWriteTarget()`. Without memoization a non-singleton
  // `targetFactory` would construct N separate resources while
  // `disposeTarget` only runs once, leaking N-1. The single-construct
  // invariant is now enforced at the io boundary rather than implicitly
  // at the call site.
  let materializedTarget: ImporterWriteTarget | undefined;
  let materializePromise: Promise<ImporterWriteTarget> | undefined;
  const io: ImportDispatchIO = {
    readFile: ioOverrides.readFile ?? (async (p) => fs.promises.readFile(p, "utf-8")),
    readFileBytes: ioOverrides.readFileBytes ?? (async (p) => fs.promises.readFile(p)),
    loadAdapter: ioOverrides.loadAdapter ?? (async (name) => (await loadImporterModule(name)).adapter),
    runImporter: ioOverrides.runImporter ?? runImporter,
    getWriteTarget: async () => {
      if (materializedTarget !== undefined) return materializedTarget;
      if (materializePromise === undefined) {
        materializePromise = Promise.resolve(targetFactory()).then((t) => {
          materializedTarget = t;
          return t;
        });
      }
      return materializePromise;
    },
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
  };

  try {
    if (bundleArgs) {
      const outcome = await runBundleImportCommand(bundleArgs, io);
      // error (so the user sees every failure in one pass), but the
      // process must exit non-zero when any entry failed so shell
      // pipelines (`remnic import --all-from-bundle ... && ...`) don't
      // falsely treat the run as success. Codex review on PR #610.
      if (outcome.failedCount > 0) {
        process.exitCode = 1;
        process.stderr.write(
          `Bundle import completed with ${outcome.failedCount} failed entr${outcome.failedCount === 1 ? "y" : "ies"} (see above).\n`,
        );
      }
      return outcome.results;
    }
    return await runImportCommand(parsed!, io);
  } catch (err) {
    process.stderr.write(
      (err instanceof Error ? err.message : String(err)) + "\n",
    );
    process.exitCode = 1;
    return undefined;
  } finally {
    // `parsed.dryRun` alone would incorrectly dispose after install-hint
    // misses or parse errors that happen BEFORE `getWriteTarget` is called.
    if (materializePromise !== undefined && disposeTarget !== undefined) {
      try {
        await disposeTarget();
      } catch {
        // Best-effort; do not mask import errors.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Argv helpers (local to this file — rule 14: reject bare flags)
// ---------------------------------------------------------------------------

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function takeValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  if (idx + 1 >= args.length) {
    throw new Error(
      `${flag} requires a value. Example: ${flag} <value>`,
    );
  }
  const value = args[idx + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(
      `${flag} requires a value. Example: ${flag} <value>`,
    );
  }
  args.splice(idx, 2);
  return value;
}

function takeOptionalValue(args: string[], flag: string): string | undefined {
  if (!args.includes(flag)) return undefined;
  return takeValue(args, flag);
}
