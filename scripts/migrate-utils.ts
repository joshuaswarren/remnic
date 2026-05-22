import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_MEMORY_FILE_WRITE_ATTEMPTS = 8;

export function makeMigrationMemoryId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export async function writeMemoryFileExclusive(opts: {
  memoryDir: string;
  dryRun: boolean;
  subdir: string;
  filename: string;
  content: string;
  log?: (message: string) => void;
}): Promise<"written" | "exists"> {
  const filePath = path.join(opts.memoryDir, opts.subdir, opts.filename);
  if (opts.dryRun) {
    (opts.log ?? console.log)(`  [dry-run] Would write: ${filePath}`);
    return "written";
  }
  try {
    await writeFile(filePath, opts.content, { encoding: "utf-8", flag: "wx" });
    return "written";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "exists";
    }
    throw error;
  }
}

export async function writeMemoryFileWithRetry(opts: {
  memoryDir: string;
  dryRun: boolean;
  subdir: string;
  prefix: string;
  buildContent: (id: string) => string;
  makeId?: (prefix: string) => string;
  maxAttempts?: number;
  log?: (message: string) => void;
}): Promise<{ id: string; filename: string }> {
  const makeId = opts.makeId ?? makeMigrationMemoryId;
  const maxAttempts = opts.maxAttempts ?? MAX_MEMORY_FILE_WRITE_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = makeId(opts.prefix);
    const filename = `${id}.md`;
    const result = await writeMemoryFileExclusive({
      memoryDir: opts.memoryDir,
      dryRun: opts.dryRun,
      subdir: opts.subdir,
      filename,
      content: opts.buildContent(id),
      ...(opts.log ? { log: opts.log } : {}),
    });
    if (result === "written") {
      return { id, filename };
    }
  }
  throw new Error(
    `failed to create a unique migration memory file for prefix ${JSON.stringify(opts.prefix)} after ${maxAttempts} attempts`,
  );
}
