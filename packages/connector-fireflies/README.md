# @remnic/connector-fireflies

Fireflies.ai meeting-transcript connector for [Remnic](https://github.com/joshuaswarren/remnic).

Pulls your Fireflies meeting transcripts into Remnic's wearables pipeline as
source `fireflies`: day transcripts at `<memoryDir>/wearables/fireflies/<date>.md`,
searchable via `remnic wearables search`, with trust-gated memories exactly like
the pendant connectors.

> **Cloud-service caveat.** These transcripts were produced by Fireflies' cloud
> ASR. Remnic ingests them but cannot make them retroactively local — set
> expectations accordingly. No transcript leaves your machine again; Remnic only
> reads.

## Install

À-la-carte — install alongside `@remnic/core` only if you use Fireflies:

```sh
npm install -g @remnic/connector-fireflies
```

Installing `@remnic/core` alone never pulls this in; core discovers it at
runtime. If it is not installed, `remnic wearables` reports a clean install hint.

## API key

Create a key in the Fireflies app under **Settings → Developer settings**, then
provide it via (checked in order):

| Environment variable | |
|---|---|
| `REMNIC_FIREFLIES_API_KEY` | preferred |
| `FIREFLIES_API_KEY` | provider-conventional |

…or the config value `wearables.sources.fireflies.apiKey` (takes precedence).
The config value wins over the environment. On launchd/systemd daemons, remember
the process environment is isolated — set the key in the unit, not just a shell.

## Configure

```jsonc
{
  "wearables": {
    "sources": {
      "fireflies": {
        "enabled": false,          // OFF until you turn it on
        "memoryMode": "smart",     // off | review | auto | smart
        "sourceTrust": 0.85
      }
    }
  }
}
```

`enabled` defaults to `false`; nothing syncs until you set it `true`. Enabling
Fireflies neither enables nor syncs any other source.

## Verify

```sh
remnic wearables check fireflies     # ok / bad-key / unreachable
remnic wearables sync --source fireflies --date 2026-03-10
remnic wearables search "roadmap"
```

## What it does

- Queries `transcripts(fromDate, toDate)` on `https://api.fireflies.ai/graphql`
  for the local day (IANA timezone decides day bounds, DST-aware, half-open
  `[start, end)`).
- Maps each transcript's `sentences` to diarized segments, converting the
  per-sentence second-offsets to absolute UTC using the meeting start.
- Meetings that expose a summary but no transcript become a single `note`
  segment — still day-anchored recall material.
- Speaker names come through as provider labels; the wearables speaker registry
  owns final naming (`remnic wearables speakers set fireflies "Speaker 1" "Jane"`).

## License

MIT
