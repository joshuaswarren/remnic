---
"@remnic/connector-x": minor
---

X (Twitter) connector for Remnic (#2009): new à-la-carte `@remnic/connector-x` package ingests the user's bookmarks and own posts through pluggable sources — a local corpus directory and a `bird`-style CLI (zero credits), and the official X MCP at `api.x.com/mcp` (budget-capped with clean `credits depleted` skips). Includes a Streamable-HTTP MCP client (session handling, SSE + JSON bodies), single-owner OAuth2 token refresh (file-locked rotation chain), post-id + content-fingerprint dedupe with provenance, `suggest`/`store` trust gating via a pluggable `XMemorySink`, and a `remnic-x status|sync` CLI. Strict `xConnector` config parsing rejects invalid values.
