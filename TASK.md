Implement GitHub issue #2718 in this worktree (Remnic public repo). Branch is already `fix/2718-mcp-get-sse`.

# Target
`packages/remnic-core/src/access-http.ts` — `EngramAccessHttpServer.dispatchAuthorizedRequest` (the block near "Method-conformance for the streamable-HTTP MCP endpoint" that currently 405s GET/DELETE on `/mcp`), plus its test in `packages/remnic-core/src/access-http.test.ts` (test name: "HTTP /mcp returns 405 with Allow: POST for GET and DELETE").

Non-goals: do NOT touch `access-mcp.ts` protocol versions, do NOT require `mcp-session-id` on POST, do NOT put JSON-RPC payloads on the GET stream, do NOT add a config key. Leave `POST /mcp` behavior exactly as-is.

# Change
Add the GET SSE half of MCP streamable HTTP so clients that open a GET stream after `initialize` (Grok Build TUI) bind the tool catalog.

1. Replace the current GET/DELETE 405 block with:
   - `DELETE /mcp` → 204 with empty body.
   - `GET /mcp` whose `accept` header contains `text/event-stream` → new private method `handleMcpGetSse(req, res)`.
   - `GET /mcp` without that Accept → keep 405, and set `allow: "GET, POST, DELETE"`.
2. Implement `private async handleMcpGetSse(req: IncomingMessage, res: ServerResponse): Promise<void>` in the same file. Copy the header/heartbeat/cleanup shape from the existing `handleGraphEventsSSE` in this file, but do NOT subscribe to the graph event bus and do NOT resolve a namespace:
   - `res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store, must-revalidate", connection: "keep-alive", "x-accel-buffering": "no", "transfer-encoding": "chunked" })`
   - Write SSE comment heartbeats only (`: ping\n\n`) on a 25s interval. NEVER write JSON-RPC.
   - Ignore `Last-Event-ID`.
   - Register a `cleanup` callback in the existing `this.sseCleanupFns` set and delete it inside cleanup; clear the interval; `req.once("close", cleanup)` and `req.once("error", cleanup)`. This must not leak an interval when a client reconnects.
3. Auth is already enforced upstream — unauthenticated GET must still 401 (do not weaken it).

# Acceptance
Update the existing 405 test and add cases in `packages/remnic-core/src/access-http.test.ts`:
- authorized `GET /mcp` with `accept: text/event-stream` → status 200, `content-type` starts with `text/event-stream`, and the first bytes read from the stream contain NO `jsonrpc`. Read a bounded chunk then abort/cancel the body so the test cannot hang.
- authorized `GET /mcp` without that Accept → 405 and `allow` header equals `GET, POST, DELETE`.
- authorized `DELETE /mcp` → 204.
- unauthenticated `GET /mcp` → 401.

Run ONLY that file:
`NODE_OPTIONS=--conditions=remnic-source npx tsx --test packages/remnic-core/src/access-http.test.ts`
All tests in it must pass (0 fail). Respect the fileSizeGrandfather ratchet for `access-http.ts`: if adding the handler would exceed the cap, extract the SSE handler into a new sibling module instead of growing the file.

Add a changeset file under `.changeset/` (one short paragraph, patch bump for `@remnic/core`).

Then: `git add -A && git commit -m "fix(mcp): serve GET /mcp SSE and DELETE 204 for streamable HTTP clients"` and `git push github fix/2718-mcp-get-sse`. Do NOT open a PR. Do NOT run the full test suite, lint, or formatters. Do not print home directory paths, hostnames, or memory content anywhere in code, tests, comments, or the changeset.
