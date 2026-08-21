# Admin console

The admin console is a browser-based operator UI for a running Remnic instance:
a memory browser, recall debugger, trust-zone and review-queue panes, and a live
memory-graph view. All data fetches and operator actions go through the loopback
bearer-token API; the page itself is a static `index.html` + `app.js` shell
shipped under `admin-console/public/`. It is distinct from the terminal
[operator console](./console.md), which inspects live engine internals.

## Serving the console

The console is mounted by the HTTP access server and reachable at `/remnic/ui/`
(with the legacy `/engram/ui/` alias). Two ways to serve it:

- **Standalone** — run `@remnic/server` (`remnic-server`) and set
  `server.adminConsoleEnabled: true` (default `false`; env override
  `REMNIC_ADMIN_CONSOLE_ENABLED`). The server binds `127.0.0.1:4318` by default,
  so the console lives at `http://127.0.0.1:4318/remnic/ui/`.
- **OpenClaw-hosted** — `openclaw engram access http-serve` (also
  `127.0.0.1:4318` by default).

All console calls require the same loopback bearer token as the rest of the
`/engram/v1/*` operator API.

## Panes

- **Memory check-in** — a guided queue for confirming what Remnic should
  trust, one memory at a time (issue #2351).
- **Memory Browser** — paginated list of `/engram/v1/memories` with
  query / status / category / sort filters.
- **Memory Detail** — content + timeline for a selected memory, with
  raw-path copy. Memory detail is the operator home for "why did you
  remember this?", "forget this", "correct this", and "scope this"
  actions as those controls graduate from API/CLI surfaces.
- **Recall Debugger** — runs `/engram/v1/recall` and
  `/engram/v1/recall/explain` for a session key. Pair it with Recall
  X-ray when auditing per-result provenance, stale/correction state,
  and whether a memory is safe to use in the current context.
- **Quality Dashboard** — counts + latest governance run from
  `/engram/v1/quality`.
- **Trust Zones** — browse and (optionally) promote trust-zone
  records.
- **Review Queue** — governance review queue with confirm / reject /
  archive dispositions.
- **Entity Explorer** — search and inspect entities.
- **Memory Graph** — live force-directed view of the multi-graph
  adjacency from `GET /engram/v1/graph/snapshot` plus incremental
  updates from `GET /engram/v1/graph/events` (issue #691).
- **Maintenance** — JSON dump of the current maintenance summary.

## Memory check-in pane (#2351)

A dashboard card that opens a focused review deck. The card renders only when
the queue is non-empty, and disappears entirely when
`GET /remnic/v1/review/deck` answers `404` — that response is the feature
gate, not an error, so nothing else is surfaced when the deck is turned off.

The deck shows one active memory plus two quiet stacked cards behind it, so
the depth of the queue is visible without pulling attention off the current
question. Each card carries the reason it was flagged, how many sources back
it, the memory content, a plain-language "Why this is here", a **See
evidence** drawer with the provenance, and what each answer will do to
recall.

Answers:

- **Keep** (Right arrow) — `keep`. Remnic keeps using it in recall.
- **Not true** (Left arrow) — `not_true`. Remnic stops using it in recall.
- **Fix** (`E`) — takes replacement text, calls `prepare_fix`, shows the
  returned correction preview, and applies it through the existing
  `POST /engram/v1/correction/apply` only after an explicit confirm.
- **Later** (Space) — sends no request at all; the card moves to the end of
  the session queue.
- **Undo** (Ctrl+Z / Cmd+Z) — offered only while the last receipt reports
  `undoAvailable: true`, and replays the stored `receiptId` plus
  `appliedRevision` against the undo endpoint.

Endpoints: `GET /remnic/v1/review/deck`,
`POST /remnic/v1/review/deck/action`, `POST /remnic/v1/review/deck/undo`, and
the existing correction-apply route. Revisions are opaque server tokens: the
console echoes them back verbatim and never parses or compares them. Every
action carries an `idempotencyKey`, and a retry after a failure reuses the
same key so a request that already landed cannot be applied twice.

Operator notes:

- A rejected action restores the same card and the same focus, and does not
  advance progress. A retry control appears inline.
- An `outcome: "conflict"` receipt re-reads the deck and swaps in just that
  memory's newest version, flagged with a `Refreshed` chip; the rest of the
  queue is untouched.
- While a request is in flight the card is covered rather than moved, and the
  answer buttons are disabled, so nothing shifts under the pointer.
- Going offline blocks the three server-backed answers but leaves **Later**
  available.
- The session ends with a neutral summary ("Reviewed N memories" plus
  kept / fixed / not-true / left-for-later counts). There is deliberately no
  score, streak, or other scoreboard.
- Keyboard: the four answers have the shortcuts listed above, Escape closes
  the evidence drawer first and then the deck, focus is trapped inside the
  open deck, and every completed answer is announced through `aria-live`.
  `prefers-reduced-motion` swaps the card movement for a 150 ms opacity
  change.
- Browser storage holds only the rolling review-duration median and bounded
  counters under `remnic.reviewDeck.metrics` — never memory content,
  provenance, ids, or namespace names. The time hint on the entry card comes
  from that median; before any local history exists it reads "A quick
  review" rather than inventing an estimate.

The deck's queue, receipts, and counters live in a transport-injected state
machine (`admin-console/public/review-deck.js`), which is covered directly by
`node admin-console/public/review-deck.test.mjs`. `app.js` supplies the real
transport and does the DOM rendering.

## Memory Graph pane (#691 PR 3/5)

The graph pane fetches a read-only baseline snapshot from
`GET /engram/v1/graph/snapshot` and renders it with a small vanilla
force-directed simulation (no new runtime dependencies). After the
snapshot loads, the pane opens an SSE stream at
`GET /engram/v1/graph/events` and applies incremental node/edge
mutations in memory so new graph changes appear without a full
re-fetch. The **Refresh** control still re-fetches the baseline snapshot
and restarts the stream.

Controls:

- **Limit** — caps the number of edges fetched (100 / 250 / 500 /
  1000). The endpoint enforces a server-side maximum of 5000.
- **Focus Node Id** — forwards as `focusNodeId` so the snapshot is
  restricted to the focus node and its direct neighbors.
- **Refresh** — re-fetches and re-renders.
- **Reset View** — clears any pan / zoom transform.

Interactions:

- **Pan** — click and drag the canvas.
- **Zoom** — scroll-wheel over the canvas.
- **Node tooltip** — hover a node to see its memory id, category,
  aggregate score, and last-updated timestamp.
- **Edge tooltip** — hover an edge to see its kind (entity / time /
  causal) and confidence (0–1).
- **Color coding** — nodes are colored by category; the legend below
  the canvas surfaces the category → color mapping.

Operator notes:

- The pane only renders after the bearer token connects successfully;
  the snapshot endpoint requires the same loopback auth as every
  other admin call.
- The first fetch runs automatically as part of the connect bootstrap
  alongside the other panes.
- Empty snapshots render an inline placeholder rather than failing.
