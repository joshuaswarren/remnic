# Wearable transcripts — Limitless, Bee, and Omi connectors

Remnic can ingest the conversations your AI wearable records, turn them
into clean, searchable day transcripts, and — under strict, per-source
trust gates — into memories.

Three connectors ship as à-la-carte optional packages:

| Source | Package | Device | Native memory import |
|---|---|---|---|
| `limitless` | `@remnic/connector-limitless` | Limitless Pendant | — |
| `bee` | `@remnic/connector-bee` | Bee bracelet (Amazon) | Bee "facts" |
| `omi` | `@remnic/connector-omi` | Omi necklace | Omi "memories" |

Installing `@remnic/core` (or `@remnic/cli`) alone never pulls a
connector in. Install only what you wear:

```bash
npm install -g @remnic/connector-limitless
# and/or
npm install -g @remnic/connector-bee @remnic/connector-omi
```

Core discovers installed connectors at runtime via computed-specifier
dynamic imports; a missing package produces a clean install hint, never
a `MODULE_NOT_FOUND`.

## The pipeline

Every sync runs the same provider-agnostic pipeline per source:

```
pull → off-the-record elision → cleanup → redaction → corrections
     → speaker labeling → day-transcript store → (optional) memories
```

1. **Pull** — fetch the day's conversations from the provider API
   (cursor/offset pagination, retry with backoff on rate limits).
2. **Cleanup** — deterministic, zero-LLM normalization: merge
   fragmented same-speaker utterances, strip filler tokens (`um`,
   `uh`, ...), collapse ASR stutters ("I I I think" → "I think";
   digit sequences are never collapsed), and drop garbage segments.
3. **Redaction** — SSN and payment-card patterns are replaced with
   `[redacted]` *before anything touches disk*; add your own regexes
   via `wearables.redactionPatterns`. Optionally honor a spoken
   "off the record" → "back on the record" span
   (`wearables.offTheRecordEnabled`).
4. **Corrections** — your personal fix-ups for words ASR keeps getting
   wrong (product names, people, jargon). Rules come from config and
   from `remnic wearables corrections add`.
5. **Speaker labeling** — provider diarization labels resolve through a
   persistent registry: provider-identified wearers render as
   "Your Name (you)"; opaque labels ("0", "SPEAKER_01", "Speaker 2")
   can be mapped to real names once and apply everywhere.
6. **Day-transcript store** — one markdown file per source per day at
   `<memoryDir>/wearables/<source>/<YYYY-MM-DD>.md` with YAML
   frontmatter. Files are rebuilt idempotently; unchanged days skip
   rewriting and re-extraction. Transcripts are full-text searchable
   (the memory dir's QMD collection indexes them) but **never** appear
   as memories — the directory sits outside the memory scan roots.
7. **Memories (trust-gated)** — see below.

## Trust-gated memory creation

Wearable ASR is noisy — a mis-transcription must not become a "fact"
about your life. But forcing a human to review every memory defeats the
point of an always-on recorder. The default mode automates the judgment
the way production memory systems do:

| `memoryMode` | Behavior |
|---|---|
| `smart` (default) | Fully automated trust pipeline (below). High-trust facts are written active; borderline facts go to the review queue; low-trust facts are dropped. |
| `off` | Transcripts only. Never creates memories. |
| `review` | Every extracted candidate is written `pending_review` — nothing enters active recall until approved. For operators who want a human in the loop. |
| `auto` | Deterministic gates only; survivors written active (no judge, no trust scoring). |

### How smart mode decides

Each extracted candidate gets a **trust score** assembled from signals
that state-of-the-art memory systems use for noisy ingest:

1. **LLM-as-judge** — every candidate runs through Remnic's existing
   extraction judge (`judgeFactDurability`, the same LLM gate the live
   conversation pipeline uses, including its verdict cache and defer
   counters). `reject` drops the fact outright; `defer` routes it to
   the review queue; `accept` boosts trust (+0.15).
2. **Provenance prior** — extraction confidence is multiplied by the
   source's `sourceTrust` (0..1, default 0.8). A device that
   mis-transcribes often gets a lower prior, so its facts need more
   independent support to auto-approve (provenance-weighted fusion).
3. **Cross-device corroboration** — if another wearable's transcript
   for the *same day* covers the same content (token-coverage
   similarity via the shared recall tokenizer; no extra LLM cost), the
   fact gets +0.15 and records which sources agreed. Two microphones
   mishearing identically is far less likely than one.
4. **Existing-memory support** — a fact consistent with an existing
   active memory gets +0.10 and records the supporting memory id
   (self-consistency with the corpus you already trust).

The score maps to a three-way decision:

```
trust >= autoApproveTrust (0.7)  -> written ACTIVE
trust >= reviewTrust      (0.45) -> written pending_review
below                            -> dropped
```

Every written memory persists its evidence — `trustScore`,
`trustDecision`, `judgeVerdict`, `corroboratedBySources`,
`supportingMemoryId` — in `structuredAttributes`, and the trust score
becomes the memory's `confidence`. From there Remnic's standing trust
machinery keeps calibrating: memory-worth outcome counters
(`mw_success`/`mw_fail`) learn from retrieval outcomes, pattern
reinforcement promotes repeatedly-observed facts, temporal supersession
and contradiction scans retire facts that stop being true. Wearable
memories enter the same lifecycle as everything else — smart mode just
decides how they arrive.

**Late-arriving evidence re-scores earlier decisions.** When another
source writes a transcript for a day, sibling sources re-run their
memory pass for that day, and duplicates of earlier writes are
re-scored with today's evidence:

- A `pending_review` row whose re-score now clears `autoApproveTrust`
  is **promoted** to active in place (`trustDecision:
  promoted-by-corroboration`) — the second device corroborating is
  exactly the signal the review queue was waiting for.
- A `pending_review` row that now draws an explicit judge **reject** is
  **demoted** to `rejected` (`trustDecision: demoted-by-rejection`) and
  leaves the review queue.
- **Active rows are never auto-demoted.** An operator approval or a
  memory's accrued recall signals must not be overturned by one later
  LLM verdict; contradiction scans and temporal supersession own
  active-row retirement. A score-based drop (below `reviewTrust`
  without a reject verdict) also leaves existing rows alone — absence
  of corroboration is weaker evidence than an explicit rejection.

If no judge is available in a context (no LLM configured), smart mode
degrades gracefully to confidence × prior + corroboration and says so
in the sync warnings.

Deterministic gates still apply in every creating mode:

- `minImportance` (default `low`) — drop trivia via the local
  importance scorer.
- Content-hash dedup against existing memories and within the run
  (applied before the day cap so duplicates never consume cap slots).
- `maxMemoriesPerDay` (default `0` — uncapped) — optional ceiling for
  operators who want one; when set, keeps the highest-trust candidates
  in smart mode, highest-importance otherwise. The smart trust pipeline
  is the quality gate, so busy days don't silently drop real memories.
- `minConfidence` (default 0.6) applies in `review`/`auto` modes; in
  smart mode the trust bands subsume it so borderline facts can reach
  the review queue instead of vanishing.

Every created memory carries provenance: `source: wearable:<id>`,
tags (`wearable`, `wearable:<id>`, `wearable-day:<date>`), and
structured attributes (`wearableSource`, `wearableDate`,
`wearableConversationId`), with `valid_at` pinned to the conversation
start. If a bad memory does slip through, the transcript day it came
from is one query away.

**Provider-native memories** (Bee facts, Omi memories) import through
the same trust pipeline by default (`importNativeMemories: "smart"`)
with a reduced prior (`sourceTrust × 0.9`) — provider extraction
quality is outside Remnic's control, so their facts need a bit more
support to auto-approve. `"review"` queues everything; `"off"` skips.

**Daily digest** (`wearables.digestEnabled`, on by default) writes one
deterministic episode memory per synced day ("3 recorded
conversations: ...") so day-level recall has an anchor. Digests follow
the source's `memoryMode` status gate and are skipped entirely when it
is `off`.

## Configuration

```jsonc
{
  "wearables": {
    "enabled": true,
    "timezone": "America/Chicago",          // default: host timezone
    "redactionEnabled": true,                // default true
    "redactionPatterns": ["internal-codename-\\w+"],
    "offTheRecordEnabled": true,          // default true
    "digestEnabled": true,                 // default true
    "autoSyncEnabled": true,               // default true (long-lived hosts)
    "autoSyncIntervalMinutes": 15,         // tick cadence
    "autoSyncDays": 2,                     // window per tick (today + yesterday)
    "autoSyncDeepDays": 7,                 // daily deep pass; 0 disables
    "corrections": [
      { "match": "remnick", "replace": "Remnic" },
      { "match": "acme corp", "replace": "ACME Corp", "sources": ["limitless"] }
    ],
    "sources": {
      "limitless": {
        "enabled": true,
        "memoryMode": "smart",               // smart (default) | off | review | auto
        "sourceTrust": 0.8,                  // transcription-quality prior (0..1)
        "autoApproveTrust": 0.7,             // trust >= this -> written active
        "reviewTrust": 0.45,                 // trust >= this -> review queue
        "minImportance": "low",              // trivial|low|normal|high|critical
        "maxMemoriesPerDay": 0                // 0 (default) = uncapped
      },
      "bee": {
        "enabled": true,
        "baseUrl": "http://127.0.0.1:8787"   // bee proxy (default)
      },
      "omi": {
        "enabled": true,
        "appId": "your-omi-app-id",
        "userId": "your-omi-uid"
      }
    }
  }
}
```

Credentials prefer environment variables over config values:

| Source | Environment variables (checked in order) |
|---|---|
| limitless | `REMNIC_LIMITLESS_API_KEY`, `LIMITLESS_API_KEY` |
| bee | `REMNIC_BEE_API_TOKEN`, `BEE_API_TOKEN` (not needed in proxy mode) |
| omi | `REMNIC_OMI_API_KEY`, `OMI_API_KEY` |

Remember the gateway runs under launchd with an isolated environment —
API keys must be in the plist `EnvironmentVariables` (or in config).

## CLI

Available both as `remnic wearables ...` and
`openclaw engram wearables ...` (identical behavior — one shared
implementation):

```bash
remnic wearables status                    # sources, connectors, last sync
remnic wearables check limitless           # verify credentials
remnic wearables sync                      # today + yesterday, all enabled sources
remnic wearables sync --source limitless --date 2026-06-10
remnic wearables sync --days 7             # backfill a week
remnic wearables sync --force-memories     # re-extract unchanged days
remnic wearables transcript --date 2026-06-10
remnic wearables search "solar quote" --source limitless --from 2026-06-01
remnic wearables memories --source limitless --date 2026-06-10
remnic wearables speakers self "Alex"
remnic wearables speakers set bee 0 "Alex" --self
remnic wearables speakers set limitless "Speaker 2" "Jane Doe"
remnic wearables corrections add "remnick" "Remnic"
remnic wearables corrections list
```

Continuous syncing is built in: long-lived hosts (the gateway, the
HTTP daemon) start an in-process **auto-sync** scheduler by default
(`wearables.autoSyncEnabled`, on). Every `autoSyncIntervalMinutes`
(default 15) it re-syncs the last `autoSyncDays` (default 2) for all
enabled sources — existing day files included, so today's transcript
keeps growing while the wearable records. Once per local day the
window deepens to `autoSyncDeepDays` (default 7) to pick up late
uploads and provider re-processing (phones syncing hours later,
re-diarized transcripts). Syncs are incremental and idempotent —
unchanged days are skipped by content hash, so a quiet tick is
read-only. Day fetches are never page-capped: a long recorded day
paginates to completion (runaway providers are stopped by
cursor-cycle detection, not by truncating real data).

The manual CLI stays useful for one-shot contexts, instant refreshes
(`remnic wearables sync`), and deep backfills (`--days 90`).

## MCP tools

Anything that talks to Remnic over MCP (agents, Claude, Codex) gets:

| Tool | Purpose |
|---|---|
| `engram.wearables_status` | Source/connector/sync status |
| `engram.wearables_sync` | Trigger a sync (`source?`, `date?`, `days?`, `forceMemories?`) |
| `engram.transcript_day` | Full day transcript(s) (`date`, `source?`) with cross-source overlap hints |
| `engram.transcript_search` | Search stored transcripts (`query`, `source?`, `from?`, `to?`, `limit?`) |
| `engram.transcript_memories` | Memories created from transcripts (`source?`, `date?`, `limit?`), including pending-review candidates |

(Each tool also has the `remnic.*` alias.)

## HTTP API

| Route | Purpose |
|---|---|
| `GET /engram/v1/wearables/status` | Status |
| `POST /engram/v1/wearables/sync` | Sync (JSON body: `source?`, `date?`, `days?`, `forceMemories?`) |
| `GET /engram/v1/wearables/transcript?date=&source=` | Day transcript(s) |
| `GET /engram/v1/wearables/transcripts/search?q=&source=&from=&to=&limit=` | Transcript search |
| `GET /engram/v1/wearables/memories?source=&date=&limit=` | Wearable-derived memories |

`/remnic/v1/...` aliases exist for every route. Validation errors return
400 with a message; backend faults return 500.

## Search semantics

Transcript search uses the indexed backend (QMD) when available and
falls back to a bounded newest-first text scan otherwise. Results are
labeled with which backend served them (`indexed` vs `scan`) so callers
can tell "no matches" apart from "weaker search ran". Day files index
on the next QMD update after a sync (the sync triggers one).

## Privacy posture

- Transcripts live in your memory directory, inherit at-rest encryption
  when the secure store is enabled, and are never exposed as memories.
- Built-in redaction is **on by default** and runs before persistence
  and before extraction — redacted text never exists on disk.
- Provider API keys are never logged and never appear in error
  messages.
- `wearables.enabled` defaults to `false`; every source additionally
  defaults to `enabled: false`. Once enabled, memory creation runs the
  fully-automated smart trust pipeline by default.

## Per-source notes

### Limitless (`@remnic/connector-limitless`)

- Auth: `X-API-Key` from Developer settings in the Limitless app.
- Pulls Pendant lifelogs day-by-day (the API's cursor pagination, max
  10 per page) and reads dialogue from `blockquote` content nodes.
- The wearer arrives pre-identified (`speakerIdentifier: "user"`);
  other speakers carry Limitless display names which you can remap via
  the speaker registry.
- Rate limit 180 req/min is respected with retry + backoff honoring
  the API's `retryAfter`.

### Bee (`@remnic/connector-bee`)

- The original public API (`api.bee.computer`) was retired after the
  Amazon acquisition. The connector targets the current developer
  surface: by default the **local Bee proxy** (`bee proxy`, default
  `http://127.0.0.1:8787`, no token needed); set `baseUrl` +
  `BEE_API_TOKEN` for direct access.
- Conversations paginate by cursor; utterances carry opaque diarization
  labels ("0", "1") — map them once with
  `remnic wearables speakers set bee 0 "You" --self`.
- `importNativeMemories: "review"` imports Bee's own extracted facts
  into the review queue.

### Omi (`@remnic/connector-omi`)

- Auth: create an app with the External Integration capabilities
  (`read_conversations`, `read_memories`) in the Omi app, generate an
  `sk_...` API key, and configure `appId` + `userId` (your uid).
- Conversations are fetched with full transcripts
  (`max_transcript_segments=-1` — the API default silently truncates
  to 100 segments otherwise) and completed status.
- Segments carry `is_user` for the wearer plus `SPEAKER_NN` labels and
  optional person ids; map labels via the speaker registry.
- `importNativeMemories: "review"` imports Omi's "memories" (its
  extracted facts) into the review queue.

## Why this design

- **Connectors are dumb, the pipeline is shared.** Every provider gets
  identical cleanup, redaction, corrections, gating, and storage —
  fixing a pipeline bug fixes all three sources.
- **Automated trust, human-priced exceptions.** The smart pipeline
  auto-approves what the judge, the source prior, and corroboration
  agree on; only genuinely borderline facts cost a review-queue click,
  and ASR garbage costs nothing at all.
- **Transcripts ≠ memories.** Day files are a verbatim-ish record you
  can search and re-read; memories are the distilled, gated layer on
  top. Each memory points back at its transcript day.
