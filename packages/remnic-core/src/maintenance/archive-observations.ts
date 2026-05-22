import path from "node:path";
import { lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";

const DATE_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.(jsonl|md)$/;

export interface ArchiveObservationsOptions {
  memoryDir: string;
  retentionDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface ArchiveObservationsResult {
  dryRun: boolean;
  retentionDays: number;
  scannedFiles: number;
  archivedFiles: number;
  archivedBytes: number;
  archiveRoot: string;
  archivedRelativePaths: string[];
}

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
}

function normalizeRetentionDays(value: number | undefined): number {
  if (!Number.isFinite(value as number)) return 30;
  return Math.max(0, Math.floor(value as number));
}

function extractDateFromFilename(name: string): Date | null {
  const match = DATE_FILE_PATTERN.exec(name);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function startOfUtcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

async function listFilesRecursive(root: string, relPrefix = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch {
    return out;
  }

  for (const entry of entries) {
    const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full, rel)));
      continue;
    }
    if (entry.isFile()) out.push(rel);
  }

  return out;
}

async function collectArchiveCandidates(
  memoryDir: string,
  cutoffTimeMs: number,
): Promise<CandidateFile[]> {
  const roots = ["transcripts", path.join("state", "tool-usage"), path.join("summaries", "hourly")];
  const out: CandidateFile[] = [];
  const memoryRoot = path.resolve(memoryDir);
  const memoryRealRoot = await realpath(memoryRoot).catch(() => memoryRoot);

  for (const relRoot of roots) {
    const absRoot = path.resolve(memoryRoot, relRoot);
    const rootInfo = await lstat(absRoot).catch(() => null);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) continue;
    const absRootReal = await realpath(absRoot).catch(() => null);
    if (absRootReal === null) continue;
    const rootRelative = path.relative(memoryRealRoot, absRootReal);
    if (rootRelative === ".." || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) {
      continue;
    }
    const files = await listFilesRecursive(absRoot);
    for (const fileRel of files) {
      const filename = path.basename(fileRel);
      const parsedDate = extractDateFromFilename(filename);
      if (!parsedDate) continue;
      if (parsedDate.getTime() >= cutoffTimeMs) continue;
      const absolutePath = path.resolve(absRoot, fileRel);
      const relativeToMemory = path.relative(memoryRoot, absolutePath);
      if (
        relativeToMemory === ".." ||
        relativeToMemory.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToMemory)
      ) {
        continue;
      }
      out.push({
        absolutePath,
        relativePath: path.join(relRoot, fileRel),
      });
    }
  }

  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

export async function archiveObservations(
  options: ArchiveObservationsOptions,
): Promise<ArchiveObservationsResult> {
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const cutoffDayStartUtc = startOfUtcDay(
    new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000),
  );
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const archiveRoot = path.join(options.memoryDir, "archive", "observations", stamp);
  const candidates =
    retentionDays === 0
      ? []
      : await collectArchiveCandidates(
        options.memoryDir,
        cutoffDayStartUtc,
      );

  let archivedFiles = 0;
  let archivedBytes = 0;
  const archivedRelativePaths: string[] = [];

  if (!dryRun && candidates.length > 0) {
    await mkdir(archiveRoot, { recursive: true });
    for (const candidate of candidates) {
      const archivePath = path.join(archiveRoot, candidate.relativePath);
      const archiveDir = path.dirname(archivePath);
      await mkdir(archiveDir, { recursive: true });
      const candidateInfo = await lstat(candidate.absolutePath).catch(() => null);
      if (!candidateInfo?.isFile() || candidateInfo.isSymbolicLink()) continue;
      const raw = await readFile(candidate.absolutePath);
      await writeFile(archivePath, raw);
      await unlink(candidate.absolutePath);
      archivedFiles += 1;
      archivedBytes += raw.byteLength;
      archivedRelativePaths.push(candidate.relativePath);
    }
  } else {
    archivedRelativePaths.push(...candidates.map((c) => c.relativePath));
  }

  return {
    dryRun,
    retentionDays,
    scannedFiles: candidates.length,
    archivedFiles,
    archivedBytes,
    archiveRoot,
    archivedRelativePaths,
  };
}
