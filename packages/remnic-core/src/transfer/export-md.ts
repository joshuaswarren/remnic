import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION } from "./constants.js";
import { listFilesRecursive, sha256File, toPosixRelPath, writeJsonFile } from "./fs-utils.js";
import type { ExportManifestV1 } from "./types.js";
import { computeTransferOutputRel, isTransferPathExcluded } from "./exclusions.js";

export interface ExportMdOptions {
  memoryDir: string;
  outDir: string;
  includeTranscripts?: boolean;
  pluginVersion: string;
}

export async function exportMarkdownBundle(opts: ExportMdOptions): Promise<void> {
  const includeTranscripts = opts.includeTranscripts === true;
  const outDirAbs = path.resolve(opts.outDir);
  await mkdir(outDirAbs, { recursive: true });

  const memDirAbs = path.resolve(opts.memoryDir);
  const outputRelPosix = computeTransferOutputRel(memDirAbs, outDirAbs);
  const filesAbs = await listFilesRecursive(memDirAbs);

  const manifestFiles: ExportManifestV1["files"] = [];

  for (const abs of filesAbs) {
    const relPosix = toPosixRelPath(abs, memDirAbs);
    if (isTransferPathExcluded(relPosix, { includeTranscripts, outputRelPosix })) continue;

    const dstAbs = path.join(outDirAbs, ...relPosix.split("/"));
    await mkdir(path.dirname(dstAbs), { recursive: true });
    const content = await readFile(abs);
    await writeFile(dstAbs, content);
    const { sha256, bytes } = await sha256File(abs);
    manifestFiles.push({ path: relPosix, sha256, bytes });
  }

  const manifest: ExportManifestV1 = {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    pluginVersion: opts.pluginVersion,
    includesTranscripts: includeTranscripts,
    files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
  };

  await writeJsonFile(path.join(outDirAbs, "manifest.json"), manifest);
}

export async function looksLikeEngramMdExport(fromDir: string): Promise<boolean> {
  const dirAbs = path.resolve(fromDir);
  try {
    const raw = await readFile(path.join(dirAbs, "manifest.json"), "utf-8");
    const parsed = JSON.parse(raw) as { format?: string; schemaVersion?: number };
    return parsed.format === EXPORT_FORMAT && parsed.schemaVersion === EXPORT_SCHEMA_VERSION;
  } catch {
    return false;
  }
}
