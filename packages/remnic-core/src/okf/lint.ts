import fs from "node:fs";
import path from "node:path";

import { OKF_RESERVED_BASENAMES } from "./type-mapping.js";

export interface OkfLintFinding {
  file: string;
  code: "missing_frontmatter" | "missing_type" | "empty_type" | "reserved_basename" | "skipped_encrypted";
  message: string;
}

export interface OkfLintResult {
  ok: boolean;
  scanned: number;
  findings: OkfLintFinding[];
}

function isEncryptedBlob(raw: string): boolean {
  return raw.startsWith("-----BEGIN REMNIC") || raw.includes("enc:v1");
}

function hasFrontmatter(raw: string): boolean {
  return raw.startsWith("---\n") || raw.startsWith("---\r\n");
}

function readType(raw: string): string | undefined {
  const close = raw.indexOf("\n---", 4);
  if (close === -1) return undefined;
  const block = raw.slice(4, close);
  const match = /^type:\s*(.*)$/m.exec(block);
  if (!match) return undefined;
  const value = match[1]!.trim().replace(/^["']|["']$/g, "");
  return value;
}

function walkMarkdown(root: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "state" || entry.name === ".git") continue;
    const full = path.join(root, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walkMarkdown(full, out);
      continue;
    }
    if (stat.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
}

export function lintOkfDir(memoryDir: string): OkfLintResult {
  const files: string[] = [];
  walkMarkdown(memoryDir, files);
  const findings: OkfLintFinding[] = [];
  for (const file of files) {
    const rel = path.relative(memoryDir, file);
    const base = path.basename(file);
    if (OKF_RESERVED_BASENAMES[base] === true) {
      findings.push({
        file: rel,
        code: "reserved_basename",
        message: `${base} is reserved by OKF §6/§7`,
      });
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (isEncryptedBlob(raw)) {
      findings.push({
        file: rel,
        code: "skipped_encrypted",
        message: "skipped (encrypted)",
      });
      continue;
    }
    if (!hasFrontmatter(raw)) {
      findings.push({
        file: rel,
        code: "missing_frontmatter",
        message: "missing YAML frontmatter",
      });
      continue;
    }
    const type = readType(raw);
    if (type === undefined) {
      findings.push({ file: rel, code: "missing_type", message: "missing type" });
    } else if (type.length === 0) {
      findings.push({ file: rel, code: "empty_type", message: "empty type" });
    }
  }
  const actionable = findings.filter((f) => f.code !== "skipped_encrypted");
  return { ok: actionable.length === 0, scanned: files.length, findings };
}
