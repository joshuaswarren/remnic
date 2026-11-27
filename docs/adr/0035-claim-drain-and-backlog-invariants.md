# Backlog claims are the durable authority for buffered work: no drop, no duplicate extraction, no plan-flattening, no early lease release

Status: accepted

## Context
A daemon-owned backlog scheduler drains claimed sessions through the shared extraction queue. Concurrent writers exist: the foreground owner keeps capturing while a drain runs, leases can be lost, providers fail mid-drain, and scope profiles (which decide the write destination) change between capture and drain. Review history showed the costly failure shapes: erasing a user's concurrent edit, extracting turns twice, flattening a pinned plan to null so a fact lands in the principal's default namespace, and stranding already-persisted turns after a lease handover.

## Decision
The claim file is authoritative and the drain is no-drop and identity-preserving: (1) tombstones are authoritative — a drained claim is an empty tombstone with no pending turns, still visible to scans so an operator sees the drained claim existed; the ack verdict is honored for an emptied entry, written by the current lease holder; (2) the runner drains a claim in-process without the global buffer swap: turns are grouped by captured extraction scope (exact pins, with the CURRENT policy re-applied only from the original binding), failing chunks stay as durable retryable backlog — no drop, no side file — and the claim stays retryable across cancel and dead-lease adoption; (3) while a drain holds extraction open, the foreground owner keeps capturing, and a live save lands in LIVE session storage, never inside the claim's storage view; (4) a drain handover makes the claim own the turns: the in-memory entries are dropped so this process cannot resurrect or re-extract them; a later observe for the same key starts a fresh entry; (5) the scope group key never merges accepted captures with ordinary turns even under identical namespace+principal pins — otherwise a group-level capture policy (the explicit-mode gate, the planless-accepted null pin) would be applied to ordinary conversation turns; (6) the drain forwards the captured plan as pinned and never flattens it to null: if the current policy refuses the scope, the drain refuses at the policy gate (before any model call), keeps the canonical turn in the claim, and reports the denial — the null pin (not an override) is what keeps a planless accepted capture outside the current profile gate, and forwarding an older-policy plan is what lets the identity re-check refuse it; (7) admission caps are pinned BEFORE bounded admission so the cap applies to real durable work; while the circuit breaker is OPEN, submission is skipped entirely (pure heap pressure per poll); a takeover is simulated after the fenced read and before serialized mutation so newer work cannot be erased; (8) a keyed task occupies the concurrency-1 slot — raw tasks bypassing the slot would let a live task start before the claim decision; (9) releasing the lease while the gated persist is still in flight strands already-persisted turns — release only after the in-flight persist completes; (10) extractor output that is null or malformed is retained (never cleared) and re-driven through the run boundary; (11) tests exercise the real loopback model boundary with the real renderer/truncation and the platform clock — the only test doubles are the extraction model and orchestrator-private seams, reached through named seam contracts with cast safety scoped to paths that cannot reach other deps.

## Consequences
Refusal semantics mean a scope-policy change can leave work retryable in the claim indefinitely until policy or profile allows it — operators see denials rather than silent namespace writes. Dropping in-memory entries on handover forces the foreground to re-buffer live captures into a fresh entry. The no-drop rule makes a poisoned chunk a full drain blocker until it succeeds or is cancelled. Test seams bridging orchestrator-private internals are load-bearing and must be updated when those internals change shape.

## Origin comments
### backlog-claim-authority
- `packages/remnic-core/src/backlog-scheduler.test.ts:1` — "Daemon-owned backlog scheduler; claim authority invariant (tombstones authoritative)."
- `packages/remnic-core/src/backlog-scheduler.test.ts:97` — "A drained claim is an empty tombstone: authoritative, no pending turns."

### backlog-cap-cycle-test-realism
- `packages/remnic-core/src/backlog-scheduler.test.ts:565` — "Real admission/scheduler/persistence; only the extraction MODEL is a test double."

### backlog-cap-pinning
- `packages/remnic-core/src/backlog-scheduler.test.ts:584` — "Captures pinned BEFORE bounded admission so cap applies to real durable work."

### backlog-fencing
- `packages/remnic-core/src/backlog-scheduler.test.ts:936` — "Simulate takeover after fenced read before serialized mutation; cannot erase newer work."

### backlog-breaker-churn-guard
- `packages/remnic-core/src/backlog-scheduler.test.ts:1298` — "Breaker OPEN: full submission is pure heap pressure per poll; scheduler must skip submission."

### claim-drain-invariants
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:1` — "// In-process claim drain (daemon backlog scheduler task body): the runner"
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:2` — "// must drain a claim through the shared extraction queue WITHOUT the global"
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:3` — "// buffer swap, group the claim's turns by captured extraction scope (exact"
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:4` — "// pins + CURRENT policy re-applied from the original binding), keep failing"
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:5` — "// chunks as durable retryable backlog (no drop, no side file), and leave the"
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:6` — "// claim retryable across cancel / dead-lease adoption."
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:100` — "// While the claim drain holds the extraction open, the foreground owner"
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:101` — "// keeps capturing: a live save must land in LIVE session storage, never"
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:102` — "// inside the claim's storage view."
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:180` — "// Namespaces DISABLED: the pinned non-default namespace can no longer be"
- `packages/remnic-core/src/buffer-drain-inprocess.test.ts:181` — "// honored, so the pinned group is denied while native work still drains."

### model-boundary-real-loopback-tests
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:1` — "Model-boundary integration tests for the claim drain: a REAL loopback"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:2` — "OpenAI-compatible model boundary stands in for the extraction model so the"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:3` — "ACTUAL chat input (renderer + truncation included) is what gets asserted —"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:4` — "no extraction seam swap, no stub bookkeeping."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:198` — "FINITE window budget for the local path so chunking is exercised"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:199` — "against the REAL renderer/truncation, not a stubbed seam."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:294` — "The controlled boundary serves the extraction — no network fallback."

### test-seams-orchestrator-private
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:52` — "SAFETY: the loopback model posts OpenAI-compatible JSON; the shape"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:53` — "named here is the only part the probe reads."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:152` — "SAFETY: test seams bridge to orchestrator-private internals whose shape is"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:158` — "SAFETY: the caller supplies the locally-declared seam contract; the cast"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:159` — "re-labels the orchestrator-private instance to that contract."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:471` — "retain (never clear). The engine field is orchestrator-private; the"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:472` — "stub goes through this named test seam."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:484` — "SAFETY: the queue re-drives malformed/null extractor output through"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:485` — "the boundary; the stub result is cast to the named verdict shape."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:567` — "Test seam: enqueueing a LIVE buffered extraction directly is the only"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:568` — "way to interleave it with the claim decision; the coordinator method is"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:569` — "orchestrator-private."

### source-grounding-requires-quote
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:61` — "The model returns the user text VERBATIM as a grounded, quoted"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:62` — "fact — the shape source grounding requires to keep a fact."

### platform-clock-in-integration-tests
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:94` — "Real pipeline (daemon poll cadence + model round-trips) — platform clock."

### model-registry-after-initialize
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:210` — "The real daemon initializes before serving; the model-input budget"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:211` — "(model registry) only exists after that."

### connector-source-header-budget
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:223` — "Connector-tagged: the renderer prepends a "Source: <connector>""
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:224` — "header for these, so the conversation-only budget measure must"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:225` — "include the same gate/margin the engine applies."

### pinned-accepted-capture-chunking
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:230` — "A pinned ACCEPTED capture in the mix: the exact class that used to"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:231` — "bypass chunking and truncate-and-ack."

### house-scope-profile-fixtures
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:300` — "House scope-profile fixture (orchestrator-flush "no writable layer""
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:301` — "shape): an ACTIVE profile whose write layer cannot resolve —"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:302` — "userProject without any project context is unwritable. The current"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:303` — "policy therefore REFUSES this scope's write."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:389` — "House scope-profile shape (orchestrator-flush profile fixture): an"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:390` — "ACTIVE profile whose serverShared layer IS writable for the"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:391` — "principal, so the CURRENT profile decides where the fact lands."

### drain-scope-profile-plan-gating
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:331` — "Current policy refuses the scope: the drain must NOT flatten the"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:332` — "legacy group to plan=null (which would bypass the profile gate and"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:333` — "write the fact into the principal's default namespace) — it must"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:334` — "refuse, keep the canonical turn in the claim, and report the denial."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:343` — "The refusal happens at the policy gate, before any model call — a"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:344` — "flattened plan=null WOULD have called the model and persisted."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:370` — "The principal resolves to the "default" namespace (prefix mode), and"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:371` — "BOTH the default and the shared namespace are writable for it — so"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:372` — "the write DESTINATION depends on which plan the drain forwards, not"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:373` — "on who is allowed to write."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:420` — "The ACTIVE profile's write namespace owns the fact. Flattening the"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:421` — "unpinned legacy group to plan=null bypasses the profile gate and"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:422` — "persists the same fact in the principal's DEFAULT namespace instead."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:618` — "Active profile with NO writable layer (house "denied" shape): if the"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:619` — "drain failed to pin null for this planless ACCEPTED capture, the"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:620` — "current profile would refuse the write and the capture would strand."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:643` — "NO writeNamespaceOverride: the null pin (not an explicit-namespace"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:644` — "override) is what keeps this capture outside the current profile gate."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:701` — "The capture pinned a plan captured under an OLDER policy: the CURRENT"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:702` — "resolution differs, so forwarding the plan (never flattening it to"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:703` — "null) is what lets the identity re-check refuse the scope."

### no-drop-claim-drain
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:453` — "Drive the malformed attempts ABOVE the drop threshold: the no-drop"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:454` — "claim drain must never drop or side-file the content regardless."
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:469` — "The actual run boundary receives null and malformed collection results"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:470` — "from the extractor — both real failure shapes the shared callee must"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:503` — "No-drop: no recovery side file may move the content aside."

### keyed-task-occupies-queue-slot
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:555` — "A KEYED task occupies the concurrency-1 slot: raw tasks bypass the slot,"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:556` — "which would let the live task start before the claim decision."

### scope-group-key-accepted-split
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:818` — "IDENTICAL scope pins (same namespace + principal), differing ONLY in"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:819` — "acceptedCapture: the scope group key must not merge them — otherwise"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:820` — "the accepted capture's group drags the ordinary turn through the gate."

### ack-tombstone-scan-visibility
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:907` — "Draining the claimed session leaves an ack tombstone: still listed so"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:908` — "an operator sees the drained claim exists (the live copy is gone)."

### emptied-claim-ack-ownership
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:958` — "Emptied claim: the ack verdict is honored (drained). The emptied entry"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:959` — "is written by the CURRENT lease holder (first-owner)."

### lease-release-after-in-flight-persist
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:1051` — "The lease-loss window: releasing the lease while the gated persist is"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:1052` — "still in flight (release-early) lets the closure's post-persist claim"
- `packages/remnic-core/src/buffer-drain-model-boundary.test.ts:1053` — "write fail its ownership check, stranding already-persisted turns."

### extraction-chunk-drop-policy
- `packages/remnic-core/src/buffer-drop-extraction-chunk.test.ts:57` — "// A drop is not an extraction: the extraction bookkeeping stays untouched."
- `packages/remnic-core/src/buffer-drop-extraction-chunk.test.ts:126` — "// A successful run clears its chunk the way the coordinator does for a native group: by identity."
- `packages/remnic-core/src/buffer-drop-extraction-chunk.test.ts:175` — "// The window a trigger snapshot sees is the retained turns followed by the live ones; the first chunk is retained-only."
- `packages/remnic-core/src/buffer-drop-extraction-chunk.test.ts:335` — "// dropFailedChunk returns false: the only buffered copy stays and the"
- `packages/remnic-core/src/buffer-drop-extraction-chunk.test.ts:336` — "// drain stops on that chunk (later chunks are not acked past it)."

### test-seam-cast-safety
- `packages/remnic-core/src/buffer-eviction-backpressure.test.ts:191` — "// SAFETY: this fixture exercises only admission + refusal; the remaining"
- `packages/remnic-core/src/buffer-eviction-backpressure.test.ts:192` — "// coordinator deps are never reached on this path."

### claim-check-fail-closed
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:295` — "// isBufferSessionClaimed is optional; a session-capable backend that omits"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:296` — "// it cannot prove a session is unclaimed, so deferral must fail closed."
- `packages/remnic-core/src/buffer-persistence.ts:189` — "// Fail closed: a backend that omits isBufferSessionClaimed cannot"
- `packages/remnic-core/src/buffer-persistence.ts:190` — "// prove the session is unclaimed, so it never defers (PR 3481 review)."

### handed-over-claim-eviction
- `packages/remnic-core/src/buffer-persistence.ts:204` — "// "handed_over": the entry moved into a drain claim. Content is durable"
- `packages/remnic-core/src/buffer-persistence.ts:205` — "// in the claim, so this key's pending state is settled — the caller"
- `packages/remnic-core/src/buffer-persistence.ts:206` — "// evicts the in-memory entry on its side."

### drain-tombstone-single-extraction
- `packages/remnic-core/src/buffer-persistence.ts:208` — "// A drain tombstone: the turns it extracted must leave this process's"
- `packages/remnic-core/src/buffer-persistence.ts:209` — "// copy too, or the owner would extract them a second time."

### accepted-capture-scope-isolation
- `packages/remnic-core/src/buffer-turn-helpers.ts:298` — "// Accepted captures are deliberately accepted content: they must never"
- `packages/remnic-core/src/buffer-turn-helpers.ts:299` — "// share a scope group with ordinary turns, or a group-level capture"
- `packages/remnic-core/src/buffer-turn-helpers.ts:300` — "// policy (the explicit-mode gate, the planless-accepted null pin) is"
- `packages/remnic-core/src/buffer-turn-helpers.ts:301` — "// applied to ordinary conversation turns because `.some(acceptedCapture)`"
- `packages/remnic-core/src/buffer-turn-helpers.ts:302` — "// only looked at the merged group."

### drain-tombstone
- `packages/remnic-core/src/buffer.ts:257` — "// A drain tombstone: the turns the drain extracted leave this copy too,"
- `packages/remnic-core/src/buffer.ts:258` — "// so a stale owner never extracts (or persists) them a second time."

### drain-claim-entry-drop
- `packages/remnic-core/src/buffer.ts:270` — "// A drain claim now owns these sessions' turns (durable in the claim"
- `packages/remnic-core/src/buffer.ts:271` — "// file): drop the in-memory entries so this process cannot resurrect"
- `packages/remnic-core/src/buffer.ts:272` — "// them. A later observe for the same key starts a fresh entry whose"
- `packages/remnic-core/src/buffer.ts:273` — "// turns flow into the claim at the next handover."

### no-fabricated-shape-casts-in-tests
- `packages/remnic-core/src/chat/chat-mcp.test.ts:145` — "/** Narrow a tools/call JSON-RPC response … typeof guards rather than an inline fabricated-shape cast … */"
