---
"@remnic/core": patch
---

Stability: stable

Make the entity canonical-id migration's search-maintenance request survive a crash. A pending marker beside the migration journal is written before a pass rewrites references and cleared only after a search-maintenance pass that covers the request actually ran, not when the debounced timer is merely armed. A crash, a `destroy()` inside the debounce window, a failed or suppressed pass, or the search backend being unavailable leaves the marker, so the next startup's no-op replay requests the re-index again. Each run owns its own marker file and clears only the markers it observed or wrote, so concurrent runs cannot delete each other's. Ordinary no-op startups stay quiet.

To tell whether a pass ran, search backends gain an optional `updateCompleted()` (QMD keeps using `updateStrict()`). Behavior change: with namespaces enabled, a strict namespace update (namespace maintenance and the convergence refresh) now fails for a non-QMD backend (Orama, LanceDB, Meilisearch) whose refresh did not complete, where it previously counted as success because the plain `update()` is fail-open. That means `refreshConvergedNamespaces` can now reject and namespace maintenance can record a failed run for such a backend. A Meilisearch backend with `autoIndex` off (the default) pushes nothing by configuration and reports complete, so it is unaffected. Non-strict updates are unchanged. Refs #3139; fixes #3286.
