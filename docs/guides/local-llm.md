# Local LLM guide

Use Remnic's local LLM path when you want extraction, reranking, and selected helper flows to stay on an OpenAI-compatible endpoint you control.

This guide applies when `modelSource` is `plugin` (the parser default when the key is unset; new installs may be seeded with `gateway`). With `modelSource: "gateway"`, Remnic sends extraction/consolidation/rerank calls to the configured gateway agent chain instead, and `localLlm*` settings no longer control the primary extraction path.

## Fast start

If you want the preset first:

```jsonc
{
  "memoryOsPreset": "local-llm-heavy",
  "localLlmEnabled": true,
  "localLlmUrl": "http://localhost:1234/v1",
  "localLlmModel": "qwen2.5-32b-instruct",
  "localLlmFastEnabled": true,
  "localLlmFastModel": "qwen2.5-7b-instruct"
}
```

The preset seeds the broader advanced surface, but your explicit `localLlm*` values still win.

## Recommended split

Use the primary local model for slower tasks:

- extraction
- consolidation
- profile / identity consolidation

Use the fast local tier for short-turn helpers:

- rerank
- entity summary
- temporal-memory summaries
- compression-guideline refinement

## Key settings

| Setting | Why it matters |
|---------|----------------|
| `localLlmEnabled` | Master switch for Remnic's local inference path while `modelSource=plugin` |
| `localLlmUrl` | Base URL for the OpenAI-compatible endpoint |
| `localLlmModel` | Main local model ID |
| `localLlmFastEnabled` | Enables the smaller/faster local tier |
| `localLlmFastModel` | Model ID for the fast tier |
| `localLlmFallback` | If `true`, fail open to the gateway/cloud chain when the local endpoint is unavailable |
| `localLlmTimeoutMs` | Upper bound for heavier local requests |
| `localLlmFastTimeoutMs` | Lower bound for fast helper requests |
| `embeddingFallbackProvider` | Use `local` if you also want embedding fallback to stay local |

## Operational notes

- Keep `localLlmFallback=true` during bring-up unless you explicitly want hard failures.
- If the local server reports a smaller context window than the model supports, set `localLlmMaxContext`.
- If reranking feels slow, lower `rerankTimeoutMs` before changing the main extraction timeout.
- The local path is fail-open by default. If the endpoint disappears, Remnic should degrade rather than block the gateway.

## Custom OpenAI-compatible endpoint (self-hosted)

If you run a single OpenAI-compatible server (vLLM, Ollama, LM Studio, etc.) that serves both chat completions and embeddings, you can point everything at it with just `openaiBaseUrl`:

```jsonc
{
  "openaiBaseUrl": "http://localhost:8005/v1",
  "openaiApiKey": "dummy",
  "embeddingFallbackEnabled": true,
  "embeddingFallbackProvider": "openai"
}
```

Remnic routes extraction, consolidation, and embedding requests to your endpoint. The embedding path appends `/embeddings` to `openaiBaseUrl` automatically.

### Separate chat and embedding models

If your chat model and embedding model live on different servers, use `openaiBaseUrl` for chat and the `localLlm*` settings for embeddings:

```jsonc
{
  "openaiBaseUrl": "http://localhost:8005/v1",
  "openaiApiKey": "dummy",
  "localLlmEnabled": true,
  "localLlmUrl": "http://localhost:8006/v1",
  "localLlmModel": "bge-m3",
  "localLlmApiKey": "dummy",
  "embeddingFallbackEnabled": true,
  "embeddingFallbackProvider": "local"
}
```

### Docker networking

When running OpenClaw in Docker and the LLM server on the host, use `host.docker.internal` instead of `localhost`:

```jsonc
{
  "openaiBaseUrl": "http://host.docker.internal:8005/v1",
  "openaiApiKey": "dummy"
}
```

## When not to use it

- If you do not have a stable local endpoint yet, start with `memoryOsPreset: "balanced"`.
- If you want the lowest moving-part count, start with `conservative` and leave local inference disabled until the rest of the install is stable.
