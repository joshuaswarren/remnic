# The mem0 adapter speaks HTTP through a minimal fetch client whose pagination never leaves the configured origin

Status: accepted

## Context
mem0 offers a hosted API and self-hosted deployments with slightly different route shapes. The adapter must fetch potentially many pages of memories while carrying an API key, so pagination behavior is a security surface: a server-controlled cursor URL could otherwise redirect the key to an attacker-controlled host. Tests need to replay HTTP without a SDK, and self-hosted operators must not patch code to change a route prefix.

## Decision
The client is intentionally tiny: `fetch`-based with no SDK dependency, an injectable `fetch` implementation so tests replay record/replay fixtures, abort-signal aware for clean cancellation, and rate-limit aware (sleeps between page requests when `rateLimit` is set on `RunImportOptions`).

Adapter purity contract: `parse` performs the adapter's I/O — for mem0 that is the HTTP fetch, mirroring file-backed importers where `parse` decodes the file. Parse must not call the orchestrator.

Self-hosted mem0-oss exposes `/memories/` without the `/v1` prefix; operators override the list path via `MEM0_LIST_PATH` instead of patching.

Pagination security: capture the allow-listed origin once, validate that the configured base URL itself parses as an absolute URL, resolve relative cursors against that origin, and refuse to follow any cursor when the origin cannot be established — cross-origin cursors can never tunnel the API key to another host. A `next` that is present but neither a non-empty string nor null (e.g. a number) is treated as end-of-stream: the server sent a signal we cannot interpret, and falling through to numeric pagination would guess.

## Consequences
No SDK conveniences (retries, auth flows) — the adapter owns them or lacks them. Conservative cursor handling may stop early on servers that emit unusual cursor values, and relative-cursor servers require a parseable absolute base URL to paginate at all.

## Origin comments
- `packages/import-mem0/src/adapter.ts:17` — "// Adapters are pure by contract (parse MUST NOT call the orchestrator), so"
- `packages/import-mem0/src/adapter.ts:18` — "// the API fetch lives in `parse`. This mirrors the file-reading importers"
- `packages/import-mem0/src/adapter.ts:19` — "// where parse does the I/O of decoding JSON — here it's HTTP instead."
- `packages/import-mem0/src/adapter.ts:80` — "// Self-hosted mem0-oss exposes `/memories/` without the `/v1` prefix."
- `packages/import-mem0/src/adapter.ts:81` — "// Let operators override via MEM0_LIST_PATH so those deployments work"
- `packages/import-mem0/src/adapter.ts:82` — "// without patching. Codex review on PR #602."
- `packages/import-mem0/src/client.ts:10` — "// This client is intentionally tiny:"
- `packages/import-mem0/src/client.ts:11` — "// - fetch-based; no SDK dependency."
- `packages/import-mem0/src/client.ts:12` — "// - Injectable `fetch` impl so tests can replay a record/replay fixture."
- `packages/import-mem0/src/client.ts:13` — "// - Abort-signal aware for clean cancellation."
- `packages/import-mem0/src/client.ts:14` — "// - Rate-limit aware (sleeps between page requests when `rateLimit` is set"
- `packages/import-mem0/src/client.ts:15` — "// on `RunImportOptions`)."
- `packages/import-mem0/src/client.ts:111` — "// Capture the allow-listed origin ONCE so cross-origin cursors can't"
- `packages/import-mem0/src/client.ts:112` — "// tunnel the API key to an attacker-controlled host. Codex review on"
- `packages/import-mem0/src/client.ts:113` — "// PR #602. We also validate that the configured base URL itself is a"
- `packages/import-mem0/src/client.ts:114` — "// parseable absolute URL — mem0 servers that return relative cursors"
- `packages/import-mem0/src/client.ts:115` — "// are then resolved against this origin."
- `packages/import-mem0/src/client.ts:211` — "// `next` was present but not a non-empty string or null (e.g. number)."
- `packages/import-mem0/src/client.ts:212` — "// Don't fall through to numeric pagination — the server sent a signal"
- `packages/import-mem0/src/client.ts:213` — "// we can't interpret. Treat as end-of-stream."
- `packages/import-mem0/src/client.ts:253` — "// Base URL wasn't parseable as an absolute URL; refuse to follow any"
- `packages/import-mem0/src/client.ts:254` — "// cursor because we can't compare origins."
