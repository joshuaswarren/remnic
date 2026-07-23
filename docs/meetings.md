# Meeting intelligence (issue #1900)

`src/meetings/` is a host-agnostic core subsystem for **retrospective meeting
detection and record-building** over already-ingested signals (wearable /
desktop audio conversations + screen activity). It is retrospective, not
realtime: no daemon, no live watcher — a pure derivation over data the audio
(#1897/#1898) and screen-activity (#1899) phases already store, so late-arriving
uploads still resolve on the next pass.

The engine landed with #2122 and is importable from `@remnic/core`. The
user-facing *surfaces* that drive it during a normal sync and let you inspect
its output (CLI/MCP/HTTP, the day-source adapter, the post-sync build step) land
with the stacked surface PR #2123. This page marks precisely what ships today
versus what is still pending, so a reader never assumes an unbuilt surface
exists.

## Status at a glance

| Capability | State |
|---|---|
| Detection — `detectMeetings()` (`detect.ts`) | **shipped** (`@remnic/core`) |
| Fusion — shared-wearables `fuseCluster` reuse (`fuse.ts`) | **shipped** |
| Record store — content-hash markdown records (`store.ts`) | **shipped** |
| Orchestration — `MeetingsBuilder` / `buildMeetingRecordsForDay()` (`build.ts`) | **shipped** |
| `meetings.*` config parsing (`config.ts`, in `config-reference.md`) | **shipped** |
| Deterministic recall-anchor episode per record | **shipped** (via the builder + memory-generator seam) |
| Memory-generation contracts (`MeetingMemoryGenerator` seam, `memory-generator.ts`) | **shipped** (interfaces only) |
| Trust-gated `summaryMode` summary/fact *generation* | pending (trust-pipeline slice) |
| Production day-source adapter (activity/wearables) | pending (#2123) |
| Post-sync auto-build tail-step | pending (#2123) |
| CLI (`remnic meetings list/show/build`) / MCP / HTTP surfaces | pending (#2123) |
| Namespace symmetry (caller-namespaced records/memories) | pending (#2123) |

What this means today: you can import the engine and drive it with an injected
day source, and its detection/fusion/store/build/config are fixture-tested. But
Remnic does **not** yet build meetings automatically during a sync, there is no
`remnic meetings` command surface, and the trust-gated summary/fact generation
that `summaryMode` governs is not wired yet — the config key parses and
validates, its enforcement lands with the trust-pipeline slice.

## Pipeline

Shipped engine stages plus the pending wiring:

```
inputs (already on disk, per day):
  wearable day transcripts   <memoryDir>/wearables/<source>/<date>.md
  screen activity            <memoryDir>/activity/... (activity store)
      │  (production day-source adapter: pending #2123; injected today)
      ▼
  detect.ts     detectMeetings() — app-span ∩ audio-window, audio-only, provider   [shipped]
      ▼
  fuse.ts       fuseMeeting() — reuse wearables fuseCluster over the window;        [shipped]
                higher-trust text wins overlaps + corroboratedBy; screen-context
                dwell timeline; attendees from fused speakers
      ▼
  store.ts      <memoryDir>/meetings/<date>/<meeting-id>.md (idempotent, contentHash) [shipped]
      ▼
  build.ts      MeetingsBuilder — detect → fuse → compose → store, stale-record     [shipped]
                reconcile (overlap-preserving ids), optional reindex hook
      ▼
  memory-generator.ts  deterministic episode (always) + trust-gated summary/facts   [seam shipped;
                       through an injected MeetingMemoryGenerator                     summary gen pending]
```

## Detection (`detect.ts`)

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
that grows a meeting never renumbers it. A resync that *shifts* the start is
reconciled by window overlap in the builder (the existing id is preserved), so
`show <id>` links stay stable. Thresholds are validated as finite, non-negative
numbers.

## Fusion (`fuse.ts`)

Segments from every wearable source overlapping the half-open `[start, end)`
window are reconciled through the **shared** wearables cross-source fusion
(`fuseCluster`) — never a parallel merger. Higher-`sourceTrust` text wins
overlapping regions; out-voted sources are recorded as `corroboratedBy`; no
utterance is duplicated. Screen context is an other-app foreground **dwell**
timeline (each span kept only when it lasts `contextDwellSeconds`; a brief
alt-tab is dropped, a trailing lone snapshot is never inflated to the meeting
end) plus deduped on-screen text excerpts capped at `maxContextChars`.

## Record (`store.ts`)

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

## Orchestration (`build.ts`)

`MeetingsBuilder` (and the lower-level `buildMeetingRecordsForDay()`) runs
detect → fuse → compose → store for a day, reconciling stale records by window
overlap so ids survive a shifted start, with an optional reindex hook. It reads
its day data through an **injected `MeetingsDaySource`** — fixtures supply it
today; the production adapter that feeds it live activity/wearables data is
pending (#2123). One deterministic recall-anchor episode is written per built
record through the injected memory-generator.

## Memories (`memory-generator.ts`)

The memory-generation **contracts** ship as a seam (`MeetingMemoryGenerator`,
`MeetingMemoryWriter`, and the episode/fact result types); the builder drives
them:

1. **Deterministic episode** (always): one recall anchor per meeting — title,
   span, attendees, sources — `source: meeting:<id>`, tags `meeting` +
   `meeting-day:<date>`, `valid_at` = start. No LLM.
2. **Trust-gated summary + facts** (`summaryMode`): decisions, commitments
   (category `commitment`), and open questions extracted from the fused
   transcript + screen context are designed to flow through the existing trust
   pipeline (`computeTrustScore` + `decideSmart`) with provenance
   `{meetingId, meetingDate, meetingApp, transcriptSources}`. The concrete
   generator that performs this extraction is **pending** (trust-pipeline
   slice); `summaryMode` parses and validates today (`off` / `review` /
   `smart`) but does not yet drive live summary generation.

## Configuration

Shipped and documented in [config-reference.md](config-reference.md); disabled
by default. Every knob is bounds-checked, and the master gate defaults off so
base installs are unchanged.

| Key | Default | Meaning |
|-----|---------|---------|
| `meetings.enabled` | `false` | Master gate. |
| `meetings.appPatterns` | shipped set | Extra meeting-app patterns (additive over Zoom/Teams/Meet/Webex/Slack huddles/FaceTime). |
| `meetings.minOverlapMinutes` | `2` | App-span ∩ audio-window pairing threshold. |
| `meetings.audioOnlyMinMinutes` | `15` | Audio-only detection minimum length. |
| `meetings.mergeGapMinutes` | `2` | Rejoin-after-drop merge gap. |
| `meetings.contextDwellSeconds` | `20` | Screen-context dwell threshold. |
| `meetings.maxContextChars` | `4000` | Screen-context excerpt cap. |
| `meetings.summaryMode` | `smart` | `off` / `review` / `smart` (generation pending trust-pipeline slice). |
| `meetings.sourceTrust` | `0.85` | Provenance trust prior for facts. |
| `meetings.autoApproveTrust` | `0.7` | Smart-mode auto-approve band. |
| `meetings.reviewTrust` | `0.45` | Smart-mode review band. |

## Surfaces & wiring — pending (#2123)

These are not yet available; they land with the stacked surface PR:

- **Day-source adapter** — the production `MeetingsDaySource` that feeds
  `MeetingsBuilder` from stored activity + wearable days.
- **Post-sync build tail-step** — running the builder automatically after a
  wearables/activity sync, so meetings appear without a manual invocation.
- **CLI / MCP / HTTP surfaces** — `remnic meetings list/show/build` and the
  matching MCP/HTTP endpoints. (The `meetings` command is not registered in the
  `remnic` CLI yet.)
- **Namespace symmetry** — activity is machine-scoped (default namespace only);
  wearable sources, meeting records, and meeting memories are caller-namespaced.

## Degradation matrix (full engine, once wired)

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
  meeting fusion and memory stages reuse.
