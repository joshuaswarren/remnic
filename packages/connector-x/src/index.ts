/**
 * @remnic/connector-x — X (Twitter) connector for Remnic (issue #2009).
 *
 * À-la-carte optional companion of @remnic/core: installing core alone
 * never pulls this in. Hosts import this module to run syncs and read
 * status; the `remnic-x` bin offers the same operations standalone.
 *
 * Sources (pluggable, cheapest-first recommended):
 *  - `corpusDir` — local bookmark/post JSON corpus (zero credits)
 *  - `cli`       — cookie-GraphQL CLI such as `bird` (zero credits)
 *  - `mcp`       — official X MCP at https://api.x.com/mcp (billed
 *                  against X API credits; budget-capped, clean-skip on
 *                  "credits depleted")
 */

export {
  XConfigError,
  X_DEFAULT_COST_PER_READ_USD,
  X_DEFAULT_MCP_URL,
  X_DEFAULT_STATE_DIR,
  X_DEFAULT_TOKEN_FILE,
  X_MEMORY_MODES,
  X_SOURCE_KINDS,
  X_SYNC_SCHEDULES,
  coerceXBool,
  monthlyCostCapUsd,
  parseXConnectorConfig,
  resolveMcpClientCredentials,
} from "./config.js";
export type {
  XBudgetConfig,
  XCliSourceConfig,
  XConnectorConfig,
  XCorpusSourceConfig,
  XMcpSourceConfig,
  XSourceConfig,
} from "./config.js";

export { isXObject } from "./guards.js";

export {
  XCreditsDepletedError,
  X_MCP_DEFAULT_URL,
  X_MCP_PROTOCOL_VERSION,
  XMcpClient,
  XMcpError,
  looksLikeCreditsDepleted,
  parseSseData,
  toolResultTexts,
} from "./mcp-client.js";
export type { XMcpClientOptions, XMcpToolCallResult } from "./mcp-client.js";

export {
  recordFingerprint,
  normalizeCorpusEntry,
  normalizeMcpPayload,
  stableStringify,
  suggestionForRecord,
} from "./normalize.js";

export {
  XBudgetTracker,
  createXSource,
  unlimitedBudget,
} from "./sources.js";
export type { XExecFn, XSourceDeps } from "./sources.js";

export { getXStatus, runXSync } from "./sync.js";
export type { XSyncDeps } from "./sync.js";

export {
  XRefreshChainBrokenError,
  XTokenError,
  XTokenStore,
  X_TOKEN_REFRESH_URL,
} from "./token-store.js";
export type { XTokenPair, XTokenStoreOptions } from "./token-store.js";

export type {
  XAuthor,
  XBudgetRuntime,
  XMemoryMode,
  XMemorySink,
  XMemorySuggestion,
  XPostRecord,
  XProvenance,
  XRecordKind,
  XSource,
  XSourceFetchContext,
  XSourceFetchOutcome,
  XSourceKind,
  XSourceStatus,
  XSourceSyncSummary,
  XStatusReport,
  XSyncReport,
} from "./types.js";

export { createFileSink } from "./file-sink.js";
