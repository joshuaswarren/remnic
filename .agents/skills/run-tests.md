# Skill: Run Tests

Run the test suite for openclaw-engram.

## Full test suite

```bash
npm test
```

Runs all `tests/*.test.ts` files using Node.js's built-in test runner via `tsx --test`.

## Quick test gate (for iterating)

```bash
npm run preflight:quick
```

Runs type check, config contract check, and a focused subset of critical tests.

## Full preflight gate (before PR)

```bash
npm run preflight
```

Runs type check, config contract check, full test suite, and build.

## Type check only

```bash
npm run lint
```

## Run a single test file

```bash
npx tsx --test tests/intent.test.ts
```

## Expected output

A passing run ends with something like:
```
✓ [file] test name (duration)
...
[preflight] OK (full)
```

## If tests fail

1. Read the error output carefully — the test name identifies which invariant was violated.
2. Check `AGENTS.md` for the corresponding guardrail.
3. Fix the implementation, not the test (unless the test itself is wrong).
4. Re-run `npm run preflight` before opening a PR.
