import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.js";
import {
  fileExists,
  prepareSafeArchiveRoot,
  resolveSafeArchiveTarget,
} from "./fs-utils.js";
import { openBetterSqlite3 } from "../runtime/better-sqlite.js";

export type ConflictPolicy = "skip" | "overwrite" | "dedupe";

export interface ImportSqliteOptions {
  targetMemoryDir: string;
  fromFile: string;
  conflict?: ConflictPolicy;
  dryRun?: boolean;
}

function normalizeForDedupe(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function importSqlite(opts: ImportSqliteOptions): Promise<{ written: number; skipped: number }> {
  const conflict = opts.conflict ?? "skip";
  const memDirAbs = path.resolve(opts.targetMemoryDir);
  const memoryRoot = await prepareSafeArchiveRoot(
    memDirAbs,
    "importSqlite",
    "targetMemoryDir",
  );
  const fromAbs = path.resolve(opts.fromFile);
  const db = openBetterSqlite3(fromAbs, { readonly: true });

  const written: Array<{ abs: string; content: string }> = [];
  let skipped = 0;

  try {
    const metaRows = db.prepare("SELECT key,value FROM meta").all() as Array<{ key: string; value: string }>;
    const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
    if (String(meta.schemaVersion) !== String(SQLITE_SCHEMA_VERSION)) {
      throw new Error(`unsupported sqlite schemaVersion: ${meta.schemaVersion}`);
    }

    const rows = db.prepare("SELECT path_rel, content FROM files").all() as Array<{ path_rel: string; content: string }>;
    for (const r of rows) {
      const absTarget = await resolveSafeArchiveTarget(memoryRoot, r.path_rel);

      const exists = await fileExists(absTarget);
      if (exists) {
        if (conflict === "skip") {
          skipped += 1;
          continue;
        }
        if (conflict === "dedupe") {
          try {
            const existing = await (await import("node:fs/promises")).readFile(absTarget, "utf-8");
            if (normalizeForDedupe(existing) === normalizeForDedupe(r.content)) {
              skipped += 1;
              continue;
            }
          } catch {
            // fall through
          }
        }
      }
      written.push({ abs: absTarget, content: r.content });
    }
  } finally {
    db.close();
  }

  if (opts.dryRun) return { written: 0, skipped };

  for (const w of written) {
    await mkdir(path.dirname(w.abs), { recursive: true });
    await writeFile(w.abs, w.content, "utf-8");
  }

  return { written: written.length, skipped };
}
