---
name: remnic-no-inline-persist-mock
description: "Tests must stub the orchestrator persist surface via stubPersistExtraction, not an inline `.persistExtraction = async …` assignment"
interruptMode: never
condition:
  - '\.persistExtraction\s*=\s*(async\b|\([^)]*\)\s*=>)'
globs:
  - "**/packages/remnic-core/src/**/*.test.ts"
  - "**/*.test.ts"
---

You are replacing the orchestrator's `persistExtraction` method with an
inline test double (`orchestrator.persistExtraction = async () => [...]`).
An inline arrow is untyped against the production signature, so a change
to `persistExtraction`'s parameters or return type does not break the
test — the mock silently drifts.

Use the shared, production-typed factory instead:

```ts
import { stubPersistExtraction } from "./testing/orchestrator-lite.js";

// records each ExtractionResult; returns the factory's ids (or [] by default)
const persistCalls = stubPersistExtraction(orchestrator, () => ["fact-1"]);
// ...
assert.equal(persistCalls.length, 1);
```

`stubPersistExtraction` types the replacement as `PersistExtractionFn`
(sourced from the extraction-run delegate contract), so a production
signature change fails to compile in every consumer rather than passing
a stale mock. The returned array is the call log — assert on `.length`
instead of hand-rolling a counter.

This rule does NOT match a delegate-deps field literal
(`persistExtraction: async (...) => [...]` with a colon) — that is a
legitimate `ExtractionRunCoordinatorDeps` value, not a method override —
nor the factory's own `seam.persistExtraction = impl` assignment.
