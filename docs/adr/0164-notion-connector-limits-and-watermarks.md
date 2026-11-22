# Notion sync enforces hard resource limits and only advances a database watermark after a fully drained pass

Status: accepted

## Context
The Notion live connector polls an API with no push capability. Notion pages can be arbitrarily long and deeply nested, passes are bounded, and queries sort descending by `last_edited_time` with an `after: watermark` filter. If a pass stops mid-database (page cap, abort, `has_more` without a usable cursor), the pages not yet seen are older than the ones seen; advancing the watermark past them would skip them forever unless re-edited. Oversized or empty pages and permanently inaccessible pages would otherwise be re-fetched on every poll.

## Decision
- Polling defaults to a 5-minute interval (sub-minute polling wastes quota for a push-less API); individual page text is capped and oversized pages are skipped; block recursion depth and pages-per-pass are capped.
- A database watermark is persisted ONLY when that database was fully drained during the pass. Any early cutoff — page cap hit, mid-pass abort, defensive bail on `has_more` with no cursor — leaves the previous watermark so the next pass re-queries the same `after` filter.
- On first sync, seed the watermark WITHOUT importing content (mirrors Drive's start-page-token bootstrap).
- Skipped pages record their revision so they are not re-fetched every poll: oversized/empty pages and terminal 404/403 skips persist the seen version; if the page later shrinks or is edited, `last_edited_time` advances past the watermark and it flows through normally.
- Integration tokens are validated against the `secret_` prefix so an OAuth-style pasted token is rejected early.

## Consequences
Correctness depends on the drained invariant: any new early-exit path in the per-database loop must leave the watermark untouched or it silently drops older pages. Skipped-page revisions mean content is intentionally absent until the source changes — acceptable, since re-fetching known-bad pages every poll is worse.

## Merged themes
`live-connector-registry-design`, `registry-no-silent-overwrite` (registration throws on malformed or duplicate ids — no silent overwrite), `state-store-location`/`state-store-validation-boundaries` (cursor files are fully validated at the write boundary; fractional counters rejected, since persisting an out-of-shape record bricks the connector until manual repair), `state-store-symlink-defense` (symlinked path components are rejected so a planted symlink cannot redirect writes outside the memory root), and `shared-transient-error-classifier` (an explicitly enumerated allowlist of network error codes is treated as transient; unknown code+no-status is conservatively terminal to avoid looping) all belong to the same live-connector design family and are merged here.

## Origin comments
- `packages/remnic-core/src/connectors/live/notion.ts:1` — "/** * @remnic/core — Notion live connector (issue #683 PR 3/N) * * Concrete `LiveConnector` implementation that incre"
- `packages/remnic-core/src/connectors/live/notion.ts:78` — "/** * Default poll interval (5 minutes). Notion's API has no push capability; * polling sub-minute wastes quota for a"
- `packages/remnic-core/src/connectors/live/notion.ts:87` — "/** * Hard cap on individual page text size. Notion pages can be very long; * we skip rather than blow the importer's"
- `packages/remnic-core/src/connectors/live/notion.ts:93` — "/** * Maximum recursion depth when fetching block children. Notion pages can * nest blocks (e.g. toggle → bulleted li"
- `packages/remnic-core/src/connectors/live/notion.ts:100` — "/** * Maximum number of pages we import in a single `syncIncremental` pass * across all databases. Prevents one runaw"
- `packages/remnic-core/src/connectors/live/notion.ts:107` — "/** * Notion integration tokens always start with `secret_`. We validate this * prefix so a typo (e.g. pasting an OAu"
- `packages/remnic-core/src/connectors/live/notion.ts:669` — "// On first sync we seed the watermark WITHOUT importing any content"
- `packages/remnic-core/src/connectors/live/notion.ts:670` — "// (mirrors Drive's getStartPageToken bootstrap pattern)."
- `packages/remnic-core/src/connectors/live/notion.ts:783` — "// Track whether we fully drained this database during the pass."
- `packages/remnic-core/src/connectors/live/notion.ts:785` — "// Why this matters (codex review P1): we sort the query descending by"
- `packages/remnic-core/src/connectors/live/notion.ts:786` — "// `last_edited_time` and filter `after: dbWatermark`. If we hit"
- `packages/remnic-core/src/connectors/live/notion.ts:787` — "// MAX_PAGES_PER_PASS or get aborted mid-database, the pages we"
- `packages/remnic-core/src/connectors/live/notion.ts:788` — "// *haven't* seen yet are *older* than the ones we have seen. Advancing"
- `packages/remnic-core/src/connectors/live/notion.ts:789` — "// `databases[dbId]` to the highest `last_edited_time` we saw would set"
- `packages/remnic-core/src/connectors/live/notion.ts:790` — "// the next pass's `after` filter past those still-pending older pages"
- `packages/remnic-core/src/connectors/live/notion.ts:791` — "// and skip them forever (they only resurface if re-edited)."
- `packages/remnic-core/src/connectors/live/notion.ts:792` — "//"
- `packages/remnic-core/src/connectors/live/notion.ts:793` — "// Solution: only persist the new database watermark when the database"
- `packages/remnic-core/src/connectors/live/notion.ts:794` — "// was fully drained for this pass. If we cut off early, leave"
- `packages/remnic-core/src/connectors/live/notion.ts:795` — "// `databases[dbId]` at its previous value so the next pass re-queries"
- `packages/remnic-core/src/connectors/live/notion.ts:796` — "// the same `after` filter and finishes the leftovers."
- `packages/remnic-core/src/connectors/live/notion.ts:872` — "// Codex review P2: record the revision so we don't re-fetch this"
- `packages/remnic-core/src/connectors/live/notion.ts:873` — "// oversized page on every subsequent poll. If the page shrinks"
- `packages/remnic-core/src/connectors/live/notion.ts:874` — "// below the limit on a future edit, `last_edited_time` will"
- `packages/remnic-core/src/connectors/live/notion.ts:875` — "// advance and the watermark check above will let it through."
- `packages/remnic-core/src/connectors/live/notion.ts:882` — "// Codex review P2: same reasoning as too-large — record the"
- `packages/remnic-core/src/connectors/live/notion.ts:883` — "// revision so we don't re-fetch an empty page indefinitely."
- `packages/remnic-core/src/connectors/live/notion.ts:896` — "// null = terminal skip (404/403). Record the version so we"
- `packages/remnic-core/src/connectors/live/notion.ts:897` — "// don't repeatedly attempt a permanently-inaccessible page."
- `packages/remnic-core/src/connectors/live/notion.ts:911` — "// Hit the per-pass cap inside this database's results. The"
- `packages/remnic-core/src/connectors/live/notion.ts:912` — "// database is NOT fully drained; leave its watermark intact so"
- `packages/remnic-core/src/connectors/live/notion.ts:913` — "// the next pass re-queries the same `after` filter."
- `packages/remnic-core/src/connectors/live/notion.ts:924` — "// Defensive bail: has_more=true but no usable next_cursor. We do"
- `packages/remnic-core/src/connectors/live/notion.ts:925` — "// NOT mark the database fully drained — the next pass must retry"
- `packages/remnic-core/src/connectors/live/notion.ts:926` — "// the same `after` filter and pick up whatever we missed."
- `packages/remnic-core/src/connectors/live/registry.ts:1` — "/** * @remnic/core — Live Connectors Registry (issue #683 PR 1/N) * * Pure in-memory registry. No I/O. Concrete conne"
- `packages/remnic-core/src/connectors/live/registry.ts:31` — "/** * Register a connector. Throws `LiveConnectorRegistryError` if the id is * malformed or already registered. * * R"
- `packages/remnic-core/src/connectors/live/state-store.ts:1` — "/** * @remnic/core — Live Connectors State Store (issue #683 PR 1/N) * * Persists per-connector cursor + sync metadat"
- `packages/remnic-core/src/connectors/live/state-store.ts:165` — "// totalDocsImported is a cumulative count — fractional values would corrupt"
- `packages/remnic-core/src/connectors/live/state-store.ts:166` — "// metrics on later increments. Mirror the boundary check in writeConnectorState."
- `packages/remnic-core/src/connectors/live/state-store.ts:234` — "/** * Reject any path component along `<memoryDir>/state/connectors/<id>.json` * that is a symlink. Without this guar"
- `packages/remnic-core/src/connectors/live/state-store.ts:641` — "// Full boundary validation. Persisting an out-of-shape record would brick"
- `packages/remnic-core/src/connectors/live/state-store.ts:642` — "// the connector's cursor file: subsequent `readConnectorState` calls would"
- `packages/remnic-core/src/connectors/live/state-store.ts:643` — "// throw `ConnectorStateCorruptionError` until manual repair. JS callers"
- `packages/remnic-core/src/connectors/live/state-store.ts:644` — "// bypassing TS types must be rejected here, not later. (PR #724 review.)"
- `packages/remnic-core/src/connectors/live/state-store.ts:692` — "// Reject planted symlinks before mkdir/write so a redirected target can't"
- `packages/remnic-core/src/connectors/live/state-store.ts:693` — "// overwrite an arbitrary file outside the memory root. (PR #724 review.)"
- `packages/remnic-core/src/connectors/live/state-store.ts:733` — "// Refuse to enumerate through a symlinked state directory — a planted"
- `packages/remnic-core/src/connectors/live/state-store.ts:734` — "// symlink at <memoryDir>/state or <memoryDir>/state/connectors would"
- `packages/remnic-core/src/connectors/live/state-store.ts:735` — "// otherwise let reads escape the memory root. (PR #724 review.)"
- `packages/remnic-core/src/connectors/live/transient-errors.ts:1` — "/** * Shared transient-error classifier for live connectors. * * All three connectors (Drive, Notion, Gmail) need to "
- `packages/remnic-core/src/connectors/live/transient-errors.ts:46` — "/** * Set of Node.js network-layer error codes we treat as transient. * Explicitly enumerated (not a denylist) so unk"
- `packages/remnic-core/src/connectors/live/transient-errors.ts:142` — "// Unknown string code with no HTTP status: conservative terminal to avoid"
- `packages/remnic-core/src/connectors/live/transient-errors.ts:143` — "// looping on a permanent error. Callers can override if needed."
- `packages/remnic-core/src/connectors/live/transient-errors.ts:147` — "// No status, no code — likely a plain `Error` from a fetch-layer network"
- `packages/remnic-core/src/connectors/live/transient-errors.ts:148` — "// failure. Treat as transient."
