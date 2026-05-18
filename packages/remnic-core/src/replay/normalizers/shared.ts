import { isReplayRole, parseIsoTimestamp, type ReplayRole } from "../types.js";

type NormalizeRoleOptions = {
  assistantAliases?: string[];
  userAliases?: string[];
};

type NormalizeTimestampOptions = {
  acceptDateObject?: boolean;
  trimString?: boolean;
};

export function normalizeReplayRole(value: unknown, options: NormalizeRoleOptions = {}): ReplayRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  if (isReplayRole(role)) return role;

  if (options.userAliases?.includes(role) || role === "human") return "user";
  if (options.assistantAliases?.includes(role) || role === "ai" || role === "model") return "assistant";
  return null;
}

export function normalizeReplayContent(value: unknown): string | null {
  if (typeof value === "string") {
    const content = value.trim();
    return content.length > 0 ? content : null;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((part) => (typeof part === "string" ? part : ""))
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.parts)) return normalizeReplayContent(obj.parts);
    if (typeof obj.text === "string") return normalizeReplayContent(obj.text);
  }
  return null;
}

export function normalizeReplayTimestamp(value: unknown, options: NormalizeTimestampOptions = {}): string | null {
  const toIso = (millis: number): string | null => {
    if (!Number.isFinite(millis)) return null;
    const date = new Date(millis);
    if (!Number.isFinite(date.getTime())) return null;
    try {
      return date.toISOString();
    } catch {
      return null;
    }
  };

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    return toIso(millis);
  }

  if (options.acceptDateObject && value instanceof Date && Number.isFinite(value.getTime())) {
    return toIso(value.getTime());
  }

  if (typeof value !== "string") return null;
  const raw = options.trimString === false ? value : value.trim();
  if (raw.length === 0) return null;
  const millis = parseIsoTimestamp(raw);
  return millis === null ? null : toIso(millis);
}
