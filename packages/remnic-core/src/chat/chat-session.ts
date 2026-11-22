
import { mkdir, readFile, appendFile, readdir, stat, unlink, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { enforceNamespaceAllowList, tokenCapabilityStore } from "../access-token-capabilities.js";

import type { ChatSessionState, ChatTranscriptEntry } from "./chat-types.js";

const CHAT_DIR_NAME = "state/chat";

export function chatSessionDir(memoryDir: string): string {
  return join(memoryDir, CHAT_DIR_NAME);
}

/**
 * Validate a chat session id is safe for filesystem use (no path traversal).
 * Accepts UUIDs and alphanumeric+dash identifiers only (P1 — path safety).
 */
export function isSafeChatSessionId(chatSessionId: string): boolean {
  return /^[A-Za-z0-9]{8,128}$/.test(chatSessionId.replace(/-/g, ""));
}

export function chatSessionFile(memoryDir: string, chatSessionId: string): string {
  if (!isSafeChatSessionId(chatSessionId)) {
    throw new Error("Invalid chat session id");
  }
  return join(chatSessionDir(memoryDir), `${chatSessionId}.jsonl`);
}


let lastTranscriptSeq = 0;

function nextTranscriptSeq(): number {
  const now = Date.now();
  lastTranscriptSeq = now > lastTranscriptSeq ? now : lastTranscriptSeq + 1;
  return lastTranscriptSeq;
}

/**
 * Test-only: reset the module-level transcript seq counter so a regression
 * test can deterministically simulate a fresh process restart (issue #1718).
 */
export function __resetTranscriptSeqForTest(): void {
  lastTranscriptSeq = 0;
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
  await mkdir(chatSessionDir(memoryDir), { recursive: true });
  await appendFile(
    chatSessionFile(memoryDir, id),
    JSON.stringify({
      seq: 0,
      ts: now,
      role: "system" as const,
      content: `Chat session created. Principal: ${opts.principal ?? "default"}. Namespace: ${opts.namespace ?? "default"}. work_task: Excluded from memory extraction`,
      ...(opts.principal ? { principal: opts.principal } : {}),
      ...(opts.namespace ? { namespace: opts.namespace } : {}),
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
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
  let pendingPlanId: string | undefined;
  let pendingPromotionId: string | undefined;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ChatTranscriptEntry & Record<string, unknown>;
      transcript.push(entry);
      if (entry.role === "system" && entry.seq === 0) {
        const metaPrincipal = typeof entry.principal === "string" ? entry.principal : undefined;
        const metaNamespace = typeof entry.namespace === "string" ? entry.namespace : undefined;
        const metaSessionKey = typeof entry.sessionKey === "string" ? entry.sessionKey : undefined;
        if (metaPrincipal) principal = metaPrincipal;
        else {
          // Greedy regex fallback for older session files (captures until ". Namespace").
          const pMatch = entry.content.match(/Principal: (.+?)\.\s/);
          if (pMatch) principal = pMatch[1]?.trim() === "default" ? undefined : pMatch[1]?.trim();
        }
        if (metaNamespace) namespace = metaNamespace;
        else {
          const nsMatch = entry.content.match(/Namespace: (.+?)\.\s/);
          if (nsMatch) namespace = nsMatch[1]?.trim() === "default" ? undefined : nsMatch[1]?.trim();
        }
        if (metaSessionKey) sessionKey = metaSessionKey;
        createdAt = entry.ts;
      }
      if (entry.role === "system") {
        const pm = entry.content.match(/^pending_plan:(.+)$/);
        if (pm) pendingPlanId = pm[1];
        const pp = entry.content.match(/^pending_promotion:(.+)$/);
        if (pp) pendingPromotionId = pp[1];
        const resolved = entry.content.match(/^(plan_applied|plan_cancelled|promotion_applied|promotion_cancelled):/);
        if (resolved) {
          if (entry.content.startsWith("plan_")) {
            pendingPlanId = undefined;
          }
          if (entry.content.startsWith("promotion_")) {
            pendingPromotionId = undefined;
          }
        }
      }
    } catch {
      // Skip malformed lines (rule 54 — atomic appends; partial lines are
      // tolerated, never crash the engine).
    }
  }
  for (const e of transcript) {
    if (typeof e.seq === "number" && e.seq + 1 > lastTranscriptSeq) {
      lastTranscriptSeq = e.seq + 1;
    }
  }
  return {
    id: chatSessionId,
    principal,
    sessionKey,
    namespace,
    transcript,
    confirmedPlanIds: new Set(),
    ...(pendingPlanId ? { pendingPlanId } : {}),
    ...(pendingPromotionId ? { pendingPromotionId } : {}),
    createdAt,
  };
}

/**
 * Structural shape {@link enforceChatSessionNamespace} reads from a service —
 * `memoryDir` to locate the session file and `configRef.defaultNamespace` to
 * resolve the effective namespace. Kept structural so the chat module need not
 * depend on the full {@link EngramAccessService} type.
 */
export interface ChatSessionNamespaceHost {
  memoryDir: string;
  configRef?: { defaultNamespace?: string } | undefined;
}

export async function enforceChatSessionNamespace(
  service: ChatSessionNamespaceHost,
  chatSessionId: string,
): Promise<void> {
  const session = await loadChatSession(service.memoryDir, chatSessionId);
  if (!session) return;
  enforceNamespaceAllowList(tokenCapabilityStore.getStore(), session.namespace, service.configRef?.defaultNamespace);
}

/**
 * Append a transcript entry to the session file (atomic append, rule 54).
 *
 * After the append resolves, in-process subscribers (open SSE connections —
 * issue #1687) are notified synchronously so live clients receive the new
 * entry without polling.  Listener errors are swallowed so a misbehaving
 * subscriber can never break a transcript append (rule 54 — atomic + safe).
 */
export async function appendTranscriptEntry(
  memoryDir: string,
  chatSessionId: string,
  entry: Omit<ChatTranscriptEntry, "seq" | "ts">,
): Promise<ChatTranscriptEntry> {
  const filePath = chatSessionFile(memoryDir, chatSessionId);
  const full: ChatTranscriptEntry = {
    ...entry,
    seq: nextTranscriptSeq(),
    ts: new Date().toISOString(),
  };
  let fh;
  try {
    fh = await open(filePath, fsConstants.O_APPEND | fsConstants.O_WRONLY);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("chat_session_expired");
    }
    throw err;
  }
  try {
    await fh.appendFile(JSON.stringify(full) + "\n", "utf8");
  } finally {
    await fh.close();
  }
  try {
    await stat(filePath);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("chat_session_expired");
    }
    throw err;
  }
  notifyTranscriptListeners(memoryDir, chatSessionId, full);
  return full;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const transcriptListeners = new Map<string, Set<(entry: ChatTranscriptEntry) => void>>();

function transcriptListenerKey(memoryDir: string, chatSessionId: string): string {
  return `${memoryDir}\x00${chatSessionId}`;
}

function notifyTranscriptListeners(memoryDir: string, chatSessionId: string, entry: ChatTranscriptEntry): void {
  const set = transcriptListeners.get(transcriptListenerKey(memoryDir, chatSessionId));
  if (!set) return;
  for (const fn of set) {
    try {
      fn(entry);
    } catch {
      // A listener must never break the append path (rule 54).
    }
  }
}

/**
 * Subscribe to live transcript entries for a chat session in a given memory
 * store.  Returns an unsubscribe function that removes the listener and
 * prunes the session's set when it becomes empty.  Used by the SSE handler
 * to push new user/assistant entries to connected clients (issue #1687).
 *
 * The `memoryDir` scopes the subscription to its store so a process hosting
 * two Remnic services cannot cross-deliver transcript entries (AGENTS.md
 * State Scoping).
 */
export function subscribeChatTranscript(
  memoryDir: string,
  chatSessionId: string,
  listener: (entry: ChatTranscriptEntry) => void,
): () => void {
  const key = transcriptListenerKey(memoryDir, chatSessionId);
  let set = transcriptListeners.get(key);
  if (!set) {
    set = new Set();
    transcriptListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = transcriptListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      transcriptListeners.delete(key);
    }
  };
}

export async function markPendingPlan(
  memoryDir: string,
  chatSessionId: string,
  planId: string,
): Promise<void> {
  await appendTranscriptEntry(memoryDir, chatSessionId, {
    role: "system",
    content: `pending_plan:${planId}`,
  });
}

export async function markPendingPromotion(
  memoryDir: string,
  chatSessionId: string,
  memoryId: string,
): Promise<void> {
  await appendTranscriptEntry(memoryDir, chatSessionId, {
    role: "system",
    content: `pending_promotion:${memoryId}`,
  });
}

export async function markPlanResolved(
  memoryDir: string,
  chatSessionId: string,
  planId: string,
): Promise<void> {
  await appendTranscriptEntry(memoryDir, chatSessionId, {
    role: "system",
    content: `plan_applied:${planId}`,
  });
}

export async function markPromotionResolved(
  memoryDir: string,
  chatSessionId: string,
  memoryId: string,
): Promise<void> {
  await appendTranscriptEntry(memoryDir, chatSessionId, {
    role: "system",
    content: `promotion_applied:${memoryId}`,
  });
}

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
        if (ttlHours > 0) {
          const fresh = await stat(filePath);
          const freshAge = (Date.now() - fresh.mtimeMs) / (1000 * 60 * 60);
          if (freshAge < ttlHours) continue;
        }
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
  if (!session.principal) return true;
  return session.principal === principal;
}
