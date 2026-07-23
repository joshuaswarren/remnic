# Meeting intelligence (issue #1900)

`src/meetings/` is a host-agnostic core subsystem for **retrospective meeting
detection** over already-ingested signals (wearable / desktop audio
conversations + screen activity). It is retrospective, not realtime: no daemon,
no live watcher — a pure derivation over data the audio (#1897/#1898) and
screen-activity (#1899) phases already store, so late-arriving uploads still
resolve on the next pass.

This page documents the whole #1900 design and marks precisely what has shipped
versus what is a planned follow-on slice, so a reader never assumes an unbuilt
surface exists.

## Status at a glance

| Capability | State |
|---|---|
| `detectMeetings()` pure detection (`detect.ts`, `types.ts`) | **shipped** in `@remnic/core` |
| Fusion (`fuse.ts`, `fuseMeeting()`) | planned (#1900 engine slice) |
| Meeting record materialization (`store.ts`) | planned |
| `MeetingsBuilder` orchestration (`build.ts`) | planned |
| Episode + trust-gated summary/fact memories (`memory-gen.ts`) | planned |
| `meetings.*` config (incl. `meetings.enabled`) + CLI/MCP/HTTP surfaces | planned |

Today `@remnic/core`'s `meetings` entry re-exports only `types` and `detect`;
there is no fusion, record, memory generation, or `meetings.enabled` runtime
yet. Those land with the sibling implementation PRs of #1900 (engine +
memory-gen, then surfaces). The sections below marked **(planned)** describe the
shape that implementation will take; do not enable or integrate against them
until they ship.

## Pipeline

Shipped stage is `detect.ts`; the rest is the planned shape:

```
inputs (already on disk, per day):
  wearable day transcripts   <memoryDir>/wearables/<source>/<date>.md
  screen activity            <memoryDir>/activity/... (activity store)
      │
      ▼
  detect.ts     detectMeetings() — app-span ∩ audio-window, audio-only, provider   [shipped]
      ▼
  fuse.ts       fuseMeeting() — reuse wearables fuseCluster over the window;        [planned]
                higher-trust text wins overlaps + corroboratedBy; screen-context
                dwell timeline; attendees from fused speakers
      ▼
  store.ts      <memoryDir>/meetings/<date>/<meeting-id>.md (idempotent, contentHash) [planned]
      ▼
  build.ts      MeetingsBuilder — detect → fuse → compose → store, stale-record     [planned]
                reconcile (overlap-preserving ids), optional reindex hook
      ▼
  memory-gen.ts deterministic episode (always) + trust-gated summary/facts (LLM)    [planned]
```

## Detection (`detect.ts`) — shipped

`detectMeetings()` is a pure function over a day's already-ingested audio
windows + meeting-app foreground spans. A meeting candidate is a meeting-app
foreground span **and** an overlapping audio conversation (intersection ≥
`minOverlapMinutes`). Additional paths:

- **Audio-only**: a conversation ≥ `audioOnlyMinMinutes` with ≥ 2 distinct
  non-wearer speakers, even without an app span (`detectionSource: "audio"`).
- **Provider**: a cloud connector (Granola/Fireflies) supplies explicit
  meeting boundaries (`detectionSource: "provider"`).
- Adjacent candidates within `mergeGapMinutes` of the same app merge
  (rejoin-after-drop). A day's meetings never overlap after merge.
- **Watching a recording** (app span, zero audio) → NOT a meeting.

Ids are `mtg-<date>-<hash>` anchored on the exact start instant, so a resync
that grows a meeting never renumbers it. (A resync that *shifts* the start
renumbers it; preserving ids across a shifted start is overlap-reconciliation
work that belongs to the planned record store.) Detection thresholds
(`minOverlapMinutes`, `audioOnlyMinMinutes`, `mergeGapMinutes`) are validated as
finite, non-negative numbers and are passed to `detectMeetings()` directly;
the `meetings.*` config surface that will supply them is planned (below).

## Fusion (`fuse.ts`) — planned

Segments from every wearable source overlapping the half-open `[start, end)`
window will be reconciled through the **shared** wearables cross-source fusion
(`fuseCluster`) — never a parallel merger. Higher-`sourceTrust` text wins
overlapping regions; out-voted sources are recorded as `corroboratedBy`; no
utterance is duplicated. Screen context is an other-app foreground **dwell**
timeline (each span kept only when it lasts `contextDwellSeconds`; a brief
alt-tab is dropped, a trailing lone snapshot is never inflated to the meeting
end) plus deduped on-screen text excerpts capped at `maxContextChars`.

## Record (`store.ts`) — planned

`<memoryDir>/meetings/<YYYY-MM-DD>/<meeting-id>.md` — YAML frontmatter
(`kind: meeting`, id, date, startUtc/endUtc, app, detectionSource, attendees,
sources, corroboratedBy, snapshotCount, contentHash, formatVersion) + body
sections `## Attendees`, `## Screen context`, `## Transcript` (reusing the
wearables day-store `**Name** [HH:MM]: text` line grammar). Rebuilt
idempotently on `contentHash`. Placement is **outside** the memory scan roots
but **inside** the QMD collection root: full-text searchable, never
auto-recalled raw (excluded from generic recall by `isGenericRecallExcludedPath`,
the same isolation artifacts and activity digests use). Symlinked meetings /
day directories are refused before any read/write.

## Memories (`memory-gen.ts`) — planned

1. **Deterministic episode** (always, when `meetings.enabled`): one recall
   anchor per meeting — title, span, attendees, sources — `source: meeting:<id>`,
   tags `meeting` + `meeting-day:<date>`, `valid_at` = start. No LLM.
2. **Trust-gated summary + facts** (`summaryMode`): decisions, commitments
   (category `commitment`), and open questions extracted from the fused
   transcript + screen context flow through the **existing** trust pipeline
   (`computeTrustScore` + `decideSmart`) with provenance
   `{meetingId, meetingDate, meetingApp, transcriptSources}`:
   - `off` → episode only; the LLM extractor is never invoked.
   - `review` → every candidate queued `pending_review`.
   - `smart` → judge verdict + trust bands (`autoApproveTrust`/`reviewTrust`)
     route each candidate to active / review / drop; ≥ 2 transcript sources
     corroborate (trust boost).

## Configuration — planned

The `meetings.*` config block is not yet parsed; it is absent from
`docs/config-reference.md` and setting it has no effect until the engine slice
lands. It will be disabled by default. Planned shape:

| Key | Default | Meaning |
|-----|---------|---------|
| `meetings.enabled` | `false` | Master gate. |
| `meetings.appPatterns` | shipped set | Extra meeting-app patterns (additive). |
| `meetings.minOverlapMinutes` | `2` | App-span ∩ audio-window pairing threshold. |
| `meetings.audioOnlyMinMinutes` | `15` | Audio-only detection minimum length. |
| `meetings.mergeGapMinutes` | `2` | Rejoin-after-drop merge gap. |
| `meetings.contextDwellSeconds` | `20` | Screen-context dwell threshold. |
| `meetings.maxContextChars` | `4000` | Screen-context excerpt cap. |
| `meetings.summaryMode` | `smart` | `off` / `review` / `smart`. |
| `meetings.sourceTrust` | `0.85` | Provenance trust prior for facts. |
| `meetings.autoApproveTrust` | `0.7` | Smart-mode auto-approve band. |
| `meetings.reviewTrust` | `0.45` | Smart-mode review band. |

## Degradation matrix (planned end-to-end pipeline)

| Available data | Behavior |
|---|---|
| activity + audio | full: app+audio detection, screen fusion |
| activity only (no audio) | no meetings (an app span alone is not a meeting) |
| audio only (no activity) | audio-only detection; record without a screen-context section |
| provider transcripts only | provider detection from conversation metadata |
| multiple audio sources | one meeting, fused transcript, corroboration recorded |
| late-arriving source | re-fuse + re-score on the next build (contentHash changes) |
| `meetings.enabled: false` | zero behavior on every surface |

## Non-goals

Realtime meeting hooks, calendar-based detection/attendee resolution, and
auto-posting summaries to external destinations are explicit non-goals for v1
(tracked as separate follow-ups).

## See also

- [Desktop capture](desktop-capture.md) — the activity/audio/connector umbrella
  (#1896) that produces the signals meeting detection reads.
- [Wearable transcripts](wearables.md) — the fusion and trust pipeline the
  planned meeting fusion/memory stages reuse.
