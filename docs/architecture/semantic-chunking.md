# Semantic Chunking

Issue #368 — Smoothing-based topic boundary detection for memory chunking.

## Overview

Semantic chunking is an **optional alternative** to the existing recursive
chunker (`chunking.ts`). Instead of splitting text at fixed token counts, it
uses sentence embeddings and cosine similarity to detect natural topic
boundaries, producing chunks that preserve topical coherence.

## How It Works

1. **Sentence tokenization** — the input is split into sentences using
   punctuation-based boundaries.
2. **Embedding** — each sentence is embedded via a caller-provided function
   (`embedFn`). Sentences are batched according to `embeddingBatchSize`.
3. **Cosine similarity** — pairwise cosine similarity is computed between
   adjacent sentence embeddings, producing a 1-D similarity series.
4. **Smoothing** — a simple centered moving average (window size from config)
   smooths the similarity series to reduce noise.
5. **Boundary detection** — local minima in the smoothed series that dip below
   `mean - boundaryThresholdStdDevs * stddev` are identified as topic
   boundaries.
6. **Segment merging** — segments shorter than `minTokens` are merged with
   their nearest neighbor.
7. **Segment splitting** — segments exceeding `maxTokens` are recursively
   split using the existing recursive chunker.

## When to Enable

| Scenario | Recommendation |
|----------|---------------|
| Short memories (< 200 tokens) | Not needed — recursive chunker is sufficient |
| Long memories with clear topic shifts | Semantic chunking produces better retrieval |
| Embedding API unavailable or expensive | Stay with recursive; set `fallbackToRecursive: true` |
| Batch extraction of many memories | Consider cost of embedding each sentence |

## Configuration Reference

All settings live under `semanticChunkingConfig` in the plugin config. The
top-level `semanticChunkingEnabled` flag gates the feature.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `targetTokens` | number | `200` | Target tokens per chunk |
| `minTokens` | number | `100` | Minimum tokens before merging with neighbor |
| `maxTokens` | number | `400` | Maximum tokens before recursive splitting |
| `smoothingWindowSize` | number | `3` | Moving-average window (centered) |
| `boundaryThresholdStdDevs` | number | `1.0` | Std devs below mean for boundary |
| `embeddingBatchSize` | number | `32` | Sentences per embedding API call |
| `fallbackToRecursive` | boolean | `true` | Fall back if embeddings unavailable |

## Performance Considerations

- **Embedding costs**: every sentence in the input requires an embedding. For
  a 20-sentence memory, that is 1 API call (at batch size 32). Plan for this
  when processing large backlogs.
- **Latency**: the embedding round-trip adds latency compared to the purely
  local recursive chunker. For real-time paths, keep `fallbackToRecursive`
  enabled.
- **Quality**: the smoothing window and threshold parameters control
  sensitivity. A larger window (5-7) reduces false boundaries but may miss
  short topic segments. A smaller threshold (0.5 std devs) is more aggressive
  at splitting.

## Architecture

The module (`packages/remnic-core/src/semantic-chunking.ts`) is self-contained
and imports only the existing `chunkContent` from `chunking.ts` for fallback
and segment splitting. It exports:

- `SemanticChunkingConfig` / `DEFAULT_SEMANTIC_CHUNKING_CONFIG`
- `SemanticChunk` / `SemanticChunkResult`
- `semanticChunkContent()` — the main entry point
- Math utilities: `cosineSimilarity`, `movingAverage`, `findLocalMinima`,
  `mean`, `stddev`

Callers (e.g., the orchestrator) choose which chunker to invoke based on the
`semanticChunkingEnabled` config flag and the availability of an embedding
function.
