/**
 * Training-data converter.
 *
 * Reads memory markdown files from a memoryDir, parses YAML
 * frontmatter, applies filters, and returns TrainingExportRecord[].
 *
 * Instruction is derived from the memory's category/tags.
 * Output is the memory content body.
 * The `input` field is empty string (synthesis is left to adapters).
 */

import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parseStrictCliDate } from "./date-parse.js";
import type { TrainingExportOptions, TrainingExportRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Frontmatter parsing (mirrors storage.ts but kept standalone)
// ---------------------------------------------------------------------------

interface ParsedMemory {
  id: string;
  category: string;
  confidence: number;
  created: string;
  updated: string;
  tags: string[];
  content: string;
  filePath: string;
}

function parseFrontmatter(raw: string): ParsedMemory | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const content = (match[2] ?? "").trim();
  const fm: Record<string, string> = {};

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }

  let tags: string[] = [];
  const tagsStr = fm.tags ?? "";
  const tagMatch = tagsStr.match(/\[(.*)]/);
  if (tagMatch) {
    tags = tagMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  const confidence = parseFloat(fm.confidence ?? "0.8");

  return {
    id: fm.id ?? "",
    category: fm.category ?? "fact",
    confidence: Number.isFinite(confidence) ? confidence : 0.8,
    created: fm.created ?? "",
    updated: fm.updated ?? "",
    tags,
    content,
    filePath: "",
  };
}

// ---------------------------------------------------------------------------
// Recursive directory scan
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical real path of `dir`. Used as the containment root
 * when rejecting symlinks that escape `memoryDir` (data-exfil protection).
 */
async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

function isContainedPath(real: string, containmentRoot: string): boolean {
  return real === containmentRoot || real.startsWith(containmentRoot + path.sep);
}

/**
 * Recursively collect `.md` files under `dir`, returning deterministic,
 * lexicographically-sorted absolute paths.
 *
 * Security: rejects symlinks outright. A symlink named `facts/private.md`
 * pointing to `~/.ssh/id_rsa` (or a symlinked `facts/` directory pointing
 * outside `memoryDir`) must NOT be read/exported — that would be a data
 * exfiltration path out of the memory store.
 *
 * `containmentRoot` is the canonical real path that every resolved file
 * must sit under. Callers pass the real path of the memoryDir so symlinked
 * subdirectories (e.g. `facts/` pointing at `/tmp/other/facts`) cannot
 * leak files from outside the memory store.
 */
async function collectMarkdownFiles(
  dir: string,
  containmentRoot: string,
): Promise<string[]> {
  const files: string[] = [];

  const walk = async (d: string): Promise<void> => {
    // Refuse to descend into `d` at all if it is a symlink — regardless of
    // whether the symlink happens to still point inside `containmentRoot`,
    // traversing symlinked directories is easy to weaponise via TOCTOU.
    let dStat: import("node:fs").Stats | null = null;
    try {
      dStat = await lstat(d);
    } catch {
      return;
    }
    if (dStat.isSymbolicLink()) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // directory does not exist or is unreadable
    }

    // Sort entries lexicographically for deterministic output ordering.
    // `readdir` does not guarantee order across filesystems/platforms, which
    // would otherwise make identical corpora produce different dataset files.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      const full = path.join(d, entry.name);

      // Skip symlinked entries entirely (security: prevents traversal out of
      // memoryDir). withFileTypes=true gives us the entry kind from lstat-
      // semantics, so we don't follow the link.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Defense in depth: confirm the resolved real path still lives under
        // the canonical containment root. `realpath` alone is not enough to
        // catch hard links that point at out-of-tree inodes (a hard link IS
        // the file, so realpath returns the in-tree path). We therefore also
        // reject entries whose `nlink > 1`: memory files should have a single
        // directory entry, and any additional hard link is a potential
        // exfiltration vector that the operator did not intend.
        let st: import("node:fs").Stats | null = null;
        try {
          st = await lstat(full);
        } catch {
          continue;
        }
        if (st.nlink > 1) continue;

        const real = await safeRealpath(full);
        if (!real) continue;
        if (!isContainedPath(real, containmentRoot)) {
          continue;
        }
        files.push(full);
      }
    }
  };

  await walk(dir);

  // Final stable sort of the absolute paths guarantees order regardless of
  // directory traversal quirks.
  return files.sort((a, b) => a.localeCompare(b));
}

export async function readContainedMarkdownFile(
  filePath: string,
  containmentRoot: string,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || st.nlink > 1) return null;

    const real = await safeRealpath(filePath);
    if (!real || !isContainedPath(real, containmentRoot)) return null;

    return await handle.readFile("utf-8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Build instruction from category + tags
// ---------------------------------------------------------------------------

function buildInstruction(category: string, tags: string[]): string {
  const tagSuffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  switch (category) {
    case "fact":
      return `Recall a factual memory${tagSuffix}`;
    case "preference":
      return `Recall a user preference${tagSuffix}`;
    case "correction":
      return `Recall a correction${tagSuffix}`;
    case "entity":
      return `Recall entity information${tagSuffix}`;
    case "decision":
      return `Recall a decision${tagSuffix}`;
    case "relationship":
      return `Recall a relationship${tagSuffix}`;
    case "principle":
      return `Recall a principle${tagSuffix}`;
    case "commitment":
      return `Recall a commitment${tagSuffix}`;
    case "moment":
      return `Recall a moment${tagSuffix}`;
    case "skill":
      return `Recall a skill${tagSuffix}`;
    case "rule":
      return `Recall a rule${tagSuffix}`;
    case "personal":
      return `Recall personal information${tagSuffix}`;
    default:
      return `Recall a memory${tagSuffix}`;
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseIsoDate(isoStr: string): Date | null {
  if (!isoStr) return null;
  try {
    return parseStrictCliDate(isoStr, "memory created timestamp");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read memories from `memoryDir`, apply option filters, and return
 * an array of TrainingExportRecord for downstream adapters.
 */
export async function convertMemoriesToRecords(
  options: TrainingExportOptions,
): Promise<TrainingExportRecord[]> {
  const { memoryDir } = options;

  // Canonicalise the memoryDir once — this is the containment root every
  // resolved `.md` file must sit under (symlink/hard-link escape defense).
  const containmentRoot = await safeRealpath(memoryDir);
  if (!containmentRoot) return [];

  // Collect from facts/ and corrections/ subdirectories (mirrors storage.ts)
  const factsDir = path.join(memoryDir, "facts");
  const correctionsDir = path.join(memoryDir, "corrections");

  const dirs = [factsDir, correctionsDir];
  if (options.includeEntities) {
    dirs.push(path.join(memoryDir, "entities"));
  }

  const allFiles: string[] = [];
  for (const dir of dirs) {
    const files = await collectMarkdownFiles(dir, containmentRoot);
    allFiles.push(...files);
  }

  const records: TrainingExportRecord[] = [];

  for (const filePath of allFiles) {
    const raw = await readContainedMarkdownFile(filePath, containmentRoot);
    if (raw === null) continue; // skip unreadable files

    const parsed = parseFrontmatter(raw);
    if (!parsed) continue; // skip malformed files
    if (!parsed.content) continue; // skip empty content

    parsed.filePath = filePath;

    // --- Apply filters ---

    // minConfidence (CLAUDE.md #35: half-open intervals where applicable,
    // but confidence is an inclusive lower bound)
    if (
      options.minConfidence !== undefined &&
      parsed.confidence < options.minConfidence
    ) {
      continue;
    }

    // categories filter
    if (
      options.categories !== undefined &&
      options.categories.length > 0 &&
      !options.categories.includes(parsed.category)
    ) {
      continue;
    }

    // since filter (half-open: created >= since)
    if (options.since) {
      const created = parseIsoDate(parsed.created);
      // Exclude memories with missing/unparseable dates when date filters are active
      if (!created || created.getTime() < options.since.getTime()) {
        continue;
      }
    }

    // until filter (exclusive upper bound per CLAUDE.md #35: created < until)
    if (options.until) {
      const created = parseIsoDate(parsed.created);
      // Exclude memories with missing/unparseable dates when date filters are active
      if (!created || created.getTime() >= options.until.getTime()) {
        continue;
      }
    }

    records.push({
      instruction: buildInstruction(parsed.category, parsed.tags),
      input: "",
      output: parsed.content,
      category: parsed.category,
      confidence: parsed.confidence,
      sourceIds: parsed.id ? [parsed.id] : undefined,
    });
  }

  return records;
}
