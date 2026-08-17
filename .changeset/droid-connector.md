---
"@remnic/core": patch
"@remnic/connector-droid": patch
---

Add Factory Droid connector (`remnic connectors install droid`). Mints a host token, records connector state, and writes a `remnic` MCP server entry (HTTP + bearer auth) to the user-level `~/.factory/mcp.json`. Never writes tokens to the project-level `.factory/mcp.json`. `remnic connectors doctor droid` and `remnic connectors remove droid` are supported. Built by Droid.
