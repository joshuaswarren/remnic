---
"@remnic/core": minor
"@remnic/cli": minor
---

Add offline mode for laptop-first Remnic usage.

Core now exposes a snapshot/changeset sync protocol plus HTTP endpoints for
pulling a remote storage snapshot and applying local changes back to a Remnic
daemon. The protocol tracks a shared base, syncs changed files only after the
initial snapshot, preserves both sides on conflicts, and excludes private
process-local directories such as `.secure-store/` and `.offline-sync/`.

The CLI now includes `remnic offline prepare`, `remnic offline sync`,
`remnic offline status`, and `remnic offline watch` so agents can keep talking
to a local laptop daemon while a background sync bridges to the home daemon
whenever the network is available.
