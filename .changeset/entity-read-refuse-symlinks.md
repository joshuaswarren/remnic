---
"@remnic/core": patch
---

Add a regression test for the entity read path: a symlink at `entities/<id>.md` that points outside the memory directory is treated as absent, `readEntity` returns nothing for it, `listEntityNames` skips it, and normal entity files still read. The guard already exists in `readStoreFileBuffer`; the test pins it (COS-388c Finding C2).

Stability: stable
