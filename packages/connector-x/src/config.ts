/**
 * Strict parser for the `xConnector` config block (issue #2009).
 *
 * Invalid values are rejected, never silently reinterpreted: unknown
 * source kinds, duplicate source ids, priorities naming unknown sources,
 * non-finite numbers, and unrecognized enum values all throw.
 */

import type { XMemoryMode, XSourceKind } from "./types.js";

export const X_SOURCE_KINDS: readonly XSourceKind[] = ["mcp", "corpusDir", "cli"];
export const X_MEMORY_MODES: readonly XMemoryMode[] = ["suggest", "store"];
export const X_SYNC_SCHEDULES: readonly string[] = ["hourly", "4x-daily", "3x-daily", "2x-daily", "daily", "weekly"];

export const X_DEFAULT_MCP_URL = "https://api.x.com/mcp";
export const X_DEFAULT_TOKEN_FILE = "~/.openclaw/secrets/x-tokens.json";
export const X_DEFAULT_STATE_DIR = "~/.remnic/x-connector";
/** Pay-per-use reference rate: ~1 credit per read at ~$0.01/credit. */
export const X_DEFAULT_COST_PER_READ_USD = 0.01;

export interface XBudgetConfig {
  maxPagesPerSync: number;
  maxCostUsdPerMonth: number;
  costPerReadUsd: number;
}

interface XBudgetInput {
  maxPagesPerSync?: unknown;
  maxCostUsdPerMonth?: unknown;
  costPerReadUsd?: unknown;
}

export interface XMcpSourceConfig {
  id: string;
  kind: "mcp";
  url: string;
  tokenFile: string;
  bookmarksTool: string;
  timelineTool: string;
  maxResults: number;
  budget: XBudgetConfig;
}

export interface XCorpusSourceConfig {
  id: string;
  kind: "corpusDir";
  path: string;
}

export interface XCliSourceConfig {
  id: string;
  kind: "cli";
  bin: string;
  bookmarksArgs: string[];
  /** When unset, this source contributes bookmarks only. */
  postsArgs?: string[];
}

export type XSourceConfig = XMcpSourceConfig | XCorpusSourceConfig | XCliSourceConfig;

export interface XConnectorConfig {
  enabled: boolean;
  userId?: string;
  sources: XSourceConfig[];
  sourcePriority: string[];
  syncSchedule: string;
  memoryMode: XMemoryMode;
  stateDir: string;
}

export class XConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XConfigError";
  }
}

/** Coerces boolean-like strings at the config boundary; anything else is invalid. */
export function coerceXBool(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw new XConfigError(`${field} must be a boolean (got ${JSON.stringify(value)})`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new XConfigError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function positiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new XConfigError(`${field} must be an integer >= 1 (got ${JSON.stringify(value)})`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new XConfigError(`${field} must be a finite number >= 0 (got ${JSON.stringify(value)})`);
  }
  return value;
}

function parseBudget(raw: unknown, sourceId: string): XBudgetConfig {
  const input: XBudgetInput =
    raw === undefined || raw === null ? {} : objectOrThrow(raw, `sources[${sourceId}].budget`);
  return {
    maxPagesPerSync: positiveInt(input.maxPagesPerSync, `sources[${sourceId}].budget.maxPagesPerSync`, 2),
    maxCostUsdPerMonth: nonNegativeNumber(
      input.maxCostUsdPerMonth,
      `sources[${sourceId}].budget.maxCostUsdPerMonth`,
      1.0
    ),
    costPerReadUsd: nonNegativeNumber(
      input.costPerReadUsd,
      `sources[${sourceId}].budget.costPerReadUsd`,
      X_DEFAULT_COST_PER_READ_USD
    ),
  };
}

function objectOrThrow(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new XConfigError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseMcpSource(raw: Record<string, unknown>): XMcpSourceConfig {
  const id = requiredString(raw.id, "source.id");
  const auth = objectOrThrow(raw.auth ?? {}, `sources[${id}].auth`);
  return {
    id,
    kind: "mcp",
    url: optionalString(raw.url, `sources[${id}].url`) ?? X_DEFAULT_MCP_URL,
    tokenFile: optionalString(auth.tokenFile ?? raw.tokenFile, `sources[${id}].auth.tokenFile`) ?? X_DEFAULT_TOKEN_FILE,
    bookmarksTool: optionalString(raw.bookmarksTool, `sources[${id}].bookmarksTool`) ?? "get_users_bookmarks",
    timelineTool: optionalString(raw.timelineTool, `sources[${id}].timelineTool`) ?? "get_users_tweets",
    maxResults: positiveInt(raw.maxResults, `sources[${id}].maxResults`, 20),
    budget: parseBudget(raw.budget, id),
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new XConfigError(`${field} must be an array of strings`);
  }
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`));
}

function parseCorpusSource(raw: Record<string, unknown>): XCorpusSourceConfig {
  const id = requiredString(raw.id, "source.id");
  return {
    id,
    kind: "corpusDir",
    path: requiredString(raw.path, `sources[${id}].path`),
  };
}

function parseCliSource(raw: Record<string, unknown>): XCliSourceConfig {
  const id = requiredString(raw.id, "source.id");
  const bookmarksArgs = stringArray(raw.bookmarksArgs, `sources[${id}].bookmarksArgs`);
  return {
    id,
    kind: "cli",
    bin: optionalString(raw.bin, `sources[${id}].bin`) ?? "bird",
    bookmarksArgs: bookmarksArgs.length > 0 ? bookmarksArgs : ["bookmarks", "--json"],
    postsArgs: (() => {
      const postsArgs = stringArray(raw.postsArgs, `sources[${id}].postsArgs`);
      return postsArgs.length > 0 ? postsArgs : undefined;
    })(),
  };
}

export function parseXConnectorConfig(raw: unknown): XConnectorConfig {
  const input = objectOrThrow(raw, "xConnector");

  const enabled = coerceXBool(input.enabled ?? true, "xConnector.enabled");

  const userId = optionalString(input.userId, "xConnector.userId");
  if (userId !== undefined && !/^\d+$/.test(userId)) {
    throw new XConfigError("xConnector.userId must be the numeric X user id");
  }

  const sourcesRaw = input.sources;
  if (!Array.isArray(sourcesRaw) || sourcesRaw.length === 0) {
    throw new XConfigError("xConnector.sources must be a non-empty array");
  }
  const sources: XSourceConfig[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < sourcesRaw.length; index++) {
    const entry = objectOrThrow(sourcesRaw[index], `sources[${index}]`);
    const kind = requiredString(entry.kind, `sources[${index}].kind`);
    if (!(X_SOURCE_KINDS as readonly string[]).includes(kind)) {
      throw new XConfigError(
        `sources[${index}].kind must be one of ${X_SOURCE_KINDS.join(", ")} (got ${JSON.stringify(kind)})`
      );
    }
    const source =
      kind === "mcp" ? parseMcpSource(entry) : kind === "corpusDir" ? parseCorpusSource(entry) : parseCliSource(entry);
    if (seenIds.has(source.id)) {
      throw new XConfigError(`duplicate source id ${JSON.stringify(source.id)} in xConnector.sources`);
    }
    seenIds.add(source.id);
    sources.push(source);
  }

  const sourcePriority = stringArray(input.sourcePriority, "xConnector.sourcePriority");
  for (const id of sourcePriority) {
    if (!seenIds.has(id)) {
      throw new XConfigError(`xConnector.sourcePriority references unknown source id ${JSON.stringify(id)}`);
    }
  }
  const orderedPriority = sourcePriority.length > 0 ? sourcePriority : sources.map((source) => source.id);

  const memoryModeRaw = optionalString(input.memoryMode, "xConnector.memoryMode") ?? "suggest";
  if (!(X_MEMORY_MODES as readonly string[]).includes(memoryModeRaw)) {
    throw new XConfigError(
      `xConnector.memoryMode must be one of ${X_MEMORY_MODES.join(", ")} (got ${JSON.stringify(memoryModeRaw)})`
    );
  }

  const syncSchedule = optionalString(input.syncSchedule, "xConnector.syncSchedule") ?? "3x-daily";
  if (!X_SYNC_SCHEDULES.includes(syncSchedule)) {
    throw new XConfigError(
      `xConnector.syncSchedule must be one of ${X_SYNC_SCHEDULES.join(", ")} (got ${JSON.stringify(syncSchedule)})`
    );
  }

  return {
    enabled,
    userId,
    sources,
    sourcePriority: orderedPriority,
    syncSchedule,
    memoryMode: memoryModeRaw as XMemoryMode,
    stateDir: optionalString(input.stateDir, "xConnector.stateDir") ?? X_DEFAULT_STATE_DIR,
  };
}

/** OAuth2 client credentials for the MCP source, with env fallbacks. */
export function resolveMcpClientCredentials(
  source: XMcpSourceConfig,
  env: NodeJS.ProcessEnv = process.env
): { clientId?: string; clientSecret?: string; tokenFile: string } {
  const clientId = env.REMNIC_X_CLIENT_ID ?? env.X_CLIENT_ID;
  const clientSecret = env.REMNIC_X_CLIENT_SECRET ?? env.X_CLIENT_SECRET;
  return {
    clientId: typeof clientId === "string" && clientId.trim().length > 0 ? clientId.trim() : undefined,
    clientSecret: typeof clientSecret === "string" && clientSecret.trim().length > 0 ? clientSecret.trim() : undefined,
    tokenFile: source.tokenFile,
  };
}

/** The effective monthly cost cap across all paid sources (max of per-source caps). */
export function monthlyCostCapUsd(config: XConnectorConfig): number {
  let cap = 0;
  for (const source of config.sources) {
    if (source.kind === "mcp") cap = Math.max(cap, source.budget.maxCostUsdPerMonth);
  }
  return cap;
}
