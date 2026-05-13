import {
  type ReplayNormalizer,
  type ReplayParseOptions,
  type ReplayParseResult,
  type ReplayTurn,
} from "../types.js";
import { normalizeReplayContent, normalizeReplayRole, normalizeReplayTimestamp } from "./shared.js";

function parseJsonl(raw: string, warnings: Array<{ code: string; message: string; index?: number }>): unknown[] {
  const out: unknown[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      warnings.push({
        code: "replay.openclaw.jsonl.invalid_line",
        message: `Skipping invalid JSONL line ${index + 1}.`,
        index,
      });
    }
  }
  return out;
}

function gatherCandidates(input: unknown, warnings: Array<{ code: string; message: string; index?: number }>): unknown[] {
  if (Array.isArray(input)) return input;

  if (typeof input === "string") {
    try {
      return gatherCandidates(JSON.parse(input), warnings);
    } catch {
      return parseJsonl(input, warnings);
    }
  }

  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;

  if (Array.isArray(obj.turns)) return obj.turns;
  if (Array.isArray(obj.entries)) return obj.entries;
  if (Array.isArray(obj.messages)) return obj.messages;

  if (Array.isArray(obj.records)) {
    const rows: unknown[] = [];
    for (const rec of obj.records) {
      if (!rec || typeof rec !== "object") continue;
      const record = rec as Record<string, unknown>;
      const content = typeof record.content === "string" ? record.content : null;
      if (!content) continue;
      const path = typeof record.path === "string" ? record.path : "";
      if (!path.startsWith("transcripts/") && !path.includes("/transcripts/")) continue;
      rows.push(...parseJsonl(content, warnings));
    }
    return rows;
  }

  return [];
}

export const openclawReplayNormalizer: ReplayNormalizer = {
  source: "openclaw",
  parse(input: unknown, options: ReplayParseOptions = {}): ReplayParseResult {
    const warnings: ReplayParseResult["warnings"] = [];
    const rawTurns = gatherCandidates(input, warnings);
    const turns: ReplayTurn[] = [];

    const defaultSessionKey = options.defaultSessionKey?.trim() || "replay:openclaw:import";

    for (let i = 0; i < rawTurns.length; i += 1) {
      const raw = rawTurns[i];
      if (!raw || typeof raw !== "object") {
        warnings.push({
          code: "replay.openclaw.turn.invalid",
          message: "Skipping non-object replay turn.",
          index: i,
        });
        continue;
      }

      const row = raw as Record<string, unknown>;
      const role = normalizeReplayRole(row.role ?? row.sender ?? (row.author as Record<string, unknown> | undefined)?.role, {
        assistantAliases: ["bot"],
      });
      const content = normalizeReplayContent(row.content ?? row.text ?? row.message);
      const timestamp = normalizeReplayTimestamp(
        row.timestamp ?? row.createdAt ?? row.created_at ?? row.time ?? row.date,
        { acceptDateObject: true },
      );

      if (!role || !content || !timestamp) {
        const message = `Skipping invalid openclaw turn at index ${i}.`;
        if (options.strict) throw new Error(message);
        warnings.push({ code: "replay.openclaw.turn.invalid", message, index: i });
        continue;
      }

      const sessionKeyRaw = row.sessionKey ?? row.session_key;
      const sessionKey = typeof sessionKeyRaw === "string" && sessionKeyRaw.trim().length > 0
        ? sessionKeyRaw.trim()
        : defaultSessionKey;

      const externalIdRaw = row.turnId ?? row.turn_id ?? row.id;

      turns.push({
        source: "openclaw",
        sessionKey,
        role,
        content,
        timestamp,
        sourceValidAt: timestamp,
        externalId: typeof externalIdRaw === "string" ? externalIdRaw : undefined,
      });
    }

    return { turns, warnings };
  },
};
