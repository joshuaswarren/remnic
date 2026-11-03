---
"@remnic/core": patch
---

Stability: stable

Make the entity canonical-id migration's search-maintenance request survive a crash. A pending marker beside the migration journal is written before a pass rewrites references and cleared only after the QMD maintenance pass that covers the request has run, not when the debounced timer is merely armed. A crash, a `destroy()` inside the debounce window, a failed pass, or QMD being unavailable leaves the marker, so the next startup's no-op replay requests the re-index again. Each run owns its own marker file and clears only the markers it observed or wrote, so concurrent runs cannot delete each other's. Ordinary no-op startups stay quiet. Refs #3139; fixes #3286.
