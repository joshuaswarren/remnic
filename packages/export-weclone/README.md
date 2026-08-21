# @remnic/export-weclone

Export [Remnic](https://github.com/joshuaswarren/remnic) memories as
[WeClone](https://github.com/xming521/weclone)-compatible fine-tuning
datasets. Produces Alpaca-format JSON consumable by
[LLaMA Factory](https://github.com/hiyouga/LLaMA-Factory), which WeClone
drives under the hood.

This package solves the noisy-chat-log problem: WeClone normally trains on
raw Telegram / WeChat exports, which include spam, one-word replies, and
PII. Remnic has already distilled your conversations into structured
facts, preferences, entities, and topics — a much higher
signal-to-noise source for a personal digital avatar.

## Install

```bash
pnpm add @remnic/export-weclone
# or: npm i @remnic/export-weclone
```

`@remnic/export-weclone` is an **optional companion** of
[`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli), installed separately —
the base install never pulls it in. It depends on `@remnic/core` and is meant to
run alongside an existing Remnic memory store. `remnic training:export --format
weclone` loads it lazily and prints an install hint if it is missing.

## Quick start

The primary entry point is the `remnic` CLI (see
[`@remnic/cli`](../remnic-cli)). Importing this package as a side-effect
registers the `weclone` adapter with the core training-export registry:

```bash
remnic training:export --format weclone --output ./weclone-dataset.json
```

Common options:

```bash
# Restrict to high-confidence memories created in 2026:
remnic training:export \
  --format weclone \
  --output ./weclone.json \
  --since 2026-01-01 \
  --until 2027-01-01 \
  --min-confidence 0.7

# Restrict to specific categories:
remnic training:export \
  --format weclone \
  --output ./weclone.json \
  --categories preference,fact,skill

# Generate conversational Q/A pairs instead of raw facts:
remnic training:export \
  --format weclone \
  --output ./weclone.json \
  --synthesize

# Preview only (no file written):
remnic training:export --format weclone --output /tmp/preview.json --dry-run
```

## Output format

WeClone / LLaMA Factory expect [Alpaca
JSON](https://github.com/tatsu-lab/stanford_alpaca#data-release):

```json
[
  {
    "instruction": "What kind of coffee do you like?",
    "input": "",
    "output": "dark roast, ethiopian yirgacheffe. something about that fruity wine-like flavor..."
  }
]
```

The adapter emits only the three Alpaca fields. Remnic metadata
(`category`, `confidence`, `sourceIds`) is stripped from the output file
but is preserved on the in-memory records so callers building their own
pipelines can inspect it before serialization.

## Programmatic API

```ts
import {
  ensureWecloneExportAdapterRegistered,
  wecloneExportAdapter,
  synthesizeTrainingPairs,
  extractStyleMarkers,
  sweepPii,
} from "@remnic/export-weclone";
import {
  convertMemoriesToRecords,
  getTrainingExportAdapter,
} from "@remnic/core";

// Side-effect import is usually enough, but explicit registration is safe:
ensureWecloneExportAdapterRegistered();

const records = await convertMemoriesToRecords({
  memoryDir: "/path/to/memory",
  minConfidence: 0.7,
});

const pairs = synthesizeTrainingPairs(records, { maxPairsPerRecord: 2 });
const { cleanRecords, redactedCount } = sweepPii(pairs);

const adapter = getTrainingExportAdapter("weclone");
const json = adapter!.formatRecords(cleanRecords);
```

### `synthesizeTrainingPairs(records, opts)`

Turns flat memory records into natural conversational Q/A pairs using
category-driven templates (preferences, opinions, expertise, personal).
Pure templates — no LLM calls. Optionally applies style markers (e.g.
lowercase normalization) extracted from the user's own transcripts.

### `extractStyleMarkers(samples)`

Analyses text samples with regex-and-count heuristics and returns a
`StyleMarkers` profile (`avgSentenceLength`, `usesEmoji`, `formality`,
`usesLowercase`, `commonPhrases`). Used by `synthesizeTrainingPairs` to
match the output tone to the user's own writing style.

### `sweepPii(records)`

Belt-and-suspenders PII redaction for email, SSN, credit-card, IP, and
phone patterns. Runs after Remnic's own privacy controls so that even if
something slips through the upstream filter, the final dataset cannot leak
these patterns. Returns `{ cleanRecords, redactedCount, redactionDetails }`.

## How synthesis works

Remnic memories are facts, not conversations. The synthesizer maps each
memory category to a template group and generates a corresponding
question, using any parenthesised tags in the instruction as the topic:

```
Category:  preference
Memory:    "Dark roast coffee, Ethiopian Yirgacheffe specifically"
Tags:      food, coffee

Generated pair:
  instruction: "What kind of food, coffee do you like?"
  output:      "Dark roast coffee, Ethiopian Yirgacheffe specifically"
```

Question templates live in `src/synthesizer.ts`. Adding a new category
mapping is a one-line change.

## Privacy posture

- Output JSON contains only `instruction`, `input`, `output`.
- Remnic metadata (`sourceIds`, etc.) is **not** written to the dataset
  file — even the record IDs stay in the memory store.
- `sweepPii` runs by default in the CLI. Disable only with
  `--no-privacy-sweep` and only when you have a compensating control.
- Symlinks and hard-linked `.md` files under `memoryDir` are refused by
  the core converter to block data-exfiltration vectors out of the memory
  store (see `packages/remnic-core/src/training-export/converter.ts`).

## Related

- Tracking issue: [remnic#459](https://github.com/joshuaswarren/remnic/issues/459)
- Upstream: [WeClone](https://github.com/xming521/weclone)
- Format: [Alpaca JSON via LLaMA Factory](https://github.com/hiyouga/LLaMA-Factory)

## License

MIT. See the root [LICENSE](../../LICENSE) file.
