---
"@remnic/core": patch
---

Add `resolveSharedAuthority` and `compareSharedAuthority` to shared-context: resolve a shared item's authority to the least-privileged class (absent, non-string, or unrecognized values resolve to `informational` with no trim or case-fold), downgrade `binding` to `advisory` unless an explicit boolean `allowBinding` flag is supplied (a non-boolean flag throws `TypeError`), and order authority classes by ascending privilege with unknown classes sorting as `informational`. The class list re-exports `SHARED_AUTHORITIES` from `governance.ts` rather than duplicating it; the module is source-internal like its shared-context siblings (it is not re-exported from the package entry), and wiring callers is a later slice. Part of #1957
