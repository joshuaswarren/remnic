import { sessionKeyFromContext } from "./messages.js";
import type { PiContextSnapshot } from "./index.js";

export type NotifyLevel = "info" | "success" | "warning" | "error";
export type NotifyFn = (message: string, level: NotifyLevel) => void;

const TRUNCATION_NOTICE = "\n\n[Remnic context truncated]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function safeSessionKeyFromContext(ctx: any): string | null {
  try {
    return sessionKeyFromContext(ctx);
  } catch {
    return null;
  }
}

export function makeNotifier(ui: unknown, hasUI: boolean): NotifyFn {
  if (hasUI || !isRecord(ui) || typeof ui.notify !== "function") {
    return () => undefined;
  }
  const notifyFn = ui.notify;
  return (message, level) => {
    try {
      notifyFn.call(ui, message, level);
    } catch {
      // Pi invalidates session-bound UI objects during reload/replacement. A
      // notification failure must not tear down Remnic's hooks.
    }
  };
}

export function makeStatusSetter(ui: unknown, hasUI: boolean): PiContextSnapshot["setStatus"] {
  if (hasUI || !isRecord(ui) || typeof ui.setStatus !== "function") {
    return () => undefined;
  }
  const setStatusFn = ui.setStatus;
  return (key, value) => {
    try {
      setStatusFn.call(ui, key, value);
    } catch {
      // See makeNotifier: stale UI should not make extension startup fail.
    }
  };
}

export function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function safeStringRead(read: () => unknown, fallback: string): string {
  const value = safeRead(read, fallback);
  return typeof value === "string" ? value : fallback;
}

export function safeEntries(ctx: any): any[] {
  try {
    const entries = ctx.sessionManager?.getEntries?.();
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

export function safeBranch(ctx: any): any[] {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

export function branchMessagesWithEntryIdentity(branch: any[]): unknown[] {
  const messages: unknown[] = [];
  for (const entry of branch) {
    const message = messageWithEntryIdentity(entry);
    if (message) messages.push(message);
  }
  return messages;
}

function messageWithEntryIdentity(entry: any): unknown | null {
  const message = entry?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return message ?? null;

  const source = isRecord(entry) ? entry : {};
  const enriched: Record<string, unknown> = { ...(message as Record<string, unknown>) };
  assignMissingIdentity(enriched, "entryId", source.id ?? source.entryId ?? source.entry_id);
  assignMissingIdentity(enriched, "timestamp", source.timestamp);
  assignMissingIdentity(enriched, "createdAt", source.createdAt ?? source.created_at);
  return enriched;
}

function assignMissingIdentity(target: Record<string, unknown>, field: string, value: unknown): void {
  if (target[field] !== undefined) return;
  if (typeof value === "string" && value.length > 0) {
    target[field] = value;
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    target[field] = value;
  }
}

export function trimContext(value: string, budget: number): string {
  if (value.length <= budget) return value;
  if (budget <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, budget);
  return `${value.slice(0, budget - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}
