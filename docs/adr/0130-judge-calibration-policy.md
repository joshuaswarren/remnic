# Judge calibration is pinned to one stored full run and only ever seeded from a sufficiently large, complete run

Status: accepted

## Context
Cached judge answers change over time, runs can be interrupted or sampled, and agreement on a tiny sample is often degenerate. Selecting "whatever is newest" made the same judge pair swing wildly between calibration runs, and a one-sample kappa could read as perfect agreement.

## Decision
- Only a complete full run may seed a calibration source. A quick run is a sampled artifact whose agreement is meaningless; a stale quick result is never selected. A partial full run (interrupted) never displaces an older complete one; if every candidate is partial, the newest is kept as the only available option.
- The candidate pool is ordered newest-first with a three-way timestamp comparator that returns 0 on ties; the run id breaks remaining ties deterministically. Status lives on the loaded result, not the summary, so candidates are loaded newest-first and the first complete one is kept.
- A calibration needs enough completed tasks to be meaningful: count unique task ids after dedupe, since raw counts can overstate the sample and yield a degenerate one-sample kappa.
- Once a calibration source is stored, every later calibration uses that exact stored result — never "whatever is newest" — so the same judge pair cannot swing as cached answers change. The persisted kappa binds to the calibrated pair's identities (local manifest and frontier judge) so a later run that swaps either cannot inherit a stale kappa for a different pair.
- Attachment applies the stored calibration to local results only; frontier and unrelated runs are not attachment candidates and must not require local-run pins. For older state that carries configuration hashes but no complete provider/model identity, the resolved local-config hash is the only safe eligibility signal; explicit pins are never silently discarded. Calibration attaches to partial results too, because kappa reflects judge reliability independent of run completion; an absent calibration file leaves results unchanged for backwards compatibility.
- After persisting, the CLI reads the state back through the same load path the artifact builder will use; a mismatch there is an operator-visible failure, not a silent one.

## Consequences
Calibration stability costs freshness: a pinned source stays pinned until the operator re-calibrates, and degenerate or partial runs are excluded even when they are the newest.

## Origin comments
- `packages/remnic-cli/src/index.ts:1959` — "// Calibration needs a full run's cached answers — a quick run (mode "quick")"
- `packages/remnic-cli/src/index.ts:1960` — "// is a 1-task sample whose agreement is meaningless (often kappa=1 on a"
- `packages/remnic-cli/src/index.ts:1961` — "// single agreeing pair), so a stale quick result must never be selected as"
- `packages/remnic-cli/src/index.ts:1962` — "// the calibration source (codex P2 review)."
- `packages/remnic-cli/src/index.ts:1967` — "// Descending by timestamp with a 3-way comparator (cursor review: the"
- `packages/remnic-cli/src/index.ts:1968` — "// previous `< b ? 1 : -1` never returned 0, so tied timestamps produced"
- `packages/remnic-cli/src/index.ts:1969` — "// an unstable order that could pick a non-latest run). The id breaks"
- `packages/remnic-cli/src/index.ts:1970` — "// remaining ties deterministically."
- `packages/remnic-cli/src/index.ts:1976` — "// Issue #1877: once a benchmark has a calibration source, keep using that"
- `packages/remnic-cli/src/index.ts:1977` — "// exact stored result. Selecting "whatever is newest" made the same judge"
- `packages/remnic-cli/src/index.ts:1978` — "// pair swing from kappa 0.769 to 0.444 as cached answers changed."
- `packages/remnic-cli/src/index.ts:1987` — "// Prefer the latest COMPLETE full run — a partial full run (interrupted)"
- `packages/remnic-cli/src/index.ts:1988` — "// would otherwise seed calibration from an incomplete slice even when an"
- `packages/remnic-cli/src/index.ts:1989` — "// older complete full run exists (codex P2 review). `status` lives on the"
- `packages/remnic-cli/src/index.ts:1990` — "// loaded result, not the summary, so load newest-first and keep the first"
- `packages/remnic-cli/src/index.ts:1991` — "// complete one; if every candidate is partial we keep the newest (the only"
- `packages/remnic-cli/src/index.ts:1992` — "// option available to the operator)."
- `packages/remnic-cli/src/index.ts:2000` — "// Codex P2 review: a `--limit 1` (or `--trial-limit 1`) full run produces"
- `packages/remnic-cli/src/index.ts:2001` — "// mode === "full" with a single task, yielding a degenerate one-sample κ"
- `packages/remnic-cli/src/index.ts:2002` — "// (often 1.0). Require enough completed tasks for a meaningful calibration."
- `packages/remnic-cli/src/index.ts:2003` — "// Count UNIQUE task ids — runJudgeCalibration dedupes by questionId, so"
- `packages/remnic-cli/src/index.ts:2004` — "// raw task count can overstate the sample (codex P2 review: a stored result"
- `packages/remnic-cli/src/index.ts:2005` — "// with duplicate taskIds could pass the minimum while producing a smaller κ)."
- `packages/remnic-cli/src/index.ts:2082` — "// Bind the persisted kappa to the calibrated judge pair (codex P2 review):"
- `packages/remnic-cli/src/index.ts:2083` — "// without these identities, a later run that swaps the local-lab manifest"
- `packages/remnic-cli/src/index.ts:2084` — "// or the frontier judge would inherit a stale kappa for a different pair."
- `packages/remnic-cli/src/index.ts:2097` — "// Read the persisted state straight back. This exercises the load path the"
- `packages/remnic-cli/src/index.ts:2098` — "// artifact builder will use (cursor review + codex P1: loadJudgeCalibration-"
- `packages/remnic-cli/src/index.ts:2099` — "// State was previously dead code — only tests called it). A mismatch here"
- `packages/remnic-cli/src/index.ts:2100` — "// would mean the persisted kappa is not what subsequent local artifacts"
- `packages/remnic-cli/src/index.ts:2101` — "// would carry, which is an operator-visible failure."
- `packages/remnic-cli/src/index.ts:3045` — "// Issue #1573 PR3 (cursor + codex High/P1 review): load the persisted"
- `packages/remnic-cli/src/index.ts:3046` — "// judge-calibration state for this benchmark so the stored local artifact"
- `packages/remnic-cli/src/index.ts:3047` — "// carries the kappa + warning after `remnic bench judge-calibrate`. Absent"
- `packages/remnic-cli/src/index.ts:3048` — "// calibration (file missing) is the common case — the result is written"
- `packages/remnic-cli/src/index.ts:3049` — "// unchanged, preserving backwards compatibility."
- `packages/remnic-cli/src/index.ts:3076` — "// Attach persisted calibration to partial results too — the kappa"
- `packages/remnic-cli/src/index.ts:3077` — "// reflects judge reliability, independent of whether the run finished."
- `packages/remnic-cli/src/index.ts:3182` — "// The persisted kappa measures the calibrated local judge's agreement"
- `packages/remnic-cli/src/index.ts:3183` — "// with the frontier judge. Frontier and unrelated runs are not attachment"
- `packages/remnic-cli/src/index.ts:3184` — "// candidates, so their normal execution must not require local-run pins."
- `packages/remnic-cli/src/index.ts:3210` — "// Older state may have configuration hashes but no complete provider/model"
- `packages/remnic-cli/src/index.ts:3211` — "// identity. In that case the resolved local-config hash is the only safe"
- `packages/remnic-cli/src/index.ts:3212` — "// eligibility signal: unrelated unpinned runs ignore the state, while"
- `packages/remnic-cli/src/index.ts:3213` — "// explicit pins must never be silently discarded."
