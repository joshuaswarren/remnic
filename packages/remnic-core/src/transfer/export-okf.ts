import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";

import { parseOaiMemCitation } from "../citations.js";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { normalizeProjectionPreview } from "../memory-projection-format.js";
import { lintOkfDir } from "../okf/lint.js";
import { okfTypeForMemory, OKF_PROFILE_TYPE } from "../okf/type-mapping.js";
import { resolveNamespaceChildRoot } from "../namespaces/path.js";
import {
  OKF_EXPORT_VERSION,
  publishBundle,
  renderFrontmatter,
  rejectSymlinkPath,
  writeBundleFile,
} from "../okf/render.js";
// Re-exported for the existing `@remnic/core/export-okf` consumers and tests
// (one public surface; the value itself now lives in okf/render.ts).
export { OKF_EXPORT_VERSION };
import { StorageManager } from "../storage.js";
import type { MemoryFile, MemoryLink, MemoryStatus } from "../types.js";

// Shared bundle mechanics (frontmatter, publish, symlink guard, file write)
// live in ../okf/render.ts — one source of truth for every OKF exporter.
export const OKF_LOG_TRUNCATION_MARKER = "<!-- okf-log-truncated -->";
export const DEFAULT_OKF_LOG_MAX_ENTRIES = 500;

const MEMORY_STATUSES: readonly MemoryStatus[] = [
  "active",
  "pending_review",
  "rejected",
  "quarantined",
  "superseded",
  "archived",
  "forgotten",
];

export interface ExportOkfOptions {
  memoryDir: string;
  /**
   * Optional namespace segment. Resolved here, once, through the shared
   * containment guard: both CLI entry points used to join the raw operator
   * value onto `memoryDir/namespaces`, so `--namespace ../../..` escaped the
   * namespace root and exported an arbitrary tree (rule 9 — one resolver, not
   * a per-caller guard).
   */
  namespace?: string;
  outDir: string;
  includeStatus?: readonly string[];
  includeCategories?: readonly string[];
  excludeTags?: readonly string[];
  includeProfile?: boolean;
  includeWearables?: boolean;
  includeLog?: boolean;
  logMaxEntries?: number;
  force?: boolean;
}

export interface ExportOkfResult {
  exported: number;
  excluded: number;
  byCategory: Record<string, number>;
  plaintextWarning: boolean;
}

export function parseIncludeStatus(raw: unknown): MemoryStatus[] {
  const values = splitCsv(raw);
  if (values.length === 0) return ["active"];
  const allowed = new Set<string>(MEMORY_STATUSES);
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(`invalid --include-status ${value}; allowed: ${MEMORY_STATUSES.join(", ")}`);
    }
  }
  return values as MemoryStatus[];
}

export async function exportOkfBundle(opts: ExportOkfOptions): Promise<ExportOkfResult> {
  const outDir = path.resolve(opts.outDir);
  rejectSymlinkPath(outDir);
  const namespace = (opts.namespace ?? "").trim();
  const memoryDir = namespace
    ? resolveNamespaceChildRoot(opts.memoryDir, namespace, "--namespace")
    : opts.memoryDir;
  const includeStatus = new Set(parseIncludeStatus(opts.includeStatus));
  const includeCategories = opts.includeCategories?.length ? new Set(opts.includeCategories) : null;
  const excludeTags = new Set(opts.excludeTags ?? []);
  const storage = new StorageManager(memoryDir);
  const memories = await storage.readAllMemories();
  const included: MemoryFile[] = [];
  let excluded = 0;
  for (const memory of memories) {
    const rel = toRel(memory.path, memoryDir);
    if (!opts.includeWearables && rel.startsWith("wearables/")) {
      excluded += 1;
      continue;
    }
    const status = inferMemoryStatus(memory.frontmatter, memory.path);
    if (!includeStatus.has(status)) {
      excluded += 1;
      continue;
    }
    if (includeCategories && !includeCategories.has(memory.frontmatter.category)) {
      excluded += 1;
      continue;
    }
    if ((memory.frontmatter.tags ?? []).some((tag) => excludeTags.has(tag))) {
      excluded += 1;
      continue;
    }
    included.push(memory);
  }
  included.sort((a, b) => toRel(a.path, memoryDir).localeCompare(toRel(b.path, memoryDir)));

  // Stage inside the destination's parent, not the OS temp dir: publishBundle
  // finishes with a rename, and a rename across filesystems fails with EXDEV
  // whenever --out lives on a different mount than /tmp.
  mkdirSync(path.dirname(outDir), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(outDir), ".remnic-okf-export-"));
  const byCategory: Record<string, number> = {};
  const idToRel = new Map<string, string>();
  for (const memory of included) {
    const rel = toRel(memory.path, memoryDir);
    idToRel.set(memory.frontmatter.id, rel);
  }
  for (const memory of included) {
    const rel = toRel(memory.path, memoryDir);
    const rendered = renderMemory(memory, rel, idToRel);
    writeBundleFile(staging, rel, rendered);
    const category = memory.frontmatter.category;
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }

  if (opts.includeProfile) {
    try {
      const profile = await storage.readProfile();
      if (profile) {
        writeBundleFile(
          staging,
          "profile.md",
          renderFrontmatter({
            type: OKF_PROFILE_TYPE,
            title: "User Profile",
            timestamp: new Date(0).toISOString(),
          }) + profile.replace(/^\uFEFF/, ""),
        );
      }
    } catch {
      // Profile is optional even when requested.
    }
  }

  if (opts.includeLog) {
    const events = await storage.readAllMemoryLifecycleEvents();
    writeBundleFile(staging, "log.md", renderLog(events, idToRel, opts.logMaxEntries ?? DEFAULT_OKF_LOG_MAX_ENTRIES));
  }

  writeIndexes(staging, included, memoryDir);
  const lint = lintOkfDir(staging);
  const blocking = lint.findings.filter((f) => f.code !== "skipped_encrypted" && f.code !== "reserved_basename");
  if (blocking.length > 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`OKF export failed lint: ${blocking.map((f) => `${f.file}: ${f.message}`).join("; ")}`);
  }

  publishBundle(staging, outDir, opts.force === true);
  return {
    exported: included.length,
    excluded,
    byCategory,
    plaintextWarning: true,
  };
}


function renderMemory(memory: MemoryFile, rel: string, idToRel: Map<string, string>): string {
  const fm = memory.frontmatter;
  const title = firstHeading(memory.content) ?? `${humanize(fm.category)} ${fm.created.slice(0, 10)}`;
  const type = fm.type ?? okfTypeForMemory(fm);
  const fields: Record<string, unknown> = {
    ...fm,
    type,
    title,
    description: normalizeProjectionPreview(memory.content),
    tags: fm.tags ?? [],
    timestamp: fm.updated,
  };
  if (fm.artifactType) fields.resource = rel;
  let body = memory.content.trim();
  const citation = parseOaiMemCitation(body);
  if (citation) {
    const start = body.indexOf("<oai-mem-citation>");
    const end = body.indexOf("</oai-mem-citation>");
    if (start >= 0 && end > start) {
      body = `${body.slice(0, start).trimEnd()}\n\n${body.slice(end + "</oai-mem-citation>".length).trimStart()}`.trim();
    }
    const lines = citation.entries.map((entry, index) => `${index + 1}. [${entry.path}](${entry.path})`);
    body = `${body}\n\n# Citations\n\n${lines.join("\n")}\n`;
  }
  const links = fm.links ?? [];
  if (links.length > 0) {
    body += `\n# Related\n\n${links.map((link) => renderRelated(link, idToRel)).join("\n")}\n`;
  }
  return renderFrontmatter(fields) + body + (body.endsWith("\n") ? "" : "\n");
}

function renderRelated(link: MemoryLink, idToRel: Map<string, string>): string {
  const target = idToRel.get(link.targetId) ?? link.targetId;
  const href = target.startsWith("/") ? target : `/${target}`;
  return `- ${link.linkType}: [${link.targetId}](${href})`;
}

function writeIndexes(root: string, memories: MemoryFile[], memoryDir: string): void {
  const groups = new Map<string, MemoryFile[]>();
  for (const memory of memories) {
    const rel = toRel(memory.path, memoryDir);
    const dir = path.posix.dirname(rel);
    const key = dir === "." ? "" : dir.split("/")[0] ?? "";
    const list = groups.get(key) ?? [];
    list.push(memory);
    groups.set(key, list);
  }
  const sections = [...groups.keys()].sort().map((key) => {
    const heading = key === "" ? "Root" : humanize(key);
    const lines = (groups.get(key) ?? [])
      .sort((a, b) => toRel(a.path, memoryDir).localeCompare(toRel(b.path, memoryDir)))
      .map((memory) => {
        const rel = toRel(memory.path, memoryDir);
        const title = firstHeading(memory.content) ?? memory.frontmatter.id;
        const description = normalizeProjectionPreview(memory.content);
        return `* [${title}](/${rel}) - ${description}`;
      });
    return `## ${heading}\n\n${lines.join("\n")}`;
  });
  writeBundleFile(root, "index.md", `---\nokf_version: "${OKF_EXPORT_VERSION}"\n---\n\n${sections.join("\n\n")}\n`);
}

function renderLog(
  events: Array<{ timestamp?: string; type?: string; action?: string; memoryId?: string }>,
  idToRel: Map<string, string>,
  maxEntries: number,
): string {
  const sorted = [...events].sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  const truncated = sorted.length > maxEntries;
  const kept = sorted.slice(0, maxEntries);
  const byDay = new Map<string, typeof kept>();
  for (const event of kept) {
    const day = String(event.timestamp ?? "").slice(0, 10) || "unknown";
    const list = byDay.get(day) ?? [];
    list.push(event);
    byDay.set(day, list);
  }
  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  const parts = ["# Log", ""];
  for (const day of days) {
    parts.push(`## ${day}`, "");
    for (const event of byDay.get(day) ?? []) {
      const action = boldAction(event.type ?? event.action ?? "Update");
      const id = event.memoryId;
      const rel = id ? idToRel.get(id) : undefined;
      const target = rel ? `[${id}](/${rel})` : id ?? "";
      parts.push(`- **${action}** ${target}`.trimEnd());
    }
    parts.push("");
  }
  if (truncated) parts.push(OKF_LOG_TRUNCATION_MARKER, "");
  return `${parts.join("\n")}\n`;
}

function boldAction(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("create") || lower.includes("add")) return "Creation";
  if (lower.includes("deprecat") || lower.includes("delete") || lower.includes("archiv")) return "Deprecation";
  return "Update";
}


export function firstHeading(content: string): string | undefined {
  for (const line of content.split("\n")) {
    // `\S` makes the capture boundary disjoint from `\s+`, so the regex
    // cannot backtrack across split points — `\s+(.+)` was superlinear on
    // whitespace-heavy lines (CodeQL js/polynomial-redos). `.` still excludes
    // \r\u2028\u2029, preserving the skip-line behavior on those lines.
    const match = /^#\s+(\S.*)$/.exec(line.trim());
    if (match) return match[1]!.trim();
  }
  return undefined;
}

function humanize(value: string): string {
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}



function splitCsv(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function toRel(abs: string, root: string): string {
  return path.relative(path.resolve(root), path.resolve(abs)).split(path.sep).join("/");
}

