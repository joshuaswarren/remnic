# Recall disclosure forms a single ordered ladder with one validation guard shared by CLI, HTTP, and MCP

Status: accepted

## Context
Recall results can be returned at several disclosure levels (chunk, section, raw). Multiple surfaces (CLI, HTTP, MCP) accept the level, and before the contract hardened, invalid values were coerced to defaults, handlers dropped validated fields, and JSON-RPC nulls were mishandled — callers silently got `chunk` or a silent default instead of an error.

Scope note: This file merges the disclosure ladder/ordering, auto-escalation, CLI/HTTP parity, and MCP-forwarding themes: they are one contract about how a caller-chosen disclosure level flows from every surface to the service layer.

## Decision
The disclosure ladder is a single frozen, ordered list; its order is stable and any refactor that flips it must fail. Validation is one shared guard (`isRecallDisclosure`) used by every surface — CLI and HTTP delegate parsing to it so loosening validation in one path but not another is caught in CI; the CLI must throw on common typos and casing variants so operators notice flag misuse instead of silently getting `chunk`. Only chunk→section auto-escalation is allowed; section and raw are never demoted and raw is never auto-selected. Threshold defaults are applied only when config-side coercion produced an out-of-range or missing value. The MCP handler must actually forward the validated field (schema-level validation alone is not enough — a dropped field is a silent default); it passes `undefined`, not `"chunk"`, when the caller omitted the value so defaulting stays in the service layer as the single source of truth; a present-but-wrong-type value (e.g. a number) throws a structured error surfaced as `isError: true` rather than being coerced to undefined; JSON-RPC `null` is treated like absence, matching the service's own null-tolerance; and the tool-list schema must declare `disclosure` so strict clients can use it. Recall paths must never attach rawExcerpts at section depth; a regression that does must not leak excerpts onto the section-shaped payload.

## Consequences
Malformed disclosure input fails loudly at MCP/CLI surfaces instead of degrading silently. Adding a disclosure level touches the shared ladder, guard, and schema together; the order is frozen.

## Origin comments
(37 records)
- `packages/remnic-core/src/recall-disclosure-escalation.test.ts:178` — "// Guard against accidentally returning an empty reason — operator"
- `packages/remnic-core/src/recall-disclosure-escalation.test.ts:179` — "// telemetry depends on it."
- `packages/remnic-core/src/recall-disclosure-escalation.ts:1` — "/** * Recall disclosure auto-escalation policy (issue #677 PR 4/4). * * Pure helper that decides the *effective* disclos"
- `packages/remnic-core/src/recall-disclosure-escalation.ts:49` — "/** * Threshold defaults — applied when config-side coercion produces an * out-of-range or missing value. 0.5 is a delib"
- `packages/remnic-core/src/recall-disclosure-escalation.ts:117` — "// Only chunk → section auto-escalation is allowed. Section and raw"
- `packages/remnic-core/src/recall-disclosure-escalation.ts:118` — "// are never demoted; raw is never auto-selected."
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:93` — "// Defensive: the recall path should never pass rawExcerpts at section"
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:94` — "// depth, but a regression that did so must not leak excerpts onto the"
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:95` — "// section-shaped payload."
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:106` — "// The CLI path uses the same `isRecallDisclosure` guard as the service"
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:107` — "// layer; this test pins the contract so a future regression that loosens"
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:108` — "// validation in one path but not the other is caught."
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:112` — "// Common typos / casing variants the CLI must throw on so operators"
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:113` — "// notice their flag misuse instead of silently getting `chunk`."
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:128` — "// The HTTP route delegates parsing to `isRecallDisclosure` after reading"
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:129` — "// the query parameter. We verify the contract here so a refactor that"
- `packages/remnic-core/src/recall-disclosure-shaping.test.ts:130` — "// stops calling the guard in `access-http.ts` would surface in CI."
- `packages/remnic-core/src/recall-disclosure.test.ts:32` — "// Order matters for future escalation policy comparisons (PR 4/4). The"
- `packages/remnic-core/src/recall-disclosure.test.ts:33` — "// ladder must be stable; freezing here so a refactor that flips order is"
- `packages/remnic-core/src/recall-disclosure.test.ts:34` — "// caught immediately."
- `packages/remnic-core/src/recall-disclosure.test.ts:110` — "// Regression coverage for the review feedback on PR #694: schema-level"
- `packages/remnic-core/src/recall-disclosure.test.ts:111` — "// validation alone is not enough — the handler must actually pass the"
- `packages/remnic-core/src/recall-disclosure.test.ts:112` — "// validated field through, otherwise callers see a silent default."
- `packages/remnic-core/src/recall-disclosure.test.ts:158` — "// The service layer owns default-application; the handler should pass"
- `packages/remnic-core/src/recall-disclosure.test.ts:159` — "// `undefined` (not `"chunk"`) when the caller did not provide a value"
- `packages/remnic-core/src/recall-disclosure.test.ts:160` — "// so the single source of truth stays in `EngramAccessService.recall()`."
- `packages/remnic-core/src/recall-disclosure.test.ts:174` — "// Codex review on PR #694: a number (e.g. `1`) used to be coerced to"
- `packages/remnic-core/src/recall-disclosure.test.ts:175` — "// `undefined`, masking malformed input and silently applying the"
- `packages/remnic-core/src/recall-disclosure.test.ts:176` — "// chunk default. The handler now distinguishes "absent" from"
- `packages/remnic-core/src/recall-disclosure.test.ts:177` — "// "present-but-wrong-type" and throws a structured error for the"
- `packages/remnic-core/src/recall-disclosure.test.ts:178` — "// latter. The MCP transport surfaces tool errors as `isError: true`."
- `packages/remnic-core/src/recall-disclosure.test.ts:198` — "// JSON-RPC clients sometimes serialize an unset field as `null`."
- `packages/remnic-core/src/recall-disclosure.test.ts:199` — "// Treat `null` like absence so the service-layer default path runs"
- `packages/remnic-core/src/recall-disclosure.test.ts:200` — "// — matches `EngramAccessService.recall()`'s own null-tolerance."
- `packages/remnic-core/src/recall-disclosure.test.ts:217` — "// MCP clients with strict validation reject unknown fields; the"
- `packages/remnic-core/src/recall-disclosure.test.ts:218` — "// tool-list schema must declare `disclosure` so legitimate clients"
- `packages/remnic-core/src/recall-disclosure.test.ts:219` — "// can use it."
