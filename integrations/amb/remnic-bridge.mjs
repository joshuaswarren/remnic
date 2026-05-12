#!/usr/bin/env node
/**
 * JSONL bridge used by the public Agent Memory Benchmark Python provider.
 *
 * The bridge intentionally keeps AMB as the benchmark authority: AMB owns
 * datasets, answer generation, judging, scoring, and output files. This process
 * only exposes Remnic memory operations through a tiny request/response protocol.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { expandTildePath } from "@remnic/core";

const DEFAULT_RECALL_BUDGET_CHARS = 49_152;
const DEFAULT_DRAIN_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const AMB_SESSION_INDEX_FILE = "amb-session-index.json";
const AMB_MONTH_NAME_TO_NUMBER = new Map([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
]);

function parsePositiveInteger(value, label, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; received ${String(value)}`);
  }
  return parsed;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean value: ${String(value)}`);
}

function parseReplayExtractionMode(value) {
  if (value === undefined || value === "") {
    return "await";
  }
  if (value === "await" || value === "background" || value === "skip") {
    return value;
  }
  throw new Error('REMNIC_AMB_REPLAY_EXTRACTION_MODE must be "await", "background", or "skip".');
}

function parseReplaySourceValidAtMode(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "historical" || normalized === "batch") {
    return normalized;
  }
  throw new Error('REMNIC_AMB_REPLAY_SOURCE_VALID_AT_MODE must be "historical" or "batch".');
}

function isBeamSessionPrefix(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "beam" || normalized.startsWith("beam-");
}

export function resolveAmbReplaySourceValidAtMode(env = process.env) {
  const sessionPrefix = env.REMNIC_AMB_SESSION_PREFIX || "amb";
  const defaultValue = isBeamSessionPrefix(sessionPrefix) ? "batch" : "historical";
  return parseReplaySourceValidAtMode(env.REMNIC_AMB_REPLAY_SOURCE_VALID_AT_MODE, defaultValue);
}

function normalizeOptionalEnvString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAmbInternalProvider(value) {
  const trimmed = normalizeOptionalEnvString(value);
  if (trimmed === undefined) {
    return undefined;
  }
  return trimmed === "codex_cli" ? "codex-cli" : trimmed;
}

function normalizeOptionalPositiveInteger(value, label) {
  const trimmed = normalizeOptionalEnvString(value);
  if (trimmed === undefined) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; received ${String(value)}`);
  }
  return parsed;
}

function normalizeCodexReasoningEffort(value, label) {
  const trimmed = normalizeOptionalEnvString(value);
  if (trimmed === undefined) {
    return undefined;
  }
  if (["low", "medium", "high", "xhigh"].includes(trimmed)) {
    return trimmed;
  }
  throw new Error(`${label} must be one of low, medium, high, xhigh; received ${String(value)}`);
}

function ambInternalProviderOptions(env = process.env) {
  const provider = normalizeAmbInternalProvider(
    env.REMNIC_AMB_INTERNAL_PROVIDER ?? env.REMNIC_AMB_INTERNAL_LLM,
  );
  const model = normalizeOptionalEnvString(env.REMNIC_AMB_INTERNAL_MODEL);
  const reasoningEffort = normalizeCodexReasoningEffort(
    env.REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT,
    "REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT",
  );
  const timeoutMs = normalizeOptionalPositiveInteger(
    env.REMNIC_AMB_INTERNAL_TIMEOUT_MS,
    "REMNIC_AMB_INTERNAL_TIMEOUT_MS",
  );
  const baseUrl = normalizeOptionalEnvString(env.REMNIC_AMB_INTERNAL_BASE_URL);
  const apiKey = normalizeOptionalEnvString(env.REMNIC_AMB_INTERNAL_API_KEY);
  const disableThinking = parseBoolean(env.REMNIC_AMB_INTERNAL_DISABLE_THINKING, false);

  if (
    !provider &&
    !model &&
    !reasoningEffort &&
    timeoutMs === undefined &&
    !baseUrl &&
    !apiKey &&
    !disableThinking
  ) {
    return null;
  }
  if (!provider || !model) {
    throw new Error(
      "REMNIC_AMB_INTERNAL_PROVIDER and REMNIC_AMB_INTERNAL_MODEL are both required when configuring an AMB internal LLM provider.",
    );
  }

  return {
    runtimeProfile: "baseline",
    internalProvider: provider,
    internalModel: model,
    ...(baseUrl ? { internalBaseUrl: baseUrl } : {}),
    ...(apiKey ? { internalApiKey: apiKey } : {}),
    ...(reasoningEffort ? { internalCodexReasoningEffort: reasoningEffort } : {}),
    ...(timeoutMs !== undefined ? { requestTimeout: timeoutMs } : {}),
    ...(disableThinking ? { internalDisableThinking: true } : {}),
  };
}

function isJsonObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }

  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${label} must be an array of strings.`);
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeAmbSessionIndex(value, label) {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  const allSessions = normalizeStringArray(value.allSessions ?? [], `${label}.allSessions`);
  const rawSessionsByUser = value.sessionsByUser ?? {};
  if (!isJsonObject(rawSessionsByUser)) {
    throw new Error(`${label}.sessionsByUser must be a JSON object.`);
  }

  const sessionsByUser = new Map();
  for (const [userId, sessions] of Object.entries(rawSessionsByUser)) {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      continue;
    }
    sessionsByUser.set(
      normalizedUserId,
      normalizeStringArray(sessions, `${label}.sessionsByUser.${userId}`),
    );
  }

  return { allSessions, sessionsByUser };
}

function sanitizeSessionPart(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "unknown";
  const safe = raw.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 120) || "unknown";
  if (safe === raw) {
    return safe;
  }
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  const prefix = safe.slice(0, 107).replace(/-+$/, "") || "unknown";
  return `${prefix}-${hash}`;
}

function sanitizeLegacySessionPart(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "unknown";
  return raw.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 120) || "unknown";
}

function normalizeAmbRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function normalizeAmbAnchorValue(value) {
  return String(value ?? "").trim().replace(/[;\r\n]+/g, " ").replace(/\s+/g, " ");
}

function extractAmbTimeAnchor(cleanedMarker) {
  const parts = cleanedMarker
    .split("|")
    .map((part) => normalizeAmbAnchorValue(part))
    .filter((part) => part.length > 0);
  return parts.find((part) => !/\bTurn\s+[A-Za-z0-9_.:-]+\b/i.test(part)) ?? "";
}

function extractAmbIsoDate(value) {
  const match = String(value ?? "").match(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?=$|[^\d])/);
  return match?.[1] ?? "";
}

function ambDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseFlexibleAmbIsoTimestamp(value) {
  const match = typeof value === "string"
    ? value.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|([+-])(\d{2}):(\d{2}))?)?$/,
    )
    : null;
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[8] === undefined ? undefined : Number(match[8]);
  const offsetMinute = match[9] === undefined ? undefined : Number(match[9]);
  const hasTime = match[4] !== undefined;
  const hasOffset = offsetHour !== undefined && offsetMinute !== undefined;
  const hasTimezone = /(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > ambDaysInMonth(year, month) ||
    (hasTime && !hasTimezone)
  ) {
    return null;
  }
  if (hasTime && (hour > 23 || minute > 59 || second > 59)) {
    return null;
  }
  if (
    hasOffset &&
    (offsetMinute > 59 ||
      offsetHour > 14 ||
      (offsetHour === 14 && offsetMinute > 0))
  ) {
    return null;
  }

  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function parseAmbMonthNameDate(value) {
  const match = String(value ?? "").trim().match(
    /^([A-Za-z]+)[\s-]+(\d{1,2})(?:,)?[\s-]+(\d{4})$/,
  );
  if (!match) {
    return null;
  }
  const month = AMB_MONTH_NAME_TO_NUMBER.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !Number.isInteger(day) || day < 1 || day > ambDaysInMonth(year, month)) {
    return null;
  }
  return Date.UTC(year, month - 1, day);
}

function parseAmbSourceTimestamp(value) {
  const isoParsed = parseFlexibleAmbIsoTimestamp(value);
  if (isoParsed !== null) {
    return isoParsed;
  }
  return parseAmbMonthNameDate(value);
}

function normalizeAmbTimeAnchor(value) {
  const normalized = normalizeAmbAnchorValue(value);
  if (!normalized) {
    return "";
  }
  if (parseFlexibleAmbIsoTimestamp(normalized) !== null) {
    return normalized;
  }
  const parsedMonthDate = parseAmbMonthNameDate(normalized);
  if (parsedMonthDate !== null) {
    return new Date(parsedMonthDate).toISOString().slice(0, 10);
  }
  throw new Error(
    `AMB source timestamp must be a valid ISO 8601 timestamp or AMB month-name date; received ${value}`,
  );
}

function parseStrictIsoTimestamp(value, label) {
  const parsed = parseFlexibleAmbIsoTimestamp(value);
  if (parsed === null) {
    throw new Error(`${label} must be a valid ISO 8601 timestamp; received ${value}`);
  }
  return parsed;
}

function normalizeAmbQueryTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error("query_timestamp must be an ISO 8601 timestamp string when provided.");
  }
  const normalized = normalizeAmbAnchorValue(value);
  if (!normalized) {
    return "";
  }
  parseStrictIsoTimestamp(normalized, "query_timestamp");
  return normalized;
}

function normalizeAmbSourceTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error("AMB source timestamp must be a string when provided.");
  }
  const normalized = normalizeAmbAnchorValue(value);
  if (!normalized) {
    return "";
  }
  const parsed = parseAmbSourceTimestamp(normalized);
  if (parsed === null) {
    throw new Error(
      `AMB source timestamp must be a valid ISO 8601 timestamp or AMB month-name date; received ${value}`,
    );
  }
  return new Date(parsed).toISOString();
}

function timestampedAmbMessage(role, content, timestamp) {
  return timestamp ? { role, content, timestamp } : { role, content };
}

function buildAmbTurnAnchor(document, marker) {
  const rawMarker = typeof marker === "string" ? marker.trim() : "";
  const turnMatch = rawMarker.match(/\bTurn\s+([A-Za-z0-9_.:-]+)\b/i);
  const cleanedMarker = normalizeAmbAnchorValue(rawMarker.replace(/^\[/, "").replace(/\]$/, ""));
  if (!turnMatch?.[1] && !cleanedMarker) {
    return "";
  }

  const fields = [];
  if (document?.id) fields.push(`document_id=${document.id}`);
  if (turnMatch?.[1]) {
    const turnId = turnMatch[1];
    fields.push(`turn_id=${turnId}`);
    fields.push(`chat_id=${turnId}`);
    fields.push(`source_chat_id=${turnId}`);
  }
  const markerTimeAnchor = extractAmbTimeAnchor(cleanedMarker);
  const timeAnchor = markerTimeAnchor
    ? normalizeAmbTimeAnchor(markerTimeAnchor)
    : normalizeAmbSourceTimestamp(document?.timestamp || "");
  if (timeAnchor) {
    fields.push(`time_anchor=${timeAnchor}`);
    const date = extractAmbIsoDate(timeAnchor);
    if (date) {
      fields.push(`date=${date}`);
    }
  }
  if (cleanedMarker) {
    fields.push(`turn_marker=${cleanedMarker}`);
  }
  return fields.length > 0 ? `AMB turn anchors: ${fields.join("; ")}` : "";
}

function sourceTimestampFromAmbMarker(document, marker) {
  const rawMarker = typeof marker === "string" ? marker.trim() : "";
  const cleanedMarker = normalizeAmbAnchorValue(rawMarker.replace(/^\[/, "").replace(/\]$/, ""));
  const timeAnchor = extractAmbTimeAnchor(cleanedMarker);
  if (timeAnchor) {
    return normalizeAmbSourceTimestamp(timeAnchor);
  }
  return normalizeAmbSourceTimestamp(document?.timestamp || "");
}

function buildStructuredAmbMessages(document) {
  if (!Array.isArray(document?.messages)) {
    return [];
  }

  return document.messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content) {
      return [];
    }
    const turnMarker =
      message.turn_id ??
      message.turnId ??
      message.id;
    const timestamp = typeof message.timestamp === "string" ? message.timestamp.trim() : "";
    const marker = turnMarker === undefined || turnMarker === null || turnMarker === ""
      ? timestamp
      : timestamp
        ? `${timestamp} | Turn ${turnMarker}`
        : `Turn ${turnMarker}`;
    const anchor = buildAmbTurnAnchor(document, marker);
    const sourceTimestamp = normalizeAmbSourceTimestamp(timestamp || document?.timestamp || "");
    return [
      timestampedAmbMessage(
        normalizeAmbRole(message.role),
        anchor ? `${anchor}\n${content}` : content,
        sourceTimestamp,
      ),
    ];
  });
}

function formattedAmbRoleMarkerStart(match) {
  return (match.index ?? 0) + (match[1]?.length ?? 0);
}

function formattedAmbMessageBodyStart(match) {
  const separatorLength = match[1]?.length ?? 0;
  return formattedAmbRoleMarkerStart(match) + match[0].length - separatorLength;
}

function parseFormattedAmbContent(document) {
  const content = typeof document?.content === "string" ? document.content.trim() : "";
  if (!content) {
    return [];
  }

  const markerPattern =
    /(^|\n+)(\[[^\]\n]*\]\s*)?(User|Assistant|System|Unknown):\s*/g;
  const matches = [...content.matchAll(markerPattern)];
  const firstMarkerStart = matches[0] ? formattedAmbRoleMarkerStart(matches[0]) : -1;
  if (matches.length === 0 || firstMarkerStart !== 0) {
    return [];
  }

  const parsed = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    if (match.index === undefined) {
      continue;
    }
    const bodyStart = formattedAmbMessageBodyStart(match);
    const bodyEnd = next?.index ?? content.length;
    const body = content.slice(bodyStart, bodyEnd).trim();
    if (!body) {
      continue;
    }
    const marker = (match[2] ?? "").trim();
    const anchor = buildAmbTurnAnchor(document, marker);
    parsed.push(
      timestampedAmbMessage(
        normalizeAmbRole(match[3]),
        anchor ? `${anchor}\n${body}` : body,
        sourceTimestampFromAmbMarker(document, marker),
      ),
    );
  }

  return parsed;
}

export function buildAmbSessionId(document, index, prefix = "amb") {
  const normalizedPrefix = sanitizeSessionPart(prefix);
  const user = sanitizeSessionPart(document?.user_id ?? "global");
  const id = sanitizeSessionPart(document?.id ?? index);
  return `${normalizedPrefix}-${user}-${id}-${index}`;
}

export function buildAmbStorageSessionId(
  document,
  index,
  prefix = "amb",
  options = {},
) {
  const groupDocumentsByUser = options.groupDocumentsByUser !== false;
  const userId = document?.user_id ? String(document.user_id).trim() : "";
  if (!groupDocumentsByUser || !userId) {
    return buildAmbSessionId(document, index, prefix);
  }

  return `${sanitizeSessionPart(prefix)}-${sanitizeSessionPart(userId)}`;
}

function buildSkippedIngestionFallbackSessionIds(scopedUserId, prefix) {
  const currentSessionId = buildAmbStorageSessionId(
    { user_id: scopedUserId },
    0,
    prefix,
    { groupDocumentsByUser: true },
  );
  const legacySessionId =
    `${sanitizeLegacySessionPart(prefix)}-${sanitizeLegacySessionPart(scopedUserId)}`;
  return [...new Set([currentSessionId, legacySessionId])];
}

export function buildAmbMessages(document) {
  const messages = [];
  const metadata = [];
  if (document?.id) metadata.push(`document_id=${document.id}`);
  if (document?.user_id) metadata.push(`user_id=${document.user_id}`);
  if (document?.timestamp) metadata.push(`timestamp=${document.timestamp}`);
  if (metadata.length > 0) {
    messages.push({
      role: "system",
      content: `AMB document metadata: ${metadata.join("; ")}`,
    });
  }

  const content = typeof document?.content === "string" ? document.content : "";
  const structuredMessages = buildStructuredAmbMessages(document);
  const parsedMessages =
    structuredMessages.length > 0 ? structuredMessages : parseFormattedAmbContent(document);
  if (parsedMessages.length > 0) {
    messages.push(...parsedMessages);
  } else if (content.trim().length > 0) {
    messages.push(
      timestampedAmbMessage(
        "user",
        content.trim(),
        normalizeAmbSourceTimestamp(document?.timestamp || ""),
      ),
    );
  }
  return messages;
}

export function buildAmbRecallDocuments(recalledText, args = {}) {
  const text = typeof recalledText === "string" ? recalledText.trim() : "";
  const k = args.k === undefined ? 10 : Number(args.k);
  if (!Number.isInteger(k) || k <= 0 || text.length === 0) {
    return [];
  }
  return [
    {
      id: `remnic-recall-${randomUUID()}`,
      content: text,
      user_id: args.user_id ?? null,
    },
  ];
}

export function ambRecallBudgetForSessionCount(totalBudgetChars, sessionCount) {
  const totalBudget = Math.max(0, Math.floor(Number(totalBudgetChars) || 0));
  const sessions = Math.max(0, Math.floor(Number(sessionCount) || 0));
  if (totalBudget <= 0 || sessions <= 0) {
    return 0;
  }
  return Math.max(256, Math.floor(totalBudget / sessions));
}

export function joinAmbRecallChunks(chunks, budgetChars) {
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0));
  if (budget <= 0 || !Array.isArray(chunks)) {
    return "";
  }

  let joined = "";
  for (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk.trim() : "";
    if (!text) {
      continue;
    }

    const separator = joined.length > 0 ? "\n\n" : "";
    const remaining = budget - joined.length - separator.length;
    if (remaining <= 0) {
      break;
    }

    if (text.length <= remaining) {
      joined += `${separator}${text}`;
      continue;
    }

    joined += `${separator}${text.slice(0, remaining).trimEnd()}`;
    break;
  }

  return joined;
}

function formatAmbRecallQuery(query, normalizedTimestamp) {
  const text = String(query ?? "").trim();
  if (!normalizedTimestamp) {
    return text;
  }

  const fields = [`query_timestamp=${normalizedTimestamp}`];
  const date = extractAmbIsoDate(normalizedTimestamp);
  if (date) {
    fields.push(`query_date=${date}`);
  }
  const anchor = `AMB query anchors: ${fields.join("; ")}`;
  return text ? `${text}\n\n${anchor}` : anchor;
}

export function buildAmbRecallQuery(query, queryTimestamp) {
  return formatAmbRecallQuery(query, normalizeAmbQueryTimestamp(queryTimestamp));
}

export async function loadRemnicAmbConfig(env = process.env) {
  const configPath = env.REMNIC_AMB_CONFIG_PATH;
  const configJson = env.REMNIC_AMB_CONFIG_JSON;
  if (configPath && configJson) {
    throw new Error("Set only one of REMNIC_AMB_CONFIG_PATH or REMNIC_AMB_CONFIG_JSON.");
  }

  if (configPath) {
    const expandedPath = expandTildePath(configPath);
    const parsed = JSON.parse(await readFile(expandedPath, "utf8"));
    if (!isJsonObject(parsed)) {
      throw new Error(`REMNIC_AMB_CONFIG_PATH must point to a JSON object: ${configPath}`);
    }
    if (Object.hasOwn(parsed, "remnic")) {
      if (!isJsonObject(parsed.remnic)) {
        throw new Error("REMNIC_AMB_CONFIG_PATH remnic value must be a JSON object.");
      }
      return { ...parsed.remnic };
    }
    return { ...parsed };
  }

  if (configJson) {
    const parsed = JSON.parse(configJson);
    if (!isJsonObject(parsed)) {
      throw new Error("REMNIC_AMB_CONFIG_JSON must be a JSON object.");
    }
    if (Object.hasOwn(parsed, "remnic")) {
      if (!isJsonObject(parsed.remnic)) {
        throw new Error("REMNIC_AMB_CONFIG_JSON remnic value must be a JSON object.");
      }
      return { ...parsed.remnic };
    }
    return { ...parsed };
  }

  return {};
}

export async function buildRemnicAmbAdapterOptions(benchModule, env = process.env) {
  const configOverrides = await loadRemnicAmbConfig(env);
  const internalOptions = ambInternalProviderOptions(env);
  if (!internalOptions) {
    return {
      configOverrides,
      internalProvider: null,
    };
  }

  if (typeof benchModule.resolveBenchRuntimeProfile !== "function") {
    throw new Error("@remnic/bench does not expose resolveBenchRuntimeProfile for AMB internal LLM setup.");
  }

  const resolved = await benchModule.resolveBenchRuntimeProfile(internalOptions);
  return {
    configOverrides: {
      ...configOverrides,
      ...resolved.effectiveRemnicConfig,
    },
    internalProvider: resolved.internalProvider ?? null,
    ...(resolved.adapterOptions?.drainTimeoutMs
      ? { drainTimeoutMs: resolved.adapterOptions.drainTimeoutMs }
      : {}),
  };
}

export function parseJsonlBridgeRequest(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isJsonObject(request)) {
    throw new Error("request must be a JSON object.");
  }
  return request;
}

async function loadBenchModule(env = process.env) {
  if (env.REMNIC_AMB_IMPORT === "package") {
    return import("@remnic/bench");
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourceAdapter = path.resolve(here, "../../packages/bench/src/adapters/remnic-adapter.ts");
  const sourceRuntimeProfiles = path.resolve(here, "../../packages/bench/src/runtime-profiles.ts");
  if (existsSync(sourceAdapter) && existsSync(sourceRuntimeProfiles)) {
    try {
      const [adapter, runtimeProfiles] = await Promise.all([
        import(pathToFileURL(sourceAdapter).href),
        import(pathToFileURL(sourceRuntimeProfiles).href),
      ]);
      return {
        createRemnicAdapter: adapter.createRemnicAdapter,
        resolveBenchRuntimeProfile: runtimeProfiles.resolveBenchRuntimeProfile,
      };
    } catch (error) {
      if (env.REMNIC_AMB_IMPORT === "source") {
        throw error;
      }
    }
  }

  return import("@remnic/bench");
}

export class RemnicAmbBridge {
  constructor(adapter, options) {
    this.adapter = adapter;
    this.options = options;
    this.sessionsByUser = new Map();
    this.allSessions = [];
    this.allSessionIds = new Set();
    this.sessionIndexLoaded = false;
    this.hasAuthoritativeSessionIndex = false;
    this.hasIngested = false;
  }

  async reset() {
    await this.adapter.reset();
    this.sessionsByUser.clear();
    this.allSessions = [];
    this.allSessionIds.clear();
    this.hasIngested = false;
    await this.persistSessionIndex();
  }

  recordSession(sessionId, userId) {
    if (!this.allSessionIds.has(sessionId)) {
      this.allSessionIds.add(sessionId);
      this.allSessions.push(sessionId);
    }
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    if (normalizedUserId) {
      const sessions = this.sessionsByUser.get(normalizedUserId) ?? [];
      if (!sessions.includes(sessionId)) {
        sessions.push(sessionId);
      }
      this.sessionsByUser.set(normalizedUserId, sessions);
    }
  }

  async loadSessionIndex() {
    if (this.sessionIndexLoaded || !this.options.sessionIndexPath) {
      this.sessionIndexLoaded = true;
      return;
    }

    let text;
    try {
      text = await readFile(this.options.sessionIndexPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.sessionIndexLoaded = true;
        return;
      }
      throw error;
    }

    const index = normalizeAmbSessionIndex(
      JSON.parse(text),
      `AMB session index ${this.options.sessionIndexPath}`,
    );
    this.sessionsByUser = new Map(index.sessionsByUser);
    this.allSessions = [];
    this.allSessionIds.clear();
    for (const sessionId of index.allSessions) {
      this.recordSession(sessionId, "");
    }
    for (const [userId, sessions] of index.sessionsByUser.entries()) {
      for (const sessionId of sessions) {
        this.recordSession(sessionId, userId);
      }
    }
    this.sessionIndexLoaded = true;
    this.hasAuthoritativeSessionIndex = true;
  }

  async persistSessionIndex() {
    if (!this.options.sessionIndexPath) {
      return;
    }

    const payload = {
      version: 1,
      allSessions: this.allSessions,
      sessionsByUser: Object.fromEntries(this.sessionsByUser.entries()),
    };
    await mkdir(path.dirname(this.options.sessionIndexPath), { recursive: true });
    const tempPath = `${this.options.sessionIndexPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, this.options.sessionIndexPath);
    this.sessionIndexLoaded = true;
    this.hasAuthoritativeSessionIndex = true;
  }

  async ingest(documents) {
    if (!Array.isArray(documents)) {
      throw new Error("ingest expects a documents array.");
    }
    if (this.options.resetBeforeIngest) {
      await this.reset();
    } else {
      await this.loadSessionIndex();
    }

    let storedCount = 0;
    const batchesBySession = new Map();
    const knownSessionIds = new Set(this.allSessionIds);
    let nextSessionIndex = this.allSessions.length;
    for (const document of documents) {
      const messages = buildAmbMessages(document);
      if (messages.length === 0) {
        continue;
      }
      const sessionId = buildAmbStorageSessionId(
        document,
        nextSessionIndex,
        this.options.sessionPrefix,
        { groupDocumentsByUser: this.options.groupDocumentsByUser },
      );
      if (!knownSessionIds.has(sessionId)) {
        knownSessionIds.add(sessionId);
        nextSessionIndex += 1;
      }

      let batch = batchesBySession.get(sessionId);
      if (!batch) {
        batch = {
          messages: [],
          userIds: new Set(),
          documentCount: 0,
        };
        batchesBySession.set(sessionId, batch);
      }

      batch.messages.push(...messages);
      const userId = document?.user_id ? String(document.user_id).trim() : "";
      if (userId) {
        batch.userIds.add(userId);
      }
      batch.documentCount += 1;
    }

    for (const [sessionId, batch] of batchesBySession.entries()) {
      await this.adapter.store(sessionId, batch.messages);
      if (batch.userIds.size === 0) {
        this.recordSession(sessionId, "");
      } else {
        for (const userId of batch.userIds) {
          this.recordSession(sessionId, userId);
        }
      }
      storedCount += batch.documentCount;
    }
    if (storedCount > 0) {
      this.hasIngested = true;
    }

    await this.persistSessionIndex();

    if (this.options.drainAfterIngest) {
      await this.adapter.drain?.();
    }
  }

  async retrieve({ query, k, user_id, query_timestamp }) {
    await this.loadSessionIndex();
    const recallAsOf = normalizeAmbQueryTimestamp(query_timestamp);
    const recallQuery = formatAmbRecallQuery(query, recallAsOf);
    const scopedUserId = user_id === undefined || user_id === null
      ? ""
      : String(user_id).trim();
    const indexedSessionIds = scopedUserId
      ? this.sessionsByUser.get(scopedUserId) ?? []
      : this.allSessions;
    const sessionIds = indexedSessionIds.length === 0
      && scopedUserId
      && !this.hasIngested
      && !this.hasAuthoritativeSessionIndex
      && this.options.groupDocumentsByUser !== false
        ? buildSkippedIngestionFallbackSessionIds(
            scopedUserId,
            this.options.sessionPrefix,
          )
        : indexedSessionIds;
    if (!sessionIds || sessionIds.length === 0) {
      return {
        documents: [],
        raw_response: {
          session_count: 0,
          returned_chars: 0,
          query_timestamp: recallAsOf || null,
          user_id: scopedUserId || null,
        },
      };
    }

    const chunks = [];
    const perSessionBudget = ambRecallBudgetForSessionCount(
      this.options.recallBudgetChars,
      sessionIds.length,
    );
    for (const sessionId of sessionIds) {
      const recalled = await this.adapter.recall(
        sessionId,
        recallQuery,
        perSessionBudget,
        recallAsOf ? { asOf: recallAsOf } : undefined,
      );
      if (recalled && recalled.trim().length > 0) {
        chunks.push(`## Remnic session ${sessionId}\n${recalled.trim()}`);
      }
    }

    const joined = joinAmbRecallChunks(chunks, this.options.recallBudgetChars);
    return {
      documents: buildAmbRecallDocuments(joined, { k, user_id }),
      raw_response: {
        session_count: sessionIds.length,
        session_budget_chars: perSessionBudget,
        returned_chars: joined.length,
        query_timestamp: recallAsOf || null,
        user_id: scopedUserId || null,
      },
    };
  }

  async cleanup() {
    await this.adapter.destroy();
  }
}

async function createBridge(env = process.env) {
  const bench = await loadBenchModule(env);
  const adapterOptions = await buildRemnicAmbAdapterOptions(bench, env);
  const preserveRuntimeDefaults = parseBoolean(
    env.REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS,
    true,
  );
  const adapter = await bench.createRemnicAdapter({
    configOverrides: {
      lcmEnabled: true,
      ...adapterOptions.configOverrides,
    },
    preserveRuntimeDefaults,
    sandboxDir: env.REMNIC_AMB_STORE_DIR,
    replayExtractionMode: parseReplayExtractionMode(env.REMNIC_AMB_REPLAY_EXTRACTION_MODE),
    replaySourceValidAtMode: resolveAmbReplaySourceValidAtMode(env),
    drainTimeoutMs: parsePositiveInteger(
      env.REMNIC_AMB_DRAIN_TIMEOUT_MS,
      "REMNIC_AMB_DRAIN_TIMEOUT_MS",
      adapterOptions.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    ),
  });
  const storeDir = typeof env.REMNIC_AMB_STORE_DIR === "string" && env.REMNIC_AMB_STORE_DIR.trim()
    ? path.resolve(expandTildePath(env.REMNIC_AMB_STORE_DIR.trim()))
    : "";

  return new RemnicAmbBridge(adapter, {
    drainAfterIngest: parseBoolean(env.REMNIC_AMB_DRAIN_AFTER_INGEST, true),
    groupDocumentsByUser: parseBoolean(env.REMNIC_AMB_GROUP_DOCUMENTS_BY_USER, true),
    resetBeforeIngest: parseBoolean(env.REMNIC_AMB_RESET_BEFORE_INGEST, false),
    recallBudgetChars: parsePositiveInteger(
      env.REMNIC_AMB_RECALL_BUDGET_CHARS,
      "REMNIC_AMB_RECALL_BUDGET_CHARS",
      DEFAULT_RECALL_BUDGET_CHARS,
    ),
    sessionPrefix: env.REMNIC_AMB_SESSION_PREFIX || "amb",
    sessionIndexPath: storeDir ? path.join(storeDir, AMB_SESSION_INDEX_FILE) : undefined,
  });
}

async function runJsonlServer() {
  let bridge = await createBridge();
  const requireBridge = async () => {
    if (!bridge) {
      bridge = await createBridge();
    }
    return bridge;
  };
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try {
      request = parseJsonlBridgeRequest(line);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      continue;
    }

    const id = request.id ?? null;
    try {
      let result;
      switch (request.method) {
        case "reset":
          result = await (await requireBridge()).reset();
          break;
        case "ingest":
          result = await (await requireBridge()).ingest(request.params?.documents);
          break;
        case "retrieve":
          result = await (await requireBridge()).retrieve(request.params ?? {});
          break;
        case "cleanup":
          if (bridge) {
            result = await bridge.cleanup();
            bridge = null;
          } else {
            result = null;
          }
          break;
        default:
          throw new Error(`unknown method: ${String(request.method)}`);
      }
      process.stdout.write(`${JSON.stringify({ id, ok: true, result: result ?? null })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
  }

  if (bridge) {
    await bridge.cleanup();
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
}

if (isEntrypoint()) {
  runJsonlServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
