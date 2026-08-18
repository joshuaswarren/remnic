import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const RESERVED = new Set(["index.md", "log.md"]);

const CATEGORY_BY_TYPE: Record<string, string> = {
  "Memory Fact": "fact",
  Decision: "decision",
  Preference: "preference",
  Commitment: "commitment",
  Relationship: "relationship",
  Principle: "principle",
  Moment: "moment",
  Skill: "skill",
  Correction: "correction",
  Rule: "rule",
};

export interface ParsedOkfDocument {
  relPath: string;
  category: string;
  content: string;
  sourceId?: string;
  sourceTimestamp?: string;
}

export interface ParsedOkfBundle {
  root: string;
  documents: ParsedOkfDocument[];
}

export function parseOkfBundle(input: unknown): ParsedOkfBundle {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("OKF import requires a directory path");
  }
  const root = path.resolve(input.trim());
  if (/\.(zip|tgz|tar\.gz)$/i.test(root)) {
    throw new Error(`unpack first: archive imports are not supported (${root})`);
  }
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new Error(`OKF bundle not found: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`OKF import requires a directory, got a file: ${root}`);
  }
  const documents: ParsedOkfDocument[] = [];
  walk(root, root, documents);
  documents.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { root, documents };
}

function walk(root: string, dir: string, out: ParsedOkfDocument[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (RESERVED.has(entry.name)) continue;
    out.push(parseDocument(root, full));
  }
}

function parseDocument(root: string, filePath: string): ParsedOkfDocument {
  const raw = readFileSync(filePath, "utf8");
  const { fields, body } = splitFrontmatter(raw);
  const type = fields.type ?? "";
  return {
    relPath: path.relative(root, filePath).split(path.sep).join("/"),
    category: CATEGORY_BY_TYPE[type] ?? "fact",
    content: body.trim(),
    ...(fields.id ? { sourceId: fields.id } : {}),
    ...(fields.timestamp ?? fields.updated ?? fields.created
      ? { sourceTimestamp: fields.timestamp ?? fields.updated ?? fields.created }
      : {}),
  };
}

function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { fields: {}, body: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { fields: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fields, body };
}
