import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { expandTildePath } from "../utils/path.js";
import { getLocalSessionSourceAdapter, listLocalSessionSourceAdapters } from "./adapters.js";
import { compileRedactionRules, redactSessionSummaryText } from "./redaction.js";
import type {
  CollectLocalSessionSummariesOptions,
  CompiledRedactionRule,
  LocalSessionRole,
  LocalSessionSummaryCliOptions,
  LocalSessionSummaryReport,
  LocalSessionTurn,
  RedactionConfig,
  SessionSummaryDraft,
  SessionSummaryExcerpt,
} from "./types.js";

export * from "./adapters.js";
export * from "./redaction.js";
export * from "./types.js";

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_SESSIONS = 500;
const SUPPORTED_EXTENSIONS = new Set([".json", ".jsonl"]);

function shortHash(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function listTranscriptFiles(root: string, maxFiles: number): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = [];
  let truncated = false;
  const entrySortKey = (entryName: string, isDirectory: boolean): string => (isDirectory ? `${entryName}${path.sep}` : entryName);
  async function visit(dir: string): Promise<void> {
    if (truncated) return;
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      entrySortKey(a.name, a.isDirectory()).localeCompare(entrySortKey(b.name, b.isDirectory()))
    );
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      out.push(fullPath);
      if (out.length > maxFiles) {
        truncated = true;
        return;
      }
    }
  }
  await visit(root);
  const sorted = out.sort();
  return {
    files: sorted.slice(0, maxFiles),
    truncated,
  };
}

function validatePositiveInt(value: number | undefined, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeInputDir(inputDir: string): string {
  if (typeof inputDir !== "string" || inputDir.trim().length === 0) {
    throw new Error("inputDir must be a non-empty string");
  }
  return path.resolve(expandTildePath(inputDir.trim()));
}

function initRoleCounts(): Record<LocalSessionRole, number> {
  return {
    user: 0,
    assistant: 0,
    tool: 0,
    system: 0,
    other: 0,
  };
}

function safeTimestampSortValue(turn: LocalSessionTurn): number {
  if (!turn.timestamp) return Number.MAX_SAFE_INTEGER;
  const millis = Date.parse(turn.timestamp);
  return Number.isFinite(millis) ? millis : Number.MAX_SAFE_INTEGER;
}

function earliestTurnSortValue(turns: readonly LocalSessionTurn[]): number {
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const turn of turns) {
    const value = safeTimestampSortValue(turn);
    if (value < earliest) earliest = value;
  }
  return earliest;
}

function truncateExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function mergeRuleNames(target: Set<string>, names: readonly string[]): void {
  for (const name of names) target.add(name);
}

function buildDraft(options: {
  source: string;
  sessionKey: string;
  turns: Array<LocalSessionTurn & { fileHash: string; fileExtension: string }>;
  generatedAt: string;
  redactionRules: readonly CompiledRedactionRule[];
  includeRedactedExcerpts: boolean;
}): SessionSummaryDraft {
  const sortedTurns = [...options.turns].sort((a, b) => safeTimestampSortValue(a) - safeTimestampSortValue(b));
  const roles = initRoleCounts();
  const fileRefs = new Map<string, string>();
  let redactionApplied = 0;
  const redactionRuleNames = new Set<string>();
  const excerpts: SessionSummaryExcerpt[] = [];

  for (const turn of sortedTurns) {
    roles[turn.role] += 1;
    fileRefs.set(turn.fileHash, turn.fileExtension);
    const redacted = redactSessionSummaryText(turn.content, options.redactionRules);
    redactionApplied += redacted.report.applied;
    mergeRuleNames(redactionRuleNames, redacted.report.ruleNames);
    if (options.includeRedactedExcerpts && excerpts.length < 5) {
      excerpts.push({
        role: turn.role,
        text: truncateExcerpt(redacted.text),
        ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
      });
    }
  }

  const firstTimestamp = sortedTurns.find((turn) => turn.timestamp)?.timestamp;
  const lastTimestamp = [...sortedTurns].reverse().find((turn) => turn.timestamp)?.timestamp;
  const sourceSessionRef = shortHash(options.sessionKey);
  const sourceFileRefs = [...fileRefs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hash, extension]) => ({ hash, extension }));
  const dateText = firstTimestamp && lastTimestamp ? ` from ${firstTimestamp} to ${lastTimestamp}` : "";
  const summary =
    `Local AI session summary: ${sortedTurns.length} turn(s)` +
    ` (${roles.user} user, ${roles.assistant} assistant, ${roles.tool} tool, ${roles.system} system, ${roles.other} other)` +
    `${dateText}. Raw transcript text, source session keys, and local file paths are not stored.`;

  return {
    schemaVersion: 1,
    draftId: shortHash(
      JSON.stringify({
        source: options.source,
        sourceSessionRef,
        firstTimestamp,
        lastTimestamp,
        turnCount: sortedTurns.length,
      }),
      24
    ),
    generatedAt: options.generatedAt,
    sourceAdapter: options.source,
    sourceSessionRef,
    sourceFileCount: sourceFileRefs.length,
    sourceFileRefs,
    ...(firstTimestamp ? { firstTimestamp } : {}),
    ...(lastTimestamp ? { lastTimestamp } : {}),
    turnCount: sortedTurns.length,
    roles,
    summary,
    redaction: {
      enabled: options.redactionRules.length > 0,
      applied: redactionApplied,
      ruleNames: [...redactionRuleNames].sort(),
    },
    ...(options.includeRedactedExcerpts && excerpts.length > 0 ? { excerpts } : {}),
    metadata: {
      storesRawTranscript: false,
      storesLocalPaths: false,
      storesSourceSessionKey: false,
    },
  };
}

export async function collectLocalSessionSummaries(
  options: CollectLocalSessionSummariesOptions
): Promise<LocalSessionSummaryReport> {
  const inputDir = normalizeInputDir(options.inputDir);
  const inputLstat = await lstat(inputDir);
  if (inputLstat.isSymbolicLink()) {
    throw new Error(`inputDir must not be a symbolic link: ${options.inputDir}`);
  }
  const inputStat = await stat(inputDir);
  if (!inputStat.isDirectory()) {
    throw new Error(`inputDir must be a directory: ${options.inputDir}`);
  }

  const source = options.source?.trim() || "generic-jsonl";
  const adapter = getLocalSessionSourceAdapter(source);
  if (!adapter) {
    throw new Error(
      `Unknown local session source '${source}'. Valid sources: ${listLocalSessionSourceAdapters().join(", ")}`
    );
  }

  const maxFiles = validatePositiveInt(options.maxFiles, "maxFiles", DEFAULT_MAX_FILES);
  const maxSessions = validatePositiveInt(options.maxSessions, "maxSessions", DEFAULT_MAX_SESSIONS);
  const redactionConfig = options.redactionConfig ?? {};
  const excerptsRequested = options.includeRedactedExcerpts === true;
  const redactionRules = compileRedactionRules({
    ...redactionConfig,
    ...(excerptsRequested ? { disableDefaults: false } : {}),
  });
  const includeRedactedExcerpts = options.includeRedactedExcerpts === true && redactionRules.length > 0;
  const listed = await listTranscriptFiles(inputDir, maxFiles);
  const files = listed.files;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const warnings: LocalSessionSummaryReport["warnings"] = [];
  const sessions = new Map<string, Array<LocalSessionTurn & { fileHash: string; fileExtension: string }>>();
  const seenFileHashes = new Set<string>();
  let turnsParsed = 0;
  let filesParsed = 0;

  if (listed.truncated) {
    warnings.push({
      code: "session-summaries.max_files_truncated",
      message: `Scanned the first ${maxFiles} transcript file(s); increase maxFiles to include all matching files.`,
    });
  }
  if (excerptsRequested && redactionConfig.disableDefaults === true) {
    warnings.push({
      code: "session-summaries.default_redaction_forced_for_excerpts",
      message: "Default redaction rules were enabled because redacted excerpts were requested.",
    });
  }
  if (excerptsRequested && redactionRules.length === 0) {
    warnings.push({
      code: "session-summaries.excerpts_suppressed_no_redaction",
      message: "Redacted excerpts were requested, but no redaction rules are enabled; excerpts were omitted.",
    });
  }

  for (const filePath of files) {
    const content = await readFile(filePath, "utf-8");
    const fileHash = shortHash(content, 24);
    if (seenFileHashes.has(fileHash)) {
      warnings.push({
        code: "session-summaries.duplicate_file_skipped",
        message: "Skipped a duplicate transcript file with identical content.",
        fileRef: fileHash,
      });
      continue;
    }
    seenFileHashes.add(fileHash);
    const fileExtension = path.extname(filePath).toLowerCase();
    const parsed = await adapter.parseFile(
      {
        content,
        fileName: path.basename(filePath),
        fileExtension,
        fileRef: fileHash,
      },
      { strict: options.strict }
    );
    warnings.push(...parsed.warnings);
    if (parsed.turns.length === 0) continue;
    filesParsed += 1;
    for (const turn of parsed.turns) {
      turnsParsed += 1;
      const sessionKey = turn.sessionKey?.trim() || `${adapter.id}:${fileHash}`;
      const bucket = sessions.get(sessionKey) ?? [];
      bucket.push({ ...turn, fileHash, fileExtension });
      sessions.set(sessionKey, bucket);
    }
  }

  const drafts: SessionSummaryDraft[] = [];
  const sessionEntries = [...sessions.entries()].sort(([aKey, a], [bKey, b]) => {
    const aFirst = earliestTurnSortValue(a);
    const bFirst = earliestTurnSortValue(b);
    return aFirst - bFirst || a[0]?.fileHash.localeCompare(b[0]?.fileHash ?? "") || aKey.localeCompare(bKey);
  });
  if (sessionEntries.length > maxSessions) {
    warnings.push({
      code: "session-summaries.max_sessions_truncated",
      message: `Summarized ${maxSessions} of ${sessionEntries.length} session(s); increase maxSessions to include all parsed sessions.`,
    });
  }
  for (const [sessionKey, turns] of sessionEntries.slice(0, maxSessions)) {
    drafts.push(
      buildDraft({
        source: adapter.id,
        sessionKey,
        turns,
        generatedAt,
        redactionRules,
        includeRedactedExcerpts,
      })
    );
  }
  drafts.sort((a, b) => (a.firstTimestamp ?? "").localeCompare(b.firstTimestamp ?? ""));

  return {
    generatedAt,
    source: adapter.id,
    filesScanned: files.length,
    filesParsed,
    turnsParsed,
    sessionsSummarized: drafts.length,
    warnings,
    drafts,
    wroteFiles: [],
  };
}

async function readRedactionConfig(pathLike: string | undefined): Promise<RedactionConfig | undefined> {
  if (!pathLike) return undefined;
  const raw = await readFile(path.resolve(expandTildePath(pathLike)), "utf-8");
  const parsed = JSON.parse(raw) as RedactionConfig;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("redaction config must be a JSON object");
  }
  return parsed;
}

function toJsonl(drafts: readonly SessionSummaryDraft[]): string {
  return `${drafts.map((draft) => JSON.stringify(draft)).join("\n")}\n`;
}

function defaultDraftOutputPath(memoryDir: string, generatedAt: string): string {
  const stamp = generatedAt.replace(/[:.]/g, "-");
  return path.join(
    path.resolve(expandTildePath(memoryDir)),
    "state",
    "session-summary-drafts",
    `session-summaries-${stamp}.jsonl`
  );
}

async function writeDrafts(filePath: string, drafts: readonly SessionSummaryDraft[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, toJsonl(drafts), "utf-8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function runLocalSessionSummaryCliCommand(
  options: LocalSessionSummaryCliOptions
): Promise<LocalSessionSummaryReport> {
  const redactionConfig = options.redactionConfig ?? (await readRedactionConfig(options.redactionConfigPath));
  const report = await collectLocalSessionSummaries({
    ...options,
    ...(redactionConfig ? { redactionConfig } : {}),
  });
  const wroteFiles: string[] = [];

  if (options.output) {
    const outputPath = path.resolve(expandTildePath(options.output));
    await writeDrafts(outputPath, report.drafts);
    wroteFiles.push(outputPath);
  }

  if (options.write === true) {
    if (!options.memoryDir || options.memoryDir.trim().length === 0) {
      throw new Error("memoryDir is required when write is true");
    }
    const outputPath = defaultDraftOutputPath(options.memoryDir, report.generatedAt);
    await writeDrafts(outputPath, report.drafts);
    wroteFiles.push(outputPath);
  }

  const stdout = options.stdout;
  if (stdout) {
    stdout.write(`Local session summaries complete (source: ${report.source})\n`);
    stdout.write(`  Files scanned:        ${report.filesScanned}\n`);
    stdout.write(`  Files parsed:         ${report.filesParsed}\n`);
    stdout.write(`  Turns parsed:         ${report.turnsParsed}\n`);
    stdout.write(`  Sessions summarized:  ${report.sessionsSummarized}\n`);
    stdout.write(`  Draft files written:  ${wroteFiles.length}\n`);
    if (wroteFiles.length === 0) {
      stdout.write("  (dry run - no Remnic draft files were written)\n");
    }
  }

  return { ...report, wroteFiles };
}
