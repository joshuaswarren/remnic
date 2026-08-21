/**
 * @remnic/core — Live Connectors Framework (issue #683 PR 1/N)
 *
 * Defines the contract that every "live" connector (Drive, Notion, Gmail,
 * GitHub, ...) must satisfy. A live connector is **continuous**: it runs on a
 * schedule, persists a cursor to disk, and ingests *new* documents since the
 * last sync. This is distinct from one-shot importers in
 * `packages/remnic-core/src/importers/` which transform an entire export file
 * in a single pass.
 *
 * This module is intentionally pure types + interfaces. No I/O. No schedule
 * wiring. Concrete connectors (PRs 2–5), the maintenance scheduler hookup
 * (separate PR), and the CLI surface (PR 6) are deferred.
 *
 * Naming caveat: `packages/remnic-core/src/connectors/` is already scoped to
 * the Codex marketplace integration. The live-connector framework lives under
 * the `live/` subdirectory to avoid collision. Do not import Codex symbols
 * from here, and do not import live-connector symbols from the Codex code.
 */

/**
 * Free-form connector configuration. Validated by each connector's
 * `validateConfig` implementation and passed to `syncIncremental` for runtime
 * use. MUST be JSON-serializable: no functions, no class instances, no
 * circular references.
 *
 * Runtime configs may contain hydrated credentials. Do not persist a runtime
 * config directly. Any code that needs to store connector settings must call
 * `persistableConnectorConfig()` so credentials are stripped or replaced by
 * connector-owned references.
 */
export type ConnectorConfig = Record<string, unknown>;

const DEFAULT_SECRET_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "credential",
  "apikey",
  "accesskey",
  "privatekey",
  "authorization",
  "authheader",
  "cookie",
] as const;

/**
 * Redact secret-looking keys from a JSON-serializable connector config.
 * Built-in connectors provide explicit projections, but this default keeps
 * third-party connectors from accidentally persisting obvious credentials.
 */
export function redactConnectorConfigSecrets(config: ConnectorConfig): ConnectorConfig {
  return redactConnectorConfigValue(config) as ConnectorConfig;
}

function redactConnectorConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactConnectorConfigValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isConnectorSecretConfigKey(key)) {
      continue;
    }
    out[key] = redactConnectorConfigValue(nested);
  }
  return out;
}

function isConnectorSecretConfigKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return DEFAULT_SECRET_KEY_PARTS.some((part) => normalized.includes(part));
}

/**
 * Opaque cursor describing "where the last sync left off". Each connector
 * defines what `kind` and `value` mean (e.g. Drive: `{kind: "pageToken",
 * value: "..."}`, Gmail: `{kind: "historyId", value: "..."}`). The orchestrator
 * treats it as opaque and only round-trips it through the state store.
 *
 * `updatedAt` is an ISO 8601 timestamp set by the framework when the cursor is
 * written. It is informational — connectors MUST NOT use it to decide
 * monotonicity. They own the `value` semantics.
 */
export interface ConnectorCursor {
  /** Connector-defined cursor kind (e.g. `"pageToken"`, `"historyId"`, `"sinceTs"`). */
  readonly kind: string;
  /** Connector-defined opaque cursor value. */
  readonly value: string;
  /** ISO 8601 timestamp of when this cursor was last written. */
  readonly updatedAt: string;
}

/**
 * Provenance for a connector-ingested document. Required so downstream recall
 * can attribute facts back to their origin and avoid re-ingesting on the next
 * incremental pass.
 */
export interface ConnectorDocumentSource {
  /** Stable connector id (matches `LiveConnector.id`). */
  readonly connector: string;
  /** Source-system identifier (Drive file id, Notion page id, Gmail msg id, ...). */
  readonly externalId: string;
  /** Optional source-system revision/version (etag, page version, history id). */
  readonly externalRevision?: string;
  /** Optional canonical URL pointing back at the source document. */
  readonly externalUrl?: string;
  /** ISO 8601 timestamp of when the connector fetched this document. */
  readonly fetchedAt: string;
}

/**
 * A single document yielded by an incremental sync. Connectors are responsible
 * for chunking large source documents themselves if needed; the orchestrator
 * ingests `content` as a unit.
 */
export interface ConnectorDocument {
  /** Connector-local stable id for this document. SHOULD match `source.externalId`. */
  readonly id: string;
  /** Optional human-readable title. */
  readonly title?: string;
  /** Body content. Plaintext or Markdown — connectors document their format. */
  readonly content: string;
  /** Provenance. Required. */
  readonly source: ConnectorDocumentSource;
}

/**
 * Arguments passed to `syncIncremental`. The framework owns cursor/config
 * lifecycle; connectors only read these and return the next cursor.
 */
export interface SyncIncrementalArgs {
  /** Last persisted cursor, or `null` on the first ever sync. */
  readonly cursor: ConnectorCursor | null;
  /** Validated connector config (already passed through `validateConfig`). */
  readonly config: ConnectorConfig;
  /** Optional abort signal. Connectors SHOULD honor it for cooperative cancellation. */
  readonly abortSignal?: AbortSignal;
}

/**
 * Result of a single incremental sync pass.
 *
 * `newDocs` MAY be empty (no new documents since the last cursor). `nextCursor`
 * MUST always be returned — even on no-op syncs the framework persists it so
 * `updatedAt` reflects the most recent attempt.
 */
export interface SyncIncrementalResult {
  readonly newDocs: ConnectorDocument[];
  readonly nextCursor: ConnectorCursor;
}

/**
 * The contract every live connector implements.
 *
 * Connectors MUST be:
 *   - **Idempotent**: re-running with the same cursor MUST NOT duplicate
 *     documents. The `source.externalId` + `source.externalRevision` pair is
 *     used downstream for dedup.
 *   - **Read-only on the source**: live connectors never mutate the upstream
 *     system (no marking emails read, no editing Notion pages).
 *   - **Cancellable**: long-running syncs SHOULD periodically check
 *     `abortSignal.aborted` and bail cleanly.
 *   - **Privacy-aware**: connectors MUST NOT log document content. Logging
 *     metadata (counts, ids, timings) is fine.
 */
export interface LiveConnector {
  /**
   * Stable connector id. MUST match `CONNECTOR_ID_PATTERN` — lowercase
   * alphanumeric plus dash, 1–64 chars, must start AND end with alphanumeric
   * (no leading or trailing dash). The registry enforces this.
   */
  readonly id: string;
  /** Short human-readable name shown in CLI / status output. */
  readonly displayName: string;
  /** Optional longer description. */
  readonly description?: string;

  /**
   * Validate raw user-supplied config. MUST throw on malformed input — never
   * silently default. The returned object is the runtime config passed back to
   * `syncIncremental`; it may contain hydrated credentials and MUST NOT be
   * persisted directly. Connectors SHOULD strip unknown fields.
   */
  validateConfig(raw: unknown): ConnectorConfig;

  /**
   * Return the subset of validated config that may be written to disk. Use this
   * for state/config persistence instead of `validateConfig()`. Connectors that
   * need credentials should omit the raw values here and store only non-secret
   * scope/schedule fields plus any connector-owned secret references.
   */
  persistConfig?(validated: ConnectorConfig): ConnectorConfig;

  /**
   * Run one incremental sync pass. See `SyncIncrementalArgs` /
   * `SyncIncrementalResult` for the contract.
   */
  syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult>;
}

export function persistableConnectorConfig(
  connector: Pick<LiveConnector, "persistConfig">,
  validated: ConnectorConfig,
): ConnectorConfig {
  if (typeof connector.persistConfig === "function") {
    return connector.persistConfig(validated);
  }
  return redactConnectorConfigSecrets(validated);
}

/**
 * Regex enforcing the connector-id naming rule. Exported so connectors and
 * tests can validate ids consistently with the registry.
 *
 * Rule: lowercase alphanumeric + dash, 1..64 chars, must start AND end with
 * alphanumeric (no leading or trailing dash). Single-char ids are allowed.
 */
export const CONNECTOR_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Returns `true` if `id` is a syntactically valid connector id.
 */
export function isValidConnectorId(id: unknown): id is string {
  return typeof id === "string" && CONNECTOR_ID_PATTERN.test(id);
}
