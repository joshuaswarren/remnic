import { lstat, mkdir, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { log } from "../logger.js";
import type { FaissConversationIndexAdapter } from "./faiss-adapter.js";
import type { ConversationChunk } from "./chunker.js";

const MAX_PATH_COMPONENT_LENGTH = 200;

function sanitizePathComponent(
  value: string,
  fallback: string,
  opts: { lowercase?: boolean } = {},
): string {
  const raw = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
  const normalized = opts.lowercase ? raw.toLowerCase() : raw;
  const sanitized = normalized
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, MAX_PATH_COMPONENT_LENGTH);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return fallback;
  }
  return sanitized;
}

export function sanitizeSessionKey(sessionKey: string): string {
  const raw = typeof sessionKey === "string" && sessionKey.trim().length > 0
    ? sessionKey.trim()
    : "";
  const safe = sanitizePathComponent(raw, "unknown-session", { lowercase: true });
  if (!raw) return safe;
  const suffix = `-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
  return `${safe.slice(0, MAX_PATH_COMPONENT_LENGTH - suffix.length)}${suffix}`;
}

function sanitizeChunkId(id: string): string {
  return sanitizePathComponent(id, "chunk");
}

function datePathComponent(startTs: string): string {
  const match = typeof startTs === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(startTs)
    : null;
  if (!match) {
    throw new Error("invalid conversation chunk start timestamp");
  }
  const date = new Date(startTs);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("invalid conversation chunk start timestamp");
  }
  const [, year, month, day] = match;
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new Error("invalid conversation chunk start timestamp");
  }
  return date.toISOString().slice(0, 10);
}

function resolveInsideRoot(rootDir: string, candidate: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(candidate);
  const rel = path.relative(root, resolved);
  if (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  ) {
    return resolved;
  }
  throw new Error("conversation chunk path escapes index root");
}

async function lstatIfExists(candidate: string): Promise<Stats | undefined> {
  try {
    return await lstat(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function rejectSymlinkIfExists(candidate: string): Promise<void> {
  const stat = await lstatIfExists(candidate);
  if (stat?.isSymbolicLink()) {
    throw new Error("conversation chunk path contains symlink");
  }
}

async function rejectExistingSymlinksInPath(baseDir: string, candidate: string): Promise<void> {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(candidate);

  let current = base;
  while (current !== path.dirname(current)) {
    const stat = await lstatIfExists(current);
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new Error("conversation chunk path contains symlink");
      }
      break;
    }
    current = path.dirname(current);
  }

  const relative = path.relative(base, resolved);
  if (relative === "") return;

  current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstatIfExists(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error("conversation chunk path contains symlink");
    }
  }
}

async function rejectExistingSymlinkAncestors(
  rootDir: string,
  candidate: string,
): Promise<void> {
  const root = path.resolve(rootDir);
  const resolved = resolveInsideRoot(root, candidate);
  await rejectExistingSymlinksInPath(root, resolved);
}

export async function writeConversationChunks(
  rootDir: string,
  chunks: ConversationChunk[],
): Promise<string[]> {
  const written: string[] = [];
  const root = path.resolve(rootDir);
  await rejectExistingSymlinksInPath(root, root);
  await mkdir(root, { recursive: true });
  await rejectExistingSymlinksInPath(root, root);

  for (const c of chunks) {
    const safe = sanitizeSessionKey(c.sessionKey);
    const date = datePathComponent(c.startTs);
    const dir = resolveInsideRoot(root, path.join(root, safe, date));
    await rejectExistingSymlinkAncestors(root, dir);
    await mkdir(dir, { recursive: true });
    await rejectExistingSymlinkAncestors(root, dir);
    const fp = resolveInsideRoot(root, path.join(dir, `${sanitizeChunkId(c.id)}.md`));
    await rejectExistingSymlinkAncestors(root, path.dirname(fp));
    await rejectSymlinkIfExists(fp);
    const content =
      `---\n` +
      `kind: conversation_chunk\n` +
      `sessionKey: ${c.sessionKey}\n` +
      `startTs: ${c.startTs}\n` +
      `endTs: ${c.endTs}\n` +
      `---\n\n` +
      c.text +
      "\n";
    await writeFile(fp, content, "utf-8");
    written.push(fp);
  }
  return written;
}

export interface ConversationChunkUpsertResult {
  upserted: number;
  skipped: boolean;
  reason?: "adapter-unavailable" | "adapter-error";
}

export interface ConversationChunkRebuildResult {
  rebuilt: number;
  skipped: boolean;
  reason?: "adapter-unavailable" | "adapter-error";
}

export async function upsertConversationChunksFailOpen(
  adapter: FaissConversationIndexAdapter | undefined,
  chunks: ConversationChunk[],
  options: { retentionCutoffMs?: number } = {},
): Promise<ConversationChunkUpsertResult> {
  if (!adapter) {
    return { upserted: 0, skipped: true, reason: "adapter-unavailable" };
  }
  try {
    const upserted = await adapter.upsertChunks(chunks, options);
    return { upserted, skipped: false };
  } catch (err) {
    log.debug(`conversation index FAISS upsert failed (fail-open): ${err}`);
    return { upserted: 0, skipped: true, reason: "adapter-error" };
  }
}

export async function rebuildConversationChunksFailOpen(
  adapter: FaissConversationIndexAdapter | undefined,
  chunks: ConversationChunk[],
): Promise<ConversationChunkRebuildResult> {
  if (!adapter) {
    return { rebuilt: 0, skipped: true, reason: "adapter-unavailable" };
  }
  try {
    const rebuilt = await adapter.rebuildChunks(chunks);
    return { rebuilt, skipped: false };
  } catch (err) {
    log.debug(`conversation index FAISS rebuild failed (fail-open): ${err}`);
    return { rebuilt: 0, skipped: true, reason: "adapter-error" };
  }
}
