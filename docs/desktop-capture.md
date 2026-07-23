# Desktop capture — on-screen activity, desktop audio & meeting intelligence

Desktop capture is the umbrella (issue #1896) for turning a workstation's own
signals — on-screen text, microphone and system audio, and cloud meeting
transcripts — into searchable daily context and detected meetings, using the
same provider-agnostic, à-la-carte, fixture-testable design as the
[wearable connectors](wearables.md).

This document describes the **whole** epic and marks precisely what has shipped
versus what is a binding-but-unbuilt design, so a reader never assumes an
unbuilt surface exists. Remnic is a **memory system, not a DVR**: it captures
*text* (accessibility-tree text, OCR output, transcripts) plus context (app,
window title, URL, timestamps, speakers). It keeps **no continuous screenshot or
audio timeline** by default: raw media is transient processing input, deleted
after text extraction unless you set the opt-in `rawRetentionHours > 0`
re-transcription debugging buffer (see the privacy charter below).

## Status at a glance

| Slice | Issue | State |
|-------|-------|-------|
| Activity store + day-digest foundation | #1899 | **shipped** (`@remnic/core`, `src/activity/`) |
| Meeting detector (pure functions) | #1900 | **shipped** (`@remnic/core`, `src/meetings/`) |
| Cloud meeting connectors: Granola, Fireflies | #1898 | **shipped** (`@remnic/connector-granola`, `@remnic/connector-fireflies`) |
| Cloud meeting connector: Otter (+ Plaud) | #1898 | planned |
| `@remnic/capture-screen` daemon (`--replay`) | #1899 | planned |
| Activity `extractionMode: smart` + judge hardening | #1899 | planned |
| Screen native macOS helper (ScreenCaptureKit/Vision/AX) | #1899 | planned, hardware-gated |
| `@remnic/capture-audio` (spool + daemon + HTTP, `--replay`) | #1897 | planned |
| STT + VAD + model download + janitor | #1897 | planned |
| Diarization + speaker clusters + enroll-self + dedup | #1897 | planned |
| Meeting fusion + record store + CLI | #1900 | planned |
| Episode memories + MCP/HTTP surfaces | #1900 | planned |
| Audio native macOS helper | #1897 | planned, hardware-gated |

The capture **daemons, their config gates, CLIs, and HTTP APIs are not yet
merged.** The architecture below is *binding* (decided on #1896; implementation
issues may not relitigate it), but where a surface is marked planned it does not
exist in the published packages yet. "Hardware-gated" slices additionally
require a macOS/Windows build+sign+on-device-permission environment and cannot
be built or verified on a headless host.

## Design principles (shared with wearables)

1. **Provider-agnostic core.** `@remnic/core` owns the data model, storage,
   digest rendering, and detection. No host SDK dependency, no native bindings,
   no capture code (see the Architecture Boundaries section in `AGENTS.md`).
2. **À-la-carte capture.** Capture daemons ship as separate optional packages
   (`@remnic/capture-screen`, `@remnic/capture-audio`) loaded lazily via
   computed-specifier dynamic import; a base install
   (`npm install @remnic/core` or `@remnic/cli`) works with zero capture
   packages present and a missing package produces a clean install hint, never a
   `MODULE_NOT_FOUND`.
3. **Fixture-first, CI-verifiable.** Every daemon exposes a `--replay` mode that
   drives it from recorded fixtures, so the pipeline is testable without a
   camera, microphone, or screen. Fixtures are synthetic (public-repo policy: no
   real conversation data).
4. **Day-anchored, searchable, never auto-recalled.** Rendered day artifacts
   live under the memory directory inside the QMD collection root but outside the
   memory scan roots — searchable on demand, never injected automatically.

## Privacy charter (binding, every phase)

These are non-negotiable design commitments from #1896. They constrain every
capture slice; each slice references them by name (for example
"charter: default-off").

1. **Default-off, double opt-in.** Screen and audio capture are OFF by default
   and turn on only after **two** deliberate acts: (a) installing and starting
   the capture daemon on the machine being captured, AND (b) setting the config
   gate (`activity.enabled: true` for screen, `wearables.sources.desktop.enabled:
   true` for audio). Either act alone captures nothing into memory. No install,
   upgrade, host adapter, or preset may flip these gates.
2. **Feature independence.** Desktop audio, screen activity, each cloud connector,
   meeting intelligence, and each memory-extraction mode are separate switches
   with their own defaults; enabling one never implicitly enables another. A
   disabled feature reports "disabled" on every surface (CLI/MCP/HTTP) rather
   than half-working. Caveat on *memory* defaults: this initiative's new capture
   features default memory creation off (screen `extractionMode: off`; the
   desktop audio example uses `memoryMode: off`), but the existing shipped
   wearable/cloud sources (Limitless/Bee/Omi/Granola/Fireflies) default
   `memoryMode: "smart"`, so enabling one of those does create trust-gated
   memories unless you set its `memoryMode` to `off`.
3. **No raw-media persistence by default.** Audio chunks and any screenshots are
   deleted after text extraction. An optional retention buffer
   (`rawRetentionHours`, default `0`) exists only for re-transcription debugging.
4. **Capture-time deny-lists** — app names, window-title glob patterns, and URL
   patterns are enforced *before* anything reaches the spool. Sensible defaults
   ship (password managers such as 1Password/Bitwarden/KeePass; private-browsing
   windows).
5. **Secure text fields are never captured** — the OS accessibility layer marks
   password/secure fields (macOS `AXSecureTextField`, Windows UIA `IsPassword`)
   and the capture layer skips them.
6. **Redaction before disk** — the wearables redaction stage (built-in SSN /
   payment-card patterns plus your `redactionPatterns`) runs on captured
   transcript text during cleanup, before the day transcript and digest are
   written to `memoryDir`, and the capture daemons redact at spool-write time so
   raw captured text is not persisted unredacted (a binding design contract for
   the unbuilt daemons). The guarantee covers day transcripts and digests; it
   does **not** yet cover provider-native imported facts (Bee/Omi via
   `importNativeMemories`), which today write their content to `memoryDir`
   without the redaction pass — enable that path only for sources you trust.
7. **Zero telemetry** — no analytics, no crash reporting, no network calls
   except the ones you configured. STT model downloads happen only on explicit
   invocation.
8. **Memory creation is separately gated.** Transcript/digest storage and memory
   extraction are independent switches. Screen-derived memory extraction
   defaults to *off* even when capture is on, because screen text includes other
   people's content (emails you read, docs colleagues shared).

## Capture daemon & local spool model (design)

The machine being captured may not be the machine running the Remnic
daemon/gateway, so each capture package ships a **standalone long-running
daemon** rather than a library call:

- The daemon persists to a **local spool** (SQLite) under `~/.remnic/capture/`
  on the capture machine — never under `memoryDir`. The spool is
  capture-machine-local raw material; `memoryDir` holds only pipeline output.
  Durable memory artifacts stay plain Markdown (the repo-wide guarantee in
  [`README.md`](../README.md)); SQLite here is operational/index data only (this
  spool and `state/activity.sqlite`), never a memory store.
- The daemon exposes a **minimal versioned HTTP API on loopback** (`/v1/health`,
  `/v1/conversations`, `/v1/snapshots`, …). Remnic consumes it exactly the way
  `@remnic/connector-bee` consumes the local `bee proxy` — that is the in-repo
  precedent for "a connector reads a local daemon".
- **Default ports: `4340` (audio), `4341` (screen)**, both configurable. Neither
  collides with the Remnic HTTP daemon default (`4318`, see
  `docs/config-reference.md`).
- **Auth & transport:** a bearer token is auto-generated at first start and
  stored at `~/.remnic/capture/token` with `0600` permissions. Rotate it by
  stopping the daemon and deleting the token file — a fresh token is generated
  on next start and clients must be re-pointed. The token authenticates but does
  **not** encrypt, so the daemon binds **loopback only** by default. A
  non-loopback bind requires an explicit `--listen` flag and MUST be fronted by
  an encrypted transport you supply (a TLS-terminating reverse proxy, or an SSH
  tunnel); plaintext capture text and the token must never cross a network
  unprotected.

The wearables side consumes desktop audio through the ordinary
`WearableSourceConnector` contract (source id `desktop`), so the entire existing
pipeline — cleanup, redaction, corrections, speaker labeling, day store,
trust-gated memory — applies with no change to pipeline semantics. A pendant
*and* the desktop hearing the same meeting yields free cross-device
corroboration (the existing `+0.15` trust signal; see [wearables](wearables.md)).

## UTC & retention behavior

- **Timestamps are UTC everywhere** — spool rows, API payloads, day-store
  frontmatter, and memory attributes all use UTC ISO-8601
  (`2026-07-15T14:03:22.000Z`). Day bucketing converts to the configured IANA
  timezone exactly the way wearables already does. Time-range filters use
  half-open `[start, end)` intervals. Remnic deliberately rejects rewriting API
  timestamps to machine-local time in middleware — a documented footgun.
- **Spool is a buffer, not an archive.** Raw WAV/frame files are deleted once a
  chunk is transcribed (unless `rawRetentionHours > 0`). A janitor prunes
  segments/conversations older than `spoolRetentionDays` (default `30`). The
  durable copy is the Remnic day store. Note that day transcripts and rendered
  digests do **not** auto-age: the [retention policy](retention-policy.md)
  tiers and purges *memory files*, not these day artifacts, and the activity
  store exposes only a `pruneOlderThan` snapshot-row helper — so captured day
  files persist until you delete them (the wearables pipeline leaves an existing
  day transcript in place and expects manual removal).

## Platform support & degradation

Priority order: **macOS (Apple Silicon) first** (best accessibility APIs,
primary user base), **Windows second**, **Linux best-effort** (OCR-only screen
path is acceptable). Native helpers ship as platform-specific optional packages
(`@remnic/capture-native-darwin-arm64`, …) resolved at runtime with an
actionable install hint on miss.

Every capture package must **degrade cleanly**: on an unsupported platform the
daemon refuses to start with a clear message and everything else in Remnic is
unaffected. A missing STT binary, model file, or native helper produces an
install hint, never a crash or a silent no-op.

## Shipped — activity subsystem (`src/activity/`, #1899)

The on-screen activity subsystem captures periodic screen snapshots (text +
window/app context) into a durable per-machine store and renders a deterministic
day digest. The library is shipped in `@remnic/core`; the capture daemon that
*feeds* it and the `activity.enabled` config gate are planned (see the status
table).

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

## Shipped — cloud meeting connectors (#1898)

Two cloud meeting sources ship today as à-la-carte wearable connectors. They
ingest transcripts a cloud service already produced (they cannot make them
retroactively local) and run through the standard wearables pipeline, including
trust-gated memory:

- **Granola** (`@remnic/connector-granola`) — cloud meeting notes + transcripts;
  requires a Granola Business/Enterprise plan.
- **Fireflies** (`@remnic/connector-fireflies`) — cloud meeting transcripts via
  the GraphQL API.

Auth, per-source config, and behavior are documented alongside the other sources
in [wearables](wearables.md#per-source-notes). The Otter connector (and a Plaud
investigation) is planned under #1898 and not yet published.

## Pipeline boundaries

Three ingestion paths feed different stores; they connect only at meeting
detection:

| Path | Produces | Store | Becomes memories? |
|------|----------|-------|-------------------|
| **Screen activity** (planned daemon → shipped `src/activity/`) | screen text + app/window context | `<memoryDir>/state/activity.sqlite` + `<memoryDir>/activity/<date>.md` | opt-in, default off |
| **Desktop audio** (planned `@remnic/capture-audio`, source `desktop`) | diarized transcripts | `<memoryDir>/wearables/desktop/<date>.md` | trust-gated (wearables pipeline) |
| **Cloud meeting connectors** (shipped) | provider transcripts | `<memoryDir>/wearables/<source>/<date>.md` | trust-gated (wearables pipeline) |
| **Meeting intelligence** (detector shipped; fusion planned) | detected/fused meetings | `<memoryDir>/meetings/<date>/<id>.md` (fusion slice) | trust-gated summary + facts |

Raw audio/frames and the capture spool (text) live only on the capture machine
and are never indexed by QMD and never become memories. Desktop audio flows into
the *same* wearables pipeline as pendants; screen activity is a distinct
modality with its own FTS5 store; meeting detection reads both.

## Configuration (design — synthetic placeholders)

The gates below are the *binding config contract* the capture slices introduce.
The `activity.*` and `meetings.*` blocks are **not yet parsed** — they are absent
from `docs/config-reference.md` and setting them has no effect until their slice
lands. The `wearables.sources` map, by contrast, is parsed today: see the
warning on the desktop example below before enabling it. Values shown are
synthetic examples.

Screen activity (planned `activity.*` block):

```jsonc
{
  "activity": {
    "enabled": false,                 // charter: default-off — screen capture stays off until set true
    "extractionMode": "off",          // screen-derived memories default off (other people's content)
    "rawRetentionHours": 0,           // delete frames after text extraction
    "spoolRetentionDays": 30,
    "denyApps": ["1Password", "Bitwarden"],
    "denyWindowTitles": ["*Private Browsing*"],
    "denyUrlPatterns": ["https://mail.example.com/*"]
  }
}
```

Desktop audio (planned entry under the existing open `wearables.sources` map;
all standard `WearableSourceSettings` fields apply). **Do not enable the
`desktop` source yet.** `wearables.sources` is parsed today and the service
treats every enabled source as a sync target, but no `desktop` connector is
registered until `@remnic/capture-audio` ships. Enabling it now (master gate +
`sources.desktop.enabled: true`) makes `remnic wearables sync` fail with a
missing-connector install hint, not do nothing. Keep it `false` until the slice
lands; the block below is the shape it will take:

```jsonc
{
  "wearables": {
    "enabled": true,                            // master wearables gate (default false); sync refuses without it
    "sources": {
      "desktop": {
        "enabled": false,                       // charter: default-off + double opt-in
        "baseUrl": "http://127.0.0.1:4340",     // the local capture-audio daemon
        "apiKey": "REPLACE_WITH_TOKEN",         // parsed credential slot; else REMNIC_CAPTURE_AUDIO_TOKEN or the local token file
        "memoryMode": "off",                    // transcripts only; smart memory is a separate opt-in (charter: independent switches)
        "sourceTrust": 0.85
      }
    }
  }
}
```

Meeting intelligence (planned `meetings.*` block):

```jsonc
{
  "meetings": {
    "enabled": false                  // fusion + record store + memories, all gated here
  }
}
```

## Installation hints

Base installs never pull a capture or connector package. Install only what you
want (`-g` for a global CLI install):

```bash
# Shipped today — cloud meeting connectors
npm install -g @remnic/connector-granola @remnic/connector-fireflies
```

The planned capture daemons — `@remnic/capture-screen` (screen activity) and
`@remnic/capture-audio` (desktop audio) — are **not yet published**. Their names
are fixed by #1896 as design placeholders, so no `npm install` command is given
for them until they ship.

Native helper binaries (planned) install as platform-specific optional packages
(for example `@remnic/capture-native-darwin-arm64`); the daemon prints the exact
`npm install` command when the matching helper is absent.

## Storage layout

```text
~/.remnic/capture/                 # capture machine only (planned daemons)
├── token                          # 0600 bearer token
├── audio.sqlite / screen.sqlite   # local spool (text; not QMD-indexed, never memories)
└── models/                        # STT models (explicit download only)

<memoryDir>/                       # Remnic host
├── state/
│   └── activity.sqlite            # ActivityStore (snapshots, FTS, sync cursors) — shipped
├── activity/
│   └── <date>.md                  # rendered day digest (QMD-searchable) — shipped
├── wearables/
│   └── desktop/<date>.md          # desktop audio day transcript (planned)
└── meetings/
    └── <date>/<id>.md             # meeting records (fusion slice, planned)
```

All `memoryDir` markdown follows the house style (YAML frontmatter, contentHash
idempotency, outside the memory scan roots but inside the QMD collection root).

## Both shipped subsystems are reachable from the package root

```ts
import { ActivityStore, composeActivityDigestBody, detectMeetings } from "@remnic/core";
```

## References

- [Wearable transcripts](wearables.md) — the sibling design and the pipeline
  desktop audio and cloud meeting connectors reuse.
- [Config reference](config-reference.md) — current settings (the capture gates
  above are added as their slices land).
- [Connectors CLI](connectors.md) and [live connectors](live-connectors.md) —
  the operator surface for scheduled ingest.
- [Retention policy](retention-policy.md) — hot/cold tiering and purging of
  *memory files* (not the day transcripts/digests, which persist until removed).
- [Architecture index](architecture/README.md) and `AGENTS.md` — architecture
  boundaries and the `activity/` + `meetings/` core-subsystem notes.
