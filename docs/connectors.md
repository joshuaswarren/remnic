# Connectors

Remnic has two distinct connector families, both driven by the `remnic
connectors` command group. They do opposite things — read the table before
reaching for a subcommand.

- **Live connectors** continuously ingest content *from* an external service
  (Google Drive, Notion, Gmail, GitHub) into your memory directory on a poll
  schedule. This is inbound content ingestion.
- **Agent-tool connectors** publish a Remnic memory extension *into* an AI
  coding tool (Claude Code, Codex CLI, Cursor, and 11 more) so that tool shares
  your memory store. This is outbound tool wiring, not ingestion.

For the live-connector framework contract (how to write one) see
[live-connectors.md](./live-connectors.md).

---

## Command families at a glance

| Command | Family | What it does |
|---|---|---|
| `remnic connectors list` | Agent-tool | List the 15 marketplace agent-tool connectors and their install state |
| `remnic connectors install <id>` | Agent-tool | Install a connector and publish its memory extension |
| `remnic connectors remove <id>` | Agent-tool | Remove a connector and unpublish its extension |
| `remnic connectors doctor <id>` | Agent-tool | Health-check one connector and its publisher |
| `remnic connectors marketplace <generate\|validate\|install>` | Agent-tool | Generate, validate, or install marketplace manifests |
| `remnic connectors status` | Live | Live-connector poll status (Google Drive + Notion), JSON by default |
| `remnic connectors run <name>` | Live | Manually trigger one incremental sync (Google Drive + Notion) |

The standalone `remnic` binary wires the live-connector debug path for **Google
Drive and Notion only**. Gmail and GitHub are live connectors too, but they run
under the hosted maintenance scheduler; inspect all four with the hosted
surface `openclaw engram connectors list` / `status` / `run`.

---

## Agent-tool connectors

`remnic connectors list` shows the built-in marketplace of agent-tool
connectors. Each publishes a Remnic memory extension (skill, MCP wiring, or
plugin) into the target tool so it shares your memory store.

```
Available connectors:
  ✓ claude-code            Claude Code v9.6.22 — Anthropic's Claude Code CLI — direct memory access via MCP
  ○ codex-cli              Codex CLI v9.6.22 — OpenAI Codex CLI — memory via MCP tool
  ○ cursor                 Cursor IDE v9.6.22 — Cursor IDE — memory via config file + tool calls
  ...
```

`✓` marks an installed connector, `○` an available one. The 15 built-ins are
`claude-code`, `codex-cli`, `cursor`, `cline`, `github-copilot`, `roo-code`,
`windsurf`, `amp`, `pi`, `omp`, `replit`, `generic-mcp`, `weclone`, `hermes`,
and `droid`. Add `--json` for machine-readable `{ installed, available }`.

### Install, remove, doctor

```bash
remnic connectors install codex-cli              # token + config + memory extension
remnic connectors install cursor --config key=value
remnic connectors remove cursor                  # unpublish + remove
remnic connectors doctor codex-cli               # health-check connector + publisher
```

`install` mints the host token and writes the connector config, then (unless
`installExtension=false`) publishes the memory extension into the tool when that
tool is present on the host *and has a real publisher* — Codex CLI does, while
the Claude Code and Hermes publishers are intentional no-op stubs: their host
wiring is manual, per [docs/plugins/claude-code.md](plugins/claude-code.md) and
[docs/plugins/hermes.md](plugins/hermes.md). `doctor` reports both the
connector's own checks and the publisher's extension status.

### Marketplace

```bash
remnic connectors marketplace generate            # generate marketplace.json
remnic connectors marketplace validate [path]     # validate a marketplace.json file
remnic connectors marketplace install <source>    # install from a source
```

`marketplace install` takes `--config <path>` for a config *file* (not
`key=value` pairs).

---

## Live connectors

Live connectors poll an external service and import changed documents into your
memory directory. The maintenance scheduler runs them automatically once
configured: the `engram-live-connectors-sync` cron calls the
`engram.live_connectors_run` MCP tool every minute and honors each connector's
`pollIntervalMs`. The subcommands below are the operator/debug surface.

### `remnic connectors status`

Live-connector poll status. Defaults to **JSON** so scripts can `jq` it without
passing `--format json` every time. The standalone binary reports **Google
Drive and Notion**; use the hosted `openclaw engram connectors list` to see
Gmail and GitHub as well.

```
Usage: remnic connectors status [options]

Options:
  --format <fmt>   Output format: json (default), text, or markdown
```

**Example — `--format text`:**

```
Live connectors (2):

  google-drive  (Google Drive)
    state:         enabled, ok
    last_poll:     2026-04-25T08:00:00.000Z
    docs_imported: 137

  notion  (Notion)
    state:         enabled, error
    last_poll:     2026-04-25T09:00:00.000Z
    docs_imported: 0
    last_error:    invalid_token: The token you provided is invalid.
```

**Example — JSON (default):**

```json
[
  {
    "id": "google-drive",
    "displayName": "Google Drive",
    "enabled": true,
    "lastSyncAt": "2026-04-25T08:00:00.000Z",
    "lastSyncStatus": "success",
    "lastSyncError": null,
    "totalDocsImported": 137,
    "updatedAt": "2026-04-25T08:00:00.000Z"
  }
]
```

### `remnic connectors run <name>`

Manually triggers one incremental `syncIncremental()` pass for the named live
connector. Useful when:

- You want to verify credentials without waiting for the next scheduler tick.
- A sync failed and you want to retry immediately.
- You are debugging cursor advancement.

```
Usage: remnic connectors run <name> [options]

Arguments:
  name             Live connector id: google-drive or notion

Options:
  --format <fmt>   Output format: text (default), markdown, or json
```

On success, exits `0` and prints the number of new documents imported. On
failure, exits `1`, writes the error to stderr, and records the failure in the
connector's state file so `connectors status` reflects it.

**Example — success:**

```
connectors run: google-drive — OK
  docs_imported: 5
```

**Example — failure (stderr, exit 1):**

```
connectors run: notion — FAILED
  docs_imported: 0
  error:         invalid_token: The token you provided is invalid.
```

---

## Connector: Google Drive

### Prerequisites

1. Create an OAuth2 client in [Google Cloud Console](https://console.cloud.google.com/).
   - Application type: **Web application** (or **Desktop app** for personal
     use).
   - Add an authorised redirect URI: `http://localhost:8080/callback` (or your
     preferred redirect).
2. Enable the **Google Drive API** in the project.
3. Obtain a refresh token using the OAuth2 flow with scope
   `https://www.googleapis.com/auth/drive.readonly`.  Tools like
   [oauth2l](https://github.com/google/oauth2l) or a small helper script can
   drive the consent flow and print the refresh token.

### Config keys

```jsonc
// In your Remnic config (e.g. ~/.config/engram/config.json)
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

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Master gate. Set to `true` to activate the connector. |
| `clientId` | `""` | OAuth2 client ID from Google Cloud Console. |
| `clientSecret` | `""` | OAuth2 client secret. |
| `refreshToken` | `""` | Long-lived refresh token obtained from the OAuth2 consent flow. |
| `pollIntervalMs` | `300000` | Poll interval in milliseconds. Min `1000` (1 s), max `86400000` (24 h). |
| `folderIds` | `[]` | Limit import to files whose Google Drive `parents` intersect this list. Empty = all accessible files. |

### Environment variables

Config values can be populated from environment variables by using
`${VAR_NAME}` placeholders in your config file if your config layer supports
interpolation, or by setting the values directly from a secrets manager /
systemd `EnvironmentFile` at startup:

| Variable | Maps to |
|----------|---------|
| `GOOGLE_DRIVE_CLIENT_ID` | `connectors.googleDrive.clientId` |
| `GOOGLE_DRIVE_CLIENT_SECRET` | `connectors.googleDrive.clientSecret` |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | `connectors.googleDrive.refreshToken` |

**Never commit real credential values.**  Use placeholders in checked-in config
files.

### Optional npm dependency

The `googleapis` package is **not** bundled with `@remnic/core`.  Install it
only if you enable this connector:

```bash
npm install googleapis
# or
pnpm add googleapis
```

The connector loads it via a computed-specifier dynamic import so bundlers
cannot include it accidentally and the package is not downloaded by users who
never configure Drive.

### What is imported

- **Google Docs / Sheets / Slides:** exported to plain text via
  `files.export`.
- **Plain-text MIME types** (`text/plain`, `text/markdown`, etc.): downloaded
  directly via `files.get?alt=media`.
- **Everything else** (images, PDFs, archives, binary files): skipped.
  Binary files belong in the binary-lifecycle pipeline, not the textual
  ingestion path.

The first sync seeds the Drive `startPageToken` without importing any files.
Subsequent syncs only pull files changed since the previous token.

---

## Connector: Notion

### Prerequisites

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations) and create a new integration.
2. Give it a name (e.g. "Remnic") and select the workspace.
3. Set **Capabilities** to at minimum **Read content**.
4. Copy the **Internal Integration Token**.
5. In each Notion database you want to import, open **Share** and invite your
   integration.

### Config keys

```jsonc
{
  "connectors": {
    "notion": {
      "enabled": true,
      "token": "${NOTION_INTEGRATION_TOKEN}",
      "databaseIds": ["<your-database-id>"],
      "pollIntervalMs": 300000
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Master gate. |
| `token` | `""` | Notion Internal Integration Token. |
| `databaseIds` | `[]` | List of Notion database IDs to import. Empty = connector does nothing. |
| `pollIntervalMs` | `300000` | Poll interval in milliseconds. Min `1000`, max `86400000`. |

### Environment variables

| Variable | Maps to |
|----------|---------|
| `NOTION_INTEGRATION_TOKEN` | `connectors.notion.token` |

### How to find a database ID

From a Notion database URL:

```
https://www.notion.so/myworkspace/My-Database-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...
```

The database ID is the 32-character hex string between the last `/` and `?`.

### What is imported

- **Database pages**: all pages in the configured databases whose
  `last_edited_time` is after the per-page high-water mark in the cursor.
- **Page content**: text extracted from supported block types
  (paragraph, heading, bulleted/numbered list, toggle, quote, code, callout).
  Unsupported block types (images, embeds, databases) are silently skipped.
- The first sync seeds the watermark from the current state of each database
  without importing any content.

---

## Connectors: Gmail and GitHub

Gmail and GitHub run on the same live-connector framework as Google Drive and
Notion, but the standalone `remnic connectors status` / `run` debug path covers
Drive and Notion only. Manage and inspect Gmail and GitHub through the hosted
maintenance scheduler and the `openclaw engram connectors list` / `status` /
`run` surface. Their config lives under `connectors.gmail` and
`connectors.github`; see [live-connectors.md](./live-connectors.md) for keys
and OAuth setup.

---

## State files

Per-connector state (cursor + sync metadata) lives at:

```
<memoryDir>/state/connectors/<connector-id>.json
```

These files travel with your memory directory.  Back them up along with the
rest of `<memoryDir>`.  To reset a connector's cursor (force a re-sync from
the beginning), delete the corresponding `.json` file — the next sync will
seed a fresh cursor.

**Do not edit state files by hand while a sync is running** — writes are
atomic (temp + rename) but a manual edit during an active sync could race.

---

## Troubleshooting

### `connectors status` shows a live connector as disabled

Connectors are opt-in.  Set `connectors.<name>.enabled: true` in your config
and ensure credentials are populated.

### Google Drive: `googleapis` package not found

Install the optional dependency:

```bash
npm install googleapis
```

Restart the daemon (`launchctl kickstart -k gui/501/ai.openclaw.gateway` on
macOS, or your systemd unit) after installing.

### Google Drive: `invalid_grant` on refresh

The refresh token has expired or been revoked (e.g., by a Google account
password change or explicit revocation in
[https://myaccount.google.com/permissions](https://myaccount.google.com/permissions)).

Re-run the OAuth2 consent flow to obtain a new refresh token, then update
`connectors.googleDrive.refreshToken` in your config.

### Notion: `unauthorized` / token errors

Verify the integration token is correct:

```bash
curl -H "Authorization: Bearer $NOTION_INTEGRATION_TOKEN" \
     -H "Notion-Version: 2022-06-28" \
     https://api.notion.com/v1/users/me
```

Also confirm the integration has been invited to each database you listed in
`databaseIds`.

### Notion: database returns no pages

Check that `databaseIds` contains the correct database ID (32-character hex
string, no hyphens in the raw API form).  Also confirm the integration has
**Read content** capability and has been added to the database via the
**Share** menu.

### `connectors run` exits 1 immediately

The connector may be disabled in config (`enabled: false`).  Check with:

```bash
remnic connectors status
```

### Cursor is stuck / connector keeps re-ingesting

Delete the state file to reset:

```bash
rm <memoryDir>/state/connectors/<connector-id>.json
remnic connectors run <connector-id>  # re-seeds cursor
```

The first run after deletion emits zero documents (cursor seed pass).
Subsequent runs pick up new content.

---

## See also

- [Live connectors framework](./live-connectors.md) — framework contract,
  registry, state store API
- [Config reference](./config-reference.md) — full list of config keys
- [Getting started](./getting-started.md) — initial setup and daemon lifecycle
