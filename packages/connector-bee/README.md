# @remnic/connector-bee

Bee wearable connector for [Remnic](https://github.com/joshuaswarren/remnic).
Pulls your Bee bracelet conversations into Remnic's wearable-transcript
pipeline: cleaned, speaker-labeled, redacted, searchable day
transcripts — and, under per-source trust gates, memories. Optionally
imports Bee's own extracted "facts" into the review queue.

This is an **à-la-carte optional companion** of `@remnic/core`:

```bash
npm install -g @remnic/connector-bee
```

Remnic discovers it at runtime. No further registration is needed.

## Setup

> **Heads up:** Bee's original public API (`api.bee.computer` with
> `x-api-key`) was retired after the Amazon acquisition. This connector
> targets the current developer surface.

### Option A — local proxy (recommended, zero config)

1. Enable Developer Mode in the Bee app (Settings → tap **Version**
   5 times), then pair the CLI:
   ```bash
   npm install -g @beeai/cli
   bee login
   bee proxy        # serves the developer API on http://127.0.0.1:8787
   ```
2. Enable the source — no token needed:

```jsonc
{
  "wearables": {
    "enabled": true,
    "sources": {
      "bee": {
        "enabled": true,
        "memoryMode": "review",
        "importNativeMemories": "review"   // optional: queue Bee facts for review
      }
    }
  }
}
```

### Option B — direct API access

Set `baseUrl` to the direct host and provide the bearer token from
`bee login` (`~/.bee/token-prod`) via `BEE_API_TOKEN` (or
`REMNIC_BEE_API_TOKEN`, or `apiKey` in config). The direct host uses
Bee's private CA — export `NODE_EXTRA_CA_CERTS` pointing at it.

## Usage

```bash
remnic wearables check bee
remnic wearables sync --source bee --days 7
remnic wearables transcript --date 2026-06-10 --source bee
```

## Speaker labels

Bee exposes opaque diarization labels ("0", "1", ...) with no wearer
marker. Map them once and every stored transcript uses the names:

```bash
remnic wearables speakers set bee 0 "Your Name" --self
remnic wearables speakers set bee 1 "Jane Doe"
```

## Notes

- Bee's list API has no date filter; the connector paginates
  newest-first and filters to the requested local day, so backfills
  stay bounded.
- Conversations still in the `CAPTURING` state are skipped until they
  settle; the next sync picks them up.
- Default `memoryMode: "review"`: nothing enters active recall without
  approval. Bee-native facts (when imported) are always review-queued.

Full documentation: [docs/wearables.md](https://github.com/joshuaswarren/remnic/blob/main/docs/wearables.md).

## License

MIT
