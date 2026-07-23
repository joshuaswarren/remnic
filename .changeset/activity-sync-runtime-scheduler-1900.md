---
"@remnic/core": minor
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Wire parsed `config.activity` through to a real periodic runtime sync
(issue #1900). Adds a host-agnostic `ActivityHttpSourceClient`-backed
runner (`runActivitySyncOnce`) that instantiates one client per parsed
source and syncs the `syncDays` window only when
`activity.enabled` is true, isolating per-source faults and delegating
cursor advancement to `syncActivitySource` (durable-success only). Adds
an in-process `ActivitySyncScheduler` (register / invoke-on-cadence /
stop-cancels, unref'd timer, overlap + latched-stop guards) registered
through the existing `MaintenanceScheduler` seam — started on deferred
init, stopped on teardown — so parsed config now drives synchronization
end to end (parser -> scheduler -> durable sync). Master default-off:
disabled config builds no client, opens no store, makes no HTTP call,
and arms no timer. Effective cadence defaults to 15 minutes per the
`activity.autoSyncIntervalMinutes` contract in #1899. No OpenClaw import
reaches core.

The two packaged plugin manifests (`@remnic/plugin-openclaw` and
`@joshuaswarren/openclaw-engram`) gain the `activity.*` schema (including
`activity.autoSyncIntervalMinutes`), so they get a patch bump to republish
the updated manifests alongside core.
