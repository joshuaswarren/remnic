# @remnic/connector-limitless

Limitless.ai Pendant connector for [Remnic](https://github.com/joshuaswarren/remnic).
Pulls your Pendant lifelogs into Remnic's wearable-transcript pipeline:
cleaned, speaker-labeled, redacted, searchable day transcripts — and,
under per-source trust gates, memories.

This is an **à-la-carte optional companion** of `@remnic/core`. The base
install never pulls it in; install it only if you wear a Pendant:

```bash
npm install -g @remnic/connector-limitless
```

Remnic discovers it at runtime. No further registration is needed.

## Setup

1. Create an API key in the Limitless app: **Developer settings →
   Create API Key**.
2. Provide the key via environment variable (preferred) or config:
   - `LIMITLESS_API_KEY` (or `REMNIC_LIMITLESS_API_KEY`)
   - or `wearables.sources.limitless.apiKey` in the plugin config
3. Enable the source:

```jsonc
{
  "wearables": {
    "enabled": true,
    "sources": {
      "limitless": {
        "enabled": true,
        "memoryMode": "review"   // off | review | auto — review is the default
      }
    }
  }
}
```

4. Sync:

```bash
remnic wearables check limitless     # verify the key
remnic wearables sync --source limitless --days 7
remnic wearables transcript --date 2026-06-10
```

## What it pulls

- Pendant **lifelogs** via `GET /v1/lifelogs` (day-windowed, cursor
  pagination, `includeContents` for the diarized segments).
- Dialogue comes from `blockquote` content nodes. The wearer is
  pre-identified by the API (`speakerIdentifier: "user"`); other
  speakers carry Limitless display names ("Speaker 2" or saved names)
  and can be renamed once via
  `remnic wearables speakers set limitless "Speaker 2" "Jane Doe"` —
  the label applies to every stored transcript going forward.

The Limitless API is in beta and currently exposes Pendant data only
(no web/desktop meetings). Rate limits (180 req/min) are respected with
automatic retry honoring the API's `retryAfter`.

## Trust gating (worth reading)

Limitless transcription quality varies; the default `memoryMode:
"review"` means **no memory enters active recall without your
approval** — extraction candidates land in the review queue. Tighten or
loosen per source with `minConfidence`, `minImportance`,
`maxMemoriesPerDay`, or `memoryMode: "auto"`.

Full documentation: [docs/wearables.md](https://github.com/joshuaswarren/remnic/blob/main/docs/wearables.md).

## Programmatic use

```ts
import { createLimitlessConnector, LimitlessClient } from "@remnic/connector-limitless";
```

The package also exports the raw `LimitlessClient` (typed lifelog
shapes, pagination, retry) for standalone use.

## License

MIT
