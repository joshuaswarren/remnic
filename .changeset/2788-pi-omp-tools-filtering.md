---
"@remnic/plugin-pi": patch
---

Accept both MCP tool-name catalog shapes in plugin-pi: current Remnic servers expose underscore-form names (`remnic_recall`), while the plugin previously filtered on the legacy dotted prefix (`remnic.`) only, so every Remnic tool was silently dropped before `pi.registerTool()`. Registration now normalizes only recognized `remnic.`/`remnic_` prefixed names, echoes the catalog name verbatim in `tools/call`, dedupes mixed-shape catalogs, and emits an actionable diagnostic when discovery succeeds but no Remnic tools match. Fixes #2788.
