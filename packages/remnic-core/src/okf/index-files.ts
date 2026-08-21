import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { writeFileAtomically } from "../maintenance/atomic-file.js";
import { normalizeProjectionPreview } from "../memory-projection-format.js";
import { OKF_RESERVED_BASENAMES } from "./type-mapping.js";

export const OKF_INDEX_MARKER = "<!-- remnic-okf-index -->";

const INDEXED_ROOTS = ["entities", "facts", "corrections", "summaries"] as const;

export interface OkfIndexReport {
  written: string[];
  removed: string[];
}

export async function runOkfIndexMaintenance(
  memoryDir: string,
  enabled: boolean,
): Promise<OkfIndexReport> {
  const written: string[] = [];
  const removed: string[] = [];
  const dirs = collectIndexDirs(memoryDir);
  for (const dir of dirs) {
    const indexPath = path.join(dir, "index.md");
    if (!enabled) {
      if (isGeneratedIndex(indexPath)) {
        unlinkSync(indexPath);
        removed.push(indexPath);
      }
      continue;
    }
    const next = renderIndex(dir);
    if (next === null) continue;
    if (isUnchangedGenerated(indexPath, next)) continue;
    await writeFileAtomically(indexPath, next);
    written.push(indexPath);
  }
  return { written, removed };
}

function collectIndexDirs(memoryDir: string): string[] {
  const dirs = [memoryDir];
  for (const root of INDEXED_ROOTS) {
    const full = path.join(memoryDir, root);
    if (!isDir(full)) continue;
    dirs.push(full);
    if (root === "facts") {
      for (const entry of safeList(full)) {
        const child = path.join(full, entry);
        if (isDir(child) && /^\d{4}-\d{2}-\d{2}$/.test(entry)) dirs.push(child);
      }
    }
  }
  return dirs;
}

function renderIndex(dir: string): string | null {
  const entries = safeList(dir)
    .filter((name) => name.endsWith(".md") && OKF_RESERVED_BASENAMES[name] !== true)
    .sort((a, b) => a.localeCompare(b));
  if (entries.length === 0) return null;
  const lines = [OKF_INDEX_MARKER, "", `# ${path.basename(dir)}`, ""];
  for (const name of entries) {
    const preview = previewFile(path.join(dir, name));
    lines.push(`* [${titleFrom(name, preview)}](${name}) - ${preview}`);
  }
  lines.push("");
  return lines.join("\n");
}

function previewFile(filePath: string): string {
  try {
    return normalizeProjectionPreview(readFileSync(filePath, "utf8"), 120);
  } catch {
    return "";
  }
}

function titleFrom(name: string, preview: string): string {
  return preview.split(" ").slice(0, 8).join(" ") || name.replace(/\.md$/, "");
}

function isGeneratedIndex(filePath: string): boolean {
  try {
    return readFileSync(filePath, "utf8").includes(OKF_INDEX_MARKER);
  } catch {
    return false;
  }
}

function isUnchangedGenerated(filePath: string, next: string): boolean {
  try {
    return readFileSync(filePath, "utf8") === next;
  } catch {
    return false;
  }
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
