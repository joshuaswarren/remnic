# QMD results are served by the daemon, never the subprocess, and degraded results are reported, redacted, and never cached

Status: accepted

## Context
QMD search has two execution modes: a long-lived daemon and a per-call subprocess. On large collections (75,000+ files) the subprocess burns CPU at ~99% and can hang or time out, making it strictly worse than the daemon for this workload. The daemon itself can be mid-handshake, slow, or transiently failing, and the results it returns flow into cached recall bundles and operator-visible error surfaces. A wrong choice here either hangs callers, poisons caches with failure-shaped results, or leaks the user's recall query through error text.

Scope note: This file merges the chunk's QMD execution, cache-invalidation, default-strategy, degradation-reporting, and error-redaction themes into one family: how a QMD result is produced, trusted, sanitized, and cached.

## Decision
Serve searches through the QMD daemon whenever it is available; never fall back to the subprocess for large collections — a daemon timeout or error still skips the subprocess (which would hang the same way), returning empty instead. When the daemon is spawned but its handshake is not complete, skip the subprocess, return empty, and let the next recheck cycle use the daemon once ready. A daemon result with a non-null outcome is trusted as-is — including zero hits; a null outcome (timeout or transient error) yields a degraded empty result that MUST be reported to the caller's observer and MUST NOT be cached: only trustworthy results are cacheable. Congestion evidence: a call cancelled after the slow-query mark counts as congestion (the daemon really did stall); an explicit cancel of a fast call does not, and a timeout never invalidates the session (the daemon is still running, just slow); transient errors are tolerated a few times before invalidation. An index refresh or embed success invalidates every cached pre-refresh QMD bundle at that single success point so no caller can serve a stale bundle; a lock held by another qmd process does not arm the failure backoff, since the next attempt would otherwise fail even after the lock clears. Error detail strings are sanitized before any line-splitting — whole sensitive values first, then their line fragments — because error labels embed the full command line including the raw recall query, and logs are sanitized the same way. Default strategies: the subprocess command stays `query` (LLM expansion + reranking Remnic depends on); BM25-only `search` is opt-in via qmdSubprocessStrategy and stays uniform across every subprocess path. The daemon v2 default plan is lex+vec+hyde to exercise RRF + rerank, overridable by operators on CPU-only models via qmdSearchStrategy; a lex-only plan never pays the remote rerank leg.

## Consequences
Large collections on a cold or stalled daemon return an empty degraded result instead of a slow-but-real subprocess answer. Degraded results must be re-reported on every call since they cannot be cached. The default `query` command keeps expansion+rerank as a hard dependency; removing it requires changing the default deliberately. Redaction must run before line-splitting or partial prompt text can leak.

## Origin comments
(64 records)
- `packages/remnic-core/src/qmd.ts:1782` — "// 99% CPU on large collections (75K+ files) making it strictly worse than"
- `packages/remnic-core/src/qmd.ts:1783` — "// the daemon for this workload. Specifically:"
- `packages/remnic-core/src/qmd.ts:1784` — "// outcome !== null → daemon succeeded (even with 0 hits) → return as-is"
- `packages/remnic-core/src/qmd.ts:1785` — "// outcome === null → daemon timed-out or errored → still skip subprocess"
- `packages/remnic-core/src/qmd.ts:1786` — "// because subprocess will also hang or timeout"
- `packages/remnic-core/src/qmd.ts:1795` — "// Daemon timed out or had a transient error — skip subprocess for large"
- `packages/remnic-core/src/qmd.ts:1796` — "// collections. Return empty rather than hanging the caller."
- `packages/remnic-core/src/qmd.ts:1802` — "// If the daemon process is spawned but still loading (handshake not yet complete),"
- `packages/remnic-core/src/qmd.ts:1803` — "// skip subprocess — it would add load and block under QMD_MUTEX without helping."
- `packages/remnic-core/src/qmd.ts:1804` — "// Return empty and let the next recheck cycle pick up the daemon once ready."
- `packages/remnic-core/src/qmd.ts:1824` — "// Never cache a degraded empty result: a 60s TTL hit would serve the"
- `packages/remnic-core/src/qmd.ts:1825` — "// failure as a genuine no-matches WITHOUT re-reporting the degradation"
- `packages/remnic-core/src/qmd.ts:1826` — "// (codex review on #1544). Only trustworthy results are cacheable."
- `packages/remnic-core/src/qmd.ts:1903` — "// Try daemon first — BM25 via daemon is much faster than subprocess."
- `packages/remnic-core/src/qmd.ts:1914` — "// When daemon is available, trust its outcome and skip subprocess (same"
- `packages/remnic-core/src/qmd.ts:1915` — "// rationale as search() — subprocess hangs at 99% CPU on 75K+ files)."
- `packages/remnic-core/src/qmd.ts:1953` — "// Try daemon first — keeps models warm, avoids cold subprocess loads."
- `packages/remnic-core/src/qmd.ts:2043` — "// QMD v2: query tool expects { searches: [...], collections?: [...] }"
- `packages/remnic-core/src/qmd.ts:2044` — "// The MCP tool is structured-only in 2.x; use lex+vec+hyde by default"
- `packages/remnic-core/src/qmd.ts:2045` — "// to exercise QMD's RRF + rerank path and let callers override when"
- `packages/remnic-core/src/qmd.ts:2046` — "// they have stronger query-document structure. Operators on CPU-only"
- `packages/remnic-core/src/qmd.ts:2047` — "// models can downgrade the plan via qmdSearchStrategy (issue #1335)."
- `packages/remnic-core/src/qmd.ts:2086` — "// A call cancelled after the slow-query mark (e.g. a namespace leg"
- `packages/remnic-core/src/qmd.ts:2087` — "// deadline) is itself congestion evidence — the daemon really did"
- `packages/remnic-core/src/qmd.ts:2088` — "// stall. An explicit cancel of a fast call still skips the mark."
- `packages/remnic-core/src/qmd.ts:2095` — "// Timeout: don't invalidate session — daemon is still running, just slow."
- `packages/remnic-core/src/qmd.ts:2101` — "// Transient error: tolerate a few before invalidating."
- `packages/remnic-core/src/qmd.ts:2132` — "// A lex-only plan never pays the remote rerank leg — congestion or"
- `packages/remnic-core/src/qmd.ts:2133` — "// dedicated bm25 alike. Forward supported options, then force it off."
- `packages/remnic-core/src/qmd.ts:2233` — "/** * Report a backend degradation to the caller's observer (#1536): an empty * result caused by unavailability/loadi..."
- `packages/remnic-core/src/qmd.ts:2252` — "/** * Condense an error into a degradation `detail` string that is safe to * serialize on LastRecallSnapshot and expo..."
- `packages/remnic-core/src/qmd.ts:2262` — "// Strip known-sensitive strings BEFORE any line-splitting: runQmdCommand"
- `packages/remnic-core/src/qmd.ts:2263` — "// error labels embed the full command line including the raw recall"
- `packages/remnic-core/src/qmd.ts:2264` — "// query, and a multi-line query would otherwise leave its first-line"
- `packages/remnic-core/src/qmd.ts:2265` — "// prefix behind after the first-line cut (codex round-6 P1 on #1544)."
- `packages/remnic-core/src/qmd.ts:2266` — "// Whole values first, then their individual line fragments so truncated"
- `packages/remnic-core/src/qmd.ts:2267` — "// embeddings cannot leak partial prompt text either."
- `packages/remnic-core/src/qmd.ts:2293` — "// INTENTIONAL — DO NOT change the default command from `query` to `search`."
- `packages/remnic-core/src/qmd.ts:2294` — "// `qmd query` performs LLM query expansion + reranking that Remnic depends on"
- `packages/remnic-core/src/qmd.ts:2295` — "// (Remnic's own reranking is disabled because `qmd query` handles it). This is"
- `packages/remnic-core/src/qmd.ts:2296` — "// CLAUDE.md gotcha #7. On very large collections `qmd query` can be slow/hang"
- `packages/remnic-core/src/qmd.ts:2297` — "// (issue #1335), so operators may opt into BM25-only `qmd search` by setting"
- `packages/remnic-core/src/qmd.ts:2298` — "// `qmdSubprocessStrategy: "search"` — but that trades away expansion + rerank,"
- `packages/remnic-core/src/qmd.ts:2299` — "// so it stays opt-in and the default remains `query`."
- `packages/remnic-core/src/qmd.ts:2323` — "// Sanitized in the LOG too: the raw error label embeds the argv,"
- `packages/remnic-core/src/qmd.ts:2324` — "// which includes the user's recall query (codex round-5 P1 on #1544)."
- `packages/remnic-core/src/qmd.ts:2398` — "// Mirror searchViaSubprocess: default `qmd query` keeps LLM expansion +"
- `packages/remnic-core/src/qmd.ts:2399` — "// rerank (gotcha #7); `qmdSubprocessStrategy: "search"` opts into BM25-only"
- `packages/remnic-core/src/qmd.ts:2400` — "// `qmd search` for both scoped AND global recall so the gate stays uniform"
- `packages/remnic-core/src/qmd.ts:2401` — "// across every subprocess path (gotcha #39). Issue #1335."
- `packages/remnic-core/src/qmd.ts:2540` — "// A successful index refresh makes newly-persisted facts searchable, so"
- `packages/remnic-core/src/qmd.ts:2541` — "// any cached pre-refresh QMD search/recall bundle is now stale. Clear the"
- `packages/remnic-core/src/qmd.ts:2542` — "// global QMD result caches here, at the single success point EVERY update"
- `packages/remnic-core/src/qmd.ts:2543` — "// path funnels through (direct calls, wearable/OpenClaw sync reindex, and"
- `packages/remnic-core/src/qmd.ts:2544` — "// the namespace router's per-backend update), so no caller can forget and"
- `packages/remnic-core/src/qmd.ts:2545` — "// serve a stale bundle past the refresh (#1904, Codex/Cursor)."
- `packages/remnic-core/src/qmd.ts:2550` — "// Another qmd process holds the index. Arming the 15-minute failure"
- `packages/remnic-core/src/qmd.ts:2551` — "// backoff would make the next converge attempt fail even after the lock"
- `packages/remnic-core/src/qmd.ts:2552` — "// is gone. A real index failure still backs off."
- `packages/remnic-core/src/qmd.ts:2664` — "// A successful embed changes vector searchability, so cached pre-embed"
- `packages/remnic-core/src/qmd.ts:2665` — "// bundles may now be stale. Clear at this single success point (#1904)."
- `packages/remnic-core/src/qmd.ts:2683` — "// Recovery also changed vector searchability — clear cached bundles."
- `packages/remnic-core/src/qmd.ts:2752` — "// Treat command/probe failures as unknown so callers do not disable features"
- `packages/remnic-core/src/qmd.ts:2753` — "// permanently after a transient CLI or daemon hiccup."
