---
"@remnic/plugin-codex": patch
"@remnic/core": patch
---

Make the Codex plugin manifest compatible with the current plugin ingestion schema, keep its version synchronized during releases, and allow the model to invoke Remnic's memory workflow and durable-write skills. The packaged `@remnic/core` skill sources and the `BUILTIN_SKILLS` registry mirror that change, and the release workflow now stages the Codex manifest so the synchronized version lands in release commits.
