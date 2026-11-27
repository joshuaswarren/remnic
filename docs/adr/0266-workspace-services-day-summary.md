# Shared workspace services are lazily constructed singletons, and day summaries read UTC facts into local-day targets with containment checks

Status: accepted

## Context
Meetings and wearables surfaces were each constructing their own service instances, and per-update corpus scans over 130k memories stalled for tens of seconds. Day summaries must reconcile UTC-stored facts with local-day summary targets without reading outside the store.

## Decision
All meetings and wearables surfaces share one lazily-constructed service instance per process; meeting memory generation sits behind the builder seam and post-sync rebuilds coalesce on a trailing-edge window; activity is machine-scoped and namespace work is scoped to the caller's collection. Indexed transcript search is scoped to the caller namespace's collection and reports 'unavailable' (not empty) on backend hiccups. QMD's own update clears the global result caches — callers do not double-clear. Workspace ops never scan the whole corpus per update: access tracking resolves paths once and the memory index stays incrementally maintained. Day summaries iterate every recall category dir from the single fallback-dirs source, map UTC fact directories onto the local-day target, harden every path read with symlink containment, and sort by created time so truncation keeps the newest facts. The xray capture queue keeps an abandoned node as a barrier until its predecessor settles.

## Consequences
Singleton services mean per-surface configuration must live in the service, not the caller. Day-summary output is local-day shaped while facts remain UTC-stored, so consumers comparing the two must convert.

## Origin comments
- `packages/remnic-core/src/orchestration/workspace-ops.test.ts:387` — "COS-666e: flushAccessTracking scanned the whole corpus for every buffered update and resolved paths on each"
- `packages/remnic-core/src/orchestration/workspace-ops.test.ts:388` — "comparison: 100 updates x 130k memories x 2-3 resolves was a 40 s main-thread stall in production."
- `packages/remnic-core/src/orchestration/workspace-ops.test.ts:454` — "late in the corpus: a scan walks almost all of it"
- `packages/remnic-core/src/orchestration/workspace-ops.test.ts:486` — "the per-update corpus scan took several seconds here"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:65` — "Trailing-edge coalescing window for post-sync meeting rebuilds (issue #1900)"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:130` — "COS-666e: the old per-update find over the corpus resolved paths (a 40 s stall at 130k memories)"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:363` — "Facts are stored under UTC date directories, while the summary target is"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:364` — "a local calendar day. Scan the UTC-date envelope that overlaps the local"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:365` — "day, then filter parseable fact timestamps to that configured local day."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:370` — "Iterate every recall category dir (RECALL_FALLBACK_DIRS — single source"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:371` — "of truth) so the day summary includes decisions/, moments/, ... not just"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:372` — "facts/ (#1546). corrections/ is flat, so corrections/<date>/ never exists"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:373` — "and is skipped by the ENOENT guard — preserving the prior exclusion. The"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:374` — "per-file created→local-day filter below is unchanged."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:375` — "Symlink/containment hardening (mirrors scanDir / the CLI walker): the"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:376` — "gathered contents feed the day-summary LLM input, so a symlinked category"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:377` — "dir (decisions/ → outside memoryDir) must not be followed and leak files."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:378` — "Resolve the store root once; skip symlinked / out-of-root dirs and"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:379` — "entries; skip the scan gracefully if the root can't be resolved."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:380` — "entries; skip the scan gracefully (continuation line of range 375-380)"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:424` — "Sort facts by created timestamp (most recent last) so truncation keeps newest"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:665` — "Lazily-constructed wearables service... All wearables surfaces share this one instance"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:700` — "Scope the indexed search to the CALLER namespace's collection so a"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:701` — "non-default caller's transcript_search never returns root or"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:702` — "other-namespace transcripts (#2123). Namespaces off, or the"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:703` — "default/machine-owner namespace rooted at memoryDir, resolve to the"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:704` — "base collection (unchanged); every other namespace to its own."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:723` — "Backend hiccup → tell the service "unavailable" so it"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:724` — "runs its bounded scan fallback instead of returning a"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:725` — "silent empty result (CLAUDE.md rule 34)."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:731` — "qmd.update() clears the global QMD result caches itself on success"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:732` — "(QmdClient.runUpdateForCollection), so newly-indexed wearable"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:733` — "transcript/fact content is never hidden by a pre-sync cache entry"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:734` — "(#1904, Codex)."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:737` — "Meeting tail-step (issue #1900): schedule a debounced meeting rebuild"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:738` — "for every day a wearable sync touched. Wired on the shared service so"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:739` — "BOTH the auto-sync adapter and the manual HTTP/MCP/CLI sync path"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:740` — "(EngramAccessService.wearablesSync -> getWearablesService().sync)"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:741` — "rebuild affected meetings. Gated on meetings.enabled so a sync of"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:742` — "other signals never spins up meeting building; a failure never fails"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:743` — "the sync."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:763` — "Lazily-constructed meetings service (issue #1900). Owns the record store..."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:779` — "Activity is machine-scoped (<memoryDir>/state/activity.sqlite) and is"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:780` — "consumed ONLY by the machine-owner (default) namespace; every other"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:781` — "caller namespace runs audio-only with no activity reader (issue #2123)."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:782` — "A missing/unavailable store degrades to no screen context, never a fail."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:838` — "Meeting records live in the QMD collection root; reindex on change"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:839` — "so `show`/search find them immediately (qmd.update clears its own"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:840` — "result caches). Fired only when records changed; a failure is"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:841` — "surfaced as a build warning, not a hard failure."
- `packages/remnic-core/src/orchestration/workspace-ops.ts:845` — "Memory generation behind the builder seam (issue #1900 decouple): the"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:846` — "deterministic engine depends only on MeetingMemoryGenerator, never on"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:847` — "memory-gen. The generator wraps the same sealed write path the wearables"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:848` — "generator uses — createMeetingMemoryWriter adds the source-scoped"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:849` — "dedup/retire the raw StorageManager lacks — plus the trust-gated"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:850` — "summary/facts layer (extractor + shared durability judge). It gates on"
- `packages/remnic-core/src/orchestration/workspace-ops.ts:851` — "summaryMode internally, so `off` never invokes the extractor."
- `packages/remnic-core/src/orchestration/xray-capture-queue.ts:34` — "Keep this abandoned node as a barrier until its predecessor settles,"
- `packages/remnic-core/src/orchestration/xray-capture-queue.ts:35` — "so later callers cannot overtake the still-active operation."
