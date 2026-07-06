/**
 * Chat session state — transcript + pending-plan pointer persisted under
 * `<memoryDir>/state/chat/<chatSessionId>.jsonl` (issue #1583).
 *
 * Atomic appends (rule 54).  Chat transcripts are excluded from memory
 * extraction — the work-task exclusion tag is stamped on creation so talking
 * *about* memories does not create memories of the conversation itself.
 */

import { mkdir, readFile, appendFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ChatSessionState, ChatTranscriptEntry } from "./chat-types.js";

const CHAT_DIR_NAME = "state/chat";

/**
 * Resolve the chat-session directory for a given memory dir.
 */
export function chatSessionDir(memoryDir: string): string {
  return join(memoryDir, CHAT_DIR_NAME);
}

/**
 * Resolve the transcript file path for a chat session id.
 */
export function chatSessionFile(memoryDir: string, chatSessionId: string): string {
  return join(chatSessionDir(memoryDir), `${chatSessionId}.jsonl`);
}

/**
 * Create a new chat session.  The session binds the caller's principal and
 * sessionKey at creation (rule 42); every tool call flows through
 * access-service with that identity.
 */
export async function createChatSession(
  memoryDir: string,
  opts: { principal?: string; sessionKey?: string; namespace?: string },
): Promise<ChatSessionState> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const state: ChatSessionState = {
    id,
    principal: opts.principal,
    sessionKey: opts.sessionKey,
    namespace: opts.namespace,
    transcript: [],
    confirmedPlanIds: new Set(),
    createdAt: now,
  };
  // Ensure the directory exists.
  await mkdir(chatSessionDir(memoryDir), { recursive: true });
  // Write a metadata header line so the file is never empty and carries
  // the principal/scope binding (used for per-session isolation checks).
  await appendFile(
    chatSessionFile(memoryDir, id),
    JSON.stringify({
      seq: 0,
      ts: now,
      role: "system" as const,
      content: `Chat session created. Principal: ${opts.principal ?? "default"}. Namespace: ${opts.namespace ?? "default"}. work_task: Excluded from memory extraction`,
    }) + "\n",
    "utf8",
  );
  return state;
}

/**
 * Load a chat session from disk, including its full transcript.
 * Returns `null` if the session file does not exist.
 *
 * Per-session isolation: the caller MUST verify that the loaded session's
 * principal matches the requesting principal before operating on it.
 */
export async function loadChatSession(
  memoryDir: string,
  chatSessionId: string,
): Promise<ChatSessionState | null> {
  let raw: string;
  try {
    raw = await readFile(chatSessionFile(memoryDir, chatSessionId), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const transcript: ChatTranscriptEntry[] = [];
  let principal: string | undefined;
  let sessionKey: string | undefined;
  let namespace: string | undefined;
  let createdAt = "";
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ChatTranscriptEntry;
      transcript.push(entry);
      // Extract binding from the system header line.
      if (entry.role === "system" && entry.seq === 0) {
        const pMatch = entry.content.match(/Principal: ([^.]+)/);
        if (pMatch) principal = pMatch[1]?.trim() === "default" ? undefined : pMatch[1]?.trim();
        const nsMatch = entry.content.match(/Namespace: ([^.]+)/);
        if (nsMatch) namespace = nsMatch[1]?.trim() === "default" ? undefined : nsMatch[1]?.trim();
        createdAt = entry.ts;
      }
    } catch {
      // Skip malformed lines (rule 54 — atomic appends; partial lines are
      // tolerated, never crash the engine).
    }
  }
  return {
    id: chatSessionId,
    principal,
    sessionKey,
    namespace,
    transcript,
    confirmedPlanIds: new Set(),
    createdAt,
  };
}

/**
 * Append a transcript entry to the session file (atomic append, rule 54).
 */
export async function appendTranscriptEntry(
  memoryDir: string,
  chatSessionId: string,
  entry: Omit<ChatTranscriptEntry, "seq" | "ts">,
): Promise<ChatTranscriptEntry> {
  const full: ChatTranscriptEntry = {
    ...entry,
    seq: Date.now(),
    ts: new Date().toISOString(),
  };
  await appendFile(
    chatSessionFile(memoryDir, chatSessionId),
    JSON.stringify(full) + "\n",
    "utf8",
  );
  return full;
}

/**
 * Clean up expired chat sessions based on TTL.
 */
export async function cleanupExpiredChatSessions(
  memoryDir: string,
  ttlHours: number,
): Promise<number> {
  const dir = chatSessionDir(memoryDir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    try {
      const filePath = join(dir, file);
      const st = await stat(filePath);
      const ageHours = (now - st.mtimeMs) / (1000 * 60 * 60);
      // TTL of 0 = expire everything immediately. For positive TTLs the
      // boundary is inclusive; sub-millisecond APFS mtime skew is negligible
      // against an hour-scale threshold (rule 54 — deterministic cleanup).
      if (ttlHours <= 0 || ageHours >= ttlHours) {
        await unlink(filePath);
        removed++;
      }
    } catch {
      // Best-effort cleanup; skip files we can't stat/unlink.
    }
  }
  return removed;
}

/**
 * Verify that a session belongs to the given principal (rule 42/47 —
 * per-session isolation, no cross-visibility).
 */
export function sessionBelongsToPrincipal(
  session: ChatSessionState,
  principal?: string,
): boolean {
  // A session with no recorded principal is accessible to anyone (legacy/
  // single-user case).  A session with a principal requires an exact match.
  if (!session.principal) return true;
  return session.principal === principal;
}
