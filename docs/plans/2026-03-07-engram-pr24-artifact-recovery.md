# PR24: Artifact Recovery / Reuse Retrieval

## Goal

Add the first retrieval path on top of the creation-memory ledger so Engram can
surface previously created outputs as reuse candidates without yet inferring
commitments or resume bundles.

## Scope

- add `workProductRecallEnabled`
- add bounded lexical search over typed work-product ledger entries
- add `openclaw engram work-product-recall-search <query>`
- inject a dedicated `## Work Products` recall section behind the recall flag
- keep retrieval grounded in the explicit ledger contract from PR23

## Non-Goals

- transcript inference into the ledger
- commitment extraction
- resume-bundle generation
- blending work-product results into generic semantic-memory scoring

## Review Risks

- surfacing work-product recall when `creationMemoryEnabled` is off
- returning stale noise because scoring ignores lexical match gates
- overloading PR24 with commitment or resume logic

## Verification

- targeted tests:
  - `tests/work-product-ledger.test.ts`
  - `tests/work-product-recall.test.ts`
  - `tests/config-eval-harness.test.ts`
- full checks before PR:
  - `npm run check-types`
  - `npm run check-config-contract`
  - `npm test`
  - `npm run build`
