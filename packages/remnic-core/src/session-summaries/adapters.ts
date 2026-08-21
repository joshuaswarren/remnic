import type { LocalSessionParsedFile, LocalSessionRole, LocalSessionSourceAdapter, LocalSessionTurn } from "./types.js";

const VALID_ROLES = new Set<LocalSessionRole>(["user", "assistant", "tool", "system", "other"]);

function normalizeRole(value: unknown): LocalSessionRole {
  if (typeof value !== "string") return "other";
  const role = value.trim().toLowerCase();
  if (VALID_ROLES.has(role as LocalSessionRole)) {
    return role as LocalSessionRole;
  }
  if (role === "human") return "user";
  if (role === "ai" || role === "model" || role === "bot") return "assistant";
  if (role === "function") return "tool";
  return "other";
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizeContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => normalizeContent(part))
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim();
    return parts.length > 0 ? parts : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (firstString(obj.type) === "tool_result") return undefined;
  return normalizeContent(obj.text ?? obj.content ?? obj.message ?? obj.parts ?? obj.value ?? obj.input);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function firstContent(...values: unknown[]): string | undefined {
  for (const value of values) {
    const content = normalizeContent(value);
    if (content) return content;
  }
  return undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

const SESSION_KEY_FIELDS = [
  "sessionKey",
  "session_key",
  "sessionId",
  "session_id",
  "conversationId",
  "conversation_id",
  "threadId",
  "thread_id",
  "transcriptId",
  "transcript_id",
] as const;

function hasUsableSessionKeyField(value: unknown): boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function inheritEnvelopeSessionFields(row: unknown, envelope: Record<string, unknown>): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const child = row as Record<string, unknown>;
  const inherited: Record<string, unknown> = {};
  for (const key of SESSION_KEY_FIELDS) {
    if (!hasUsableSessionKeyField(child[key]) && hasUsableSessionKeyField(envelope[key])) {
      inherited[key] = envelope[key];
    }
  }
  return Object.keys(inherited).length > 0 ? { ...child, ...inherited } : row;
}

function codexRoleFromTypes(
  rowType: string | undefined,
  payloadType: string | undefined
): LocalSessionRole | undefined {
  if (payloadType === "agent_message") return "assistant";
  if (payloadType === "user_message") return "user";
  if (rowType === "event_msg") return "user";
  if (rowType === "response_item") return "assistant";
  return undefined;
}

function sessionKeyFromRow(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const obj = row as Record<string, unknown>;
  const nestedMessage = objectField(obj.message);
  const payload = objectField(obj.payload);
  const payloadMessage = objectField(payload?.message);
  const rowType = firstString(obj.type, obj.kind, obj.event)?.toLowerCase();
  return firstString(
    obj.sessionKey,
    obj.session_key,
    obj.sessionId,
    obj.session_id,
    obj.conversationId,
    obj.conversation_id,
    obj.threadId,
    obj.thread_id,
    obj.transcriptId,
    obj.transcript_id,
    nestedMessage?.sessionKey,
    nestedMessage?.session_key,
    nestedMessage?.sessionId,
    nestedMessage?.session_id,
    nestedMessage?.conversationId,
    nestedMessage?.conversation_id,
    nestedMessage?.threadId,
    nestedMessage?.thread_id,
    nestedMessage?.transcriptId,
    nestedMessage?.transcript_id,
    rowType === "session_meta" ? payload?.id : undefined,
    payload?.sessionKey,
    payload?.session_key,
    payload?.sessionId,
    payload?.session_id,
    payload?.conversationId,
    payload?.conversation_id,
    payload?.threadId,
    payload?.thread_id,
    payload?.transcriptId,
    payload?.transcript_id,
    payloadMessage?.sessionKey,
    payloadMessage?.session_key,
    payloadMessage?.sessionId,
    payloadMessage?.session_id,
    payloadMessage?.conversationId,
    payloadMessage?.conversation_id,
    payloadMessage?.threadId,
    payloadMessage?.thread_id,
    payloadMessage?.transcriptId,
    payloadMessage?.transcript_id
  );
}

function extractRowsFromJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  for (const key of ["turns", "messages", "events", "entries", "items"]) {
    const rows = obj[key];
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.map((row) => inheritEnvelopeSessionFields(row, obj));
    }
  }
  return [obj];
}

function parseJsonlRows(
  content: string,
  adapterId: string,
  strict: boolean | undefined,
  fileRef: string
): { rows: unknown[]; warnings: LocalSessionParsedFile["warnings"] } {
  const rows: unknown[] = [];
  const warnings: LocalSessionParsedFile["warnings"] = [];
  for (const [index, line] of content.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      const warning = {
        code: `${adapterId}.jsonl.invalid_line`,
        message: `Skipping invalid JSONL line ${index + 1} in fileRef ${fileRef}.`,
        fileRef,
        line: index + 1,
      };
      if (strict) throw new Error(warning.message);
      warnings.push(warning);
    }
  }
  return { rows, warnings };
}

function parseRows(
  content: string,
  extension: string,
  adapterId: string,
  strict: boolean | undefined,
  fileRef: string
): { rows: unknown[]; warnings: LocalSessionParsedFile["warnings"] } {
  if (extension === ".jsonl") {
    return parseJsonlRows(content, adapterId, strict, fileRef);
  }
  try {
    return { rows: extractRowsFromJson(JSON.parse(content)), warnings: [] };
  } catch {
    const message = `Invalid ${adapterId} JSON in fileRef ${fileRef}; skipping file.`;
    if (strict) throw new Error(message);
    return {
      rows: [],
      warnings: [{ code: `${adapterId}.json.invalid`, message, fileRef }],
    };
  }
}

function turnFromRow(row: unknown, fallbackSessionKey: string): LocalSessionTurn | null {
  if (!row || typeof row !== "object") return null;
  const obj = row as Record<string, unknown>;
  const nestedMessage = objectField(obj.message);
  const payload = objectField(obj.payload);
  const payloadItem = objectField(payload?.item);
  const payloadMessage = objectField(payload?.message);
  const author = objectField(obj.author);
  const rowType = firstString(obj.type, obj.kind, obj.event);
  const payloadType = firstString(payload?.type, payloadItem?.type);
  const codexRole = codexRoleFromTypes(rowType, payloadType);

  const content = firstContent(
    obj.content,
    obj.text,
    obj.message,
    obj.body,
    obj.parts,
    obj.input,
    payload?.message,
    payload?.content,
    payload?.text,
    payload?.body,
    payload?.parts,
    payload?.input,
    payloadMessage?.content,
    payloadMessage?.text,
    payloadMessage?.parts,
    payloadMessage?.input,
    payloadItem?.content,
    payloadItem?.text,
    payloadItem?.message,
    payloadItem?.parts,
    payloadItem?.input,
    nestedMessage?.content,
    nestedMessage?.text,
    nestedMessage?.parts,
    nestedMessage?.input
  );
  if (!content) return null;

  const role = normalizeRole(
    obj.role ??
      obj.sender ??
      obj.actor ??
      payload?.role ??
      payload?.sender ??
      payloadMessage?.role ??
      payloadMessage?.sender ??
      payloadItem?.role ??
      nestedMessage?.role ??
      nestedMessage?.sender ??
      author?.role ??
      codexRole ??
      obj.type
  );

  return {
    role,
    content,
    timestamp: normalizeTimestamp(
      obj.timestamp ??
        obj.createdAt ??
        obj.created_at ??
        obj.time ??
        obj.date ??
        payload?.timestamp ??
        payload?.createdAt ??
        payload?.created_at ??
        payloadMessage?.timestamp ??
        payloadMessage?.createdAt ??
        payloadMessage?.created_at ??
        payloadItem?.timestamp ??
        payloadItem?.created_at ??
        nestedMessage?.timestamp ??
        nestedMessage?.created_at
    ),
    sessionKey: sessionKeyFromRow(row) ?? fallbackSessionKey,
    sourceId: firstString(obj.id, obj.uuid, obj.turnId, obj.turn_id, payload?.id, payloadItem?.id),
  };
}

function shouldSkipRowForAdapter(adapterId: string, row: unknown): boolean {
  if (adapterId !== "codex-jsonl" || !row || typeof row !== "object") return false;
  const obj = row as Record<string, unknown>;
  const payload = objectField(obj.payload);
  const rowType = firstString(obj.type, obj.kind, obj.event)?.toLowerCase();
  const payloadType = firstString(payload?.type)?.toLowerCase();
  return rowType === "compacted" || payloadType === "compacted";
}

type CodexMirrorSurface = "event-agent-message" | "response-item";

const CODEX_MIRROR_SURFACE_PRIORITY: Record<CodexMirrorSurface, number> = {
  "event-agent-message": 1,
  "response-item": 2,
};

function codexMirrorSurface(row: unknown): CodexMirrorSurface | undefined {
  if (!row || typeof row !== "object") return undefined;
  const obj = row as Record<string, unknown>;
  const payload = objectField(obj.payload);
  const payloadItem = objectField(payload?.item);
  const rowType = firstString(obj.type, obj.kind, obj.event)?.toLowerCase();
  const payloadType = firstString(payload?.type, payloadItem?.type)?.toLowerCase();
  if (rowType === "event_msg" && payloadType === "agent_message") return "event-agent-message";
  if (rowType === "response_item") return "response-item";
  return undefined;
}

function codexMirrorKey(adapterId: string, row: unknown, turn: LocalSessionTurn): string | undefined {
  if (adapterId !== "codex-jsonl" || turn.role !== "assistant") return undefined;
  const surface = codexMirrorSurface(row);
  if (!surface) return undefined;
  const sessionKey = turn.sessionKey?.trim();
  const content = turn.content.replace(/\s+/g, " ").trim();
  if (!sessionKey || content.length === 0) return undefined;
  return `${sessionKey}\0${turn.role}\0${content}`;
}

function pushTurnWithCodexMirrorDedupe(
  adapterId: string,
  row: unknown,
  turn: LocalSessionTurn,
  turns: LocalSessionTurn[],
  codexMirrorTurns: Map<string, { index: number; surface: CodexMirrorSurface; rowSignal?: string }[]>
): void {
  const key = codexMirrorKey(adapterId, row, turn);
  const surface = key ? codexMirrorSurface(row) : undefined;
  if (!key || !surface) {
    turns.push(turn);
    return;
  }

  const candidates = codexMirrorTurns.get(key) ?? [];
  const rowSignal = turn.sourceId ?? turn.timestamp;
  const matchingIndex = candidates.findIndex((candidate) => {
    if (candidate.surface === surface) {
      return Boolean(candidate.rowSignal && rowSignal && candidate.rowSignal === rowSignal);
    }
    return Boolean(candidate.rowSignal && rowSignal && candidate.rowSignal === rowSignal);
  });
  const existing = matchingIndex >= 0 ? candidates[matchingIndex] : undefined;
  if (existing) {
    if (CODEX_MIRROR_SURFACE_PRIORITY[surface] > CODEX_MIRROR_SURFACE_PRIORITY[existing.surface]) {
      turns[existing.index] = turn;
      candidates[matchingIndex] = { index: existing.index, surface, ...(rowSignal ? { rowSignal } : {}) };
      codexMirrorTurns.set(key, candidates);
    }
    return;
  }

  candidates.push({ index: turns.length, surface, ...(rowSignal ? { rowSignal } : {}) });
  codexMirrorTurns.set(key, candidates);
  turns.push(turn);
}

function makeJsonTranscriptAdapter(id: string): LocalSessionSourceAdapter {
  return {
    id,
    parseFile(input, options = {}) {
      const parsed = parseRows(input.content, input.fileExtension, id, options.strict, input.fileRef);
      const fallbackSessionKey = `${id}:${input.fileRef}`;
      let currentSessionKey = fallbackSessionKey;
      const turns: LocalSessionTurn[] = [];
      const codexMirrorTurns = new Map<string, { index: number; surface: CodexMirrorSurface; rowSignal?: string }[]>();
      for (const row of parsed.rows) {
        if (shouldSkipRowForAdapter(id, row)) continue;
        currentSessionKey = sessionKeyFromRow(row) ?? currentSessionKey;
        const turn = turnFromRow(row, currentSessionKey);
        if (turn) {
          currentSessionKey = turn.sessionKey ?? currentSessionKey;
          pushTurnWithCodexMirrorDedupe(id, row, turn, turns, codexMirrorTurns);
        }
      }
      return { turns, warnings: parsed.warnings };
    },
  };
}

const BUILT_IN_ADAPTERS = new Map<string, LocalSessionSourceAdapter>();

export function registerLocalSessionSourceAdapter(adapter: LocalSessionSourceAdapter): void {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("local session source adapter must be an object");
  }
  if (typeof adapter.id !== "string" || adapter.id.trim().length === 0) {
    throw new Error("local session source adapter id must be a non-empty string");
  }
  if (typeof adapter.parseFile !== "function") {
    throw new Error(`local session adapter '${adapter.id}' must define parseFile`);
  }
  const id = adapter.id.trim();
  if (BUILT_IN_ADAPTERS.has(id)) {
    throw new Error(`local session adapter '${id}' is already registered`);
  }
  BUILT_IN_ADAPTERS.set(id, adapter.id === id ? adapter : { ...adapter, id });
}

export function getLocalSessionSourceAdapter(id: string | undefined): LocalSessionSourceAdapter | undefined {
  const key = typeof id === "string" && id.trim().length > 0 ? id.trim() : "generic-jsonl";
  return BUILT_IN_ADAPTERS.get(key);
}

export function listLocalSessionSourceAdapters(): string[] {
  return [...BUILT_IN_ADAPTERS.keys()].sort();
}

for (const adapterId of ["generic-jsonl", "codex-jsonl", "claude-jsonl"]) {
  registerLocalSessionSourceAdapter(makeJsonTranscriptAdapter(adapterId));
}
