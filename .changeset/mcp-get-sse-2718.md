---
"@remnic/core": patch
---

Serve the GET SSE half of the MCP streamable-HTTP transport (#2718). `GET /mcp`
now returns a `text/event-stream` response carrying comment-only heartbeats
(`: ping` every 25 s, never a JSON-RPC payload) when the client sends
`Accept: text/event-stream`, so clients that open a GET stream after
`initialize` bind the tool catalog; `DELETE /mcp` returns 204 with an empty
body per the spec's session-teardown shape. GET without the SSE Accept header
still returns 405, now advertising `Allow: GET, POST, DELETE`. `POST /mcp`
behavior and authentication are unchanged. The SSE handler lives in a new
sibling module (`access-mcp-sse.ts`) to respect the file-size ratchet on
`access-http.ts`.
