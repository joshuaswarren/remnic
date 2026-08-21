# Live connectors

Live connectors are the **continuous** ingest path: they run on a schedule,
remember where they left off, and pull *new* documents from external services
(Google Drive, Notion, Gmail, GitHub, …) into the user's memory directory.

This page documents the framework contract, built-in connector implementations,
operator CLI, and maintenance scheduler hookup that landed across issue #683.

## How live connectors differ from importers

Remnic already ships **importers** (`packages/remnic-core/src/importers/`) that
transform a one-shot export file (ChatGPT export, Claude export, mem0 dump)
into memories in a single pass. Importers are not stateful — once the file is
ingested, the importer's job is done.

Live connectors are different in two ways:

1. **Continuous, not one-shot.** A live connector is invoked on a schedule by
   the maintenance loop. Every invocation is an *incremental* sync that picks
   up where the previous one stopped.
2. **Cursor-based.** Each connector persists an opaque cursor (`pageToken`,
   `historyId`, `since` timestamp, etc.) so the next pass only fetches
   documents the source considers new.

If you have a single export file in hand, write an **importer**. If you have a
service you want Remnic to keep watching, write a **live connector**.

## The contract

```ts
import type {
  LiveConnector,
  ConnectorConfig,
  ConnectorCursor,
  ConnectorDocument,
} from "@remnic/core";
```

Every connector implements:

```ts
interface LiveConnector {
  readonly id: string;          // /^[a-z0-9][a-z0-9-]{0,63}$/
  readonly displayName: string;
  readonly description?: string;

  validateConfig(raw: unknown): ConnectorConfig;
  syncIncremental(args: {
    cursor: ConnectorCursor | null;
    config: ConnectorConfig;
    abortSignal?: AbortSignal;
  }): Promise<{ newDocs: ConnectorDocument[]; nextCursor: ConnectorCursor }>;
}
```

Connectors **must** be:

- **Idempotent.** Re-running with the same cursor never duplicates documents.
  Documents carry `source.externalId` and (optionally) `source.externalRevision`
  so downstream dedup can de-duplicate by stable upstream identity.
- **Read-only on the source.** Live connectors never mutate the upstream
  service: no marking emails read, no editing pages, no archiving.
- **Cancellable.** Long-running syncs check `abortSignal.aborted` and bail
  cleanly when the scheduler cancels them.
- **Privacy-aware.** Connectors never log document content. Counts, ids, and
  timing are fine; bodies are not.

## Cursor + state persistence

Cursors and per-connector sync metadata live at:

```
<memoryDir>/state/connectors/<id>.json
```

Use the public helpers:

```ts
import {
  readConnectorState,
  writeConnectorState,
  listConnectorStates,
} from "@remnic/core";
```

Writes are atomic (temp file + rename) and never destroy the previous good
state on failure. Files that fail to parse are skipped by `listConnectorStates`
rather than failing the whole listing — operators inspecting the directory
can still see the corrupt file by hand.

The state record shape:

```ts
interface ConnectorState {
  id: string;
  cursor: ConnectorCursor | null;
  lastSyncAt: string | null;
  lastSyncStatus: "success" | "error" | "never";
  lastSyncError?: string;          // truncated to 1 KB
  totalDocsImported: number;
  updatedAt: string;
}
```

`"never"` is intentionally distinct from `"success"` so callers can detect
"registered but never run" without inspecting timestamps.

## Registry

```ts
import { LiveConnectorRegistry } from "@remnic/core";

const reg = new LiveConnectorRegistry();
reg.register(myConnector);
reg.list();         // sorted by id
reg.get("drive");
reg.unregister("drive");
```

The registry is pure in-memory and one-instance-per-orchestrator. Duplicate
ids are rejected (rather than silently overwritten) so plugin loading bugs
fail loudly and a malicious extension cannot shadow a built-in connector.

`unregister()` does **not** touch the on-disk state file. Fully decommission a
connector by also deleting `<memoryDir>/state/connectors/<id>.json`.

## Privacy posture

The framework is built around three rules:

1. **Read-only scopes.** Each concrete connector documents the minimum OAuth
   scope it requires. The framework itself never exposes write APIs to
   upstream services.
2. **Opt-in per connector.** Connectors are off until a user explicitly
   configures them. There is no "enable everything" switch.
3. **Local cursors.** Cursor state lives in the user's memory directory on
   disk. Nothing is uploaded to a Remnic-controlled service.

Credential storage (OAuth tokens, refresh tokens) is **not** part of this PR
— that's the design surface for PR 2. Connectors that need credentials will
read them from the OS keychain or a user-supplied secret store, never from
the connector state file.

## Concrete connectors

### Google Drive (`google-drive`) — issue #683 PR 2/N

Imports text content from a user's Google Drive into Remnic on a poll
schedule.

- **Cursor:** opaque Drive `startPageToken` (`{kind: "drivePageToken"}`).
  First sync seeds the token via `drive.changes.getStartPageToken` and emits
  zero documents — historical files are deliberately not back-filled, so
  enabling the connector does not flood the memory layer.
- **Content extraction:** Google Docs / Sheets / Slides are exported to
  plaintext / CSV via `files.export`; plain-text MIME types are pulled with
  `files.get?alt=media`. Binary formats (images, PDFs, archives) are
  skipped — those go through the binary-lifecycle pipeline, not the
  textual ingestion path.
- **Folder scope:** when `connectors.googleDrive.folderIds` is non-empty,
  only files whose `parents` intersect the configured set are imported.
  Empty array = all accessible files. Folder ids are validated for shape;
  nested folders are NOT auto-included.
- **Idempotency:** every emitted `ConnectorDocument.source` carries
  `externalId = file.id` plus `externalRevision = file.modifiedTime`, so
  downstream dedup recognises repeat fetches even if the cursor is rewound.
- **Required OAuth scope:** read-only —
  `https://www.googleapis.com/auth/drive.readonly` is sufficient.
- **À-la-carte packaging.** The `googleapis` npm package is **not** a hard
  dependency of `@remnic/core`. The connector loads it via a
  computed-specifier dynamic import; operators who never enable the
  connector pay nothing for it. To enable: `npm install googleapis` in the
  host package, then populate `clientId`, `clientSecret`, `refreshToken`
  in `connectors.googleDrive` and set `enabled: true`.
- **Privacy.** No document content is ever logged. OAuth credentials are
  accepted via config but the intended pattern is to populate them from a
  secret store (env vars, keychain, systemd `EnvironmentFile`) — never
  commit real values. The connector never persists credentials through the
  state-store; it only persists the cursor + sync-status metadata.

### Configuration

```jsonc
{
  "connectors": {
    "googleDrive": {
      "enabled": true,
      "clientId": "${GOOGLE_DRIVE_CLIENT_ID}",
      "clientSecret": "${GOOGLE_DRIVE_CLIENT_SECRET}",
      "refreshToken": "${GOOGLE_DRIVE_REFRESH_TOKEN}",
      "pollIntervalMs": 300000,
      "folderIds": []
    }
  }
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `enabled` | `false` | Master gate. Connector is also no-op until credentials are populated. |
| `clientId` | `""` | OAuth2 client id. Populate from a secret store. |
| `clientSecret` | `""` | OAuth2 client secret. Populate from a secret store. |
| `refreshToken` | `""` | OAuth2 refresh token. Populate from a secret store. |
| `pollIntervalMs` | `300000` (5 min) | Min `1000`, max `86400000` (24h). |
| `folderIds` | `[]` | Drive folder ids to scope import. Empty = all accessible. |

### Notion (`notion`) — issue #683 PR 3/N

Imports Notion database page content into Remnic on a poll schedule using the
Notion REST API (no `@notionhq/client` dependency).

- **Auth:** integration token from `connectors.notion.token`.  Populate from a
  secret store — never commit a real value.
- **Scope:** `databaseIds` limits import to the listed Notion databases.  Empty
  array = connector does nothing (safe default).
- **Cursor semantics:** per-page high-water mark stored as a JSON string.  First
  sync seeds the watermark without importing history.
- **Idempotency:** `source.externalId = page.id`, `source.externalRevision =
  last_edited_time`.

```jsonc
{
  "connectors": {
    "notion": {
      "enabled": true,
      "token": "${NOTION_INTEGRATION_TOKEN}",
      "databaseIds": ["<database-id>"],
      "pollIntervalMs": 300000
    }
  }
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `enabled` | `false` | Master gate. |
| `token` | `""` | Notion integration token. Populate from a secret store. |
| `databaseIds` | `[]` | Notion database ids to import.  Empty = do nothing. |
| `pollIntervalMs` | `300000` (5 min) | Min `1000`, max `86400000` (24h). |

## CLI surface (`remnic connectors`)

Three subcommands ship in issue #683 PR 6/N.  Full reference:
[docs/connectors.md](./connectors.md).

```bash
# List all configured connectors: enabled state, last poll, last error
remnic connectors list

# Same data, JSON by default (for scripting/automation)
remnic connectors status

# Manually trigger one incremental sync for an operator debug pass
remnic connectors run google-drive
remnic connectors run notion
```

The manual CLI run target currently supports Google Drive and Notion. The
scheduled MCP runner covers every enabled built-in connector. All three CLI
subcommands accept `--format text|markdown|json`.  `status` defaults to `json`;
the others default to `text`.

## Scheduled sync

When any connector is enabled, the orchestrator registers an OpenClaw
maintenance cron job:

| Job id | Schedule | Tool |
|--------|----------|------|
| `engram-live-connectors-sync` | `* * * * *` when configured; `*/5 * * * *` before connector config loads | `remnic.live_connectors_run` (legacy alias `engram.live_connectors_run`) |

The cron wakes every minute once connectors are configured and runs only
connectors whose own `pollIntervalMs` says they are due. Operators can call the
same MCP tool with `{"force": true}` to bypass the due check during debugging.

## What's deferred

- **OAuth helpers and credential storage** — keychain-backed storage is
  still TODO; connectors currently read credentials directly from the
  validated config.

## File map

```
packages/remnic-core/src/
├── connectors-cli.ts            # remnic connectors CLI helpers (PR 6/N)
├── live-connectors-runner.ts     # scheduler/MCP runner for due connectors
├── maintenance/
│   └── memory-governance-cron.ts # OpenClaw cron registration helpers
└── connectors/live/
    ├── framework.ts             # LiveConnector interface + ConnectorConfig/Cursor/Document
    ├── registry.ts              # LiveConnectorRegistry (pure, in-memory)
    ├── state-store.ts           # readConnectorState / writeConnectorState / listConnectorStates
    ├── google-drive.ts          # Google Drive connector (PR 2/N)
    ├── google-drive.test.ts
    ├── notion.ts                # Notion connector (PR 3/N)
    ├── notion.test.ts
    ├── gmail.ts                 # Gmail connector (PR 4/N)
    ├── gmail.test.ts
    ├── github.ts                # GitHub connector (PR 5/N)
    ├── github.test.ts
    ├── index.ts                 # Public barrel
    └── live-connectors.test.ts

tests/cli/
└── connectors.test.ts           # Unit tests for connectors-cli.ts helpers
tests/
└── live-connectors-runner.test.ts # Scheduler runner tests
```

The framework lives under `connectors/live/` because the parent
`connectors/` directory is already scoped to the existing Codex marketplace
integration (`codex-marketplace.ts`, `codex-materialize-runner.ts`,
`codex-materialize.ts`). Keep the namespaces distinct.
