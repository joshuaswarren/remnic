# Remnic Relay implementation plan

## Completion contract

Relay is complete when a clean-room installation can run or replay one isolated
mission in which a stale project decision is observed, corrected with explicit
human approval, propagated to a cold Codex agent, and followed by a passing
test—with a single receipt that renders the full lineage.

The user owns the final Devpost submission and final recording/upload. The
repository must contain everything else needed to do those steps reliably.

## Phase 1 — Mission evidence contract and API (#1966)

Deliver a host-agnostic, versioned `RelayMissionEvent` contract and append-only
store. Add strict access operations and bounded HTTP routes for appending events
and reading a reduced `RelayMissionSnapshot`. Include deterministic fixture
coverage for conflicting decisions, approval, supersession, cold recall, and
the resulting test outcome.

Verification:

- focused contract, store, reducer, access, and HTTP tests;
- empty, malformed, unauthorized, missing-evidence, idempotency, corruption,
  and backend-failure cases;
- type checking and `npm run preflight:quick`;
- scoped PR, current-head PR loop, and manual merge.

## Phase 2 — Mission Control UI (#1967)

Build a distinctive judge-facing surface around the snapshot contract. The
screen must communicate disagreement, provenance, human approval, correction
lineage, propagation, cold-start handoff, and outcome without narration. Keep
the interaction model intentionally cinematic and bounded to one mission.

Before implementation, write the visual system and interaction plan, critique
generic dashboard defaults, and define the exact hero frames needed for the
video. Verify in a real browser at desktop and presentation dimensions.

## Phase 3 — Isolated Codex mission runner (#1968)

Create a synthetic fixture repository and a runner that provisions fresh
`memoryDir`, `sharedContextDir`, and `CODEX_HOME` roots. The live path uses only
bounded Codex CLI one-shot calls with `gpt-5.6`; it rejects Sol models, enforces
hard call/credit/time limits, and captures truthful event evidence. A signed or
integrity-checked replay path must reproduce the same mission without network or
model timing risk.

## Phase 4 — Judge-ready hardening and story (#1969)

Exercise the complete clean-room path, capture evidence and polished screenshots,
write the measured sub-three-minute script, prepare Devpost-ready copy, and add a
claim ledger that separates pre-existing Remnic foundations from Build Week Relay
work. Close every child issue only after its merged current head is verified.

## Continuous product gate

At every decision ask: “Is this OpenAI-attention and 1st place Build Week winning
worthy?” Prefer visible product leverage, honest proof, and reliable judge
reproduction over broad infrastructure or speculative generality.

