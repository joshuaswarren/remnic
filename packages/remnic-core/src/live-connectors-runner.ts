import {
  runConnectorPollOnce,
  type ConnectorRunResult,
} from "./connectors-cli.js";
import {
  createGitHubConnector,
  createGmailConnector,
  createGoogleDriveConnector,
  createNotionConnector,
  GITHUB_CONNECTOR_ID,
  GITHUB_DEFAULT_POLL_INTERVAL_MS,
  GMAIL_CONNECTOR_ID,
  GMAIL_DEFAULT_POLL_INTERVAL_MS,
  GOOGLE_DRIVE_CONNECTOR_ID,
  GOOGLE_DRIVE_DEFAULT_POLL_INTERVAL_MS,
  NOTION_CONNECTOR_ID,
  NOTION_DEFAULT_POLL_INTERVAL_MS,
  readConnectorState,
  withConnectorStateLock,
  writeConnectorState,
  validateGitHubConfig,
  validateGmailConfig,
  validateGoogleDriveConfig,
  validateNotionConfig,
  type ConnectorConfig,
  type ConnectorCursor,
  type ConnectorDocument,
  type ConnectorState,
  type LiveConnector,
} from "./connectors/live/index.js";
import type { LiveConnectorsConfig } from "./types.js";

export type LiveConnectorSkipReason =
  | "disabled"
  | "not_due"
  | "invalid_config"
  | "state_read_error"
  | "connector_error";

export interface LiveConnectorRunItem {
  id: string;
  displayName: string;
  enabled: boolean;
  ran: boolean;
  skippedReason?: LiveConnectorSkipReason;
  docsImported: number;
  error?: string;
  stateWriteError?: string;
  lastSyncAt: string | null;
  nextDueAt: string | null;
}

export interface LiveConnectorsRunSummary {
  ranAt: string;
  force: boolean;
  totalDocsImported: number;
  ranCount: number;
  skippedCount: number;
  errorCount: number;
  results: LiveConnectorRunItem[];
}

export interface LiveConnectorDefinition {
  id: string;
  displayName: string;
  enabled: boolean;
  pollIntervalMs: number;
  rawConfig: unknown;
  createConnector: () => LiveConnector;
  validateConfig: (raw: unknown) => ConnectorConfig;
}

type LiveConnectorsNow = Date | (() => Date);

export function builtInLiveConnectorDefinitions(
  config: LiveConnectorsConfig,
): LiveConnectorDefinition[] {
  return [
    {
      id: GOOGLE_DRIVE_CONNECTOR_ID,
      displayName: "Google Drive",
      enabled: config.googleDrive.enabled,
      pollIntervalMs:
        config.googleDrive.pollIntervalMs ?? GOOGLE_DRIVE_DEFAULT_POLL_INTERVAL_MS,
      rawConfig: config.googleDrive,
      createConnector: createGoogleDriveConnector,
      validateConfig: (raw) =>
        validateGoogleDriveConfig(raw) as unknown as ConnectorConfig,
    },
    {
      id: NOTION_CONNECTOR_ID,
      displayName: "Notion",
      enabled: config.notion.enabled,
      pollIntervalMs: config.notion.pollIntervalMs ?? NOTION_DEFAULT_POLL_INTERVAL_MS,
      rawConfig: config.notion,
      createConnector: createNotionConnector,
      validateConfig: (raw) =>
        validateNotionConfig(raw) as unknown as ConnectorConfig,
    },
    {
      id: GMAIL_CONNECTOR_ID,
      displayName: "Gmail",
      enabled: config.gmail.enabled,
      pollIntervalMs: config.gmail.pollIntervalMs ?? GMAIL_DEFAULT_POLL_INTERVAL_MS,
      rawConfig: config.gmail,
      createConnector: createGmailConnector,
      validateConfig: (raw) => validateGmailConfig(raw) as unknown as ConnectorConfig,
    },
    {
      id: GITHUB_CONNECTOR_ID,
      displayName: "GitHub",
      enabled: config.github.enabled,
      pollIntervalMs:
        config.github.pollIntervalMs ?? GITHUB_DEFAULT_POLL_INTERVAL_MS,
      rawConfig: config.github,
      createConnector: createGitHubConnector,
      validateConfig: (raw) => validateGitHubConfig(raw) as unknown as ConnectorConfig,
    },
  ];
}

export function hasEnabledLiveConnector(config: LiveConnectorsConfig): boolean {
  return (
    config.googleDrive.enabled ||
    config.notion.enabled ||
    config.gmail.enabled ||
    config.github.enabled
  );
}

export async function runLiveConnectorsOnce(options: {
  memoryDir: string;
  connectors: LiveConnectorsConfig;
  ingestDocuments: (docs: ConnectorDocument[]) => Promise<void>;
  force?: boolean;
  now?: LiveConnectorsNow;
  abortSignal?: AbortSignal;
  definitions?: LiveConnectorDefinition[];
}): Promise<LiveConnectorsRunSummary> {
  const ranAt = resolveNow(options.now);
  const force = options.force === true;
  const definitions =
    options.definitions ?? builtInLiveConnectorDefinitions(options.connectors);
  const results: LiveConnectorRunItem[] = [];

  for (const definition of definitions) {
    const checkAt = resolveNow(options.now);
    if (!definition.enabled) {
      results.push(skipResult(definition, null, "disabled"));
      continue;
    }
    let state: ConnectorState | null;
    try {
      state = await readConnectorState(options.memoryDir, definition.id);
    } catch (err) {
      results.push({
        id: definition.id,
        displayName: definition.displayName,
        enabled: true,
        ran: false,
        skippedReason: "state_read_error",
        docsImported: 0,
        error: err instanceof Error ? err.message : String(err),
        lastSyncAt: null,
        nextDueAt: null,
      });
      continue;
    }
    if (!force && !isConnectorDue(state, definition.pollIntervalMs, checkAt)) {
      results.push(skipResult(definition, state, "not_due"));
      continue;
    }

    let validatedConfig: ConnectorConfig;
    try {
      validatedConfig = definition.validateConfig(definition.rawConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let stateWriteError: string | undefined;
      let writtenErrorState: ConnectorState | undefined;
      const errorAt = resolveNow(options.now);
      try {
        writtenErrorState = await writeConnectorErrorState({
          memoryDir: options.memoryDir,
          connectorId: definition.id,
          state,
          error: message,
          now: errorAt,
        });
      } catch (writeErr) {
        stateWriteError =
          writeErr instanceof Error ? writeErr.message : String(writeErr);
      }
      const reportedState = writtenErrorState ?? state;
      results.push({
        id: definition.id,
        displayName: definition.displayName,
        enabled: true,
        ran: false,
        skippedReason: "invalid_config",
        docsImported: 0,
        error: message,
        ...(stateWriteError !== undefined ? { stateWriteError } : {}),
        lastSyncAt: reportedState?.lastSyncAt ?? null,
        nextDueAt: nextDueAt(reportedState, definition.pollIntervalMs),
      });
      continue;
    }

    let runResult: ConnectorRunResult;
    let lastStateWrittenAt: Date | undefined;
    try {
      const connector = definition.createConnector();
      runResult = await withConnectorStateLock(options.memoryDir, definition.id, async () => {
        const lockedState = await readConnectorState(options.memoryDir, definition.id);
        if (!force && !isConnectorDue(lockedState, definition.pollIntervalMs, checkAt)) {
          return { docsImported: 0 };
        }
        state = lockedState;
        return runConnectorPollOnce({
          connectorId: definition.id,
          priorState: lockedState,
          syncFn: (cursor: ConnectorCursor | null) =>
            connector.syncIncremental({
              cursor,
              config: validatedConfig,
              abortSignal: options.abortSignal,
            }),
          ingestFn: options.ingestDocuments,
          writeCursorFn: (writeState) => {
            const writeAt = resolveNow(options.now);
            return writeConnectorState(options.memoryDir, definition.id, {
              id: definition.id,
              cursor: writeState.cursor,
              lastSyncAt: writeAt.toISOString(),
              lastSyncStatus: writeState.lastSyncStatus,
              ...(writeState.lastSyncError !== undefined
                ? { lastSyncError: writeState.lastSyncError }
                : {}),
              totalDocsImported: writeState.totalDocsImported,
            }).then(() => {
              lastStateWrittenAt = writeAt;
            });
          },
        });
      });
      if (
        runResult.docsImported === 0 &&
        runResult.error === undefined &&
        runResult.stateWriteError === undefined &&
        lastStateWrittenAt === undefined
      ) {
        const lockedState = await readConnectorState(options.memoryDir, definition.id);
        if (!force && !isConnectorDue(lockedState, definition.pollIntervalMs, checkAt)) {
          results.push(skipResult(definition, lockedState, "not_due"));
          continue;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let stateWriteError: string | undefined;
      let writtenErrorState: ConnectorState | undefined;
      const errorAt = resolveNow(options.now);
      try {
        writtenErrorState = await writeConnectorErrorState({
          memoryDir: options.memoryDir,
          connectorId: definition.id,
          state,
          error: message,
          now: errorAt,
        });
      } catch (writeErr) {
        stateWriteError =
          writeErr instanceof Error ? writeErr.message : String(writeErr);
      }
      const reportedState = writtenErrorState ?? state;
      results.push({
        id: definition.id,
        displayName: definition.displayName,
        enabled: true,
        ran: false,
        skippedReason: "connector_error",
        docsImported: 0,
        error: message,
        ...(stateWriteError !== undefined ? { stateWriteError } : {}),
        lastSyncAt: reportedState?.lastSyncAt ?? null,
        nextDueAt: nextDueAt(reportedState, definition.pollIntervalMs),
      });
      continue;
    }
    results.push(
      runItemFromResult(
        definition,
        runResult,
        state,
        lastStateWrittenAt ?? resolveNow(options.now),
      ),
    );
  }

  return {
    ranAt: ranAt.toISOString(),
    force,
    totalDocsImported: results.reduce((sum, item) => sum + item.docsImported, 0),
    ranCount: results.filter((item) => item.ran).length,
    skippedCount: results.filter((item) => !item.ran).length,
    errorCount: results.filter(
      (item) => item.error !== undefined || item.stateWriteError !== undefined,
    ).length,
    results,
  };
}

function resolveNow(now: LiveConnectorsNow | undefined): Date {
  return typeof now === "function" ? now() : now ?? new Date();
}

function isConnectorDue(
  state: ConnectorState | null,
  pollIntervalMs: number,
  now: Date,
): boolean {
  if (state?.lastSyncAt === null || state?.lastSyncAt === undefined) return true;
  const lastMs = Date.parse(state.lastSyncAt);
  if (!Number.isFinite(lastMs)) return true;
  return now.getTime() - lastMs >= Math.max(1, Math.floor(pollIntervalMs));
}

function nextDueAt(
  state: ConnectorState | null,
  pollIntervalMs: number,
): string | null {
  if (state?.lastSyncAt === null || state?.lastSyncAt === undefined) return null;
  const lastMs = Date.parse(state.lastSyncAt);
  if (!Number.isFinite(lastMs)) return null;
  return new Date(lastMs + Math.max(1, Math.floor(pollIntervalMs))).toISOString();
}

function skipResult(
  definition: LiveConnectorDefinition,
  state: ConnectorState | null,
  skippedReason: LiveConnectorSkipReason,
): LiveConnectorRunItem {
  return {
    id: definition.id,
    displayName: definition.displayName,
    enabled: definition.enabled,
    ran: false,
    skippedReason,
    docsImported: 0,
    lastSyncAt: state?.lastSyncAt ?? null,
    nextDueAt:
      skippedReason === "not_due"
        ? nextDueAt(state, definition.pollIntervalMs)
        : null,
  };
}

function runItemFromResult(
  definition: LiveConnectorDefinition,
  result: ConnectorRunResult,
  priorState: ConnectorState | null,
  now: Date,
): LiveConnectorRunItem {
  const stateWriteFailed = result.stateWriteError !== undefined;
  const reportedLastSyncAt = stateWriteFailed
    ? priorState?.lastSyncAt ?? null
    : now.toISOString();
  const reportedNextDueAt = stateWriteFailed
    ? nextDueAt(priorState, definition.pollIntervalMs)
    : new Date(
        now.getTime() + Math.max(1, Math.floor(definition.pollIntervalMs)),
      ).toISOString();

  return {
    id: definition.id,
    displayName: definition.displayName,
    enabled: definition.enabled,
    ran: true,
    docsImported: result.docsImported,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.stateWriteError !== undefined
      ? { stateWriteError: result.stateWriteError }
      : {}),
    lastSyncAt: reportedLastSyncAt,
    nextDueAt: reportedNextDueAt,
  };
}

async function writeConnectorErrorState(options: {
  memoryDir: string;
  connectorId: string;
  state: ConnectorState | null;
  error: string;
  now: Date;
}): Promise<ConnectorState> {
  return writeConnectorState(options.memoryDir, options.connectorId, {
    id: options.connectorId,
    cursor: options.state?.cursor ?? null,
    lastSyncAt: options.now.toISOString(),
    lastSyncStatus: "error",
    lastSyncError: options.error,
    totalDocsImported: options.state?.totalDocsImported ?? 0,
  });
}
