# PR12: Trust-Zone Promotion Rules And Provenance Enforcement

## Goal

Add the first explicit promotion path on top of the trust-zone store introduced
in PR11 without changing retrieval behavior yet.

## Scope

- Add deterministic promotion planning for `quarantine -> working` and
  `working -> trusted`.
- Block direct `quarantine -> trusted` promotion.
- Require anchored provenance (`sourceId` + `evidenceHash`) before promoting
  tool/web/subagent-derived working records into `trusted`.
- Add a dry-run/apply CLI wrapper for promotions.
- Preserve defaults-off behavior via existing trust-zone flags.

## Non-Goals

- No automatic promotion from hooks or background jobs.
- No corroboration engine yet.
- No trust-zone-aware retrieval filtering yet.
- No poisoning benchmark packs yet.

## Contract

- `trustZonesEnabled` must be `true`.
- `quarantinePromotionEnabled` must be `true`.
- Promotion writes a new trust-zone record rather than mutating the source.
- Promoted records carry:
  - `promotedFromZone`
  - lineage metadata with `sourceRecordId`
  - `promotionReason`

## Tests

- Direct `quarantine -> trusted` promotion is denied.
- `working -> trusted` promotion is denied when risky provenance lacks anchors.
- `working -> trusted` promotion is allowed when provenance is anchored.
- Promotion writes a lineage-aware successor record.
- CLI dry-run returns the plan without writing.
