# Benchmark Task Instruction

Functional requirement: Preserve immutable update semantics: no-op updates retain object identity, value changes replace both root and nested branch, and sequential updates keep prior snapshots unchanged.

Update the local domain module for workflow-runner-engine so `node test/check.js` completes successfully.
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
