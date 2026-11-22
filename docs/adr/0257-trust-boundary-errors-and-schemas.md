# Anything crossing a trust boundary is sanitized or strictly parsed: raw errors stay internal, user-facing error detail carries only stable identifiers, and gateway payloads get tolerant aliases

Status: accepted

## Context

Error messages embed absolute paths and stack detail; user-facing surfaces (HTTP bodies, MCP tool errors) must not leak them, yet operators still need actionable diagnostics. Conversely, LLM gateway output is loose enough that strict-only parsing would drop entire valid extraction results.

## Decision

Raw, unredacted error messages are used ONLY internally (e.g. detecting a native-binding mismatch via markers like better_sqlite3.node / NODE_MODULE_VERSION in the raw message — redaction could strip the detection markers, and .stack is never read for detection). Native-binding detection therefore runs on the RAW message.

The user-facing error detail thrown to HTTP/MCP surfaces deliberately exposes only the error class name and Node error code (MODULE_NOT_FOUND, ERR_DLOPEN_FAILED, …) — a stable, path-free identifier — never the raw message or stack, because Node module-load failures embed absolute server paths (Require stack blocks, unquoted loader paths, even with spaces) that no regex can reliably redact. The full original error stays on the `cause` chain and is logged with its stack in the operator-only debug log. Migration/operator-facing strings route through the shared displayErrorDetail() sanitizer.

On the inbound side, the gateway extraction schema accepts snake_case aliases (final_answer / observed_outcome) via Zod union, matching the tolerance local/direct-client normalization already has, so a loose gateway model cannot fail schema parsing and drop the whole result. The provider-facing extraction contract itself stays free of transforms/refinements, since JSON Schema generators cannot faithfully express them.

Standup commitment ordering is deterministic: due-ness first (a concrete expiry outranks an undated one, earlier expiry is more due), with created-then-id as the stable tiebreak.

Standup input errors are typed so the HTTP surface maps them to 400 while the CLI prints the message verbatim; the daemon health probe runs under one 3-second aggregate budget, treating 401/503/other statuses as final answers and retrying the legacy diagnostic path only on 404. Recall handles are render-time-only tokens: when an agent echoes one back, the orchestrator strips it before the turn enters the extraction buffer.

## Consequences

Error codes are less informative than messages for end users; strict rejection of transforms in the provider schema moves normalization burdens to callers.

## Origin comments

- `packages/remnic-core/src/runtime/better-sqlite.ts:73` — "// Raw, unredacted message — used ONLY for internal classification (detecting a"
- `packages/remnic-core/src/runtime/better-sqlite.ts:74` — "// native-binding mismatch). Never returned to a user-facing surface, because it"
- `packages/remnic-core/src/runtime/better-sqlite.ts:75` — "// can contain absolute paths. Native-binding markers (better_sqlite3.node,"
- `packages/remnic-core/src/runtime/better-sqlite.ts:76` — "// NODE_MODULE_VERSION, \"was compiled against a different Node.js version\") live"
- `packages/remnic-core/src/runtime/better-sqlite.ts:77` — "// in error.message, so message text is sufficient and we never read .stack."
- `packages/remnic-core/src/runtime/better-sqlite.ts:121` — "// True when a single error's RAW message carries a native-binding ABI marker."
- `packages/remnic-core/src/runtime/better-sqlite.ts:122` — "// Raw (not displayErrorDetail) so redaction can't strip detection markers"
- `packages/remnic-core/src/runtime/better-sqlite.ts:123` — "// (e.g. the loader path containing \"better_sqlite3.node\")."
- `packages/remnic-core/src/runtime/better-sqlite.ts:161` — "// Sanitized, user-facing error detail. This string becomes the message of the"
- `packages/remnic-core/src/runtime/better-sqlite.ts:162` — "// Error thrown by unavailableError(), which propagates to user-facing surfaces"
- `packages/remnic-core/src/runtime/better-sqlite.ts:163` — "// (HTTP error bodies, MCP tool errors — access-http.ts / access-mcp.ts return"
- `packages/remnic-core/src/runtime/better-sqlite.ts:164` — "// err.message). We must not leak server internals (CodeQL js/stack-trace-exposure):"
- `packages/remnic-core/src/runtime/better-sqlite.ts:165` — "// - error.stack is never read."
- `packages/remnic-core/src/runtime/better-sqlite.ts:166` — "// We deliberately surface only the error's class name and Node error code —"
- `packages/remnic-core/src/runtime/better-sqlite.ts:167` — "// never the raw message. Node module-load failures embed absolute server paths"
- `packages/remnic-core/src/runtime/better-sqlite.ts:168` — "// directly in error.message (the \"Require stack:\" block, and unquoted native"
- `packages/remnic-core/src/runtime/better-sqlite.ts:169` — "// loader paths that may even contain spaces), which no regex can redact"
- `packages/remnic-core/src/runtime/better-sqlite.ts:170` — "// reliably. The error code (MODULE_NOT_FOUND, ERR_DLOPEN_FAILED, …) is a stable,"
- `packages/remnic-core/src/runtime/better-sqlite.ts:171` — "// path-free identifier that, together with the native-binding hint, is enough"
- `packages/remnic-core/src/runtime/better-sqlite.ts:172` — "// for a user to act on. The full original error stays on the `cause` chain and"
- `packages/remnic-core/src/runtime/better-sqlite.ts:173` — "// is logged with its stack elsewhere."
- `packages/remnic-core/src/runtime/daemon-health.ts:19` — "// One 3 s aggregate budget: /engram/v1/live, and only a 404 (daemon older"
- `packages/remnic-core/src/runtime/daemon-health.ts:20` — "// than the live route) retries the legacy diagnostic path with the"
- `packages/remnic-core/src/runtime/daemon-health.ts:21` — "// remaining time. 401/503/other statuses are final answers, never re-probed."
- `packages/remnic-core/src/sanitize.ts:60` — "// Issue #1582 hygiene §2 — handles are render-time-only tokens; when an agent"
- `packages/remnic-core/src/sanitize.ts:61` — "// echoes one back into a turn, the orchestrator strips it via this name before"
- `packages/remnic-core/src/sanitize.ts:62` — "// the turn enters the extraction buffer (rule 23). Re-exported from the pure"
- `packages/remnic-core/src/sanitize.ts:63` — "// recall-handles module so every content-sanitization concern lives here."
- `packages/remnic-core/src/schemas.ts:161` — "// Accept snake_case aliases so a loose gateway model using"
- `packages/remnic-core/src/schemas.ts:162` — "// `final_answer` / `observed_outcome` does not fail schema parsing"
- `packages/remnic-core/src/schemas.ts:163` — "// and drop the entire extraction result. Local/direct-client"
- `packages/remnic-core/src/schemas.ts:164` — "// normalization already tolerates these keys; the gateway path must"
- `packages/remnic-core/src/schemas.ts:165` — "// too. Zod's `union` keeps the parse successful either way."
- `packages/remnic-core/src/schemas.ts:367` — "/** * Provider-facing extraction contract. Keep this free of transforms/refinements: * JSON Schema generators cannot fai"
- `packages/remnic-core/src/standup/build.ts:25` — "// Typed so the HTTP surface maps it to 400 (EngramAccessInputError);"
- `packages/remnic-core/src/standup/build.ts:26` — "// subclasses Error, so the CLI still prints the message verbatim."
- `packages/remnic-core/src/standup/build.ts:243` — "// Due-ness first: a commitment with a concrete expiry outranks an"
- `packages/remnic-core/src/standup/build.ts:244` — "// undated one; earlier expiry is more due. Created, then id, as the"
- `packages/remnic-core/src/standup/build.ts:245` — "// stable tiebreak (§12)."
