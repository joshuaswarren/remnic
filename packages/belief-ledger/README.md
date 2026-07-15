# @remnic/belief-ledger

A Remnic library for a personal belief and prediction ledger. It stores claims,
predictions, and opinions as structured Remnic facts, retrieves prior claims that
may conflict, asks a host LLM to classify the relationship, and tracks prediction
calibration over time.

Part of [Remnic](https://github.com/joshuaswarren/remnic), the open-source,
local-first memory and context layer for AI agents.

## Install

```bash
npm install @remnic/belief-ledger
```

This package is intentionally host-neutral:

- It depends on `@remnic/core` public APIs.
- It does not import OpenClaw, Hermes, or direct OpenAI clients.
- Host adapters provide LLM access through `LedgerLlmAdapter`, or wrap Remnic's
  existing `FallbackLlmClient` with `createFallbackLlmLedgerAdapter`.

## Basic Usage

```ts
import { StorageManager } from "@remnic/core";
import {
  BeliefLedger,
  RemnicLedgerStore,
  createFallbackLlmLedgerAdapter,
} from "@remnic/belief-ledger";

const storage = new StorageManager("/path/to/remnic-memory");
const store = new RemnicLedgerStore(storage);
const llm = createFallbackLlmLedgerAdapter(fallbackLlmClient);

const ledger = new BeliefLedger({ store, llm });

const result = await ledger.capture({
  text: "I think local-first memory tools will beat cloud-only memory tools by 2027.",
});

if (result.challenge) {
  console.log(result.challenge.question);
}
```

## What Gets Stored

Claims are written as Remnic `fact` memories with:

- `tags`: `belief-ledger`, claim kind, status, and optional domain.
- `entityRef`: the first extracted entity when one exists.
- `structuredAttributes`: stance, confidence, domain, entities, deadline,
  evidence links, status, prediction outcome, and Brier score.

That confirms issue #869's upstream requirements through the public core
surface: custom metadata, entity-scoped retrieval inputs, and supersession via
`StorageManager.supersedeMemory`.

## Host LLM Access

The package asks for a `LedgerLlmAdapter` rather than an API key. OpenClaw,
Hermes, CLI, or app adapters can route the calls through their normal Remnic LLM
path. For OpenClaw-backed Remnic runtimes, pass the existing gateway-backed
`FallbackLlmClient` to `createFallbackLlmLedgerAdapter`.

## Core Flows

- `capture`: extract a structured claim, persist it, retrieve prior claims,
  judge contradictions, and draft a Socratic challenge when needed.
- `crossExamine`: run retrieval and LLM judging against an existing claim.
- `supersede`, `split`, `resolve`, `snooze`, `ignore`: typed ledger actions
  suitable for host tool/function surfaces.
- `scoreDuePredictions`: find predictions past deadline, grade them from a
  verdict source or return a user-verdict prompt.
- `reflect`: compute calibration summaries, Brier score, flipped claims, and
  dormant topics.

## License

MIT
