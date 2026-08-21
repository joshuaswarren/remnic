# @remnic/connector-granola

Granola meeting-notes connector for [Remnic](https://github.com/joshuaswarren/remnic).

Pulls your Granola meeting notes + transcripts into Remnic's wearables pipeline
as source `granola`: day transcripts at `<memoryDir>/wearables/granola/<date>.md`,
searchable via `remnic wearables search`, with trust-gated memories exactly like
the pendant connectors.

> **Cloud-service caveat.** These notes/transcripts were produced by Granola's
> cloud. Remnic ingests them but cannot make them retroactively local. Requires
> a Granola **Business/Enterprise** plan to create an API key.

## Install

À-la-carte — install alongside `@remnic/core` only if you use Granola:

```sh
npm install -g @remnic/connector-granola
```

Installing `@remnic/core` alone never pulls this in; core discovers it at
runtime. If it is not installed, `remnic wearables` reports a clean install hint.

## API key

Create a key in the Granola desktop app under **Settings → Connectors → API
keys** (choose the note access scopes). The connector resolves the key in this
order — the **config value takes precedence**, then the environment variables:

1. `wearables.sources.granola.apiKey` (config; wins when set)
2. `REMNIC_GRANOLA_API_KEY` (preferred env var)
3. `GRANOLA_API_KEY` (provider-conventional env var)

On launchd/systemd daemons the process environment is isolated — set the key in
the unit, not just a shell.

## Configure

```jsonc
{
  "wearables": {
    "sources": {
      "granola": {
        "enabled": false,          // OFF until you turn it on
        "memoryMode": "smart",     // off | review | auto | smart
        "sourceTrust": 0.85
      }
    }
  }
}
```

`enabled` defaults to `false`; nothing syncs until you set it `true`. Enabling
Granola neither enables nor syncs any other source.

## Verify

```sh
remnic wearables check granola      # ok / bad-key / unreachable
remnic wearables sync --source granola --date 2026-03-10
remnic wearables search "roadmap"
```

## What it does

- Lists notes for the local day via `GET /v1/notes?created_after=&created_before=`
  (half-open `[start, end)`, DST-aware), then fetches each note's transcript with
  `GET /v1/notes/{id}?include=transcript`.
- Meeting timing prefers the linked calendar event (`scheduled_start/end_time`),
  falling back to the transcript times, then the note's `created_at`.
- Speaker keys come from `speaker.source` (`microphone` = the wearer's own audio,
  `speaker` = other meeting audio) or the iOS `diarization_label`. The wearables
  speaker registry owns final naming.
- The notes list returns summaries; a note's detail record may lack a transcript
  (the field is nullable), so a summary-only note becomes a single `note`
  segment. A note that 404s on the detail fetch is skipped, not fatal.

## License

MIT
