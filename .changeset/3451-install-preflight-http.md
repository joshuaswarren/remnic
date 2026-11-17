---
"@remnic/plugin-agy": patch
---

Add `install-preflight.cjs` so the agy install fails before reporting green when the daemon URL is non-loopback plain `http://` — the condition where `mcp-server-stdio` exits 2 without `REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1` and the remember/recall MCP tools never register. Loopback and `https://` URLs pass silently; the explicit opt-in passes with a cleartext warning. Closes #3451.

Stability: stable
