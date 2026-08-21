import path from "node:path";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.js";
import {
  fileExists,
  prepareSafeArchiveRoot,
  resolveSafeArchiveTarget,
  writeSafeArchiveTarget,
} from "./fs-utils.js";
import { parseConflictPolicy, type ConflictPolicy } from "./conflict-policy.js";
import { openBetterSqlite3 } from "../runtime/better-sqlite.js";
import { validateManifestRecords } from "./integrity.js";

export type { ConflictPolicy };

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
  const conflict = parseConflictPolicy(opts.conflict, "importSqlite");
  const memDirAbs = path.resolve(opts.targetMemoryDir);
  const memoryRoot = await prepareSafeArchiveRoot(
    memDirAbs,
    "importSqlite",
    "targetMemoryDir",
  );
  const fromAbs = path.resolve(opts.fromFile);
  const db = openBetterSqlite3(fromAbs, { readonly: true });

  const written: Array<{ relPath: string; content: string }> = [];
  let skipped = 0;

  try {
    const metaRows = db.prepare("SELECT key,value FROM meta").all() as Array<{ key: string; value: string }>;
    const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
    if (String(meta.schemaVersion) !== String(SQLITE_SCHEMA_VERSION)) {
      throw new Error(`unsupported sqlite schemaVersion: ${meta.schemaVersion}`);
    }

    const rows = db.prepare("SELECT path_rel, bytes, sha256, content FROM files").all() as Array<{
      path_rel: string;
      bytes: number;
      sha256: string;
      content: string;
    }>;
    validateManifestRecords(
      {
        files: rows.map((row) => ({
          path: row.path_rel,
          bytes: row.bytes,
          sha256: row.sha256,
        })),
      },
      rows.map((row) => ({ path: row.path_rel, content: row.content })),
      "importSqlite",
    );

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
      written.push({ relPath: r.path_rel, content: r.content });
    }
  } finally {
    db.close();
  }

  if (opts.dryRun) return { written: 0, skipped };

  for (const w of written) {
    await writeSafeArchiveTarget(memoryRoot, w.relPath, w.content);
  }

  return { written: written.length, skipped };
}
