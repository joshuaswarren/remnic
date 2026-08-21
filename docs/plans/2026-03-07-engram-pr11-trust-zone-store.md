# Engram PR11: Trust-Zone Schemas and Storage Paths

**Status:** planned for implementation in this slice  
**Roadmap track:** Hierarchical trust zones  
**Primary source:** AgentSys — https://arxiv.org/abs/2602.07398

## Goal

Ship the first trust-zone slice as a storage contract, not as retrieval or
promotion behavior. This PR creates typed quarantine/working/trusted records
and a dedicated zoned store so later PRs can add promotion rules and
trust-aware retrieval without inventing the schema midstream.

## Why This Slice Exists

The roadmap’s third priority is trust-zoned promotion and poisoning defense.
AgentSys argues that raw tool output, web content, and subagent traces should
not flow directly into durable core memory. Engram therefore needs explicit
quarantine, working, and trusted storage boundaries before it can enforce
promotion rules.

## Scope

This slice includes:

- config flags for enabling trust zones and later quarantine promotion
- a typed trust-zone record schema with provenance fields
- a dedicated zoned store rooted at `{memoryDir}/state/trust-zones`
- validation and status inspection helpers
- a CLI status command for operators and tests/docs for the new contract

This slice does **not** include:

- promotion rules between zones
- provenance trust scoring
- trust-zone-aware retrieval filters
- poisoning defense heuristics or benchmarks

## Flags

- `trustZonesEnabled`
- `quarantinePromotionEnabled`
- `trustZoneStoreDir`

All are defaults-off to preserve current Engram behavior.

## Storage Contract

- store root: `{memoryDir}/state/trust-zones`
- zoned path: `zones/<zone>/YYYY-MM-DD/<recordId>.json`
- zones: `quarantine`, `working`, `trusted`
- each record carries typed provenance (`sourceClass`, `observedAt`, optional session/source/hash fields)

## Verification

1. `npx tsx --test tests/trust-zones.test.ts tests/config-eval-harness.test.ts`
2. `npm run check-types`
3. `npm run check-config-contract`
4. `npm test`
5. `npm run build`

## Follow-On Slices

- PR12: promotion rules and provenance enforcement
- PR13: trust-zone-aware retrieval filters
