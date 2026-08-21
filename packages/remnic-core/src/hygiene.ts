import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type HygieneWarning = {
  path: string;
  bytes: number;
  budgetBytes: number;
  warnAtBytes: number;
  message: string;
};

function toSafeTimestamp(ts: Date): string {
  // filesystem-safe, deterministic-ish, UTC
  return ts.toISOString().replace(/[:.]/g, "");
}

export async function lintWorkspaceFiles(opts: {
  workspaceDir: string;
  paths: string[];
  budgetBytes: number;
  warnRatio: number;
}): Promise<HygieneWarning[]> {
  const warnings: HygieneWarning[] = [];
  const warnAtBytes = Math.floor(opts.budgetBytes * opts.warnRatio);

  for (const p of opts.paths) {
    const abs = path.isAbsolute(p) ? p : path.join(opts.workspaceDir, p);
    try {
      const st = await stat(abs);
      if (!st.isFile()) continue;
      const bytes = st.size;
      if (bytes >= warnAtBytes) {
        warnings.push({
          path: p,
          bytes,
          budgetBytes: opts.budgetBytes,
          warnAtBytes,
          message: `Bootstrap file '${p}' is approaching its budget (${bytes} bytes >= ${warnAtBytes} bytes). Consider splitting/archiving it to avoid silent truncation.`,
        });
      }
    } catch {
      // ignore missing files
    }
  }

  return warnings;
}

export async function rotateMarkdownFileToArchive(opts: {
  filePath: string;
  archiveDir: string;
  archivePrefix: string;
  keepTailChars: number;
}): Promise<{ archivedPath: string; newContent: string }> {
  const existing = await readFile(opts.filePath, "utf-8");
  const ts = toSafeTimestamp(new Date());
  const archiveName = `${opts.archivePrefix}-${ts}.md`;
  await mkdir(opts.archiveDir, { recursive: true });
  const archivedPath = path.join(opts.archiveDir, archiveName);
  await writeFile(archivedPath, existing, "utf-8");

  const tail =
    opts.keepTailChars > 0 && existing.length > opts.keepTailChars
      ? existing.slice(-opts.keepTailChars)
      : existing;

  const relLink = path.relative(path.dirname(opts.filePath), archivedPath);

  const newContent = [
    "# Index",
    "",
    "This file is kept intentionally small to reduce the risk of silent truncation when OpenClaw bootstraps workspace files into the prompt.",
    "",
    "## Archives",
    `- [${archiveName}](${relLink})`,
    "",
    "## Recent Tail (for continuity)",
    "",
    "```md",
    tail.trim(),
    "```",
    "",
  ].join("\n");

  return { archivedPath, newContent };
}

