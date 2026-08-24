---
"@remnic/core": minor
"@remnic/bench": minor
---

Add bench-gated span-mode extraction (#2333).

Phase A (`@remnic/bench`): deterministic fake-provider A/B benchmark `extraction-span-mode` (synthetic LoCoMo-style + LongMemEval-style slices, same model/seed) measuring judge score, modeled decode-bound wall-clock, output tokens, span-validation fallback rate, and memory entry count, evaluated against the issue's Phase B gate (≥20% wall-clock reduction, judge drop <2 points, fallback <15%). Pinned seed-0 run: 24.9% wall-clock reduction, judge drop 0.16, fallback 2.6% — gate cleared.

Phase B (`remnic-core`, default off): `extraction.spanMode: "off" | "shadow" | "on"` config (strict enum, unrecognized values rejected). Materialization runs after parse and before sanitize/grounding/judge/dedup/persist, validates offsets against a sha256 stamp of the exact per-turn prompt text, and fails open per fact to generated content. Shadow mode persists generated content unchanged (zero-diff proven byte-identical). Grounding learns to gate span-materialized "frame: verbatim slice" facts on the embedded slice. No storage-format change; offsets never persist.
