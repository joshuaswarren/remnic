import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** OKF spec version emitted in every bundle root index. */
export const OKF_EXPORT_VERSION = "0.1";

export function renderFrontmatter(fields: Record<string, unknown>): string {
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

/**
 * Write one file into a bundle staging tree. `rel` is a POSIX-style
 * bundle-relative path; parent directories are created as needed.
 */
export function writeBundleFile(root: string, rel: string, content: string): void {
  const dest = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content, "utf8");
}

/**
 * Publish a staged bundle: refuse a non-empty target without `--force`,
 * swap via rename so the target is never observed half-written, and keep a
 * restorable backup when replacing an existing tree.
 */
export function publishBundle(staging: string, outDir: string, force: boolean): void {
  let exists = false;
  try {
    const stat = lstatSync(outDir);
    if (stat.isSymbolicLink()) throw new Error(`--out must not be a symlink: ${outDir}`);
    if (!stat.isDirectory()) throw new Error(`--out exists and is not a directory: ${outDir}`);
    exists = true;
    const entries = readdirSync(outDir).filter((name) => name !== "." && name !== "..");
    if (entries.length > 0 && !force) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`--out ${outDir} is not empty; pass --force to replace it`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(path.dirname(outDir), { recursive: true });
  if (exists && force) {
    const backup = `${outDir}.okf-prev-${randomUUID().slice(0, 8)}`;
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
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // Keep the backup when the restore itself fails: it is the only
        // surviving copy of the operator's previous bundle.
      }
      throw err;
    }
    return;
  }
  renameSync(staging, outDir);
}

export function rejectSymlinkPath(target: string): void {
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

