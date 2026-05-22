import path from "node:path";

export const DEFAULT_TRANSFER_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".secure-store",
  ".capsules",
]);

export interface TransferPathExcludeOptions {
  includeTranscripts?: boolean;
  outputRelPosix?: string | null;
}

export function computeTransferOutputRel(rootAbs: string, outputAbs: string): string | null {
  const rel = path.relative(rootAbs, outputAbs);
  if (rel === "") {
    throw new Error("transfer export output path must not equal the memory directory");
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return null;
  if (path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export function isTransferPathExcluded(relPosix: string, options: TransferPathExcludeOptions = {}): boolean {
  const parts = relPosix.split("/");
  if (parts.some((part) => DEFAULT_TRANSFER_EXCLUDE_DIRS.has(part))) return true;
  if (!options.includeTranscripts && parts[0] === "transcripts") return true;

  const outputRelPosix = options.outputRelPosix ?? null;
  if (outputRelPosix !== null) {
    if (outputRelPosix === ".") return true;
    if (relPosix === outputRelPosix || relPosix.startsWith(`${outputRelPosix}/`)) return true;
    if (
      relPosix === `${outputRelPosix}-wal` ||
      relPosix === `${outputRelPosix}-shm` ||
      relPosix === `${outputRelPosix}-journal`
    ) {
      return true;
    }
  }

  return false;
}
