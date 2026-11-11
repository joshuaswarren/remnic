---
"@remnic/core": patch
---

Hide unexpected MCP tools/call Error.message values behind a stable internal error (detail stays in the server log) and bound stdio Content-Length and header frames to the same 131072-byte ceiling as the HTTP body limit. Part of #3225.
Stability: stable
