# Meeting intelligence (issue #1900)

`src/meetings/` is a host-agnostic core subsystem that **retrospectively detects,
fuses, stores, and remembers meetings** from already-ingested signals (wearable /
desktop audio conversations + screen activity). It is retrospective, not
realtime: no daemon, no live watcher — a pure derivation over data the audio
(wearable/cloud connectors, #1897/#1898) and screen-activity (#1899) phases
store, so late-arriving uploads still resolve on the next build.

The full pipeline shipped across #2122 (engine) and #2123 (surfaces): detection,
fusion, record store, `MeetingsBuilder`, trust-gated memory generation, the
`meetings.*` config, the `remnic meetings` CLI, MCP tools, HTTP routes, the
day-source adapter, the post-sync auto-build tail-step, and caller-namespace
symmetry. It is disabled by default (`meetings.enabled: false`); base installs
are unchanged.

Input availability: audio-based detection works today with any wearable or
cloud meeting source (Limitless/Bee/Omi and the shipped Granola/Fireflies
connectors). Screen-activity fusion additionally requires the screen capture
source that feeds the activity store (`@remnic/capture-screen`, still pending
under #1899); without it, detection runs audio-only.

## Status at a glance

| Capability | State |
|---|---|
| Detection — `detectMeetings()` (`detect.ts`) | **shipped** (`@remnic/core`) |
| Fusion — shared-wearables `fuseCluster` reuse (`fuse.ts`) | **shipped** |
| Record store — content-hash markdown records (`store.ts`) | **shipped** |
| Orchestration — `MeetingsBuilder` / `buildMeetingRecordsForDay()` (`build.ts`) | **shipped** |
| Memory generation — deterministic episode + trust-gated `summaryMode` summary/facts (`createMeetingMemoryGenerator`) | **shipped** |
| `meetings.*` config parsing (`config.ts`, in `config-reference.md`) | **shipped** |
| Production day-source adapter (activity/wearables) | **shipped** (#2123) |
| Post-sync auto-build tail-step (auto + manual sync) | **shipped** (#2123) |
| CLI — `remnic meetings list/show/build` | **shipped** (#2123) |
| MCP tools — `meetings_list` / `meetings_get` / `meetings_build` | **shipped** (#2123) |
| HTTP routes — `/engram|remnic/v1/meetings[/:id\|/build]` | **shipped** (#2123) |
| Caller-namespace symmetry | **shipped** (#2123) |

## Pipeline

```text
inputs (already on disk, per day):
  wearable/cloud day transcripts   <ns>/wearables/<source>/<date>.md
  screen activity                  <memoryDir>/state/activity.sqlite (default namespace only)
      │  (day-source adapter assembles the day's audio windows + app spans)
      ▼
  detect.ts     detectMeetings() — app-span ∩ audio-window, audio-only, provider
      ▼
  fuse.ts       fuseMeeting() — reuse wearables fuseCluster over the window;
                higher-trust text wins overlaps + corroboratedBy; screen-context
                dwell timeline; attendees from fused speakers
      ▼
  store.ts      <ns>/meetings/<date>/<meeting-id>.md (idempotent, contentHash)
      ▼
  build.ts      MeetingsBuilder — detect → fuse → compose → store, stale-record
                reconcile (overlap-preserving ids), reindex hook
      ▼
  memory-generator  deterministic episode (always) + trust-gated summary/facts
                    via createMeetingMemoryGenerator, on the MeetingMemoryGenerator seam
```

A wearables/activity sync (auto-sync **and** manual CLI/MCP/HTTP sync) triggers
a debounced meetings build for the affected days through an `onDaysSynced` hook,
so meetings appear without a separate command.

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
reconciled by the record store and `MeetingsBuilder` — a re-detected meeting is
matched to its stored record by window overlap, so `show <id>` links stay
stable. Thresholds are validated as finite, non-negative numbers.

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

`<ns>/meetings/<YYYY-MM-DD>/<meeting-id>.md` — YAML frontmatter
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
overlap so ids survive a shifted start, with a reindex hook. It reads its day
data through a `MeetingsDaySource`; the production adapter assembles it from the
stored activity + wearable days for the caller's namespace. One deterministic
recall-anchor episode is written per built record, and (per `summaryMode`) the
trust-gated summary/facts, through the memory generator.

## Memories (`memory-generator.ts`)

`createMeetingMemoryGenerator(createMeetingMemoryWriter(storage), config)` wires
the concrete generator onto the `MeetingMemoryGenerator` seam and the builder
drives it:

1. **Deterministic episode** (always): one recall anchor per meeting — title,
   span, attendees, sources — `source: meeting:<id>`, tags `meeting` +
   `meeting-day:<date>`, `valid_at` = start. No LLM. Idempotent per
   `meeting:<id>`.
2. **Trust-gated summary + facts** (`summaryMode`): decisions, commitments
   (category `commitment`), and open questions extracted from the fused
   transcript + screen context flow through the existing trust pipeline
   (`computeTrustScore` + `decideSmart`) with provenance
   `{meetingId, meetingDate, meetingApp, transcriptSources}`:
   - `off` → episode only; the LLM extractor is never invoked.
   - `review` → every candidate queued `pending_review`.
   - `smart` → judge verdict + trust bands (`autoApproveTrust`/`reviewTrust`)
     route each candidate to active / review / drop; ≥ 2 transcript sources
     corroborate (trust boost). A throwing/absent judge degrades gracefully
     (no verdict; routed via the deterministic path).

## Configuration

Documented in [config-reference.md](config-reference.md); disabled by default.
Every knob is bounds-checked, and the master gate defaults off so base installs
are unchanged.

| Key | Default | Meaning |
|-----|---------|---------|
| `meetings.enabled` | `false` | Master gate. |
| `meetings.appPatterns` | shipped set | Extra meeting-app patterns (additive over Zoom/Teams/Meet/Webex/Slack huddles/FaceTime). |
| `meetings.minOverlapMinutes` | `2` | App-span ∩ audio-window pairing threshold. |
| `meetings.audioOnlyMinMinutes` | `15` | Audio-only detection minimum length. |
| `meetings.mergeGapMinutes` | `2` | Rejoin-after-drop merge gap. |
| `meetings.contextDwellSeconds` | `20` | Screen-context dwell threshold. |
| `meetings.maxContextChars` | `4000` | Screen-context excerpt cap. |
| `meetings.summaryMode` | `smart` | `off` / `review` / `smart`. |
| `meetings.sourceTrust` | `0.85` | Provenance trust prior for facts. |
| `meetings.autoApproveTrust` | `0.7` | Smart-mode auto-approve band. |
| `meetings.reviewTrust` | `0.45` | Smart-mode review band. |

## Surfaces

- **CLI** — `remnic meetings list` (stored records, all days or one `--date`),
  `remnic meetings show <id>` (one record), `remnic meetings build <date>`
  (detect + fuse + store a day), and `remnic meetings help`.
- **MCP tools** — `meetings_list` (all days or one `date`), `meetings_get` (by
  `id`), `meetings_build` (a `date`). Each accepts optional `namespace` /
  `sessionKey`.
- **HTTP** (access server, token-gated) — `GET /engram/v1/meetings` (list),
  `GET /engram/v1/meetings/:id` (get), `POST /engram/v1/meetings/build`. The
  `/remnic/v1/...` prefix is an accepted alias of `/engram/v1/...`.
- **Auto-build** — a wearables/activity sync (auto and manual) rebuilds affected
  days via the `onDaysSynced` hook and the meetings service's debounced
  `requestBuild`.

## Namespace + machine-source boundary

Meetings follow caller-derived namespace symmetry: the caller's resolved
namespace determines where meeting inputs are read and outputs are written,
**except** machine-scoped screen activity, which is global.

- **Caller-namespaced** (per-namespace storage root): wearable source
  transcripts, meeting records (`<ns>/meetings/<date>/<id>.md`), and meeting
  episode/summary memories live under the caller's namespace root. Reads resolve
  through `resolveReadableNamespace`; writes (wearables sync, meetings build)
  through `writableNamespaceFor`. A build reads wearable source + prior records
  from the caller namespace's storage only.
- **Machine-scoped, default-only** (global): screen activity is a single
  machine-global store (`<memoryDir>/state/activity.sqlite`), never migrated
  per-namespace. It is consumed only when the resolved caller namespace is the
  machine-owner (`config.defaultNamespace`). For every non-default caller
  namespace the day-source is built with no activity reader, so detection
  degrades to audio-only.
- **Strict isolation for non-default callers**: a non-default caller reads only
  its own namespace's wearable days and records — no fallback to
  default-namespace wearables, no global activity. A day with only
  default-namespace wearables + global activity yields zero meetings for a
  non-default caller. The default/machine-owner namespace is the only one that
  consumes default-namespace wearables (incl. legacy historical data) and the
  global activity store.

Operator/CLI callers carry the default principal and resolve to
`config.defaultNamespace`, preserving pre-#1900 single-tenant behavior.

## Degradation matrix

| Available data | Behavior |
|---|---|
| activity + audio | full: app+audio detection, screen fusion |
| activity only (no audio) | no meetings (an app span alone is not a meeting) |
| audio only (no activity) | audio-only detection; record without a screen-context section |
| provider transcripts only | provider detection from conversation metadata |
| multiple audio sources | one meeting, fused transcript, corroboration recorded |
| late-arriving source | re-fuse + re-score on the next build (contentHash changes) |
| non-default caller namespace | audio-only (no global activity reader) |
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
