# The chat engine is a bounded, confirmation-gated agent whose sessions are principal-bound, path-safe, and race-hardened

Status: accepted

## Context
The chat engine lets an LLM call mutating memory tools (correction_apply, memory_promote) across CLI, HTTP, and MCP surfaces. The LLM can hallucinate tool calls, sessions are files on disk exposed to TTL sweeps and concurrent appends, and several principals can target the same session id. Review rounds surfaced bypass attempts (re-apply of confirmed plans, repeated tool-loop calls of memory_promote, namespace-scoped tokens minting sessions outside their allow-list), clock skew, and TOCTOU between open and append.

## Decision
Keep the agent bounded and the session trustworthy: (1) the engine is a bounded tool-loop agent with a sealed system prompt — not a general assistant; (2) mutating tools are never executed directly in the tool loop — they are applied only via a deterministic, exact-match confirmation fast-path at the top of processMessage, bypassing LLM interpretation; the confirmation is one-time and consumed on success so a stale confirm cannot re-apply; a failed apply restores the pending state for retry; (3) a tool not in the active schema set is rejected before any confirmation flow or executor call — disabled mutating tools stay out of the schema entirely so hallucinated calls cannot reach executors; (4) all three surfaces share one engine factory, and every executor is a thin adapter over the access service so tool calls flow with the session's namespace/sessionKey identity; (5) an MCP chat turn enforces the same per-token op allow-list and effective-namespace gate as the HTTP route — new sessions resolve the effective namespace (scope or server default) and fail closed against the token allow-list at one shared chokepoint; (6) a resumed session with no recorded principal is accessible to anyone (legacy single-user case); a session with a principal requires an exact match; session files live only under the chat dir and a malicious session id reads as not-found, never as a file outside the dir; (7) session appends use O_APPEND without O_CREAT so a session unlinked by a concurrent TTL sweep fails at open time — no stat-then-append TOCTOU; a post-append re-stat fails the turn visibly rather than writing to an orphaned inode and returning 200; only ENOENT maps to session-expired, real fs errors are rethrown; the TTL sweep re-checks mtime immediately before unlinking; (8) transcript sequence numbers are strictly monotonic across restarts and clock skews (raise the counter above the on-disk max), because SSE reconnect dedup relies on seq; pending plan/promotion state is persisted as append-only markers written only when state actually changes, and resolving one kind never clears the other; (9) SSE streams subscribe before reading the transcript snapshot, register disconnect cleanup immediately, never write to a closed connection, drain buffered appends only after switching to live push, use unref'd heartbeats, and release server-stop registrations on every exit path including error paths; (10) identical concurrent chat requests are coalesced under a key that includes the principal (absent included), so two callers on one session id never share a result; engine errors are mapped to HTTP statuses field-by-field — the engine result is never serialized wholesale and raw error metadata or messages are never echoed to MCP/HTTP clients; tool results are normalized to a provider-safe role (user message) since bare role:tool is rejected by OpenAI-compatible endpoints; (11) chat must work local-first via duck-typed LLM clients with fallback routing; the bridge prompt must spell out the required JSON shape so summary-only replies are schema-rejected.

## Consequences
The confirmation protocol adds one turn of latency to every mutating action and cannot be shortened by prompt engineering. Strict principal binding means legacy sessions without bindings stay world-readable — migrating them requires backfilling headers. The append TOCTOU guard converts a mid-sweep race into a visible failed turn instead of a silent success, which callers must treat as retryable. Exact-match confirmations stay a small fixed set; paraphrased confirmations fall through to the conservative no-apply default.

## Origin comments
### chat-engine-confirmation-protocol
- `packages/remnic-core/src/chat/chat-engine.ts:1` — "Chat engine — the bounded tool-loop agent (issue #1583). Loop: user message → LLM (with tool schema) → execute tool call"
- `packages/remnic-core/src/chat/chat-engine.ts:88` — "// Exact-match confirmations. Unrecognized text keeps the conservative"
- `packages/remnic-core/src/chat/chat-engine.ts:89` — "// no-apply default, so this stays a small fixed set (issue #2198)."
- `packages/remnic-core/src/chat/chat-engine.ts:147` — "// ── Confirmation fast-path ──────────────────────────────────────────"
- `packages/remnic-core/src/chat/chat-engine.ts:148` — "// If there is a pending plan and the user's message is an exact-match"
- `packages/remnic-core/src/chat/chat-engine.ts:149` — "// confirmation keyword, mark the plan confirmed and apply it directly"
- `packages/remnic-core/src/chat/chat-engine.ts:150` — "// (bypassing the LLM — deterministic, not LLM-interpreted)."
- `packages/remnic-core/src/chat/chat-engine.ts:162` — "// Consume the one-time confirmation on success so a later"
- `packages/remnic-core/src/chat/chat-engine.ts:163` — "// tool-loop correction_apply cannot re-apply the same plan id"
- `packages/remnic-core/src/chat/chat-engine.ts:164` — "// (cursor Medium: stale confirm allowed re-apply)."
- `packages/remnic-core/src/chat/chat-engine.ts:172` — "// Roll back: the plan was NOT applied — restore the pending state"
- `packages/remnic-core/src/chat/chat-engine.ts:173` — "// so the user can retry (cursor HIGH OlACo)."
- `packages/remnic-core/src/chat/chat-engine.ts:195` — "// Roll back: the promotion was NOT applied — restore pending state."
- `packages/remnic-core/src/chat/chat-engine.ts:310` — "// Not confirmed — return the plan preview for user confirmation."
- `packages/remnic-core/src/chat/chat-engine.ts:311` — "// The plan was generated by a prior correction_plan call; fetch it."
- `packages/remnic-core/src/chat/chat-engine.ts:316` — "// Bind the REQUESTED planId so the confirmation fast-path applies"
- `packages/remnic-core/src/chat/chat-engine.ts:317` — "// the exact plan shown (not an executor re-minted id)."
- `packages/remnic-core/src/chat/chat-engine.ts:347` — "// ── memory_promote confirmation (mutating tool) ─────────────────"
- `packages/remnic-core/src/chat/chat-engine.ts:348` — "// memory_promote is NEVER executed directly in the tool loop — it can"
- `packages/remnic-core/src/chat/chat-engine.ts:349` — "// only be applied via the confirmation fast-path at the top of"
- `packages/remnic-core/src/chat/chat-engine.ts:350` — "// processMessage (cursor HIGH: prevent bypass via repeated tool calls)."

### chat-executor-thin-adapter
- `packages/remnic-core/src/chat/chat-engine.ts:39` — "The executor interface the engine calls for each tool. Each implementation is a thin adapter over the corresponding acce"
- `packages/remnic-core/src/chat/chat-executor.ts:1` — "Production chat-tool executor (issue #1583). Each method is a thin adapter over the corresponding EngramAccessService me"

### chat-engine-tool-schema-gate
- `packages/remnic-core/src/chat/chat-engine.ts:134` — "// Pre-compute the set of allowed tool names for fast lookup (cursor HIGH —"
- `packages/remnic-core/src/chat/chat-engine.ts:135` — "// executeTool must not run a tool that's not in the active schema set)."
- `packages/remnic-core/src/chat/chat-engine.ts:293` — "// ── Tool-schema gate (cursor HIGH OlCjs — must run before mutating-tool"
- `packages/remnic-core/src/chat/chat-engine.ts:294` — "// interception so disabled tools like correction_apply/memory_promote"
- `packages/remnic-core/src/chat/chat-engine.ts:295` — "// are rejected before any confirmation flow or executor call)."

### chat-transcript-integrity
- `packages/remnic-core/src/chat/chat-engine.ts:207` — "// ── Normal tool-loop ────────────────────────────────────────────────"
- `packages/remnic-core/src/chat/chat-engine.ts:208` — "// Build the transcript context, filtering out:"
- `packages/remnic-core/src/chat/chat-engine.ts:209` — "// - the system header (seq === 0)"
- `packages/remnic-core/src/chat/chat-engine.ts:210` — "// - internal state markers (pending_plan:/pending_promotion:/plan_applied:)"
- `packages/remnic-core/src/chat/chat-engine.ts:211` — "// - the last user entry if it matches userMessage (the caller already"
- `packages/remnic-core/src/chat/chat-engine.ts:212` — "// appended it to the transcript before calling processMessage — adding"
- `packages/remnic-core/src/chat/chat-engine.ts:213` — "// it again below would duplicate it in the prompt)."
- `packages/remnic-core/src/chat/chat-engine.ts:281` — "// Push the assistant response content once for this LLM turn (not per"
- `packages/remnic-core/src/chat/chat-engine.ts:282` — "// tool call — avoids duplicate assistant messages in the conversation)."

### chat-budget-summary-best-effort
- `packages/remnic-core/src/chat/chat-engine.ts:413` — "// Budget-exhaustion summary is best-effort — don't mask the partial"
- `packages/remnic-core/src/chat/chat-engine.ts:414` — "// results with a transport error (kilo review, Thread 16)."

### chat-citation-guard-heuristic
- `packages/remnic-core/src/chat/chat-engine.ts:492` — "Heuristic: does the reply look like it's asserting stored memory content without citing a tool result? This is intention"

### chat-unified-engine-factory
- `packages/remnic-core/src/chat/chat-factory.ts:1` — "Chat engine factory + message processor (issue #1583). Used by all three surfaces (CLI, HTTP, MCP) so they share..."

### chat-session-scope-inheritance
- `packages/remnic-core/src/chat/chat-factory.ts:95` — "Load or create the session FIRST so the engine inherits the session's"
- `packages/remnic-core/src/chat/chat-factory.ts:96` — "namespace/sessionKey scope (rule 42 — every tool call flows with that"
- `packages/remnic-core/src/chat/chat-factory.ts:97` — "identity; the executor must not use a different scope than the session)."

### chat-pending-state-markers
- `packages/remnic-core/src/chat/chat-factory.ts:131` — "Snapshot pending state BEFORE the turn so we only persist a marker when"
- `packages/remnic-core/src/chat/chat-factory.ts:132` — "state actually changed (Thread 15 — a normal turn must not clear an"
- `packages/remnic-core/src/chat/chat-factory.ts:133` — "active pending plan/promotion from an earlier turn)."
- `packages/remnic-core/src/chat/chat-factory.ts:144` — "Persist pending-plan/promotion state so a later turn can confirm it"
- `packages/remnic-core/src/chat/chat-factory.ts:145` — "(append-only — loadChatSession scans for the latest unresolved marker)."
- `packages/remnic-core/src/chat/chat-factory.ts:158` — "else: no pending-state change this turn — do NOT append a marker."

### chat-http-test-design
- `packages/remnic-core/src/chat/chat-http.test.ts:22` — "Minimal mock res capturing writes. All tracking fields live on one"
- `packages/remnic-core/src/chat/chat-http.test.ts:23` — "object the methods mutate (no spread copy — primitives would freeze at 0)."
- `packages/remnic-core/src/chat/chat-http.test.ts:263` — "Simulate enough work that the second request lands while the"
- `packages/remnic-core/src/chat/chat-http.test.ts:264` — "first is still in-flight (the dedup window)."
- `packages/remnic-core/src/chat/chat-http.test.ts:326` — "Emit close as a microtask so it fires while the handler is awaiting"
- `packages/remnic-core/src/chat/chat-http.test.ts:327` — "loadChatSession (before writeHead). The handler must bail out without"
- `packages/remnic-core/src/chat/chat-http.test.ts:328` — "writing to the ended response and without setting up a heartbeat."

### chat-http-design
- `packages/remnic-core/src/chat/chat-http.ts:1` — "Chat HTTP handler (issue #1583 PR 3; deferred items #1685 / #1687)."

### chat-message-in-flight-dedup
- `packages/remnic-core/src/chat/chat-http.ts:63` — "Pending chat-message promises keyed by"
- `packages/remnic-core/src/chat/chat-http.ts:78` — "Encode the principal into a fingerprint component where an absent principal"
- `packages/remnic-core/src/chat/chat-http.ts:90` — "sha256 keeps the key bounded for long messages; the principal component"
- `packages/remnic-core/src/chat/chat-http.ts:91` — "is distinct per principal (incl. absent) so two callers targeting the"
- `packages/remnic-core/src/chat/chat-http.ts:92` — "same session id can never share a result — the wrong principal still"
- `packages/remnic-core/src/chat/chat-http.ts:93` — "independently hits access_denied inside processChatMessage."
- `packages/remnic-core/src/chat/chat-http.ts:98` — "Run `processChatMessage` with concurrent-identical-request coalescing."
- `packages/remnic-core/src/chat/chat-http.ts:110` — "No session id → no coalescing (each request creates its own session)."

### chat-http-error-mapping
- `packages/remnic-core/src/chat/chat-http.ts:179` — "processChatMessage throws tagged errors for the session/LLM/engine"
- `packages/remnic-core/src/chat/chat-http.ts:180` — "paths; map each back to its HTTP status.  Dedup coalescing means a"
- `packages/remnic-core/src/chat/chat-http.ts:181` — "concurrent duplicate shares the same rejection.  A 'chat_session_expired'"
- `packages/remnic-core/src/chat/chat-http.ts:182` — "means the session was swept by the TTL cleanup mid-turn (codex P2) —"
- `packages/remnic-core/src/chat/chat-http.ts:183` — "tell the client to start a fresh session (410 Gone)."

### chat-http-response-field-filtering
- `packages/remnic-core/src/chat/chat-http.ts:204` — "Build the public response field-by-field.  Never serialize the engine"
- `packages/remnic-core/src/chat/chat-http.ts:205` — "result wholesale: an engine failure may carry internal error metadata."

### chat-sse-stream-lifecycle
- `packages/remnic-core/src/chat/chat-http.ts:261` — "Liveness flag + handle, both closed over by the disconnect cleanup. The"
- `packages/remnic-core/src/chat/chat-http.ts:262` — "cleanup is idempotent (guarded by `closed`) so a repeat close is harmless."
- `packages/remnic-core/src/chat/chat-http.ts:265` — "Every SSE write goes through this helper so a closed connection is never"
- `packages/remnic-core/src/chat/chat-http.ts:266` — "written to (cursor Low review). Returns false when the write was skipped."
- `packages/remnic-core/src/chat/chat-http.ts:277` — "Subscribe BEFORE reading the transcript so a concurrent append between"
- `packages/remnic-core/src/chat/chat-http.ts:278` — "the snapshot read and subscription is never missed (cursor Bugbot race)."
- `packages/remnic-core/src/chat/chat-http.ts:279` — "During the initial burst entries are buffered; after the burst the"
- `packages/remnic-core/src/chat/chat-http.ts:280` — "listener switches to writing straight to the response. A `closed` check"
- `packages/remnic-core/src/chat/chat-http.ts:281` — "short-circuits pushes to a connection that is already gone."
- `packages/remnic-core/src/chat/chat-http.ts:293` — "Register disconnect cleanup IMMEDIATELY so a close during loadChatSession"
- `packages/remnic-core/src/chat/chat-http.ts:294` — "or the burst still releases the subscription (cursor Bugbot). The flag"
- `packages/remnic-core/src/chat/chat-http.ts:295` — "gates every later write so the handler never touches an ended response"
- `packages/remnic-core/src/chat/chat-http.ts:296` — "(kilo review thread) and never sets up a heartbeat for a dead socket"
- `packages/remnic-core/src/chat/chat-http.ts:297` — "(cursor review thread)."
- `packages/remnic-core/src/chat/chat-http.ts:304` — "Register with the host server's stop() cleanup set (cursor Medium) so an"
- `packages/remnic-core/src/chat/chat-http.ts:305` — "HTTP shutdown forcibly releases the subscription + heartbeat even when a"
- `packages/remnic-core/src/chat/chat-http.ts:306` — "lingering client never emits 'close'. Unregistered again on normal close."
- `packages/remnic-core/src/chat/chat-http.ts:314` — "If the client disconnected during the load, cleanup already ran — bail"
- `packages/remnic-core/src/chat/chat-http.ts:315` — "out before touching the response (prevents "headers after end")."
- `packages/remnic-core/src/chat/chat-http.ts:318` — "No SSE stream is established — release the server stop() registration"
- `packages/remnic-core/src/chat/chat-http.ts:319` — "alongside the subscription so sseCleanupFns does not retain a stale"
- `packages/remnic-core/src/chat/chat-http.ts:320` — "callback for this JSON error response (cursor Medium: error-path leak)."
- `packages/remnic-core/src/chat/chat-http.ts:344` — "Send the transcript snapshot as the initial burst, recording delivered"
- `packages/remnic-core/src/chat/chat-http.ts:345` — "seqs so buffered concurrent appends are not double-delivered."
- `packages/remnic-core/src/chat/chat-http.ts:352` — "Switch to live push FIRST, THEN drain buffered appends. Ordering matters:"
- `packages/remnic-core/src/chat/chat-http.ts:353` — "if an append lands between the drain and the mode switch it would be"
- `packages/remnic-core/src/chat/chat-http.ts:354` — "buffered (bursting still true) and never re-drained (cursor Medium). With"
- `packages/remnic-core/src/chat/chat-http.ts:355` — "live mode on, appends during the drain write straight through and the"
- `packages/remnic-core/src/chat/chat-http.ts:356` — "buffer is emptied once."
- `packages/remnic-core/src/chat/chat-http.ts:364` — "Heartbeat. Unref'd so a lingering connection never blocks process"
- `packages/remnic-core/src/chat/chat-http.ts:365` — "exit (rule 47 — no shared mutable objects keep the loop alive). Cleared"
- `packages/remnic-core/src/chat/chat-http.ts:366` — "by the close handler above when the client disconnects. Guard against"
- `packages/remnic-core/src/chat/chat-http.ts:367` — "arming after a disconnect during the burst/drain: the close handler"
- `packages/remnic-core/src/chat/chat-http.ts:368` — "already ran doCleanup (clearing any prior handle and unregistering the"
- `packages/remnic-core/src/chat/chat-http.ts:369` — "server callback), so an interval armed here would be untracked and never"
- `packages/remnic-core/src/chat/chat-http.ts:370` — "cleared — bail out instead (codex P2)."

### chat-llm-local-first
- `packages/remnic-core/src/chat/chat-llm.ts:1` — "LLM adapter for the chat engine (issue #1583). ... Memory chat must not require cloud."

### chat-duck-typed-llm-client
- `packages/remnic-core/src/chat/chat-llm.ts:21` — "Minimal LLM-client interface (duck-typed from FallbackLlmClient and"
- `packages/remnic-core/src/chat/chat-llm.ts:22` — "LocalLlmClient — both expose chatCompletion returning {content}|null)."

### chat-tool-result-role-normalization
- `packages/remnic-core/src/chat/chat-llm.ts:55` — "Normalize tool results to a provider-safe role. The underlying"
- `packages/remnic-core/src/chat/chat-llm.ts:56` — "chat-completion clients do not implement native tool-call envelopes,"
- `packages/remnic-core/src/chat/chat-llm.ts:57` — "so a bare role:"tool" (without tool_call_id) is rejected by"
- `packages/remnic-core/src/chat/chat-llm.ts:58` — "OpenAI/Anthropic/Ollama endpoints. Surface the result as a user"
- `packages/remnic-core/src/chat/chat-llm.ts:59` — "message so the follow-up LLM turn always succeeds (P1)."

### chat-prompt-based-tool-calling
- `packages/remnic-core/src/chat/chat-llm.ts:80` — "Format the available tools as a function-calling instruction... models that don't (most local models) use it to emit structured tool calls."

### chat-toolcall-dedupe
- `packages/remnic-core/src/chat/chat-llm.ts:140` — "De-duplicate: a fenced block and its inner bare line can both match."

### mcp-chat-error-leak-stripping
- `packages/remnic-core/src/chat/chat-mcp.test.ts:128` — "// The text content and structuredContent must NOT expose the raw error field."

### chat-mcp-gate-parity
- `packages/remnic-core/src/chat/chat-mcp.test.ts:139` — "// Issue #1850 round 6: MCP memory_chat dispatches via processChatMessage,"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:140` — "// bypassing op.run() (the boundary hook every other callTool branch routes"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:141` — "// through). It must still enforce the per-token ops allow-list (op-gate) AND"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:142` — "// the chat-session namespace, matching the HTTP /engram/v1/chat/message route."
- `packages/remnic-core/src/chat/chat-mcp.test.ts:289` — "// The resume path already gates the session's stored namespace (r6). A NEW"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:290` — "// chat turn (no chatSessionId) previously forwarded scope.namespace straight"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:291` — "// to processChatMessage with NO allow-list gate, so a namespace-scoped token"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:292` — "// could mint a session in a namespace outside its allow-list. The new-session"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:293` — "// path must resolve the EFFECTIVE namespace (scope.namespace OR server"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:294` — "// default) and fail closed against the token allow-list — same chokepoint the"
- `packages/remnic-core/src/chat/chat-mcp.test.ts:295` — "// HTTP /engram/v1/chat/message route gained in r7."

### chat-session-path-safety
- `packages/remnic-core/src/chat/chat-security.test.ts:105` — "// chatSessionFile throws on the malicious id; loadChatSession catches that"
- `packages/remnic-core/src/chat/chat-security.test.ts:106` — "// and returns null. The security property: NO file outside the chat dir is"
- `packages/remnic-core/src/chat/chat-security.test.ts:107` — "// ever read — the caller sees "not found"."

### chat-tool-schema-gating
- `packages/remnic-core/src/chat/chat-security.test.ts:410` — "// correctionAvailable=true so memory_promote is in the schema and requires confirmation."
- `packages/remnic-core/src/chat/chat-security.test.ts:444` — "// correctionAvailable=false so memory_promote is NOT in the tool schema."
- `packages/remnic-core/src/chat/chat-security.test.ts:445` — "// The LLM hallucinates a memory_promote call anyway."

### chat-session-state
- `packages/remnic-core/src/chat/chat-session.ts:1` — "/** * Chat session state — transcript + pending-plan pointer persisted under * `<memoryDir>/state/chat/<chatSessionId>.j"

### monotonic-transcript-seq
- `packages/remnic-core/src/chat/chat-session.ts:49` — "/** * Last emitted transcript `seq`. Seeded from `Date.now()` on first use and * incremented when two appends land in th"
- `packages/remnic-core/src/chat/chat-session.ts:189` — "// Issue #1718 — backward-clock-skew robustness: raise the module-level seq"
- `packages/remnic-core/src/chat/chat-session.ts:190` — "// counter so the next append is strictly greater than any line already on"
- `packages/remnic-core/src/chat/chat-session.ts:191` — "// disk for this session, regardless of clock direction across restarts"
- `packages/remnic-core/src/chat/chat-session.ts:192` — "// (NTP step, VM migration, manual change). Without this, a backward clock"
- `packages/remnic-core/src/chat/chat-session.ts:193` — "// skew would re-seed the counter below the on-disk max and the SSE"
- `packages/remnic-core/src/chat/chat-session.ts:194` — "// reconnect dedup-by-seq contract could drop freshly-appended entries as"
- `packages/remnic-core/src/chat/chat-session.ts:195` — "// duplicates. The transcript is already fully parsed above, so this is a"
- `packages/remnic-core/src/chat/chat-session.ts:196` — "// single pass over the in-memory array."

### chat-session-header-binding
- `packages/remnic-core/src/chat/chat-session.ts:97` — "// Write a metadata header line so the file is never empty and carries"
- `packages/remnic-core/src/chat/chat-session.ts:98` — "// the principal/scope binding (used for per-session isolation checks)."
- `packages/remnic-core/src/chat/chat-session.ts:106` — "// Structured binding fields so loadChatSession doesn't need to regex-parse"
- `packages/remnic-core/src/chat/chat-session.ts:107` — "// prose (robust against dotted principals like <email>)."
- `packages/remnic-core/src/chat/chat-session.ts:148` — "// Prefer structured fields (robust against dotted principals)."

### chat-pending-plan-markers
- `packages/remnic-core/src/chat/chat-session.ts:174` — "// Only clear the matching pending — a plan resolution must not drop"
- `packages/remnic-core/src/chat/chat-session.ts:175` — "// an active promotion (and vice versa) (cursor Medium OlACs)."
- `packages/remnic-core/src/chat/chat-session.ts:374` — "/** * Append a pending-plan marker so a later turn can confirm the plan * (append-only state — loadChatSession scans for"

### chat-session-namespace-chokepoint
- `packages/remnic-core/src/chat/chat-session.ts:226` — "/** * The shared effective-namespace chokepoint for a resumed chat session * (issue #1850 round 6). A chat session is an"

### chat-session-append-toctou
- `packages/remnic-core/src/chat/chat-session.ts:267` — "// Atomic resurrection guard (codex P2): open with O_APPEND but WITHOUT"
- `packages/remnic-core/src/chat/chat-session.ts:268` — "// O_CREAT so a session already unlinked by a concurrent TTL sweep fails at"
- `packages/remnic-core/src/chat/chat-session.ts:269` — "// open-time (ENOENT) — there is no stat->appendFile TOCTOU. A headerless"
- `packages/remnic-core/src/chat/chat-session.ts:270` — "// recreation would load with no principal binding and be treated as public"
- `packages/remnic-core/src/chat/chat-session.ts:271` — "// by sessionBelongsToPrincipal. A concurrent unlink during the append is"
- `packages/remnic-core/src/chat/chat-session.ts:272` — "// caught by the post-append re-stat below so the turn fails visibly rather"
- `packages/remnic-core/src/chat/chat-session.ts:273` — "// than writing to an orphaned inode and returning 200."
- `packages/remnic-core/src/chat/chat-session.ts:278` — "// Only ENOENT (session unlinked by a concurrent TTL sweep) maps to"
- `packages/remnic-core/src/chat/chat-session.ts:279` — "// chat_session_expired; real fs errors (EACCES, EMFILE, EISDIR, ...)"
- `packages/remnic-core/src/chat/chat-session.ts:280` — "// are rethrown so the caller surfaces the actual failure (codex P2)."
- `packages/remnic-core/src/chat/chat-session.ts:291` — "// Post-append re-check (codex P2): if a concurrent TTL sweep unlinked the"
- `packages/remnic-core/src/chat/chat-session.ts:292` — "// session between open() and here, the append landed on the orphaned inode"
- `packages/remnic-core/src/chat/chat-session.ts:293` — "// and the directory no longer references it. Re-stat the PATH (not the fd)"
- `packages/remnic-core/src/chat/chat-session.ts:294` — "// so the turn fails with chat_session_expired instead of returning 200 with"
- `packages/remnic-core/src/chat/chat-session.ts:295` — "// a reply the client cannot resume. A later sweep unlinking an over-TTL"
- `packages/remnic-core/src/chat/chat-session.ts:296` — "// session is a legitimate TTL action, not a silent loss."
- `packages/remnic-core/src/chat/chat-session.ts:300` — "// Only ENOENT (concurrent TTL unlink) is session expiry; other fs"
- `packages/remnic-core/src/chat/chat-session.ts:301` — "// errors (EACCES, EMFILE, ENOTDIR, ...) are rethrown (codex/kilo P2)."

### chat-transcript-pubsub-scoping
- `packages/remnic-core/src/chat/chat-session.ts:315` — "/** * Per-session listener sets, keyed by `memoryDir + chatSessionId` so two * memory stores sharing a legacy/imported s"

### chat-session-ttl-sweep
- `packages/remnic-core/src/chat/chat-session.ts:457` — "// Re-check mtime immediately before unlinking so a turn appended"
- `packages/remnic-core/src/chat/chat-session.ts:458` — "// mid-sweep (which refreshes mtime) is not deleted by the stale age"
- `packages/remnic-core/src/chat/chat-session.ts:459` — "// decision captured above (codex P2). ttlHours <= 0 (expire-all)"
- `packages/remnic-core/src/chat/chat-session.ts:460` — "// skips the re-check. The residual microsecond window is a"
- `packages/remnic-core/src/chat/chat-session.ts:461` — "// legitimate sweep of an over-TTL file."

### chat-session-legacy-principal-failopen
- `packages/remnic-core/src/chat/chat-session.ts:485` — "// A session with no recorded principal is accessible to anyone (legacy/"
- `packages/remnic-core/src/chat/chat-session.ts:486` — "// single-user case). A session with a principal requires an exact match."

### chat-system-prompt-rules
- `packages/remnic-core/src/chat/chat-system-prompt.ts:1` — "Sealed system prompt for the chat engine (issue #1583). The prompt encodes the core rules that every turn enforces..."

### chat-tools-surface-gating
- `packages/remnic-core/src/chat/chat-tools.ts:1` — "Chat tools — the ONLY tools available to the chat engine (issue #1583). Thin adapters over access-service (rule 22). Mutating tools go through the engine confirmation protocol."

### chat-engine-bounded-tool-loop
- `packages/remnic-core/src/chat/chat-types.ts:1` — "Shared types for the conversational memory chat engine (issue #1583)... bounded tool-loop agent — NOT a general assistan"

### chat-llm-adapter-fallback-routing
- `packages/remnic-core/src/chat/chat-types.ts:45` — "Production-grade LLM adapter interface... production wraps FallbackLlmClient routing chain so local Ollama/vLLM supporte"
