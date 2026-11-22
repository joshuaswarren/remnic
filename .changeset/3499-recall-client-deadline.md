---
"@remnic/plugin-pi": patch
"@remnic/core": patch
---

Stability: stable

Publish the recall client's request budget to the daemon as `deadlineMs` on both explicit-recall surfaces — the `/engram/v1/recall` body and the `engram.recall` MCP `tools/call` arguments — so a cold recall after a Pi restart degrades inside the window the client is actually waiting on instead of running the daemon's unclamped ceiling after the socket closed (issue #3499). The published deadline is the request budget minus a small response-egress reserve, so the daemon's degraded answer or deadline error still reaches the client before its own abort fires. The `engram.recall` MCP tool now advertises `deadlineMs` in its input schema.
