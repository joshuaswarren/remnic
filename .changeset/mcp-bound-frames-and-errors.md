---
"@remnic/core": patch
---

MCP tools/call no longer returns the message of an unexpected error. A plain `Error` (for example a filesystem error that carries an absolute path) now returns the stable text `internal error`, and the detail goes to the server log. Typed access errors (`EngramAccessInputError`, `EngramAccessForbiddenError`) keep their readable messages.

The MCP stdio reader now bounds each frame (header and body) to 131072 bytes, the same ceiling as the default HTTP body limit. An oversized frame gets a JSON-RPC `frame too large` error, its body is discarded without buffering, and the next frame is answered. The reader also waits for more input when a frame is split across reads instead of looping on the partial buffer, which stalled the stdio server. Part of #3225 (findings C5 and N1).

Stability: stable
