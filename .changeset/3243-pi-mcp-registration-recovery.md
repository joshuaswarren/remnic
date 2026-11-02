---
"@remnic/plugin-pi": patch
---

Stability: stable

Let `/remnic-status` retry missing MCP tool registrations after the daemon recovers. Retain successful registrations after a partial failure and share overlapping registration attempts, without bypassing the MCP-tools or authentication gates. Fixes #3243.
