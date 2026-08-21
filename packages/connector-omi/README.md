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

The connector uses Omi's Developer API by default:

1. In the Omi app, open **Settings → Developer → Create Key**.
2. Create a Developer API key (`omi_dev_...`).
3. Configure:

```jsonc
{
  "wearables": {
    "enabled": true,
    "sources": {
      "omi": {
        "enabled": true,
        "memoryMode": "smart",             // smart (default) | off | review | auto
        "importNativeMemories": "smart"    // Omi memories through the same trust pipeline
      }
    }
  }
}
```

Provide the key via `OMI_API_KEY` (or `REMNIC_OMI_API_KEY`, or `apiKey`
in config). No app id or uid is needed for the current Developer API.

Legacy External Integration app installs remain supported. If you are
still using that older flow, configure both `appId` and `userId`; when
both are present the connector uses Omi's app-scoped integration
endpoints.

## Usage

```bash
remnic wearables check omi
remnic wearables sync --source omi --days 7
remnic wearables transcript --date 2026-06-10 --source omi
```

## Speaker labels

Omi Developer API segments carry `speaker_name` and `speaker_id`.
Legacy integration segments may mark the wearer (`is_user`) and use
`SPEAKER_NN` diarization labels or stable person ids once you tag
people in Omi. Map any speaker key to a display name once:

```bash
remnic wearables speakers set omi SPEAKER_01 "Jane Doe"
```

## Notes

- Transcripts are fetched with `include_transcript=true`. In legacy
  integration mode, the connector also passes `max_transcript_segments=-1`
  because that API's default silently truncates conversations to their
  first 100 segments.
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
