# model-lab: reproducible fine-tuning lab

The `model-lab/` tree holds reproducible recipes to fine-tune the two small
classification models Remnic's extraction pipeline can consume locally:

- **faithfulness-gate** (`remnic-faithfulness-gate-v1`) — (factText, quote, context)
  → {entailed, contradicted, unsupported}. Backs the extraction faithfulness
  gate (#1576 / #1585).
- **correction-intent** (`remnic-correction-intent-v1`) — a turn window →
  {correction, none} detection classifier. Backs passive-correction detection
  (#1581 / #1585 / #1738). Emitting the full #1581 `corrections[]` block
  (targetHint, correctedAssertion, polarity) is the v2 causal-LM follow-up.

Everything reproduces from manifests; **no datasets or weights are ever
committed to this repo** (git carries recipes and hashes, never blobs).

## Status: both v1 models trained; downstream numbers GPU-gated

This document describes the reproducible software shipped for #1585:

| Piece | Status |
|---|---|
| Manifest schema + version-pin (`common/manifest_schema.py`, `common/training_stack.py`) | landed (both manifests committed as `trained` with real eval numbers) |
| Seeded data generators (faithfulness perturbations + correction-intent morphology) | landed (CI-tested: determinism + selfcheck, pure CPU) |
| Train recipes (`train.py`, lazy-imported GPU stack) | landed (recipe + reproducibility contract) |
| Eval harness (held-out p95 latency + F1) | landed (`common/latency.py`, `common/eval_runner.py`) |
| Remnic config pointers | landed (`extractionFaithfulnessBaseUrl`, `correctionIntent*`) |
| **Actual training runs + eval-number manifests** | **both v1 models trained** on the lab RTX 3090 (#1737 faithfulness-gate, #1738 correction-intent) — held-out macro-F1 1.0 each; see Results below |
| **Downstream bench artifacts (gate quality vs prompted LLM; MemCorrect false_apply)** | GPU-gated — produced by the #1574 / #1584 bench protocols, not the model-lab recipes; each manifest's `eval.downstream` points there |
| **HF weight publish (`common/hf_push.py`)** | pending — `hf_push.py` is a stub (`NotImplementedError`) and no HF credentials exist on the lab box; the trained weights are content-pinned locally via `manifest.artifact.localArtifactSha256` (see that block) |

Per rule 55 (#1520): **no accuracy/latency number appears here without an
artifact from a real run.** Both v1 manifests are `status: trained` and carry
real held-out numbers; the downstream (production-signal) numbers are still
GPU-gated. Every number below traces to a manifest `eval` block.

## Results — faithfulness-gate v1 (real run, RTX 3090)

Trained from the manifest at `model-lab/faithfulness-gate/manifest.json`
(`status: trained`). All numbers are from that run; reproduce with the
commands in the next section.

| Metric | Value | Source |
|---|---|---|
| Held-out macro-F1 | **1.000** | `manifest.eval.heldOut.macroF1` (21 held-out examples, 10% split) |
| Per-class F1 (entailed / contradicted / unsupported) | 1.00 / 1.00 / 1.00 | `manifest.eval.heldOut.perClass` |
| Held-out p95 latency | **9.93 ms** | `manifest.eval.heldOut.latencyMs.p95` (single-example GPU forward, fp32) |
| Base model | `roberta-large-mnli` (0.355 B) | `manifest.baseModel` — fallback encoder (see note) |
| Dataset | 204 records, 1:1:1 balanced, sha256 `751aa45d…` | `manifest.dataRecipe` |

**Held-out caveat:** the split is drawn from the same systematic perturbation
generator as the train set, so macro-F1 1.0 reflects perfect separation of the
(code-generated, label-trustworthy) perturbation patterns — it clears the
#1585 held-out target (≥0.9) but is **not** a real-world robustness claim.
The number that matters for production is the **downstream** one (gate quality
vs the prompted-LLM baseline on real extraction), produced by the #1574 bench
harness — deliberately out of scope for `eval.py` (rule 55).

**Base-model note:** issue #1585 names DeBERTa-v3-large-MNLI as the first-choice
encoder. On this box DeBERTa-v3 (base **and** large) is numerically unusable:
it NaNs in fp32 (its XPOS relative-position encoding overflows fp32 range in
the backward pass) and is unstable under bf16 on small data. `roberta-large-mnli`
is the documented ≤4B fallback — fp32-stable and already NLI-pretrained — and
converged cleanly (held-out macro-F1 climbed 0.22→0.48→0.65→0.96→1.0 over
epochs 1–5). See `manifest.baseModel.$comment`.

## Results — correction-intent v1 (real run, RTX 3090)

Trained from the manifest at `model-lab/correction-intent/manifest.json`
(`status: trained`). v1 is the **detection** slice of #1581: a turn window in,
`{correction, none}` out. It shares the faithfulness-gate encoder stack and the
same reproducible venv (identical `trainingStack.pipFreezeSha256`).

| Metric | Value | Source |
|---|---|---|
| Held-out macro-F1 | **1.000** | `manifest.eval.heldOut.macroF1` (25 held-out examples, 10% split) |
| Per-class F1 (correction / none) | 1.00 / 1.00 | `manifest.eval.heldOut.detection` |
| Held-out p95 latency | **11.75 ms** | `manifest.eval.heldOut.latencyMs.p95` (single-example GPU forward, fp32) |
| Base model | `roberta-large-mnli` (0.355 B) | `manifest.baseModel` — 3-way NLI head reinitialized to a 2-way detection head |
| Dataset | 250 records (120 correction / 130 none), sha256 `c0238a2b…` | `manifest.dataRecipe` |

The original #1585 plan used a <=4B instruct causal LM (TRL/LoRA) emitting the
`corrections[]` JSON block, but `trl==0.16.6` / `bitsandbytes==0.44.1` do not
exist on PyPI and the only resolvable `trl` breaks the shared venv's `datasets`
pin (#1738). v1 therefore reuses the fp32-stable `roberta-large-mnli` encoder;
it converged cleanly (held-out macro-F1 0.92 → 0.87 → 1.0 over epochs 1–3, held
through epoch 12). Span extraction (`correctedAssertion` + polarity) is
`not-applicable-v1` and is the v2 causal-LM follow-up.

Same held-out caveat as the gate: the split is drawn from the same morphology
generator as the train set, so macro-F1 1.0 reflects perfect pattern separation,
not real-world robustness. The production number is the **downstream** one
(detection quality vs the prompted-LLM classifier on real conversations),
produced by the #1584 MemCorrect bench protocol — out of scope for `eval.py`.

## Hardware envelope (sets the model-size policy)

| Operation | RTX 3090 (24 GB, Ampere — bf16 yes, FP8 no) |
|---|---|
| Encoder classifier fine-tune (DeBERTa-v3-large class, ~0.4B) | Trivial: full fine-tune, minutes–1h |
| Full fine-tune, causal LM | ≤ ~1.5B comfortably |
| LoRA (bf16 base) | ≤ ~8B |
| QLoRA (4-bit base + paged optimizer) | ≤ ~14B; ~30B-class technically possible but too slow — out of policy |
| Inference serving (Ollama / vLLM, 4-bit) | ~14B dense or ~30B-class MoE, one model at a time |

**Policy: target models ≤ 4B for these two tasks** (classification, not
generation). An 8B LoRA is an escape hatch if evals demand it; anything larger
needs a written justification in the manifest's `policyCompliance` block.

## Reproducing a model on a 3090-class GPU

```bash
# 1. Bootstrap the version-pinned training stack. For a NEW training run,
#    HEAD's requirements.txt is the pin source. To REPRODUCE a committed
#    trained manifest, install the exact versions recorded in that
#    manifest's trainingStack.libs (verify with its pipFreezeSha256) —
#    requirements.txt at HEAD moves ahead of committed manifests when
#    dependencies bump, so it is not the reproduction pin source.
bash model-lab/setup.sh
source model-lab/.venv/bin/activate

# 2. Faithfulness-gate (encoder baseline — roberta-large-mnli; see base-model note):
python model-lab/faithfulness-gate/generate-data.py --seed 1337 --yes   # → faithfulness-gate/data/  (sha256 recorded in the manifest)
python model-lab/faithfulness-gate/train.py --version-tag v1 \
    --base-model roberta-large-mnli --mixed-precision fp32 --epochs 12 --learning-rate 1e-5
python model-lab/faithfulness-gate/eval.py --version-tag v1            # → manifest eval.heldOut block (F1 + p95 latency)

# 3. Correction-intent (encoder detection classifier — roberta-large-mnli; v1 is #1738):
python model-lab/correction-intent/generate-data.py --seed 1337 --yes   # → correction-intent/data/ (sha256 in the manifest)
python model-lab/correction-intent/train.py --version-tag v1 \
    --base-model roberta-large-mnli --mixed-precision fp32 --epochs 12 --learning-rate 1e-5
python model-lab/correction-intent/eval.py --version-tag v1            # → manifest eval.heldOut block (detection F1 + p95 latency)
```

`train.py`/`eval.py` lazy-import the GPU stack so `--help` works on a bare
machine; each exits with code 2 + an install hint if `torch`/`transformers`
are missing (both v1 models share the encoder stack — no `trl`/`peft`).
**They never run in CI.**

After a real run, `train.py` captures the exact interpreter + lib versions into
the manifest's `trainingStack` block (`common/training_stack.capture_training_stack`),
and `eval.py` writes the `eval.heldOut` block (held-out p95 latency +
faithfulness macro/per-class F1, or correction-intent detection F1 + span
overlap). The manifest must pass `validate_manifest(..., allow_pending=False)`
before publish — a half-recorded run cannot ship as complete.

## Pointing Remnic at a fine-tuned local model

Remnic consumes the models through config only — **zero core code changes
beyond the config pointers**. Serve the trained + quantized model via Ollama or
vLLM on the lab box, then:

```jsonc
// .openclaw/workspace/config.json (or --config)
{
  // Faithfulness gate → local fine-tuned encoder:
  "extractionFaithfulnessGate": "enforce",            // or "shadow" to record only
  "extractionFaithfulnessModel": "remnic-faithfulness-gate-v1",
  "extractionFaithfulnessBaseUrl": "http://localhost:11434/v1",  // Ollama; or vLLM :8000/v1

  // Correction-intent classifier (optional; rule-based detector is the default):
  "correctionIntentModel": "remnic-correction-intent-v1",
  "correctionIntentBaseUrl": "http://localhost:11434/v1"
}
```

When `extractionFaithfulnessBaseUrl` + `extractionFaithfulnessModel` are both
set, the gate routes to that local endpoint **first**, falling back to the
configured LLM chain on any failure (graceful degradation — a down local model
never blocks writes). Empty/unset values preserve the existing routing exactly
(byte-identical pre-feature path, rule 39).

The `correctionIntent*` pointer is the hook the model-backed detector consumes;
the rule-based `detectPassiveCorrections` (#1581) remains the default path until
a model-backed detector lands in the consuming child.

## Privacy + consent

- The **harvest stream** (teacher labels from shadow telemetry) is real, opt-in,
  and local-only (issue #2852). `model-lab/harvest.py` requires an explicit
  `--consent` flag plus explicit local `--input`/`--out` paths, prints exactly
  what it will read, and refuses otherwise (exit 2, nothing read). It walks
  exactly the named directory — no vault scan, no symlink `--input` root, no
  descendant symlink follow — strips session keys, principals, namespaces,
  memory ids, and model ids by projecting records field-by-field from an
  allowlist, emits an unlinkable hashed `sourceId`, keeps every verified
  source quote (joined with a newline, same as the gate), skips
  redacted/never-store plans, treats unknown classification/status/version/
  action kind or required field or a confidence outside `[0, 1]` as
  malformed, derives polarity and assertion from the action, reconstructs
  gated `factText` by stripping the persist-time attribute suffix and
  default inline citation, stats-and-streams
  `--max-text-bytes` before a full read, and never
  runs from the daemon, build, or CI. See `model-lab/README.md`
  ("Harvesting shadow-telemetry labels") for the command recipe.
- **No committed dataset contains harvested data.** Both v1 datasets are
  synthetic-only; any harvested dataset lives under the gitignored
  `model-lab/**/data/` dirs with a provenance manifest + sha256, and never
  reaches git.
- Teacher-model outputs ("LLM traces") live under the gitignored data dir like
  everything else.

## Repo ethics

`model-lab/**/data/`, `model-lab/**/runs/`, `model-lab/.venv/`, `*.safetensors`,
and `*.gguf` are gitignored. The committed manifests are the **only** model-lab
artifacts in git; everything else reproduces from the recipes plus the pinned
versions recorded in each manifest's `trainingStack.libs` (for committed
models) or `requirements.txt` at HEAD (for new runs).
