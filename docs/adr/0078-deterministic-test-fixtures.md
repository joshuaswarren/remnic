# Test fixtures stay deterministic and honest: partial doubles declare their unused surface, safety idioms fail fast, and background actors are excluded

Status: accepted

## Context
Orchestrator-level tests otherwise drag in background actors — eviction sweeps, trigger tasks — that make multi-hundred-entry fixtures nondeterministic and turn regressions into harness hangs instead of assertion failures. Fixtures structurally replace private fields or implement narrow seams, so a reviewer must see at a glance that the wider surface is deliberately unused rather than forgotten. Unhandled rejections between an abort and its assertion can fail a run spuriously, and a regression that queues instead of rejecting otherwise hangs until timeout. Pilot operation registration is a side effect of importing access-operations, so cross-file imports can trip the registration guard.

## Decision
1. Partial dependency doubles supply ONLY the members the exercised path touches, with a SAFETY comment naming the unreachable remainder (a queue recorded but never executed; a transcript double exposing only `observe()`; a session observer exposing only `observe()`; phase-specific configs where the off-phase collapses to the default store). Storage doubles implement exactly the used seam (loadBuffer/saveBuffer) while the wider storage surface stays unused; structural replacement of a private field is marked per rule. Access surfaces that accept a live orchestrator get a named fixture supplying exactly the members that surface owns and no unrelated runtime machinery; subset casts keep the fixture honest at each method while avoiding a full filesystem store.
2. Deterministic isolation: no orchestrator background actors in fixture runs (eviction sweeps would make a 200-entry fixture nondeterministic); thresholds force keep_buffering so the scoped flush alone decides what drains; clocks are deterministic and monotonic (each read advances a fixed step) so timed stages assert exact durations.
3. Harness safety idioms: rejections are marked handled BEFORE the assertion that expects them, so an unhandled rejection between abort and assert cannot fail the run; settles are bounded so a regression that queues instead of rejecting fails the assertion fast instead of hanging the harness; and a failing assertion must never leave a gate unresolved into destroy(), or the harness reports a timeout instead of the failure.
4. Pilot registrations reset between files so cross-file imports do not trip the registration guard.

## Consequences
Fixtures can drift from reality only inside the declared-unreachable surface, and the SAFETY comments make that drift reviewable. The safety idioms add boilerplate but convert hangs into assertion failures. Registration side effects constrain import order across test files.

## Origin comments
- `packages/remnic-core/src/access-boundary.test.ts:42` — "reset pilot registrations so cross-file imports do not trip guard"
- `packages/remnic-core/src/access-identity-continuity-surface.test.ts:89` — "// The surface deliberately consumes only this storage subset; the cast keeps"
- `packages/remnic-core/src/access-identity-continuity-surface.test.ts:90` — "// the fixture honest at each method while avoiding a full filesystem store."
- `packages/remnic-core/src/access-identity-continuity-surface.test.ts:118` — "// Access surfaces accept the live orchestrator; this named fixture supplies"
- `packages/remnic-core/src/access-identity-continuity-surface.test.ts:119` — "// the exact members this surface owns and no unrelated runtime machinery."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:155` — "// Mark handled early: the rejection itself is asserted below, and"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:156` — "// an unhandled rejection between abort and assert must not fail"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:157` — "// the run."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:200` — "// Idempotent: a failing assertion must never leave the gate unresolved"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:201` — "// into destroy(), or the harness reports a timeout instead of the failure."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:240` — "// Mark handled early: rejections are asserted below."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:353` — "// SAFETY: `storage` is a private SmartBuffer field, structurally replaced"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:354` — "// in place to force durable-write failures. Named cast per rule."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:358` — "// Bounded settle: a regression that queues instead of rejecting must fail"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:359` — "// the assertion fast, never hang the harness."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:389` — "// SAFETY: SeedStorage implements the loadBuffer/saveBuffer surface this fixture drives."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:417` — "// Real SmartBuffer + real coordinator, NO Orchestrator background actors —"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:418` — "// background eviction sweeps would make a 200-entry fixture nondeterministic."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:435` — "// SAFETY: SeedStorage implements SmartBuffer's storage seam (loadBuffer/"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:436` — "// saveBuffer); the wider StorageManager surface is unused here."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:440` — "// SAFETY: capacity fixture exercises only buffered admission — the queue"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:441` — "// is recorded, never executed; the remaining deps are unreachable here."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:877` — "// SAFETY: inline seed storage satisfies SmartBuffer's storage needs."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1039` — "// Thresholds force keep_buffering: no trigger tasks, so the scoped flush"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1040` — "// alone decides what drains — deterministic isolation check."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1174` — "// SAFETY: these fixtures exercise only buffered admission + trigger"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1175` — "// routing; the remaining deps are never reached on this path."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1193` — "// StorageManager surface is unused in this fixture."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1254` — "// SAFETY: heartbeat fixture exercises only the observer trigger routing;"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1255` — "// the remaining deps are unreachable on this path."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1262` — "// SAFETY: transcript double — remaining TranscriptManager members are"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1263` — "// unreachable from the heartbeat observer trigger path."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1274` — "// SAFETY: session observer double — only observe() is called."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1469` — "// SAFETY: phase-specific configs — off-phase collapses to the default"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1470` — "// store, on-phase enables routing to verify the pin prevents retargeting."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1579` — "// SAFETY: admission-guard fixture exercises only the rejection path; the"
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1580` — "// LCM engine records calls and the remaining deps are unreachable."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1728` — "// SAFETY: mixed-dispatch fixture exercises only the scope-group routing."
- `packages/remnic-core/src/access-observe-replay-durability.test.ts:1794` — "// SAFETY: native-clear fixture exercises only the scope-group routing."
- `packages/remnic-core/src/access-observe-stage-timing.test.ts:26` — "// SAFETY: the probe drives only the observe scope path on this orchestrator."
- `packages/remnic-core/src/access-observe-stage-timing.test.ts:28` — "// SAFETY: the probe sets exactly these two internal fields."
- `packages/remnic-core/src/access-observe-stage-timing.test.ts:62` — "// SAFETY: the literal sets the request fields the scope path reads."
- `packages/remnic-core/src/access-observe-stage-timing.test.ts:120` — "// SAFETY: the probe exercises the observe surface; the rest of Orchestrator"
- `packages/remnic-core/src/access-observe-stage-timing.test.ts:121` — "// is unused on this path."
- `packages/remnic-core/src/access-observe-stage-timing.test.ts:158` — "// Deterministic monotonic clock: every read advances 6s, so each timed"
- `packages/remnic-core/src/access-observe-stage-timing.test.ts:159` — "// stage records exactly 6000ms and the total exceeds the slow threshold."
- `packages/remnic-core/src/access-observe-stage-timing.test.ts:168` — "// SAFETY: the literal sets the request fields the observe path reads."
