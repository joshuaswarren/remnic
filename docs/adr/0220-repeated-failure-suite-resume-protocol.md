# A repeated-failure suite treats retry exhaustion as a durable pause with committed history, and synthetic drift corpora record their realized lifecycle

Status: accepted

## Context
Long-running fault-injection suites run for hours against flaky providers. Rows died mid-flight with "Claim token does not own" because the claim lease expired while a request hung; a transient outage could void a whole run; a locally redeclared cap silently diverged once and defeated a cap change. The drift generator's fact-lifecycle scheduler additionally had to stay consistent under a per-epoch budget.

This ADR merges the sweep themes: claim-lease-covers-retry-budget, retry-exhaustion-pauses-not-invalidates, retry-exhaustion-commit-before-pause, driver-deadline-integration-coverage, trap-audit-usage-contract-pin, shared-caps-import-not-redeclare, drift-gen-fact-lifecycle-scheduling, drift-gen-validator-shape-checks.

Merged sweep themes: claim-lease-covers-retry-budget, retry-exhaustion-pauses-not-invalidates, retry-exhaustion-commit-before-pause, driver-deadline-integration-coverage, trap-audit-usage-contract-pin, shared-caps-import-not-redeclare, drift-gen-fact-lifecycle-scheduling, drift-gen-validator-shape-checks.

## Decision
- A claim lease must outlast the worst-case row: attempts × per-request timeout of wall clock. The heartbeat timer is unref'd and cannot be relied on to refresh the lease while a request is hung — the lease itself covers the full retry budget.
- Exhausting the retry budget PAUSES the suite instead of marking the row invalid (decision rule v10), so a transient outage cannot void a run.
- The attempt that stopped the run is committed BEFORE the pause, so a resumed run replays from the next attempt with the fault durably auditable instead of silently lost.
- Suite caps and tool-output limits are imported from the shared suite module, never redeclared locally.
- Trap-audit tests pin the complete normalized usage contract with strict equality.
- The real driver deadline has integration coverage using an evaluator that never settles.
- Drift generator: contradicted supersessions land the very next epoch; when the due set exceeds the per-epoch budget, postpone drifting items first. Record the realized lifecycle, not the scheduling intent — overflow can postpone a supersession past its intended epoch, and anything still pending after the horizon was never superseded — and the validator enforces kind/timing consistency on that realized form. Historical/transition questions ask about the MOST RECENT change, so they are valid only while the successor itself is still current.
- Externally supplied corpora are shape-checked row by row: they can be syntactically valid JSON with mistyped fields.

## Consequences
Leases are conservative (sized to the worst case, not the expected case). Paused suites wait for an explicit resume. Drift items may land later than intended, so downstream validators must consume realized epochs rather than planned ones.

## Origin comments
- `packages/bench/src/coding-graph/repeated-failure-ollama-chat-driver.test.ts:632` — "// Integration coverage for the real driver deadline; the evaluator never settles."
- `packages/bench/src/coding-graph/repeated-failure-store.ts:39` — "// Lease must outlast the worst-case row: six attempts at the 180s request"
- `packages/bench/src/coding-graph/repeated-failure-store.ts:40` — "// timeout is 18 minutes of wall clock. The heartbeat timer is unref'd, so it"
- `packages/bench/src/coding-graph/repeated-failure-store.ts:41` — "// cannot be relied on to refresh the lease while a request is hung — the lease"
- `packages/bench/src/coding-graph/repeated-failure-store.ts:42` — "// itself has to cover the full retry budget or the row loses its claim"
- `packages/bench/src/coding-graph/repeated-failure-store.ts:43` — "// mid-flight and the run dies with \"Claim token does not own\"."
- `packages/bench/src/coding-graph/repeated-failure-suite-runner.ts:912` — "// Commit first so the exhausting attempt is durably auditable, then"
- `packages/bench/src/coding-graph/repeated-failure-suite-runner.ts:913` — "// pause. A resumed run replays from the next attempt with full history"
- `packages/bench/src/coding-graph/repeated-failure-suite-runner.ts:914` — "// instead of silently losing the fault that stopped the suite."
- `packages/bench/src/coding-graph/repeated-failure-suite.test.ts:1129` — "// Decision rule v10: exhausting the retry budget pauses the suite instead"
- `packages/bench/src/coding-graph/repeated-failure-suite.test.ts:1130` — "// of marking the row invalid, so a transient outage cannot void a run."
- `packages/bench/src/coding-graph/repeated-failure-suite.test.ts:1147` — "// The attempt that stopped the run is committed before the pause so a"
- `packages/bench/src/coding-graph/repeated-failure-suite.test.ts:1148` — "// resumed run replays from the next attempt with a complete history."
- `packages/bench/src/coding-graph/repeated-failure-trap-audit.test.ts:656` — "// Keep strict equality here: this test pins the complete normalized usage contract."
- `packages/bench/src/coding-graph/repeated-failure-trap-audit.ts:42` — "// Caps and tool-output limits are shared with the suite on purpose. A local"
- `packages/bench/src/coding-graph/repeated-failure-trap-audit.ts:43` — "// copy silently diverged once and defeated a cap change, so import rather than"
- `packages/bench/src/coding-graph/repeated-failure-trap-audit.ts:44` — "// redeclare."
- `packages/bench/src/generators/drift-gen/schedule.ts:178` — "// Contradicted supersessions must land the very next epoch; when the"
- `packages/bench/src/generators/drift-gen/schedule.ts:179` — "// due set exceeds the per-epoch budget, postpone drifting items first."
- `packages/bench/src/generators/drift-gen/schedule.ts:210` — "// Record the realized lifecycle, not the scheduling intent: overflow can"
- `packages/bench/src/generators/drift-gen/schedule.ts:211` — "// postpone a supersession past its intended epoch, and anything still"
- `packages/bench/src/generators/drift-gen/schedule.ts:212` — "// pending after the horizon was never superseded at all. The validator"
- `packages/bench/src/generators/drift-gen/schedule.ts:213` — "// enforces kind/timing consistency on this realized form."
- `packages/bench/src/generators/drift-gen/schedule.ts:436` — "// Historical/transition questions ask about the MOST RECENT change, so"
- `packages/bench/src/generators/drift-gen/schedule.ts:437` — "// they are only valid while the successor itself is still current."
- `packages/bench/src/generators/drift-gen/validate.ts:116` — "/** * Externally supplied corpora can be syntactically valid JSON with mistyped * fields; every row is shape-checked her"
