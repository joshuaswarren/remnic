---
"@remnic/core": minor
---

Add `GrokAdapter` and `OpenCodeAdapter` to the adapter registry. Grok and OpenCode MCP clients now resolve a transport principal (and default namespace) the same way Codex, Claude Code, Hermes, and Replit do — via `clientInfo.name`, `User-Agent`, or the user-configured `X-Engram-Client-Id` header — so namespaced calls work without inventing a session key. Adapters never trust `X-Engram-Principal`; that stays behind the server's `trustPrincipalHeader` gate. Fixes #2782.

---

---
"@remnic/server": minor
---

Parse `server.trustPrincipalHeader` in standalone `remnic-server` config and pass it to the HTTP access server, so the documented `X-Engram-Principal` per-request override works outside the OpenClaw hosted path (issue #2782). Accepts boolean-like strings (`"true"`/`"1"`/`"on"`), defaults to false.
