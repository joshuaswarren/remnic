import { CODEX_THREAD_KEY_PREFIX } from "@remnic/core";
import type { CodexCompatConfig } from "@remnic/core";

export { CODEX_THREAD_KEY_PREFIX };

function readModelId(
  source: Record<string, unknown> | undefined,
): string | null {
  if (!source) return null;
  const provider = source.provider;
  if (provider && typeof provider === "object") {
    const model =
      (provider as Record<string, unknown>).model ??
      (provider as Record<string, unknown>).modelId;
    if (typeof model === "string" && model.length > 0) return model;
  }
  const directModel = source.modelId ?? source.model;
  return typeof directModel === "string" && directModel.length > 0
    ? directModel
    : null;
}

function isCodexProvider(
  source: Record<string, unknown> | undefined,
): boolean {
  if (!source || typeof source !== "object") return false;
  const messageProvider = source.messageProvider;
  if (messageProvider === "codex") return true;
  const provider =
    source.provider && typeof source.provider === "object"
      ? (source.provider as Record<string, unknown>)
      : undefined;
  const providerId = provider?.id ?? source.providerId;
  if (providerId === "codex") return true;

  const providerName = provider?.name ?? source.providerName;
  if (
    typeof providerName === "string" &&
    (providerName === "codex" || providerName.startsWith("codex/"))
  ) {
    return true;
  }

  const modelId = readModelId(source);
  if (typeof modelId === "string" && modelId.startsWith("codex/")) {
    return true;
  }

  const directCodexThreadId = source.codexThreadId;
  return (
    typeof directCodexThreadId === "string" && directCodexThreadId.length > 0
  );
}

export function extractCodexThreadId(
  source: Record<string, unknown> | undefined,
): string | null {
  if (!source || typeof source !== "object") return null;
  const provider =
    source.provider && typeof source.provider === "object"
      ? (source.provider as Record<string, unknown>)
      : undefined;
  const threadId =
    source.providerThreadId ??
    provider?.threadId ??
    (provider?.thread &&
    typeof provider.thread === "object" &&
    typeof (provider.thread as Record<string, unknown>).id === "string"
      ? (provider.thread as Record<string, unknown>).id
      : undefined) ??
    source.codexThreadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

export function codexLogicalSessionKey(providerThreadId: string): string {
  return `${CODEX_THREAD_KEY_PREFIX}${providerThreadId}`;
}

function extractProviderMessageCount(
  source: Record<string, unknown> | undefined,
): number | null {
  if (!source || typeof source !== "object") return null;
  const directCount = source.messageCount;
  if (typeof directCount === "number" && Number.isFinite(directCount)) {
    return directCount;
  }
  const provider =
    source.provider && typeof source.provider === "object"
      ? (source.provider as Record<string, unknown>)
      : undefined;
  const nestedCount = provider?.messageCount;
  if (typeof nestedCount === "number" && Number.isFinite(nestedCount)) {
    return nestedCount;
  }
  return null;
}

export interface CodexSessionIdentity {
  sessionKey: string;
  logicalSessionKey: string;
  isCodex: boolean;
  providerThreadId: string | null;
  modelId: string | null;
  messageCount: number | null;
}

export function resolveCodexSessionIdentity(input: {
  sessionKey?: string | null;
  event?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  codexCompat?: CodexCompatConfig;
}): CodexSessionIdentity {
  const sessionKey =
    typeof input.sessionKey === "string" && input.sessionKey.length > 0
      ? input.sessionKey
      : "default";
  const event = input.event ?? undefined;
  const ctx = input.ctx ?? undefined;
  const compat = input.codexCompat;
  const codex =
    compat?.enabled === true && (isCodexProvider(ctx) || isCodexProvider(event));
  const extractedThreadId =
    compat?.enabled === true
      ? extractCodexThreadId(ctx) ?? extractCodexThreadId(event)
      : null;
  const providerThreadId =
    codex && typeof extractedThreadId === "string" ? extractedThreadId : null;
  const logicalSessionKey =
    codex &&
    compat?.threadIdBufferKeying !== false &&
    typeof providerThreadId === "string"
      ? codexLogicalSessionKey(providerThreadId)
      : sessionKey;

  return {
    sessionKey,
    logicalSessionKey,
    isCodex: codex,
    providerThreadId,
    modelId: readModelId(ctx) ?? readModelId(event),
    messageCount:
      extractProviderMessageCount(ctx) ?? extractProviderMessageCount(event),
  };
}

export function buildTurnFingerprint(input: {
  role: "user" | "assistant";
  content: string;
  logicalSessionKey: string;
  providerThreadId?: string | null;
  maxContentChars?: number;
  turnIndex: number;
}): string {
  const normalizedContent = input.content.replace(/\s+/g, " ").trim();
  const fingerprintContent =
    typeof input.maxContentChars === "number" &&
    Number.isFinite(input.maxContentChars) &&
    input.maxContentChars > 0
      ? normalizedContent.slice(0, input.maxContentChars)
      : normalizedContent;
  const fieldSeparator = String.fromCharCode(1);
  return [
    input.role,
    fingerprintContent,
    input.providerThreadId ?? input.logicalSessionKey,
    String(input.turnIndex),
  ].join(fieldSeparator);
}
