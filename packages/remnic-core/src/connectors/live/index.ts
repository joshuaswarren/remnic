/**
 * @remnic/core — Live Connectors public barrel (issue #683 PR 1/N)
 *
 * Re-exports the live-connector framework, registry, and state store. This
 * is the only path other modules in `@remnic/core` should import from.
 *
 * NOTE: These symbols intentionally live under `connectors/live/` to avoid
 * colliding with the existing Codex marketplace integration in
 * `connectors/`. Do not flatten this barrel into the parent `connectors/`
 * index — keep the namespaces distinct.
 */

export {
  CONNECTOR_ID_PATTERN,
  isValidConnectorId,
  type ConnectorConfig,
  type ConnectorCursor,
  type ConnectorDocument,
  type ConnectorDocumentSource,
  type LiveConnector,
  type SyncIncrementalArgs,
  type SyncIncrementalResult,
} from "./framework.js";

export {
  LiveConnectorRegistry,
  LiveConnectorRegistryError,
} from "./registry.js";

export {
  listConnectorStates,
  readConnectorState,
  withConnectorStateLock,
  writeConnectorState,
  type ConnectorState,
  type ConnectorSyncStatus,
} from "./state-store.js";

export { isTransientHttpError } from "./transient-errors.js";

export {
  GOOGLE_DRIVE_CONNECTOR_ID,
  GOOGLE_DRIVE_CURSOR_KIND,
  DEFAULT_POLL_INTERVAL_MS as GOOGLE_DRIVE_DEFAULT_POLL_INTERVAL_MS,
  createGoogleDriveConnector,
  defaultGoogleDriveClientFactory,
  isTransientDriveError,
  validateGoogleDriveConfig,
  type DriveChange,
  type DriveChangesPage,
  type DriveFileMetadata,
  type GoogleDriveClient,
  type GoogleDriveClientFactory,
  type GoogleDriveConnectorConfig,
  type GoogleDriveSyncResult,
} from "./google-drive.js";

export {
  NOTION_CONNECTOR_ID,
  NOTION_CURSOR_KIND,
  NOTION_DEFAULT_POLL_INTERVAL_MS,
  createNotionConnector,
  isTransientNotionError,
  validateNotionConfig,
  type NotionBlock,
  type NotionConnectorConfig,
  type NotionFetchFn,
  type NotionPage,
  type NotionSyncResult,
} from "./notion.js";

export {
  GMAIL_CONNECTOR_ID,
  GMAIL_CURSOR_KIND,
  GMAIL_DEFAULT_POLL_INTERVAL_MS,
  buildListQuery,
  createGmailConnector,
  internalDateToEpochSeconds,
  internalDateToIso,
  isTransientGmailError,
  validateGmailConfig,
  type GmailConnectorConfig,
  type GmailFetchFn,
  type GmailHeader,
  type GmailMessage,
  type GmailMessagePart,
  type GmailMessageRef,
  type GmailSyncResult,
} from "./gmail.js";

export {
  GITHUB_CONNECTOR_ID,
  GITHUB_CURSOR_KIND,
  GITHUB_DEFAULT_POLL_INTERVAL_MS,
  createGitHubConnector,
  isTransientGitHubError,
  validateGitHubConfig,
  type GitHubComment,
  type GitHubConnectorConfig,
  type GitHubFetchFn,
  type GitHubSyncResult,
} from "./github.js";
