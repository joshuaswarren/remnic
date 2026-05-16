import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ExportBundleV1Schema } from "./types.js";
import {
  fileExists,
  prepareSafeArchiveRoot,
  readJsonFile,
  resolveSafeArchiveTarget,
  type SafeArchiveRoot,
} from "./fs-utils.js";

export type ConflictPolicy = "skip" | "overwrite" | "dedupe";

export interface ImportJsonOptions {
  targetMemoryDir: string;
  fromDir: string;
  conflict?: ConflictPolicy;
  dryRun?: boolean;
  workspaceDir?: string;
}

function normalizeForDedupe(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function importJsonBundle(opts: ImportJsonOptions): Promise<{ written: number; skipped: number }> {
  const conflict = opts.conflict ?? "skip";
  const fromDirAbs = path.resolve(opts.fromDir);
  const bundlePath = path.join(fromDirAbs, "bundle.json");
  const bundle = ExportBundleV1Schema.parse(await readJsonFile(bundlePath));

  const memDirAbs = path.resolve(opts.targetMemoryDir);
  const memoryRoot = await prepareSafeArchiveRoot(
    memDirAbs,
    "importJsonBundle",
    "targetMemoryDir",
  );
  const written: Array<{ abs: string; content: string }> = [];

  let skipped = 0;
  let workspaceRoot: SafeArchiveRoot | null = null;

  for (const rec of bundle.records) {
    const isWorkspace = rec.path.startsWith("workspace/");
    let absTarget: string;
    if (isWorkspace) {
      if (!opts.workspaceDir) {
        skipped += 1;
        continue;
      }
      workspaceRoot ??= await prepareSafeArchiveRoot(
        path.resolve(opts.workspaceDir),
        "importJsonBundle",
        "workspaceDir",
      );
      absTarget = await resolveSafeArchiveTarget(
        workspaceRoot,
        rec.path.slice("workspace/".length),
      );
    } else {
      absTarget = await resolveSafeArchiveTarget(memoryRoot, rec.path);
    }

    const exists = await fileExists(absTarget);
    if (exists) {
      if (conflict === "skip") {
        skipped += 1;
        continue;
      }
      if (conflict === "dedupe") {
        try {
          const existing = await (await import("node:fs/promises")).readFile(absTarget, "utf-8");
          if (normalizeForDedupe(existing) === normalizeForDedupe(rec.content)) {
            skipped += 1;
            continue;
          }
        } catch {
          // if can't read, fall through to overwrite
        }
      }
      // overwrite: proceed
    }

    written.push({ abs: absTarget, content: rec.content });
  }

  if (opts.dryRun) {
    return { written: 0, skipped };
  }

  for (const w of written) {
    await mkdir(path.dirname(w.abs), { recursive: true });
    await writeFile(w.abs, w.content, "utf-8");
  }

  return { written: written.length, skipped };
}

export function looksLikeEngramJsonExport(fromDir: string): Promise<boolean> {
  const dir = path.resolve(fromDir);
  return Promise.all([
    fileExists(path.join(dir, "manifest.json")),
    fileExists(path.join(dir, "bundle.json")),
  ]).then(([m, b]) => m && b);
}
