# model-lab

Reproducible recipes to generate training data, fine-tune, evaluate, and serve the two small classification models Remnic's extraction pipeline consumes — the **faithfulness gate** (issue #1576 / #1585) and **correction-intent** detector (#1581 / #1585). Everything reproduces from manifests; **no datasets or weights are ever committed to this repo** (git carries recipes and hashes, never blobs).

This is **not** an npm workspace package. It is a standalone Python tree that follows the repo's Python standards (3.12+, typed, `requirements.txt` / `setup.sh` local to `model-lab/`). The npm build/test pipeline never touches it; the **only** CI hook is the seeded data generator's determinism test (pure CPU, small N).

## What lives here

```
model-lab/
  README.md                       this file
  requirements.txt                version-pinned GPU training stack (both models)
  setup.sh                        bootstrap a venv on the lab box
  common/                         shared, stdlib-only helpers
    seeding.py                    deterministic RNG + sha256 + JSONL writer
    jsonl_schema.py               FaithfulnessRecord + validators (the #1576 contract)
    eval_runner.py                per-class/macro F1 (faithfulness) + detection F1 +
                                  span overlap (correction-intent) — identical math in CI and on GPU
    latency.py                    held-out p95 latency harness + percentile math
    manifest_schema.py            the reproducibility-manifest validator (both models)
    training_stack.py             version-pin capture (requirements parse + pip-freeze hash)
    hf_push.py                    HF Hub upload — STUB (honestly labeled; GPU-run follow-up)
  faithfulness-gate/
    generate-data.py              synthetic perturbation generator (the CI-tested piece)
    perturbations.py              pure perturbation primitives + the selfcheck case table
    train.py                      encoder-baseline training recipe (GPU + deps at runtime)
    eval.py                       held-out eval recipe; emits the manifest eval block
    manifest.json                 THE reproducibility artifact (schema example; pending-training)
  correction-intent/
    generate-data.py              synthetic morphology generator (CI-tested; mirrors #1581)
    morphology.py                 seed grammar: #1581 polarities + anti-fixtures
    train.py                      RoBERTa detection classifier (v1, issue #1738); causal-LM extraction is v2
    eval.py                       held-out detection F1 + span quality + p95 latency
    manifest.json                 THE reproducibility artifact (schema example; pending-training)
```

Both task trees share the same shape: a CI-tested seeded data generator (pure
CPU, small N), lazy-imported GPU train/eval recipes, and a pending `manifest.json`.
The actual GPU training runs + committed eval-number manifests are the
GPU-gated part — they land in the #1585 follow-up when the lab frees (see
`docs/model-lab.md`).

## Hardware envelope (sets the model-size policy)

| Operation | RTX 3090 (24 GB, Ampere — bf16 yes, FP8 no) |
|---|---|
| Encoder classifier fine-tune (DeBERTa-v3-large class, ~0.4B) | Trivial: full fine-tune, minutes–1h |
| Full fine-tune, causal LM | ≤ ~1.5B comfortably |
| LoRA (bf16 base) | ≤ ~8B |
| QLoRA (4-bit base + paged optimizer) | ≤ ~14B (bs 1–2 + grad-accum); ~30B-class technically possible but too slow to iterate — out of policy |
| Inference serving (Ollama / vLLM, 4-bit) | ~14B dense or ~30B-class MoE, one model at a time |

**Policy: target models ≤ 4B for these two tasks** — they are classification, not generation, so small models + good data win. An 8B LoRA is an escape hatch if evals demand it. Anything larger needs a written justification in the manifest's `policyCompliance` block.

## Reproducibility status (this PR vs the GPU-run follow-up)

This PR ships the **reproducible software**: recipes, the version-pinned training
stack, the manifest schema, the data generators (both models), the eval harness
(held-out p95 latency + faithfulness F1 / correction-intent detection F1), and
the Remnic config pointers (`extractionFaithfulnessBaseUrl`, `correctionIntent*`).
Everything is unit-tested on CPU; **no GPU is required to land this PR.**

The **actual training runs + committed eval-number manifests are GPU-gated** —
they land in the #1585 follow-up when the lab box (RTX 3090) frees. Per rule 55
(#1520), no eval/accuracy/latency number appears in docs or a manifest without an
artifact from a real run; every committed manifest is explicitly `pending-training`
until then.

## Quickstart

### CI / data generation (no GPU, no `pip install`)

```bash
# Self-test every perturbation against hand-written cases:
python model-lab/faithfulness-gate/generate-data.py --selfcheck

# Generate a seeded dataset (same seed → same sha256):
python model-lab/faithfulness-gate/generate-data.py --seed 1337 --out /tmp/faith --yes
# → DATASET_SHA256=<hex>  (stdout, machine-parseable)
```

The determinism contract — *same seed → byte-identical dataset → identical sha256* — is asserted by `tests/model-lab-faithfulness-data.test.mjs`, which shells out to `generate-data.py` and is capability-guarded on `python3` via `tests/helpers/capability-probe.mjs` (skip-with-reason locally; `REMNIC_REQUIRE_CAPABILITY_TESTS=1` forbids skipping in CI).

### Lab box (GPU + deps)

```bash
bash model-lab/setup.sh
source model-lab/.venv/bin/activate

python model-lab/faithfulness-gate/generate-data.py --seed 1337 --yes   # → faithfulness-gate/data/ (sha256 in the manifest)
python model-lab/faithfulness-gate/train.py --version-tag v1 \
    --base-model roberta-large-mnli --mixed-precision fp32 --epochs 12 --learning-rate 1e-5   # → model-lab/runs/faithfulness-gate/v1/
python model-lab/faithfulness-gate/eval.py --version-tag v1             # → manifest eval block (macro-F1 + p95 latency)
#
# Real v1 numbers (RTX 3090): held-out macro-F1 1.0, p95 9.93 ms. See
# docs/model-lab.md (Results) + model-lab/faithfulness-gate/manifest.json.
```

`train.py` / `eval.py` lazy-import the GPU stack so `--help` works on a bare machine. `train.py` exits with code 2 and an install hint if `torch`/`transformers` are missing. `eval.py`'s GPU gate is scoped to the inference path (no `--predictions`): offline scoring of pre-computed predictions is JSONL + stdlib only and runs CPU-only; the inline inference loop (which loads the checkpoint) gates the GPU stack. **They never run in CI.**

## Reproducibility model

* **git carries recipes + hashes, never blobs.** `model-lab/**/data/`, `model-lab/**/runs/`, `*.safetensors`, `*.gguf` are gitignored.
* **The manifest is the only committed artifact for a trained model.** `manifest.json` carries `{task, baseModel, dataRecipe, trainingStack, hyperparams, hardware, eval, artifact, policyCompliance}` — validated by `common/manifest_schema.py`. The committed manifests ship as the **schema example** with every eval/weight/training-stack field explicitly `null`/`pending` (rule 55: no fabricated numbers); a real GPU run fills them and `validate_manifest(..., allow_pending=False)` must pass before publish.
* **The sha256 is the reproducibility check.** Re-running `generate-data.py --seed <s>` must reproduce `datasetSha256`; the manifest records it so a future operator can verify the dataset they regenerated matches the one a model was trained on.

## Privacy + consent

* The **harvest stream** (teacher labels from shadow mode) is not implemented and never was — the deleted `harvest-shadow-logs.py` stubs (#2847) were dead code, and the #1585 GPU-run work landed with synthetic-data training only. Shadow verdicts are already recorded (`extraction-persist.ts`, #1576); harvesting them into training data is a separate, unscheduled enhancement (#2852), opt-in and local-only by design.
* Teacher-model outputs ("LLM traces") live under the gitignored data dir like everything else.
