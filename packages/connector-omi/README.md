# @remnic/connector-omi

Omi AI wearable connector for [Remnic](https://github.com/joshuaswarren/remnic).
Pulls your Omi necklace conversations into Remnic's wearable-transcript
pipeline: cleaned, speaker-labeled, redacted, searchable day
transcripts — and, under per-source trust gates, memories. Optionally
imports Omi's own "memories" (extracted facts) into the review queue.

This is an **à-la-carte optional companion** of `@remnic/core`:

```bash
npm install -g @remnic/connector-omi
```

Remnic discovers it at runtime. No further registration is needed.

## Setup

The connector uses Omi's Integrations API, which is scoped to an app
you create:

1. In the Omi app: **Apps → Create App → External Integration**, and
   grant the **read conversations** capability (plus **read memories**
   if you want native-memory import). Install/enable the app for your
   account.
2. On the app's management page, create an **API key** (`sk_...`).
3. Note your **app id** and your **uid** (Omi passes `?uid=` to your
   app's links; it identifies the account to read).
4. Configure:

```jsonc
{
  "wearables": {
    "enabled": true,
    "sources": {
      "omi": {
        "enabled": true,
        "appId": "your-omi-app-id",
        "userId": "your-omi-uid",
        "memoryMode": "smart",             // smart (default) | off | review | auto
        "importNativeMemories": "smart"    // Omi memories through the same trust pipeline
      }
    }
  }
}
```

Provide the key via `OMI_API_KEY` (or `REMNIC_OMI_API_KEY`, or `apiKey`
in config).

## Usage

```bash
remnic wearables check omi
remnic wearables sync --source omi --days 7
remnic wearables transcript --date 2026-06-10 --source omi
```

## Speaker labels

Omi marks the wearer (`is_user`) automatically. Other voices arrive as
`SPEAKER_NN` diarization labels — or stable person ids once you tag
people in Omi. Map either form to a display name once:

```bash
remnic wearables speakers set omi SPEAKER_01 "Jane Doe"
```

## Notes

- Transcripts are fetched **unabridged**: the connector passes
  `max_transcript_segments=-1` because the API's default silently
  truncates conversations to their first 100 segments.
- Day windows are timezone-correct: the connector computes local-day
  ISO bounds (DST-aware) for the API's `start_date`/`end_date` filters,
  and only `completed`, non-discarded conversations sync.
- Default `memoryMode: "smart"`: the LLM judge + per-source trust prior
  + cross-device corroboration write high-trust facts active, queue
  borderline ones, and drop the rest. Omi-native memories run through
  the same pipeline with a reduced prior.

Full documentation: [docs/wearables.md](https://github.com/joshuaswarren/remnic/blob/main/docs/wearables.md).

## License

MIT
