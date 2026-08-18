# @remnic/connector-x

X (Twitter) connector for [Remnic](https://github.com/joshuaswarren/remnic) —
remember the user's own X posts and bookmarks (issue #2009).

Bookmarks are deliberate curation; posts are deliberate expression. Both are
high-trust memory sources. This connector ingests them through **pluggable
sources** and maps them to Remnic memories with dedupe, provenance, and
trust gating.

```
npm install @remnic/connector-x        # à-la-carte; @remnic/core works alone without it
```

## Cost reality — read this first

The official X MCP (`https://api.x.com/mcp`) is a transport over the same
**metered X API**: every read consumes the same quota and pay-per-use credits
as a raw v2 call. A `tools/call get_users_bookmarks` against an exhausted
account returns `{"detail":"credits depleted","status":402}` (session
`initialize`/`tools/list` stay free).

The connector is budget-aware by design:

- `maxPagesPerSync` (default 2) caps paid pages per cycle.
- `maxCostUsdPerMonth` (default $1.00) is a hard ceiling; when projected
  spend would cross it, the source **skips the cycle cleanly** (`skipped:
  monthly-cost-cap`) instead of erroring.
- `costPerReadUsd` (default $0.01 — ~1 credit/read pay-per-use reference
  rate) converts reads to dollars; set it to your account's real rate.
- Stop-on-known-ids: paging stops as soon as a page contains only posts
  already ingested, so slow-changing bookmarks cost one page per sync.
- Bookmarks change slowly — keep `syncSchedule` at `3x-daily` or slower.

Because reads cost money, the source layer is pluggable so the same
normalized records can come from zero-credit inputs, cheapest first:

| kind       | credits | what it reads |
|---|---|---|
| `corpusDir` | 0 | `*.json` files in a local corpus directory (e.g. one exported by another pipeline) |
| `cli`       | 0 | a cookie-GraphQL CLI such as `bird` (`bird bookmarks --json`) |
| `mcp`       | paid | the official X MCP — canonical shape |

## Config

The `xConnector` block (issue #2009). Put it in a JSON file and point the
CLI at it, or pass the parsed object to `parseXConnectorConfig` from a host:

```jsonc
{
  "xConnector": {
    "enabled": true,
    "userId": "123456789",            // numeric X user id; enables own-post ingestion
    "sources": [
      { "id": "local-corpus", "kind": "corpusDir", "path": "~/corpus/bookmarks" },
      { "id": "bird", "kind": "cli", "bin": "bird" },
      {
        "id": "x-mcp", "kind": "mcp", "url": "https://api.x.com/mcp",
        "auth": { "tokenFile": "~/.openclaw/secrets/x-tokens.json" },
        "bookmarksTool": "get_users_bookmarks",   // defaults shown; override if X renames
        "timelineTool": "get_users_tweets",
        "maxResults": 20,
        "budget": { "maxPagesPerSync": 2, "maxCostUsdPerMonth": 1.0, "costPerReadUsd": 0.01 }
      }
    ],
    "sourcePriority": ["local-corpus", "bird", "x-mcp"],  // cheapest first
    "syncSchedule": "3x-daily",
    "memoryMode": "suggest",          // "suggest" → review queue, "store" → direct write
    "stateDir": "~/.remnic/x-connector"
  }
}
```

Invalid values are rejected, never silently reinterpreted: unknown kinds,
duplicate source ids, priorities naming unknown sources, non-numeric
`userId`, and bad enum values all throw `XConfigError`.

## Auth setup (MCP source)

Bookmarks need a **user-context OAuth2 token** — app-only bearers have no
user context. There is no OAuth discovery or dynamic registration on
`api.x.com/mcp`; you need a pre-registered confidential client:

1. Create an OAuth2 client in the X developer portal.
2. Run the authorization-code flow once (with offline access) and write the
   token file:
   ```json
   { "access_token": "...", "refresh_token": "...", "expires_at": 1750000000000 }
   ```
   `expires_at` is epoch milliseconds. Unknown extra fields are preserved.
3. Give the connector the client credentials (env is easiest):
   `REMNIC_X_CLIENT_ID`, `REMNIC_X_CLIENT_SECRET`.

### Single-owner refresh chain (important)

X **rotates the refresh token on every refresh**. Two independent
refreshers fork the chain and kill one of them — you get HTTP 401 on the
next refresh and must re-authorize. `XTokenStore` is built to be the single
owner: refreshes only run while holding `<tokenFile>.lock`; a concurrent
refresher waits, then adopts the rotated pair from the file. Do not run
another tool that refreshes the same grant.

The token file is written 0600, atomically. A 400/401/403 on refresh raises
`XRefreshChainBrokenError` with recovery instructions.

## Ingestion → memory mapping

Every source emits the same normalized record
(`postId`, `kind: bookmark|own_post`, `author`, `createdAt`, `text`, `urls`,
`mediaCount`, optional `enrichment`), deduped by `postId` + content
fingerprint — re-fetching a bookmark daily never churns the memory store,
and an edited post re-ingests exactly once.

| record | tags | category | confidence |
|---|---|---|---|
| bookmark | `x/bookmark` | `reference` (has URL) or `interest` | 0.7 |
| own post | `x/post` | `expression` | 0.9 |

Author usernames become `person-<handle>` entity refs, feeding the entity
graph. `memoryMode` gates trust: `suggest` (default) routes through
`XMemorySink.submitSuggestion` (review queue); `store` routes through
`storeMemory`. Records carry provenance (`sourceId`, `syncRunId`,
`fetchedAt`) for attribution.

## CLI

```
remnic-x status [--config path] [--json]   # offline: sources, availability, spend vs cap
remnic-x sync   [--config path] [--json]   # one cycle; skips are expected, not errors
```

Default config path: `$REMNIC_X_CONFIG` or `~/.config/remnic/x-connector.json`.
Exit code 0 for skips (credits depleted, caps), 1 for sink failures, 2 for
bad invocation or config.

## Host API

```ts
import { parseXConnectorConfig, runXSync, getXStatus } from "@remnic/connector-x";

const config = parseXConnectorConfig(rawBlock);
const report = await runXSync(config, {
  sink: {
    submitSuggestion: (s) => myReviewQueue.push(s),
    storeMemory: async (s) => { await memoryStore.write(toMemory(s)); },
  },
});
const status = await getXStatus(config); // offline, zero credits
```

The default on-disk sink (`createFileSink`) writes `suggest`-mode files to
`<stateDir>/suggestions/` and `store`-mode files to `<stateDir>/records/`;
every ingested record is also materialized under `<stateDir>/records/`.

## Non-goals

- No posting, liking, or bookmark writes (X blocks autonomous posting via
  MCP; writes are priced per action).
- No full-archive backfill through the metered MCP — backfill from a local
  corpus.
- No scraping: zero-credit sources are pluggable inputs provided by the
  deployment.

## Development

```
npm run test          # node:test via tsx, no network
npm run check-types
npm run build         # tsup → dist/
```

Tests run fully offline against scripted HTTP fakes and temp directories.
