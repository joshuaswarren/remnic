import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  fileExists,
  listFilesRecursive,
  prepareSafeArchiveRoot,
  readJsonFile,
  resolveSafeArchiveTarget,
  toPosixRelPath,
  writeSafeArchiveTarget,
} from "./fs-utils.js";
import { parseConflictPolicy, type ConflictPolicy } from "./conflict-policy.js";
import { validateManifestRecords } from "./integrity.js";
import { ExportManifestV1Schema } from "./types.js";

export type { ConflictPolicy };

export interface ImportMdOptions {
  targetMemoryDir: string;
  fromDir: string;
  conflict?: ConflictPolicy;
  dryRun?: boolean;
}

export async function importMarkdownBundle(opts: ImportMdOptions): Promise<{ written: number; skipped: number }> {
  const conflict = parseConflictPolicy(opts.conflict, "importMarkdownBundle");
  const fromAbs = path.resolve(opts.fromDir);
  const targetAbs = path.resolve(opts.targetMemoryDir);
  const targetRoot = await prepareSafeArchiveRoot(
    targetAbs,
    "importMarkdownBundle",
    "targetMemoryDir",
  );
  const manifest = ExportManifestV1Schema.parse(
    await readJsonFile(path.join(fromAbs, "manifest.json")),
  );

  const filesAbs = await listFilesRecursive(fromAbs);
  const records: Array<{ path: string; content: Uint8Array }> = [];
  for (const abs of filesAbs) {
    const relPosix = toPosixRelPath(abs, fromAbs);
    if (relPosix === "manifest.json") continue;
    records.push({ path: relPosix, content: await readFile(abs) });
  }
  validateManifestRecords(manifest, records, "importMarkdownBundle");

  const writes: Array<{ relPath: string; content: Uint8Array }> = [];
  let skipped = 0;

  for (const record of records) {
    const relPosix = record.path;
    const dstAbs = await resolveSafeArchiveTarget(targetRoot, relPosix);
    const content = record.content;

    const exists = await fileExists(dstAbs);
    if (exists) {
      if (conflict === "skip") {
        skipped += 1;
        continue;
      }
      if (conflict === "dedupe") {
        try {
          const existing = await readFile(dstAbs);
          if (Buffer.compare(existing, Buffer.from(content)) === 0) {
            skipped += 1;
            continue;
          }
        } catch {
          // fall through to overwrite
        }
      }
    }

    writes.push({ relPath: relPosix, content });
  }

  if (opts.dryRun) return { written: 0, skipped };

  for (const w of writes) {
    await writeSafeArchiveTarget(targetRoot, w.relPath, w.content);
  }

  return { written: writes.length, skipped };
}
