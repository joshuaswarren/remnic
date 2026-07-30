# Benchmark Task Instruction

Update the local domain module for workflow-runner-engine so `node test/check.js` completes successfully.
Review the source and the available candidate changes before acting.

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
