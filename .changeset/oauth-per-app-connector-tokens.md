---
"@remnic/core": patch
"@remnic/server": patch
"@remnic/cli": patch
---

OAuth: mint a separate connector token per linked app (`chatgpt`, `claude-ai`, or `oauth-app-<origin>` for any other app, keyed by the app's full approved redirect origin), so linking Claude no longer revokes ChatGPT's token and the reverse. Origin keys are percent-encoded and include the scheme and port, so two apps can never share an id and rotate each other. All OAuth connector ids stay pinned to `/mcp`.

Stability: stable
