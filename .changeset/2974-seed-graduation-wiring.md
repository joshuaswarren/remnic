---
"@remnic/core": minor
---

Corroboration-graduated seed memories, wiring layer (issue #2974): parse the
`seedGraduation` block in `parseConfig`, mix `SeedGraduationSettings` into
`PluginConfig`, pin the gate off on the `conservative` preset, and run
`runSeedGraduationPass` at the end of the lifecycle policy pass with the
recall-handle history as the echo lookup. Default remains off — the policy
pass makes zero extra storage calls while disabled.
