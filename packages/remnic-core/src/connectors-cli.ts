
import {
  type ConnectorCursor,
  type ConnectorDocument,
  type ConnectorState,
  type ConnectorSyncStatus,
} from "./connectors/live/index.js";

// ─────────────────────────────────────────────────────────────────────────────

/**
 * A lightweight descriptor for one live connector, assembled from the parsed
 * config and any persisted state.  The CLI handler builds this from
 * `orchestrator.config.connectors` + `listConnectorStates(memoryDir)`.
 */
export interface ConnectorRow {
  /** Stable connector id (e.g. `"google-drive"`, `"notion"`). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Whether the operator has enabled this connector in config. */
  enabled: boolean;
  /** Persisted sync state, or `null` if no sync has ever run. */
  state: ConnectorState | null;
}

export interface ConnectorRowDefinition {
  id: string;
  displayName: string;
  enabled: boolean;
}

export function buildConnectorRowsFromDefinitions(
  definitions: readonly ConnectorRowDefinition[],
  states: readonly ConnectorState[],
): ConnectorRow[] {
  const stateMap = new Map(states.map((state) => [state.id, state]));
  return definitions.map((definition) => ({
    id: definition.id,
    displayName: definition.displayName,
    enabled: definition.enabled,
    state: stateMap.get(definition.id) ?? null,
  }));
}

export interface ConnectorRunResult {
  /** Number of new documents imported in this pass. */
  docsImported: number;
  /**
   * Error message if the sync or ingest failed, undefined on full success.
   * When only the cursor write failed after a successful ingest, this field is
   * undefined and `stateWriteError` carries the failure. When persisting error
   * state fails after a sync/ingest error, both fields are set so callers can
   * preserve the primary failure while also reporting stale persisted state.
   */
  error?: string;
  /**
   * Set when cursor/error-state persistence fails. On the success path,
   * `docsImported` reflects the actual count of successfully ingested docs so
   * the operator knows data was persisted even though the cursor did not
   * advance. On the error path, `error` preserves the primary sync/ingest
   * failure and this field reports the secondary persistence failure.
   */
  stateWriteError?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export const CONNECTORS_OUTPUT_FORMATS = ["text", "markdown", "json"] as const;
export type ConnectorsOutputFormat = (typeof CONNECTORS_OUTPUT_FORMATS)[number];

/**
 * Validate `--format <fmt>`.  Throws a listed-options error for any value not
 * in `CONNECTORS_OUTPUT_FORMATS`.  Returns the given default when the value is
 * `undefined` (no flag supplied).
 */
export function parseConnectorsFormat(
  value: unknown,
  defaultFormat: ConnectorsOutputFormat = "text",
): ConnectorsOutputFormat {
  if (value === undefined || value === null) return defaultFormat;
  if (
    typeof value !== "string" ||
    !(CONNECTORS_OUTPUT_FORMATS as readonly string[]).includes(value)
  ) {
    throw new Error(
      `--format expects one of ${CONNECTORS_OUTPUT_FORMATS.join(", ")}; got ${JSON.stringify(value)}`,
    );
  }
  return value as ConnectorsOutputFormat;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedConnectorsListOptions {
  format: ConnectorsOutputFormat;
}

export interface ParsedConnectorsStatusOptions {
  /** `status` defaults to JSON for scripting; `--format` can override. */
  format: ConnectorsOutputFormat;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export function parseConnectorsListOptions(
  options: Record<string, unknown>,
): ParsedConnectorsListOptions {
  return {
    format: parseConnectorsFormat(options.format, "text"),
  };
}

export function parseConnectorsStatusOptions(
  options: Record<string, unknown>,
): ParsedConnectorsStatusOptions {
  return {
    format: parseConnectorsFormat(options.format, "json"),
  };
}

export function parseConnectorsRunName(rawName: unknown): string {
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new Error(
      "connectors run: <name> is required and must be a non-empty connector id",
    );
  }
  return rawName.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

function statusLabel(status: ConnectorSyncStatus): string {
  switch (status) {
    case "never":
      return "never synced";
    case "success":
      return "ok";
    case "error":
      return "error";
    default:
      return status;
  }
}

function fmtTimestamp(value: string | null | undefined, fallback = "—"): string {
  if (!value) return fallback;
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export function renderConnectorsList(
  rows: readonly ConnectorRow[],
  format: ConnectorsOutputFormat,
): string {
  if (format === "json") {
    const out = rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      enabled: row.enabled,
      lastSyncAt: row.state?.lastSyncAt ?? null,
      lastSyncStatus: row.state?.lastSyncStatus ?? "never",
      lastSyncError: row.state?.lastSyncError ?? null,
      totalDocsImported: row.state?.totalDocsImported ?? 0,
      updatedAt: row.state?.updatedAt ?? null,
    }));
    return JSON.stringify(out, null, 2);
  }

  if (rows.length === 0) {
    if (format === "markdown") {
      return "# Live connectors\n\n_No live connectors are configured._\n";
    }
    return "No live connectors configured.";
  }

  if (format === "markdown") {
    const lines: string[] = ["# Live connectors", ""];
    lines.push("| ID | Display name | Enabled | Last poll | Docs imported | Status |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of rows) {
      const lastPoll = fmtTimestamp(row.state?.lastSyncAt);
      const docs = row.state?.totalDocsImported ?? 0;
      const status = statusLabel(row.state?.lastSyncStatus ?? "never");
      lines.push(
        `| \`${row.id}\` | ${row.displayName} | ${row.enabled ? "yes" : "no"} | ${lastPoll} | ${docs} | ${status} |`,
      );
      if (row.state?.lastSyncError) {
        lines.push(
          `| | | | | | _Error: ${escapePipes(row.state.lastSyncError)}_ |`,
        );
      }
    }
    return lines.join("\n") + "\n";
  }

  const lines: string[] = [`Live connectors (${rows.length}):`];
  lines.push("");
  for (const row of rows) {
    const enabledStr = row.enabled ? "enabled" : "disabled";
    const status = statusLabel(row.state?.lastSyncStatus ?? "never");
    const lastPoll = fmtTimestamp(row.state?.lastSyncAt, "(never polled)");
    const docs = row.state?.totalDocsImported ?? 0;
    lines.push(`  ${row.id}  (${row.displayName})`);
    lines.push(`    state:         ${enabledStr}, ${status}`);
    lines.push(`    last_poll:     ${lastPoll}`);
    lines.push(`    docs_imported: ${docs}`);
    if (row.state?.lastSyncError) {
      lines.push(`    last_error:    ${row.state.lastSyncError}`);
    }
  }
  return lines.join("\n");
}

export function renderConnectorsRunResult(
  connectorId: string,
  result: ConnectorRunResult,
  format: ConnectorsOutputFormat,
): string {
  const ok = result.error === undefined && result.stateWriteError === undefined;

  if (format === "json") {
    return JSON.stringify(
      {
        connector: connectorId,
        docsImported: result.docsImported,
        error: result.error ?? null,
        stateWriteError: result.stateWriteError ?? null,
        ok,
      },
      null,
      2,
    );
  }

  if (format === "markdown") {
    const lines: string[] = [`# connectors run: \`${connectorId}\``, ""];
    lines.push(`- **Status:** ${ok ? "success" : "error"}`);
    lines.push(`- **Docs imported:** ${result.docsImported}`);
    if (result.error !== undefined) {
      lines.push(`- **Error:** ${result.error}`);
    }
    if (result.stateWriteError !== undefined) {
      const label =
        result.error === undefined
          ? "State-write error (cursor not advanced)"
          : "State-write error (error state not persisted)";
      lines.push(`- **${label}:** ${result.stateWriteError}`);
    }
    return lines.join("\n") + "\n";
  }

  // text
  const lines: string[] = [];
  if (ok) {
    lines.push(`connectors run: ${connectorId} — OK`);
    lines.push(`  docs_imported: ${result.docsImported}`);
  } else {
    lines.push(`connectors run: ${connectorId} — FAILED`);
    lines.push(`  docs_imported: ${result.docsImported}`);
    if (result.error !== undefined) {
      lines.push(`  error:         ${result.error}`);
    }
    if (result.stateWriteError !== undefined) {
      lines.push(
        `  state_write_error: ${result.stateWriteError}`,
      );
      if (result.error === undefined) {
        lines.push(
          result.docsImported > 0
            ? `  (docs were ingested; cursor was not advanced — next poll will re-fetch from prior position)`
            : `  (cursor was not advanced — next poll will retry from prior position)`,
        );
      } else {
        lines.push(
          `  (error state was not persisted — next poll will retry from prior position)`,
        );
      }
    }
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arguments for a single connector poll pass.
 *
 * All I/O is injectable so callers (cli.ts) can supply real implementations
 * and tests can supply lightweight stubs without booting an orchestrator.
 */
export interface RunConnectorPollOnceArgs {
  /** Connector identifier (used in error/success state writes). */
  connectorId: string;
  /** Prior persisted state, or `null` on the very first sync. */
  priorState: ConnectorState | null;
  /**
   * Perform a single incremental sync.  Returns newly-fetched documents and
   * the cursor that should be persisted on success.
   */
  syncFn: (
    cursor: ConnectorCursor | null,
  ) => Promise<{ newDocs: ConnectorDocument[]; nextCursor: ConnectorCursor }>;
  ingestFn: (docs: ConnectorDocument[]) => Promise<void>;
  /**
   * Persist connector state (cursor + metadata).  Called after `ingestFn`
   * succeeds (success path) or when `syncFn` / `ingestFn` throws (error path,
   * with old cursor retained).
   */
  writeCursorFn: (state: {
    cursor: ConnectorCursor | null;
    lastSyncStatus: ConnectorSyncStatus;
    lastSyncError?: string;
    totalDocsImported: number;
  }) => Promise<void>;
}

export async function runConnectorPollOnce(
  args: RunConnectorPollOnceArgs,
): Promise<ConnectorRunResult> {
  const { connectorId, priorState, syncFn, ingestFn, writeCursorFn } = args;

  let syncResult: Awaited<ReturnType<typeof syncFn>> | undefined;
  let ingestError: string | undefined;

  try {
    syncResult = await syncFn(priorState?.cursor ?? null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let stateWriteError: string | undefined;
    try {
      await writeCursorFn({
        cursor: priorState?.cursor ?? null,
        lastSyncStatus: "error",
        lastSyncError: msg,
        totalDocsImported: priorState?.totalDocsImported ?? 0,
      });
    } catch (writeErr) {
      stateWriteError = writeErr instanceof Error ? writeErr.message : String(writeErr);
      console.error(
        `[remnic] connectors/${connectorId}: failed to persist error state after syncFn failure (${stateWriteError}); original error: ${msg}`,
      );
    }
    return {
      docsImported: 0,
      error: msg,
      ...(stateWriteError !== undefined ? { stateWriteError } : {}),
    };
  }

  // ── Phase 2: ingest ─────────────────────────────────────────────────────────
  if (syncResult.newDocs.length > 0) {
    try {
      await ingestFn(syncResult.newDocs);
    } catch (err) {
      ingestError = err instanceof Error ? err.message : String(err);
    }
  }

  if (ingestError !== undefined) {
    let stateWriteError: string | undefined;
    try {
      await writeCursorFn({
        cursor: priorState?.cursor ?? null,
        lastSyncStatus: "error",
        lastSyncError: ingestError,
        totalDocsImported: priorState?.totalDocsImported ?? 0,
      });
    } catch (writeErr) {
      stateWriteError = writeErr instanceof Error ? writeErr.message : String(writeErr);
      console.error(
        `[remnic] connectors/${connectorId}: failed to persist error state after ingestFn failure (${stateWriteError}); original error: ${ingestError}`,
      );
    }
    return {
      docsImported: 0,
      error: ingestError,
      ...(stateWriteError !== undefined ? { stateWriteError } : {}),
    };
  }

  const docsImported = syncResult.newDocs.length;
  try {
    await writeCursorFn({
      cursor: syncResult.nextCursor,
      lastSyncStatus: "success",
      totalDocsImported: (priorState?.totalDocsImported ?? 0) + docsImported,
    });
  } catch (writeErr) {
    const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    return { docsImported, stateWriteError: writeMsg };
  }

  return { docsImported };
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

function escapePipes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
