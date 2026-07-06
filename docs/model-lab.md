# model-lab: reproducible fine-tuning lab

The `model-lab/` tree holds reproducible recipes to fine-tune the two small
classification models Remnic's extraction pipeline can consume locally:

- **faithfulness-gate** (`remnic-faithfulness-gate-v1`) — (factText, quote, context)
  → {entailed, contradicted, unsupported}. Backs the extraction faithfulness
  gate (#1576 / #1585).
- **correction-intent** (`remnic-correction-intent-v1`) — turn text + a small
  prior-turn window → the #1581 `corrections[]` block (or none). Backs passive-
  correction detection (#1581 / #1585).

Everything reproduces from manifests; **no datasets or weights are ever
committed to this repo** (git carries recipes and hashes, never blobs).

## Status: software landed, eval numbers GPU-gated

This document describes the reproducible software shipped for #1585:

| Piece | Status |
|---|---|
| Manifest schema + version-pin (`common/manifest_schema.py`, `common/training_stack.py`) | ✅ landed (both manifests committed as `pending-training` schema examples) |
| Seeded data generators (faithfulness perturbations + correction-intent morphology) | ✅ landed (CI-tested: determinism + selfcheck, pure CPU) |
| Train recipes (`train.py`, lazy-imported GPU stack) | ✅ landed (recipe + reproducibility contract) |
| Eval harness (held-out p95 latency + F1) | ✅ landed (`common/latency.py`, `common/eval_runner.py`) |
| Remnic config pointers | ✅ landed (`extractionFaithfulnessBaseUrl`, `correctionIntent*`) |
| **Actual training runs + eval-number manifests** | ⏳ **GPU-gated** — #1585 follow-up when the lab frees |
| **Downstream bench artifacts (gate quality vs prompted LLM; MemCorrect false_apply)** | ⏳ **GPU-gated** — #1585 follow-up |

Per rule 55 (#1520): **no accuracy/latency number appears here without an
artifact from a real run.** Every committed manifest is explicitly
`pending-training` until the GPU-run follow-up fills `eval.heldOut`,
`eval.downstream`, and `trainingStack` with real values.

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
# 1. Bootstrap the version-pinned training stack (the manifest's trainingStack
#    must reproduce these exact versions).
bash model-lab/setup.sh
source model-lab/.venv/bin/activate

# 2. Faithfulness-gate (encoder baseline):
python model-lab/faithfulness-gate/generate-data.py --seed 1337 --yes   # → faithfulness-gate/data/
python model-lab/faithfulness-gate/train.py   --version-tag v1          # → model-lab/runs/faithfulness-gate/v1/
python model-lab/faithfulness-gate/eval.py    --version-tag v1 --held-out <gold.jsonl> --latency-samples <ms.txt>

# 3. Correction-intent (≤4B instruct LM, LoRA):
python model-lab/correction-intent/generate-data.py --seed 1337 --yes   # → correction-intent/data/
python model-lab/correction-intent/train.py   --version-tag v1
python model-lab/correction-intent/eval.py    --held-out <gold.jsonl> --latency-samples <ms.txt>
```

`train.py`/`eval.py` lazy-import the GPU stack so `--help` works on a bare
machine; each exits with code 2 + an install hint if `torch`/`transformers`
(and `trl`/`peft` for correction-intent) are missing. **They never run in CI.**

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

- The **harvest stream** (teacher labels from shadow mode) is opt-in, local-only,
  and documented. `harvest-shadow-logs.py` requires `--i-consent-local-data` and
  prints exactly what it will read. It is a **stub** until the relevant shadow
  telemetry lands (#1576 for the gate, #1581 for correction-intent).
- Teacher-model outputs ("LLM traces") live under the gitignored data dir like
  everything else.

## Repo ethics

`model-lab/**/data/`, `model-lab/**/runs/`, `model-lab/.venv/`, `*.safetensors`,
and `*.gguf` are gitignored. The committed manifests are the **only** model-lab
artifacts in git; everything else reproduces from the recipes + the version-pinned
`requirements.txt`.
