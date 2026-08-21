# PR13: Trust-Zone Recall Filters And Section Injection

## Goal

Add the first trust-aware retrieval surface on top of the trust-zone store and
promotion rules introduced in PR11 and PR12.

## Scope

- Add `trustZoneRecallEnabled` as a defaults-off config flag.
- Add a bounded `trust-zones` recall-pipeline section.
- Add store-side trust-zone search over existing records.
- Exclude `quarantine` records from recall by default.
- Prefer `trusted` records over `working` records when both are relevant.
- Inject a separate `## Trust Zones` section into recall output.

## Non-Goals

- No automatic promotion or demotion logic.
- No provenance-scoring or corroboration engine yet.
- No poisoning-defense heuristics yet.
- No blending of trust-zone hits into semantic, objective-state, or causal
  ranking paths.

## Contract

- `trustZonesEnabled` must be `true`.
- `trustZoneRecallEnabled` must be `true`.
- The recall section is bounded by `recallPipeline` section controls for
  `trust-zones`.
- `quarantine` records are not eligible for recall in this slice.
- Non-empty queries still require lexical overlap for admission.
- `trusted` outranks `working` when both are otherwise relevant.

## Tests

- Search excludes `quarantine` material and prefers `trusted` matches.
- Search returns no matches when query normalization removes all tokens.
- Recall injects `## Trust Zones` when enabled.
- Recall omits the section when `trustZoneRecallEnabled` is off.
- Recall omits the section when the `trust-zones` pipeline section is disabled.
