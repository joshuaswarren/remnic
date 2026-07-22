# Desktop capture — on-screen activity & meeting intelligence

Desktop capture is the umbrella (issue #1896) for turning a workstation's own
signals — on-screen text and, later, microphone audio — into searchable daily
context and detected meetings, using the same provider-agnostic, à-la-carte,
fixture-testable design as the wearable connectors.

This document describes the **whole** epic and marks precisely what has shipped
versus what is a planned follow-on slice, so a reader never assumes an
unbuilt surface exists.

## Status at a glance

| Slice | Issue | State |
|-------|-------|-------|
| Activity store + day-digest foundation | #1899 | **shipped** (`@remnic/core`, `src/activity/`) |
| Meeting detector (pure functions) | #1900 | **shipped** (`@remnic/core`, `src/meetings/`) |
| `@remnic/capture-screen` daemon (`--replay`) | #1899 | planned |
| Activity `extractionMode: smart` + judge hardening | #1899 | planned |
| Screen native macOS helper (ScreenCaptureKit/Vision/AX) | #1899 | planned, hardware-gated |
| `@remnic/capture-audio` (spool + daemon + HTTP, `--replay`) | #1897 | planned |
| STT + VAD + model download + janitor | #1897 | planned |
| Diarization + speaker clusters + enroll-self + dedup | #1897 | planned |
| Meeting fusion + record store + CLI | #1900 | planned |
| Episode memories + MCP/HTTP surfaces | #1900 | planned |
| Audio native macOS helper | #1897 | planned, hardware-gated |

"Hardware-gated" slices require a macOS/Windows build+sign+on-device-permission
environment and cannot be built or verified on a headless Linux host.

## Design principles (shared with wearables)

1. **Provider-agnostic core.** `@remnic/core` owns the data model, storage,
   digest rendering, and detection. No host SDK dependency (see the Architecture
   Boundaries section in `AGENTS.md`).
2. **À-la-carte capture.** Capture daemons ship as separate optional packages
   (`@remnic/capture-screen`, `@remnic/capture-audio`) loaded lazily; core works
   without them.
3. **Fixture-first, CI-verifiable.** Every daemon exposes a `--replay` mode that
   drives it from recorded fixtures, so the pipeline is testable without a
   camera, microphone, or screen.
4. **Day-anchored, searchable, never auto-recalled.** Rendered day artifacts
   live under the memory directory inside the QMD collection root but outside the
   memory scan roots — searchable on demand, never injected automatically.

## Shipped — activity subsystem (`src/activity/`, #1899)

The on-screen activity subsystem captures periodic screen snapshots (text +
window/app context) into a durable per-machine store and renders a deterministic
day digest.

### Store — `ActivityStore` (`store.ts`)

- SQLite-backed via the shared `better-sqlite3` runtime wrapper.
- `ActivityStore.open(memoryDir)` is the public factory; it creates
  `<memoryDir>/state/activity.sqlite` (and the `state/` directory) itself.
- `insertSnapshot(snapshot)` is **idempotent on `(machine, captured_at_utc,
  content_hash)`** — the same screen content recurring at a *different* time is
  kept; only an exact re-ingestion dedups. The base row and its FTS row are
  written in one transaction, so search can never drift from the base table.
- Capture timestamps are validated (real calendar instant, `±14:00` offsets) and
  canonicalized to `YYYY-MM-DDTHH:MM:SS.sssZ` on write, so day-window range
  filtering is a valid lexical comparison. Required fields and `textSource`
  (`ax` | `ocr`) are validated at the boundary.
- `listSnapshotsForDay`, `searchSnapshots` (FTS5; a real backend failure is
  surfaced, never masked as an empty result), `getCursor`/`setCursor`,
  `pruneOlderThan`.

### Day digest (`digest.ts`)

- `composeActivityDigestBody(date, timezone, snapshots)` renders a deterministic
  Markdown body: a per-app time breakdown, a coalesced timeline, and a "notable"
  section, all ordered by parsed instant with total tie-breakers.
- **Dwell is scoped per capture machine**, and the timeline keys on machine as
  well as app/window, so a multi-machine day never lets one machine steal or
  drop another's spans.
- `activityDayWindow(date, timezone)` returns half-open `[start, end)` UTC bounds
  for a local day, correct across DST fall-back (first of a repeated midnight)
  and spring-forward (no backdating a skipped midnight), including zones east of
  UTC.
- `serializeActivityDigest`/`parseActivityDigest` round-trip a digest with a YAML
  frontmatter block; machine labels are JSON-encoded so a label containing a
  comma or YAML-significant character survives the round trip.
- Digests are written to `<memoryDir>/activity/<date>.md`.

## Shipped — meeting detector (`src/meetings/`, #1900)

`detectMeetings(input, config?)` is a **pure function** over a day's
already-ingested signals — audio conversation windows (from wearable day
transcripts, any source) plus meeting-app foreground spans (from screen
activity). No store, fusion, or surfaces yet; those are later #1900 slices.

- A meeting is either an audio conversation overlapping a meeting-app span
  (`app+audio`), a provider-boundaried meeting (`provider`), or a long
  multi-speaker audio-only conversation (`audio`).
- Candidates are merged so the day's meetings never overlap; within-gap same-app
  rejoins collapse into one session. Merge order is a total order, so equal-time
  spans resolve deterministically regardless of input order.
- **Meeting IDs** (`meetingId(date, startUtc)` → `mtg-<date>-<hash>`) are hashed
  from the date plus the **exact start instant** only. End and app are excluded,
  so a resync that extends a meeting's end or reassigns its app never renumbers
  it; full start precision keeps short same-minute provider meetings distinct.
  A resync that moves a meeting's *start* earlier does renumber it — preserving
  IDs across a shifted start is cross-run identity work that belongs to the
  fusion/record-store slice, which matches a re-detected meeting to its stored
  record by overlap.
- Timestamps are validated (real calendar instant, `±14:00` offsets); an invalid
  `input.date` or a malformed window is rejected rather than silently coerced.
- Config thresholds (`minOverlapMinutes`, `audioOnlyMinMinutes`,
  `mergeGapMinutes`) are validated as finite, non-negative numbers.

## Storage layout

```
<memoryDir>/
├── state/
│   └── activity.sqlite        # ActivityStore (snapshots, FTS, sync cursors)
└── activity/
    └── <date>.md              # rendered day digest (QMD-searchable)
```

Meeting records get their own store + on-disk layout in the fusion slice (#1900);
this is documented here when that slice lands.

## Both subsystems are reachable from the package root

```ts
import { ActivityStore, composeActivityDigestBody, detectMeetings } from "@remnic/core";
```

## References

- Wearable transcript pipeline (the sibling design): `docs/wearables.md`
- Architecture boundaries and the activity/ + meetings/ notes: `AGENTS.md`
