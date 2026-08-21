# Benchmark Task Instruction

Functional requirement: Enforce normalization and validation inside the service boundary: reject invalid raw records without state changes and accept valid records consistently for every caller.

Update the local domain module for media-transcoder-service so `node test/check.js` completes successfully.
Inspect the implementation and preserve all unrelated behavior.

## Verification
- Run `node test/check.js` after changing the implementation.

## Rules & Constraints
1. Work offline without external npm or network access.
2. Maintain backward compatibility across public exported functions.
3. Keep the implementation consistent across its exported interfaces.

## Execution Guidance
Read source files in `src/` and `vendor/` carefully.
Verify fixes using `node test/check.js`.
Do not introduce external network dependencies or import unvendored packages.
