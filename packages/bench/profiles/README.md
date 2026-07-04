# Local-lab runtime profiles

This directory ships reference JSON manifests for the **`local-lab`** bench
runtime profile (issue #1573 PR2). A local-lab profile pins responder,
judge, and (optionally) embedding to operator-hosted models so the bench
runs entirely on local hardware — no paid API calls, no rate-limit cliffs.

These manifests are **templates**. They use placeholder model ids on
purpose: the operator must replace them with the ids their endpoint
actually reports (`GET /v1/models` for OpenAI-compatible servers,
`GET /api/tags` for Ollama) before running. The bench refuses to start a
phase whose preflight cannot find the manifest model id (rule 51 — no
silent fallback).

## Schema

|Field|Type|Meaning|
|---|---|---|
|`profile`|`"local-lab"`|Discriminator. Required.|
|`responder`|role|Answering model (must report this id at the endpoint).|
|`judge`|role|Scoring model. Runs in the judge phase after the responder.|
|`embedding`|role?|Optional embedding model for retrieval indexing.|
|`phases`|`"sequential"`|Phase scheduling mode. PR2 ships `sequential` only.|
|`notes.responderToJudgeHandoff`|string?|Operator guidance printed between responder and judge phases when the two roles live on different endpoints.|

Each role has shape:

|Field|Type|Meaning|
|---|---|---|
|`provider`|`"openai-compatible"` \| `"ollama"`|Transport the bench uses for preflight + completion.|
|`baseUrl`|string|Endpoint URL. Fetch target only — never interpolated into a shell.|
|`model`|string|Exact id the endpoint reports. No aliases.|
|`quantization`|string?|Informational; recorded in artifacts.|
|`ctx`|positive int|Manifest-declared serving context (tokens). Preflight verifies the live endpoint reports at least this much.|
|`temperature`|`0`|Pinned to 0 for reproducibility. Non-zero is rejected.|
|`seed`|int|Sampling seed; required so reruns reproduce the same draws.|

## `local-lab-3090.json`

Reference profile targeting a single-GPU lab box. The numbers below come
from issue #1573's *Hardware envelope* section; they are VRAM math, not
performance claims, and are reproduced here so the manifest's defaults
can be checked against the design constraints.

### Hardware envelope (RTX 3090, 24 GB VRAM, Ampere; 256 GB RAM, NVMe)

|Class|Rough VRAM @ 4-bit|Practical serving ctx|Notes|
|---|---|---|---|
|~14B dense (e.g. Qwen 2.5 14B, Llama 3 8B-class step-up)|9–10 GB|32k KV cache headroom|Comfortably fits; responder-only or judge-only.|
|~24–32B dense or ~30B-class MoE|14–19 GB|≤16k ctx (tight)|Responder OR judge, not both; KV budget tight.|
|Embedding model (e.g. BGE-M3, Qwen 3 embedding)|1–3 GB|8k ctx|Fits alongside one of the above on the same GPU in some setups.|

Constraints the profile respects:

- **24 GB VRAM fits one serious model at a time** — responder and judge
  MUST run in sequential phases, never co-resident.
- **Ampere: bf16 OK, no FP8.** Prefer AWQ/GPTQ-int4 or GGUF Q4_K_M
  quantizations.
- Remnic's memory-based answering keeps prompts small (that is the
  product); LongMemEval_S's ~115k-token histories are ingested through
  observe/extraction, not stuffed in context — so **16–32k serving context
  is sufficient**.
- **256 GB RAM**: model files stay in page cache; phase swaps from NVMe
  are seconds, not minutes. The operator can hot-swap models between
  phases without long stalls.

### Defaults chosen in this manifest

The reference manifest pins both `responder` and `judge` to a **16 384
token** serving context. That value:

- Lies inside the 16–32k envelope above.
- Is conservatively below the "tight" ceiling for 24–32B dense models.
- Matches what GGUF Q4_K_M builds of mainstream ~14B / ~30B-class models
  expose out of the box, so an operator swapping in their own model id is
  unlikely to need to lower `ctx`.

`temperature: 0` and a fixed `seed: 1573` make reruns reproducible (the
manifest parser rejects non-zero temperatures and missing seeds).

The two endpoints (`http://127.0.0.1:8080/v1` responder,
`http://127.0.0.1:11434` judge) live on different ports on purpose: on a
single 3090 the operator must physically stop one server and start the
other between phases. The bench detects that they differ and prints the
`notes.responderToJudgeHandoff` operator guidance. To run both roles on
one Ollama daemon instead, point both `baseUrl` fields at it and the
bench proceeds silently between phases.

## Using a profile

Resolution goes through `resolveBenchRuntimeProfile` (see
`packages/bench/src/runtime-profiles.ts`); the resolver turns each role
into a `ProviderConfig` with `temperature` and `seed` forwarded verbatim.
The sequential phase scheduler (`runSequentialPhases`) executes
preflight → hand-off → execute for each phase. Neither layer manages
model processes — that is the operator's responsibility.

```ts
import {
  loadLocalLabManifest,
  resolveLocalLabProfile,
  runSequentialPhases,
} from "@remnic/bench/local-lab";

const manifest = await loadLocalLabManifest("packages/bench/profiles/local-lab-3090.json");
const profile = resolveLocalLabProfile(manifest);
// profile.responder.providerConfig.temperature === 0
// profile.responder.providerConfig.seed === 1573
```
