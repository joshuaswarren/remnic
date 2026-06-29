import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import { displayErrorDetail } from "./runtime/better-sqlite.js";
import { parseSessionIdentity, sessionStoragePaths } from "./session-identity.js";
import { resolveSafeStoragePath } from "./storage-paths.js";
import type { TranscriptEntry } from "./types.js";

/**
 * Lossless migration of legacy `transcripts/other/default/*.jsonl` files into
 * first-class `transcripts/session/<hash>/*.jsonl` directories (issue #1496).
 *
 * Older builds routed every non-legacy session key (e.g. `pi-geek:abc123`)
 * into the shared `other/default` directory on first write. That conflated
 * distinct standalone-client sessions into one transcript directory. This
 * migration splits those mixed files back out, grouping entries by
 * `entry.sessionKey` and re-homing each distinct session under its own
 * deterministic hashed directory.
 *
 * Safety contract (rules #54, #51, #18, #35):
 *   - Dry-run is the default; nothing is written without `apply: true`.
 *   - Writes go to a temp file then atomic-rename (never delete-before-write).
 *   - JSONL line ordering and byte content are preserved per session.
 *   - Idempotent: re-running after apply finds nothing left to migrate.
 *   - A manifest is returned (and written under `state/` on apply) as an audit
 *     trail.
 */

/**
 * Channel type that NEW writes use for first-class arbitrary keys. Subdirs of
 * this type whose `<id>` is a canonical `storagePathHash` (16 lowercase hex)
 * are already homed — every line there is, by definition, already in its
 * destination directory, so they are never migration sources.
 */
const FIRST_CLASS_CHANNEL_TYPE = "session";

/**
 * Matches a canonical `session/<hash>` channel id produced by
 * {@link storagePathHash} (16 lowercase hex chars). Used to tell a NEW
 * first-class directory (skip) apart from a LEGACY `session/<name>` directory.
 *
 * Pre-#1496 the OLD `parts.length >= 3` parser stored a key whose 3rd colon
 * segment was literally `session` (e.g. `foo:bar:session:baz`) under
 * `transcripts/session/baz` — a non-hash id. Those legacy dirs MUST still be
 * scanned and split, while genuine `session/<hash>` data is left untouched
 * (codex review on PR #1496 / PR #1504). The hex length is fixed because
 * `storagePathHash` slices the sha256 hex digest to 16 chars.
 */
const CANONICAL_SESSION_HASH_RE = /^[0-9a-f]{16}$/;

/**
 * True when `<type>/<id>` is a canonical first-class `session/<hash>` directory
 * (NEW write target) rather than a legacy stranded directory. Defensive: also
 * confirms the id is exactly what `storagePathHash` would produce for some
 * value by shape — a 16-hex string — so we never misclassify a legacy
 * `session/<name>` dir as homed and skip migrating it.
 */
function isCanonicalSessionDir(channelType: string, channelId: string): boolean {
  return channelType === FIRST_CLASS_CHANNEL_TYPE && CANONICAL_SESSION_HASH_RE.test(channelId);
}

export interface SessionMigrationEntryGroup {
  /** The distinct session key these lines belong to. */
  sessionKey: string;
  /** Whether this key is a recognized legacy `agent:<id>:...` shape. */
  legacy: boolean;
  /** Destination directory (relative to the transcripts root). */
  destDir: string;
  /** Number of JSONL entries that will move. */
  entryCount: number;
}

export interface SessionMigrationFilePlan {
  /** Source file path (relative to transcripts root). */
  sourceRelPath: string;
  /** The date-stamped file name (e.g. `2026-06-29.jsonl`). */
  fileName: string;
  /** Distinct session groups discovered inside this source file. */
  groups: SessionMigrationEntryGroup[];
  /** Lines that could not be parsed as JSON or lacked a sessionKey. */
  unmovableLines: number;
  /**
   * True when EVERY entry in the file already belongs in the source directory
   * (nothing to do). Such files are skipped.
   */
  alreadyHomed: boolean;
}

export interface SessionMigrationPlan {
  generatedAt: string;
  dryRun: boolean;
  transcriptsDir: string;
  /** Per-file plans that have at least one entry to move. */
  files: SessionMigrationFilePlan[];
  /** Distinct destination session keys across all files. */
  distinctSessions: number;
  /** Total entries that will be re-homed. */
  movedEntries: number;
}

export interface SessionMigrationResult {
  plan: SessionMigrationPlan;
  applied: boolean;
  filesRewritten: number;
  filesRemoved: number;
  errors: string[];
  manifestPath?: string;
}

export interface MigrateSessionTranscriptsOptions {
  /** The memory directory root (transcripts live under `<memoryDir>/transcripts`). */
  memoryDir: string;
  /** When true, perform the migration; otherwise produce a dry-run plan only. */
  apply?: boolean;
}

const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function isDateStampedJsonl(name: string): boolean {
  return DATE_FILE_RE.test(name);
}

/**
 * Candidate source directories that older builds may have used to conflate or
 * misroute arbitrary sessions. We scan `transcripts/<type>/<id>/` two levels
 * deep and consider any directory EXCEPT the first-class `session/<hash>` tree
 * (whose contents are already homed). This covers:
 *
 *   - the shared `other/default` fallback every arbitrary key once landed in;
 *   - the OLD `parts.length >= 3` parser's directories (e.g. `foo:bar:baz` →
 *     `baz/default`, `foo:bar:baz:qux` → `baz/qux`), which the pre-#1496 build
 *     wrote even for non-`agent:` keys (Thread B / codex review on PR #1504).
 *
 * `planFile` is the actual gate: a line is only moved when its session key now
 * resolves to a DIFFERENT directory than the one it sits in. Legacy
 * `agent:<id>:...` keys still resolve to their original channel directory, so
 * scanning `main/default`, `discord/<chan>`, etc. is a safe no-op for them
 * (rule #39 — identical routing across paths). This keeps the migration
 * lossless and idempotent regardless of which directory data was stranded in.
 */
async function listFallbackSourceFiles(
  transcriptsDir: string
): Promise<Array<{ relPath: string; fileName: string; absPath: string }>> {
  const out: Array<{ relPath: string; fileName: string; absPath: string }> = [];
  let typeEntries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    typeEntries = await readdir(transcriptsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const typeEnt of typeEntries) {
    if (!typeEnt.isDirectory()) continue;

    const typeDir = path.join(transcriptsDir, typeEnt.name);
    let idEntries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      idEntries = await readdir(typeDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const idEnt of idEntries) {
      if (!idEnt.isDirectory()) continue;

      // Only canonical `session/<hash>` dirs are already homed — skip those.
      // A LEGACY `session/<name>` dir (e.g. `foo:bar:session:baz` →
      // `session/baz` under the OLD parser) is a real migration source and
      // must be scanned/split (codex review on PR #1504). `planFile`'s
      // destination gate still guarantees losslessness/idempotence.
      if (isCanonicalSessionDir(typeEnt.name, idEnt.name)) continue;

      const chanDir = path.join(typeDir, idEnt.name);
      let files: string[];
      try {
        files = (await readdir(chanDir)).filter((f) => f.endsWith(".jsonl")).sort();
      } catch {
        continue;
      }
      for (const fileName of files) {
        out.push({
          relPath: path.join(typeEnt.name, idEnt.name, fileName),
          fileName,
          absPath: path.join(chanDir, fileName),
        });
      }
    }
  }

  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

interface ParsedSourceLine {
  sessionKey?: string;
  /** The raw JSONL text (without trailing newline). */
  raw: string;
}

/**
 * Parse a source JSONL file, preserving line order. Lines that are not valid
 * JSON or lack a string `sessionKey` are tracked as unmovable and left in the
 * source file so no data is lost (rule #18 — validate parse result type).
 */
function parseSourceLines(content: string): ParsedSourceLine[] {
  const out: ParsedSourceLine[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let sessionKey: string | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        const sk = (parsed as { sessionKey?: unknown }).sessionKey;
        if (typeof sk === "string" && sk.length > 0) {
          sessionKey = sk;
        }
      }
    } catch {
      // Unparseable line — keep it in place.
    }
    out.push({ sessionKey, raw: line });
  }
  return out;
}

/**
 * Build a per-file migration plan. A line is "movable" when its session key
 * resolves to a destination directory different from the source directory.
 */
function planFile(sourceRelPath: string, fileName: string, lines: ParsedSourceLine[]): SessionMigrationFilePlan {
  const sourceDir = path.dirname(sourceRelPath);
  const groups = new Map<string, { legacy: boolean; destDir: string; count: number }>();
  let unmovableLines = 0;
  let movableCount = 0;

  for (const line of lines) {
    if (!line.sessionKey) {
      unmovableLines += 1;
      continue;
    }
    const identity = parseSessionIdentity(line.sessionKey);
    const paths = sessionStoragePaths(line.sessionKey);
    // Only move when the destination directory differs from the source.
    if (paths.dir === sourceDir) {
      continue;
    }
    movableCount += 1;
    const existing = groups.get(line.sessionKey);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(line.sessionKey, {
        legacy: identity.legacy,
        destDir: paths.dir,
        count: 1,
      });
    }
  }

  const groupList: SessionMigrationEntryGroup[] = [...groups.entries()]
    .map(([sessionKey, info]) => ({
      sessionKey,
      legacy: info.legacy,
      destDir: info.destDir,
      entryCount: info.count,
    }))
    .sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));

  return {
    sourceRelPath,
    fileName,
    groups: groupList,
    unmovableLines,
    alreadyHomed: movableCount === 0,
  };
}

/**
 * Compute the migration plan without modifying anything.
 */
export async function planSessionTranscriptMigration(
  options: MigrateSessionTranscriptsOptions
): Promise<SessionMigrationPlan> {
  const transcriptsDir = path.join(options.memoryDir, "transcripts");
  const sources = await listFallbackSourceFiles(transcriptsDir);
  const files: SessionMigrationFilePlan[] = [];
  const distinctSessions = new Set<string>();
  let movedEntries = 0;

  for (const source of sources) {
    if (!isDateStampedJsonl(source.fileName)) continue;
    let content: string;
    try {
      content = await readFile(source.absPath, "utf-8");
    } catch {
      continue;
    }
    const lines = parseSourceLines(content);
    const filePlan = planFile(source.relPath, source.fileName, lines);
    if (filePlan.alreadyHomed) continue;

    for (const group of filePlan.groups) {
      distinctSessions.add(group.sessionKey);
      movedEntries += group.entryCount;
    }
    files.push(filePlan);
  }

  return {
    generatedAt: new Date().toISOString(),
    dryRun: options.apply !== true,
    transcriptsDir,
    files,
    distinctSessions: distinctSessions.size,
    movedEntries,
  };
}

/**
 * Append `lines` (raw JSONL strings) to `<destDir>/<fileName>` using a
 * write-then-rename merge so a crash mid-migration cannot corrupt or truncate
 * the destination (rule #54).
 *
 * Existing destination content is preserved and de-duplicated by raw line so
 * re-running the migration is idempotent.
 */
async function mergeAppendLines(
  transcriptsDir: string,
  destDir: string,
  fileName: string,
  newLines: string[]
): Promise<void> {
  const destChannelDir = await resolveSafeStoragePath(transcriptsDir, destDir);
  await mkdir(destChannelDir, { recursive: true });
  const destPath = await resolveSafeStoragePath(transcriptsDir, destDir, fileName);

  const existing: string[] = [];
  const seen = new Set<string>();
  try {
    const raw = await readFile(destPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      existing.push(line);
      seen.add(line);
    }
  } catch {
    // No existing destination file — fine.
  }

  const merged = [...existing];
  for (const line of newLines) {
    if (seen.has(line)) continue;
    merged.push(line);
    seen.add(line);
  }

  const body = merged.length > 0 ? `${merged.join("\n")}\n` : "";
  const tmpPath = await resolveSafeStoragePath(
    transcriptsDir,
    destDir,
    `${fileName}.migrate-${process.pid}-${Date.now()}.tmp`
  );
  await writeFile(tmpPath, body, "utf-8");
  await rename(tmpPath, destPath);
}

/**
 * Rewrite the source file to retain ONLY the lines that were not moved
 * (unparseable lines and any that already belong in the source dir). Uses
 * write-then-rename; deletes the source only when nothing remains.
 */
async function rewriteSourceRetainingUnmoved(
  transcriptsDir: string,
  sourceRelPath: string,
  retainedLines: string[]
): Promise<{ removed: boolean }> {
  const sourcePath = await resolveSafeStoragePath(transcriptsDir, sourceRelPath);
  if (retainedLines.length === 0) {
    // Atomic-rename into a sibling tombstone then unlink, so a crash leaves the
    // original intact (never delete-before-confirm; rule #54). Simpler and
    // equally safe: unlink only after destinations are confirmed written.
    try {
      await unlink(sourcePath);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
      if (code !== "ENOENT") throw err;
    }
    return { removed: true };
  }

  const body = `${retainedLines.join("\n")}\n`;
  const sourceDir = path.dirname(sourceRelPath);
  const tmpPath = await resolveSafeStoragePath(
    transcriptsDir,
    sourceDir,
    `${path.basename(sourceRelPath)}.migrate-${process.pid}-${Date.now()}.tmp`
  );
  await writeFile(tmpPath, body, "utf-8");
  await rename(tmpPath, sourcePath);
  return { removed: false };
}

/**
 * Run the migration. Dry-run by default; pass `apply: true` to mutate.
 */
export async function migrateSessionTranscripts(
  options: MigrateSessionTranscriptsOptions
): Promise<SessionMigrationResult> {
  const plan = await planSessionTranscriptMigration(options);
  const apply = options.apply === true;

  if (!apply) {
    return {
      plan,
      applied: false,
      filesRewritten: 0,
      filesRemoved: 0,
      errors: [],
    };
  }

  const transcriptsDir = plan.transcriptsDir;
  const errors: string[] = [];
  let filesRewritten = 0;
  let filesRemoved = 0;

  for (const filePlan of plan.files) {
    try {
      const sourcePath = await resolveSafeStoragePath(transcriptsDir, filePlan.sourceRelPath);
      const content = await readFile(sourcePath, "utf-8");
      const lines = parseSourceLines(content);
      const sourceDir = path.dirname(filePlan.sourceRelPath);

      // Bucket lines by destination, preserving order. Retain unmovable lines
      // and any line already homed in the source dir.
      const byDest = new Map<string, string[]>();
      const retained: string[] = [];
      for (const line of lines) {
        if (!line.sessionKey) {
          retained.push(line.raw);
          continue;
        }
        const dest = sessionStoragePaths(line.sessionKey).dir;
        if (dest === sourceDir) {
          retained.push(line.raw);
          continue;
        }
        const bucket = byDest.get(dest) ?? [];
        bucket.push(line.raw);
        byDest.set(dest, bucket);
      }

      // 1. Write destinations FIRST (write-then-rename, idempotent merge).
      for (const [destDir, destLines] of byDest.entries()) {
        await mergeAppendLines(transcriptsDir, destDir, filePlan.fileName, destLines);
      }

      // 2. Only after all destinations are confirmed, rewrite/remove source.
      const { removed } = await rewriteSourceRetainingUnmoved(transcriptsDir, filePlan.sourceRelPath, retained);
      if (removed) {
        filesRemoved += 1;
      } else {
        filesRewritten += 1;
      }
    } catch (err) {
      // The `errors` array is surfaced to operators via the CLI
      // (`sessions migrate-transcripts --apply`) AND persisted in the audit
      // manifest. Raw `err.message`/`String(err)` can leak filesystem paths or
      // stack detail, so route operator-facing strings through the shared
      // `displayErrorDetail()` sanitizer (cursor review on PR #1504, rule #51).
      // The full error still goes to the operator-only debug log.
      const detail = displayErrorDetail(err);
      errors.push(
        `Failed to migrate ${filePlan.sourceRelPath}${detail ? `: ${detail}` : ""}`,
      );
      log.error(`session transcript migration failed for ${filePlan.sourceRelPath}:`, err);
    }
  }

  let manifestPath: string | undefined;
  try {
    manifestPath = await writeManifest(options.memoryDir, {
      plan,
      applied: true,
      filesRewritten,
      filesRemoved,
      errors,
    });
  } catch (err) {
    // Manifest is best-effort audit; do not fail the migration over it.
    log.debug(`failed to write session migration manifest: ${err}`);
  }

  return {
    plan,
    applied: true,
    filesRewritten,
    filesRemoved,
    errors,
    manifestPath,
  };
}

async function writeManifest(memoryDir: string, result: Omit<SessionMigrationResult, "manifestPath">): Promise<string> {
  const auditDir = path.join(memoryDir, "state", "session-migration");
  await mkdir(auditDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = path.join(auditDir, `migrate-transcripts-${stamp}.json`);
  await writeFile(manifestPath, JSON.stringify(result, null, 2), "utf-8");
  return manifestPath;
}

/** Best-effort byte-size summary for reporting (used by CLI output). */
export async function summarizeMigrationSources(memoryDir: string): Promise<{ files: number; bytes: number }> {
  const transcriptsDir = path.join(memoryDir, "transcripts");
  const sources = await listFallbackSourceFiles(transcriptsDir);
  let bytes = 0;
  let files = 0;
  for (const source of sources) {
    const info = await stat(source.absPath).catch(() => null);
    if (info?.isFile()) {
      bytes += info.size;
      files += 1;
    }
  }
  return { files, bytes };
}
