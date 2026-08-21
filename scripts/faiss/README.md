# FAISS Sidecar

This directory documents the Python sidecar used by the TypeScript FAISS adapter.

## Files

- `../faiss_index.py`: JSON-in/JSON-out CLI (`upsert`, `rebuild`, `search`, `health`, `inspect`)
- `../faiss_requirements.txt`: Python dependencies

## Install

```bash
python3 -m venv .venv-faiss
source .venv-faiss/bin/activate
pip install -r scripts/faiss_requirements.txt
```

Optional:
- Set `ENGRAM_FAISS_ENABLE_ST=1` to enable sentence-transformers embeddings.
- If that env var is unset, the sidecar uses deterministic hash embeddings and does not require sentence-transformers model downloads.

## Runtime Modes

- Default mode uses deterministic `__hash__` embeddings to avoid heavy model initialization on per-command subprocess calls.
- To enable sentence-transformers models, set `ENGRAM_FAISS_ENABLE_ST=1` in the sidecar environment.

## Contract

The sidecar reads one JSON payload from stdin and writes exactly one JSON object to stdout.

### Commands

1. `upsert`
- Input: `{ "modelId", "indexPath", "chunks": [...] }`
- Output: `{ "ok": true, "upserted": <number> }`

2. `search`
- Input: `{ "modelId", "indexPath", "query", "topK" }`
- Output: `{ "ok": true, "results": [{ "path", "snippet", "score" }] }`

3. `health`
- Input: `{ "modelId", "indexPath" }`
- Output: `{ "ok": true, "status": "ok|degraded|error", "error"?: "..." }`

4. `inspect`
- Input: `{ "modelId", "indexPath" }`
- Output: `{ "ok": true, "status": "...", "metadata": { "chunkCount", "hasIndex", "hasMetadata", "hasManifest" } }`

5. `rebuild`
- Input: `{ "modelId", "indexPath", "chunks": [...] }`
- Output: `{ "ok": true, "rebuilt": <number> }`

## Storage Layout

`indexPath` should point to a plugin-managed directory under:

`<memoryDir>/state/conversation-index/faiss/`

Artifacts written by the sidecar:

- `index.faiss`: FAISS index file
- `metadata.jsonl`: chunk metadata in insertion order
- `manifest.json`: model/dimension/chunk-count metadata used to reject stale index reuse
- `.index.lock`: transient file lock used during upserts

Current runtime expectation:
- Health checks verify dependency availability and whether `index.faiss`, `metadata.jsonl`, and `manifest.json` agree.
- Search refuses to reuse an index when the saved manifest no longer matches the requested embedding mode/model.
- Search validates query/index vector dimensions and returns a fail-open error envelope on mismatch.

Operational flow:
1. Engram writes chunk markdown under `memoryDir/conversation-index/chunks/...`.
2. `conversation_index_update` calls the sidecar `upsert` command.
3. `search` reads `index.faiss`, `metadata.jsonl`, and `manifest.json` from the configured `indexPath`.
4. `health` is safe to call at startup or via `openclaw engram conversation-index-health`.
5. `inspect` is safe to call via `openclaw engram conversation-index-inspect`.
6. `rebuild` is available via `openclaw engram conversation-index-rebuild`.

## Fail-open Notes

- On validation/dependency errors, sidecar emits `{ "ok": false, "error": "..." }`.
- Adapter treats this as fail-open and conversation recall degrades without crashing hook execution.
- Common degraded causes:
  - missing `faiss` / `numpy` dependencies
  - missing `sentence-transformers` when `ENGRAM_FAISS_ENABLE_ST=1`
  - missing local artifacts (`index.faiss`, `metadata.jsonl`, `manifest.json`)
  - dimension mismatch between the saved index and the current embedding mode/model
