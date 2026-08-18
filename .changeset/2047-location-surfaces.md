---
"@remnic/core": minor
"@remnic/cli": minor
---

Expose location sync across every surface (issue #2047): CLI (`remnic location status|check|sync|backfill|day`), MCP (`engram.location_*` tools with automatic `remnic.*` aliases), HTTP (`/engram/v1/location/...` + `/remnic/v1/...` aliases; 400 invalid input, 401/403 auth, 404 unstored day, 500 backend faults), and the maintenance scheduler (daily tick over the `location.syncDays` window, master default-off, torn down with the orchestrator). One shared runner (`location/surfaces.ts`) backs all four surfaces — disabled vs empty vs failure stay distinct, a forced sync never bypasses the enabled gates, and backfill is bounded to 90 days. Providers boot from env credentials (`REITTI_BASE_URL`, `REITTI_TOKEN`, optional `REITTI_AUTH_MODE`) via computed-specifier dynamic imports, so an absent package or credential set stays `provider-not-registered`, never an error; tokens never reach logs. access-mcp.ts/access-http.ts/maintenance.ts/remnic-cli index stay at or under their grandfather ceilings (net-negative: wearables route body, wearables CLI case, and the day-summary cron model block were extracted into sibling modules).
