---
"@remnic/core": patch
---

Repair CI gates broken on main by #2437/#2438: register `storage/tombstone-migration-sources.ts` in the lifecycle manifest (it was added to the coverage map but not the manifest), sync the ratchet baseline to the committed config.ts/recall-internal.ts sizes, and update the offline manifest test expectation for the new `identityResolutionVersion: 2` row field.
