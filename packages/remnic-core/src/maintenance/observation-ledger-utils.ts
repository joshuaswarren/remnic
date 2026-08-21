import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeFileAtomically } from "./atomic-file.js";

interface LedgerWriteOptions<T extends object> {
  memoryDir: string;
  outputPath: string;
  rows: T[];
  now: Date;
  atomicWrite?: typeof writeFileAtomically;
}

export function toHourBucketIso(timestamp: string): string | null {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp) ? timestamp : `${timestamp}Z`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export async function backupAndWriteRebuiltObservations<T extends object>(
  options: LedgerWriteOptions<T>,
): Promise<string | undefined> {
  const stamp = options.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const atomicWrite = options.atomicWrite ?? writeFileAtomically;
  const archiveRoot = path.join(options.memoryDir, "archive", "observations", stamp);
  let backupPath: string | undefined = path.join(
    archiveRoot,
    "state",
    "observation-ledger",
    "rebuilt-observations.jsonl",
  );
  try {
    const existing = await readFile(options.outputPath, "utf-8");
    await atomicWrite(backupPath, existing);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code === "ENOENT") {
      backupPath = undefined;
    } else {
      throw err;
    }
  }

  const rebuiltAt = options.now.toISOString();
  const lines = options.rows.map((row) =>
    JSON.stringify({
      ...row,
      rebuiltAt,
    }),
  );
  await atomicWrite(options.outputPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return backupPath;
}
