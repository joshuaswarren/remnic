---
"@remnic/core": patch
"@remnic/server": patch
"@remnic/cli": patch
---

OAuth: mint a separate connector token per linked app (`chatgpt`, `claude-ai`, or `oauth-app-<host>` for any other app, chosen from the approved redirect URI host), so linking Claude no longer revokes ChatGPT's token and the reverse. All OAuth connector ids stay pinned to `/mcp`.

Stability: stable
