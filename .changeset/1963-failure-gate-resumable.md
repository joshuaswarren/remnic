---
"@remnic/bench": patch
---

Make H6 repeated-failure runs survive transient endpoint outages instead of being voided by them. A completed 1,260-episode pilot was invalidated by a ~1% infrastructure stall: rows exhausted the two-retry allowance, producing primary task cuts that forced `NOT_ESTIMABLE` on data that otherwise showed a relative risk reduction of 1.00. Decision rule v10 targets the delivery mechanism and leaves every arm definition, cap, interval rule, and the zero-cut rule unchanged: the host/API fault allowance rises from two retries to five (six attempts), and exhausting it now commits the failing attempt and pauses the run for operator recovery rather than marking the row invalid, so a resumed run replays from the next attempt with complete history. Claim and commit leases rise to 30 minutes because six attempts at the 180s request timeout exceed the previous 5-minute lease and the heartbeat timer is unref'd. Refs #1963.
