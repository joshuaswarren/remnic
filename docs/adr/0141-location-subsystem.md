# Location context is opt-in, provider-agnostic through a core registry, and journaled in durable half-open day buckets

Status: accepted

## Context
The location subsystem (issues #2043-#2047) must work on machines where no provider package is installed, keep coordinates (privacy data) out of storage unless explicitly retained, and never let a sync watermark advance past data that was not durably written. Host adapters, MCP tools, and HTTP routes must share one validated dispatch so the surfaces cannot diverge; a static dependency from core on a provider package would break a-la-carte installs.

## Decision
(1) Core never statically imports a provider package; provider implementations register at runtime through an in-memory registry (registerLocationProvider) consumed via the @remnic/core/location subpath export. (2) Provider bootstrap treats absent credentials or packages as skips, never errors; tokens never enter config files, errors, or logs; registration is idempotent. (3) All surfaces (CLI, MCP tools, HTTP routes under /engram/v1/location/... and the /remnic/v1 alias) dispatch through the same access-boundary operations and one shared runner implementation; MCP tool definitions are extracted into their own module so the surface file stays at its structural ceiling. (4) Sync state advances only AFTER the durable day write succeeds; an empty fetch is a successful sync. State load-mutate-save sections are serialized per state file so concurrently syncing sources cannot lose-update each other; a corrupt state file is treated as a cold start (re-syncing is idempotent via the day file's contentHash). (5) Day documents live under memoryDir/locations/YYYY-MM-DD; an unvalidated date is never interpolated into a filesystem path (reject loudly); a symlinked locations root or day file is rejected outright even when the link resolves inside the memory dir. (6) Day attribution uses half-open [start, end) buckets ending at local midnight, keyed on the conversation's END-anchored day; fills must consult both day keys of a conversation that spans midnight. (7) Matching is decided in one module: structured-attribute keys owned by the tagging pipeline are never manual; the interval comparator is total (equal keys fall back to place id) and insertion order never wins; slug edge strips depend on the single-character collapse invariant, which tests assert via the OUTPUT contract. (8) Tagging outcome counts are recorded only after the write; the briefing reads the location section before build runs. (9) Backfill is idempotent, bounded, and LLM-free over an explicit [from, to] range.

## Consequences
Runtime registration means a missing provider package degrades to skips rather than a hard error; coordinates are dropped everywhere by default; strict path/symlink rejection trades convenience for tamper resistance; end-anchored bucketing requires two day-key lookups for midnight-spanning conversations.

## Origin comments
- `packages/remnic-core/src/location/matching.test.ts:76` - "This is the invariant the single-character edge strips depend on: the /[^a-z0-9]+/ collapse cannot leave two dashes at an edge."
- `packages/remnic-core/src/location/matching.test.ts:77` - "the collapse and the strips silently stop being complete, so assert the OUTPUT contract directly rather than timing"
- `packages/remnic-core/src/location/matching.test.ts:79` - "OUTPUT contract directly rather than timing something the collapse has already bounded"
- `packages/remnic-core/src/location/matching.test.ts:80` - "already bounded."
- `packages/remnic-core/src/location/matching.ts:1` - "Core location matcher (issue #2046) — the ONE place that decides whether a memory or wearable conversation gets provider location context."
- `packages/remnic-core/src/location/matching.ts:39` - "Structured-attribute keys owned by the tagging pipeline (never manual)."
- `packages/remnic-core/src/location/matching.ts:95` - "The interval is half-open [start, end): its last instant is end-1ms, so a memory ending exactly at local midnight never touches the next day."
- `packages/remnic-core/src/location/mcp-tools.ts:1` - "Location MCP tool definitions (issue #2047) — extracted from access-mcp.ts so the surface file stays at its structural ceiling."
- `packages/remnic-core/src/location/phase5-wiring.test.ts:1` - "Phase-5 wiring regression (issue #2925): pins the contract the umbrella issue (#2043) requires."
- `packages/remnic-core/src/location/phase5-wiring.test.ts:250` - "America/New_York: conversation 2026-06-30T03:30Z–04:30Z is 23:30–00:30 local, spanning the June-29 / June-30 midnight."
- `packages/remnic-core/src/location/phase5-wiring.test.ts:251` - "23:30–00:30 local, spanning the June-29 / June-30 midnight. The only qualifying segment lives on the June-30 bucket."
- `packages/remnic-core/src/location/phase5-wiring.test.ts:252` - "The only qualifying segment (00:00–01:00 local) lives on the June-30 bucket — the conversation's END-anchored day."
- `packages/remnic-core/src/location/phase5-wiring.test.ts:253` - "the conversation's END-anchored day, not its start day. The fill must consult both day keys, not just the start day."
- `packages/remnic-core/src/location/phase5-wiring.test.ts:254` - "The fill must consult both day keys, not just the start day."
- `packages/remnic-core/src/location/pipeline.ts:1` - "Location day-sync pipeline (issue #2044). Sync state advances only AFTER the day document is durable; an empty fetch is a successful sync (AGENTS.md rule 22)."
- `packages/remnic-core/src/location/pipeline.ts:193` - "State advances only after the durable day write above succeeded."
- `packages/remnic-core/src/location/provider-setup.test.ts:1` - "Provider setup regression (issue #2047): absent credentials or package are skips (never errors), tokens never reach logs, registration is idempotent."
- `packages/remnic-core/src/location/provider-setup.ts:1` - "Location provider bootstrapping (issue #2047). Core never statically imports a provider package; tokens never enter config files, errors, or logs."
- `packages/remnic-core/src/location/registry.ts:1` - "/** * Location provider registry (issue #2044). * * In-memory only: host adapters register provider implementations at s"
- `packages/remnic-core/src/location/scheduler.ts:1` - "/** * Location auto-sync — in-process periodic day sync (issue #2047). * * Arms one repeating timer that runs the SAME s"
- `packages/remnic-core/src/location/store.ts:1` - "/** * Location day-file + sync-state store (issue #2044). * * Day documents live at `<memoryDir>/locations/<YYYY-MM-DD>."
- `packages/remnic-core/src/location/store.ts:37` - "// Serializes state load→mutate→save sections per state file so two sources"
- `packages/remnic-core/src/location/store.ts:38` - "// syncing concurrently cannot lose-update each other's entries."
- `packages/remnic-core/src/location/store.ts:57` - "// Never interpolate an unvalidated date into a filesystem path (a `../`"
- `packages/remnic-core/src/location/store.ts:58` - "// would escape <memoryDir>/locations/). Reject loudly."
- `packages/remnic-core/src/location/store.ts:101` - "// A corrupt state file must not brick syncing forever; treat it as a cold"
- `packages/remnic-core/src/location/store.ts:102` - "// start. The worst case is re-syncing days already on disk, and the day"
- `packages/remnic-core/src/location/store.ts:103` - "// file's contentHash makes that rewrite idempotent."
- `packages/remnic-core/src/location/store.ts:419` - "// Reject a symlinked locations root or day file outright — even when the"
- `packages/remnic-core/src/location/store.ts:420` - "// link resolves inside the memory dir (aliasing / tampering) — before IO."
- `packages/remnic-core/src/location/surfaces.ts:1` - "/** * Location surface runners (issues #2047, #2046) — ONE implementation shared * by the CLI (`remnic location ...`), t"
- `packages/remnic-core/src/location/tagging.ts:200` - "// Count patch outcomes (tagged/updated/removed) only after the write"
- `packages/remnic-core/src/location/tagging.ts:297` - "/** * Append the opt-in location section to a briefing. The section is read BEFORE * `build` runs: buildBriefing drains "
