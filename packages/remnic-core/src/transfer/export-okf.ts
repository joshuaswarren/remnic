import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseOaiMemCitation } from "../citations.js";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { normalizeProjectionPreview } from "../memory-projection-format.js";
import { lintOkfDir } from "../okf/lint.js";
import { okfTypeForMemory, OKF_PROFILE_TYPE } from "../okf/type-mapping.js";
import { StorageManager } from "../storage.js";
import type { MemoryFile, MemoryLink, MemoryStatus } from "../types.js";

export const OKF_EXPORT_VERSION = "0.1";
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
  const includeStatus = new Set(parseIncludeStatus(opts.includeStatus));
  const includeCategories = opts.includeCategories?.length ? new Set(opts.includeCategories) : null;
  const excludeTags = new Set(opts.excludeTags ?? []);
  const storage = new StorageManager(opts.memoryDir);
  const memories = await storage.readAllMemories();
  const included: MemoryFile[] = [];
  let excluded = 0;
  for (const memory of memories) {
    const rel = toRel(memory.path, opts.memoryDir);
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
  included.sort((a, b) => toRel(a.path, opts.memoryDir).localeCompare(toRel(b.path, opts.memoryDir)));

  const staging = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-export-"));
  const byCategory: Record<string, number> = {};
  const idToRel = new Map<string, string>();
  for (const memory of included) {
    const rel = toRel(memory.path, opts.memoryDir);
    idToRel.set(memory.frontmatter.id, rel);
  }
  for (const memory of included) {
    const rel = toRel(memory.path, opts.memoryDir);
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

  writeIndexes(staging, included, opts.memoryDir);
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

function publishBundle(staging: string, outDir: string, force: boolean): void {
  let exists = false;
  try {
    const stat = lstatSync(outDir);
    if (stat.isSymbolicLink()) throw new Error(`--out must not be a symlink: ${outDir}`);
    exists = true;
    const entries = listNonDot(outDir);
    if (entries.length > 0 && !force) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`--out ${outDir} is not empty; pass --force to replace it`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(path.dirname(outDir), { recursive: true });
  if (exists && force) {
    const backup = `${outDir}.okf-prev`;
    try {
      renameSync(outDir, backup);
    } catch {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`cannot replace --out ${outDir}`);
    }
    try {
      renameSync(staging, outDir);
      rmSync(backup, { recursive: true, force: true });
    } catch (err) {
      try {
        renameSync(backup, outDir);
      } catch {
        // Keep backup if restore fails.
      }
      throw err;
    }
    return;
  }
  renameSync(staging, outDir);
}

function renderMemory(memory: MemoryFile, rel: string, idToRel: Map<string, string>): string {
  const fm = memory.frontmatter;
  const title = firstHeading(memory.content) ?? `${humanize(fm.category)} ${fm.created.slice(0, 10)}`;
  const type = fm.type ?? okfTypeForMemory(fm);
  const fields: Record<string, unknown> = {
    type,
    title,
    description: normalizeProjectionPreview(memory.content),
    tags: fm.tags ?? [],
    timestamp: fm.updated,
    ...fm,
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

function renderFrontmatter(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort((a, b) => {
    const order = ["type", "title", "description", "tags", "timestamp"];
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.localeCompare(b);
  });
  const lines = keys.flatMap((key) => yamlLine(key, fields[key]));
  return `---\n${lines.join("\n")}\n---\n\n`;
}

function yamlLine(key: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return [`${key}:`, ...value.map((item) => `  - ${yamlScalar(item)}`)];
    }
    return [`${key}: ${JSON.stringify(value)}`];
  }
  if (typeof value === "object" && value !== null) return [`${key}: ${JSON.stringify(value)}`];
  return [`${key}: ${yamlScalar(value)}`];
}

function yamlScalar(value: unknown): string {
  if (typeof value === "string") {
    if (value === "" || /[:#\n]/.test(value) || value !== value.trim()) return JSON.stringify(value);
    return value;
  }
  return String(value);
}

function firstHeading(content: string): string | undefined {
  for (const line of content.split("\n")) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return match[1]!.trim();
  }
  return undefined;
}

function humanize(value: string): string {
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function toRel(abs: string, root: string): string {
  return path.relative(path.resolve(root), path.resolve(abs)).split(path.sep).join("/");
}

function writeBundleFile(root: string, rel: string, content: string): void {
  const dest = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content, "utf8");
}

function splitCsv(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function rejectSymlinkPath(target: string): void {
  let current = path.resolve(target);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`--out path component is a symlink: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function listNonDot(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name !== "." && name !== "..");
  } catch {
    return [];
  }
}
