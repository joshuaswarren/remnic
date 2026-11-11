---
"@remnic/core": patch
---

`remnic access mcp-serve` now accepts newline-delimited JSON on stdio, which is the form the MCP spec specifies, and replies in the same form. A client that sends `Content-Length` frames still gets `Content-Length` replies.

Stability: stable
