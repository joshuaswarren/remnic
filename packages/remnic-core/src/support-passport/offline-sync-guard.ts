import path from "node:path";

import type { OfflineSyncFileTarget } from "../offline-sync-file-io.js";
import { parseFrontmatter } from "../storage.js";
import { validateArchiveRelativePath } from "../transfer/fs-utils.js";
import type { MemoryFile } from "../types.js";
import {
  createSupportPassportPrivateFileExclusion,
  isSupportPassportPrivateMemory,
} from "./card-projection.js";

const MAX_SUPPORT_PASSPORT_FRONTMATTER_BYTES = 1_048_576;
const SUPPORT_PASSPORT_MARKER = "support-passport-";
const FRONTMATTER_PREFIXES = ["---\n", "---\r\n"] as const;

type FrontmatterDecision = "allow" | "wait";

function frontmatterPrefixState(raw: Buffer): "absent" | "present" | "pending" {
  const prefix = raw.subarray(0, Math.min(raw.length, 5)).toString("utf8");
  if (FRONTMATTER_PREFIXES.some((candidate) => prefix.startsWith(candidate))) return "present";
  if (FRONTMATTER_PREFIXES.some((candidate) => candidate.startsWith(prefix))) return "pending";
  return "absent";
}

function completeFrontmatter(raw: Buffer): string | null {
  const text = raw.toString("utf8");
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] ?? null;
}

function assertFrontmatterAllowed(frontmatter: string, relativePath: string): void {
  const parsed = parseFrontmatter(frontmatter);
  if (
    frontmatter.includes(SUPPORT_PASSPORT_MARKER)
    || (parsed !== null && isSupportPassportPrivateMemory(parsed))
  ) {
    throw new Error(`offline sync cannot modify private support-passport record: ${relativePath}`);
  }
}

function inspectBufferedFrontmatter(
  raw: Buffer,
  relativePath: string,
  endOfFile: boolean,
): FrontmatterDecision {
  const prefixState = frontmatterPrefixState(raw);
  if (prefixState === "absent") return "allow";
  if (prefixState === "pending" && !endOfFile) return "wait";

  const frontmatter = completeFrontmatter(raw);
  if (frontmatter !== null) {
    assertFrontmatterAllowed(frontmatter, relativePath);
    return "allow";
  }
  if (raw.length > MAX_SUPPORT_PASSPORT_FRONTMATTER_BYTES) {
    throw new Error(`offline sync frontmatter is too large: ${relativePath}`);
  }
  if (endOfFile) {
    assertFrontmatterAllowed(raw.toString("utf8"), relativePath);
    return "allow";
  }
  return "wait";
}

async function* guardSupportPassportChunks(
  chunks: AsyncIterable<Buffer>,
  relativePath: string,
): AsyncIterable<Buffer> {
  const buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let passThrough = false;
  for await (const chunk of chunks) {
    if (passThrough) {
      yield chunk;
      continue;
    }
    buffered.push(chunk);
    bufferedBytes += chunk.length;
    const raw = Buffer.concat(buffered, bufferedBytes);
    if (inspectBufferedFrontmatter(raw, relativePath, false) === "wait") continue;
    for (const bufferedChunk of buffered) yield bufferedChunk;
    passThrough = true;
  }
  if (!passThrough && bufferedBytes > 0) {
    const raw = Buffer.concat(buffered, bufferedBytes);
    inspectBufferedFrontmatter(raw, relativePath, true);
    for (const bufferedChunk of buffered) yield bufferedChunk;
  }
}

export function createSupportPassportOfflineSyncGuard(storage: {
  dir: string;
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
}) {
  const excludePrivateFile = createSupportPassportPrivateFileExclusion(storage);

  const targetForPath = (relativePath: string): OfflineSyncFileTarget => {
    const normalizedPath = validateArchiveRelativePath(relativePath, "path");
    return {
      root: storage.dir,
      path: normalizedPath,
      filePath: path.resolve(storage.dir, ...normalizedPath.split("/")),
    };
  };

  const assertTargetAllowed = async (target: OfflineSyncFileTarget): Promise<void> => {
    if (await excludePrivateFile(target)) {
      throw new Error(`offline sync cannot modify private support-passport record: ${target.path}`);
    }
  };

  return {
    async assertPathAllowed(relativePath: string): Promise<void> {
      await assertTargetAllowed(targetForPath(relativePath));
    },
    assertContentAllowed(relativePath: string, content: Buffer): void {
      inspectBufferedFrontmatter(content, relativePath, true);
    },
    assertTargetAllowed,
    guardChunks(relativePath: string, chunks: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
      return guardSupportPassportChunks(chunks, relativePath);
    },
    excludePrivateFile,
  };
}
