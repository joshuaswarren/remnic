#!/usr/bin/env python3
"""Correction-intent training recipe (issue #1585 PR3 / #1738; grammar in morphology.py).

Trains a detection classifier — a RoBERTa-large encoder with a 2-way head —
on the synthetic conversation dataset produced by ``generate-data.py``. The
model maps the :class:`PassiveCorrection` contract from #1581 (a small
prior-turn window + the turn under inspection → ``correction`` / ``none``) so
the #1581 passive-correction detector can route on the served checkpoint.

v1 is DETECTION ONLY: it predicts whether a turn expresses a correction, not
the structured ``corrections[]`` block (targetHint / correctedAssertion /
polarity). Issue #1738 records that the original #1585 plan called for a ≤4B
instruct causal LM (TRL/LoRA) emitting the full JSON block, but two facts
changed that for v1:

1. ``trl==0.16.6`` / ``bitsandbytes==0.44.1`` (the pre-#1737 pins) DO NOT
   EXIST on PyPI; the only resolvable trl (1.7.1) drags ``datasets`` 3.6 → 5.0
   and would break the faithfulness-gate v1 pinned stack in the shared venv.
2. Detection F1 is the eval GATE (#1585: "Detection F1 is the gate; span
   quality is the tiebreaker"), and ``roberta-large-mnli`` — the documented
   ≤4B fallback — already trained cleanly on this exact box for the
   faithfulness gate (#1737). DeBERTa-v3 NaNs in fp32 on CUDA (XPOS overflow)
   and is unusable here for the same reason documented there.

So v1 is a classification-head fine-tune (issue #1738: "classification head
fine-tune is fine — TRL/QLoRA NOT required if a plain Trainer suffices at this
scale"). The structured-extraction (correctedAssertion span) stream is the v2
causal-LM follow-up, recorded honestly in the manifest's ``eval.heldOut``
caveat (mean span overlap is 0 by construction because v1 emits no span).

Hardware + dependencies
-----------------------
This recipe requires a CUDA GPU and the pinned encoder stack in
``model-lab/requirements.txt``. **It does NOT run in CI** — CI only exercises
the seeded data generator's determinism. Heavy imports are lazy so
``python train.py --help`` works on a bare machine; the entry point raises a
clear install hint if torch/transformers are missing.

Reproducibility
---------------
Every value that affects the resulting weights is captured by argparse and
mirrored into the manifest's ``hyperparams`` / ``hardware`` blocks so a
manifest can reproduce its own eval numbers (issue #1585 pitfall: "a manifest
that can't reproduce its own eval numbers is a bug").
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

_MODEL_LAB_ROOT = Path(__file__).resolve().parents[1]
if str(_MODEL_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODEL_LAB_ROOT))

from common.eval_runner import detection_metrics  # noqa: E402

import morphology  # noqa: E402  (sibling module, same dir)

#: Stable label → integer class id (do not reorder; matches morphology.LABELS).
LABEL_TO_ID: dict[str, int] = {label: index for index, label in enumerate(morphology.LABELS)}
ID_TO_LABEL: dict[int, str] = {index: label for label, index in LABEL_TO_ID.items()}

#: Base model (issue #1738): the documented ≤4B fallback, fp32-stable (no
#: XPOS), already NLI-pretrained, and proven on this exact box for the
#: faithfulness gate (#1737). 0.355B — well within the ≤4B policy. The
#: original #1585 first-choice (a ≤4B instruct causal LM emitting JSON) is the
#: v2 extraction path; v1 is detection-only (see module docstring).
DEFAULT_BASE_MODEL = "roberta-large-mnli"
DEFAULT_DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_RUNS_DIR = Path(__file__).resolve().parents[1] / "runs" / "correction-intent"


@dataclass(frozen=True)
class TrainHyperparams:
    """Hyperparameters mirrored into ``manifest.json`` ``hyperparams``."""

    base_model: str
    seed: int
    epochs: int
    train_batch_size: int
    eval_batch_size: int
    learning_rate: float
    warmup_ratio: float
    weight_decay: float
    max_length: int
    label_smoothing: float
    mixed_precision: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="train.py",
        description="Train the correction-intent detection classifier (issue #1585 PR3 / #1738).",
    )
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR,
                        help=f"training data directory (default: {DEFAULT_DATA_DIR})")
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR,
                        help=f"output runs directory (default: {DEFAULT_RUNS_DIR})")
    parser.add_argument("--base-model", type=str, default=DEFAULT_BASE_MODEL,
                        help=f"Hugging Face base model id (default: {DEFAULT_BASE_MODEL})")
    parser.add_argument("--seed", type=int, default=1337, help="training seed (default: 1337)")
    parser.add_argument("--epochs", type=int, default=12, help="epochs (default: 12)")
    parser.add_argument("--train-batch-size", type=int, default=16)
    parser.add_argument("--eval-batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--max-length", type=int, default=128,
                        help="max tokens for the joined turn window")
    parser.add_argument("--label-smoothing", type=float, default=0.0)
    parser.add_argument("--mixed-precision", choices=("fp32", "bf16"), default="fp32",
                        help="mixed precision: fp32 (default, stable for <=0.4B base) or "
                             "bf16 (escape hatch). fp32 mirrors the faithfulness-gate v1 run "
                             "(#1737): RoBERTa is fp32-stable and the freshly-initialized "
                             "2-way head needs fp32 gradients to converge on small data.")
    parser.add_argument("--version-tag", type=str, default="v1",
                        help="artifact version tag (names the runs subdir)")
    return parser


def hyperparams_from_args(args: argparse.Namespace) -> TrainHyperparams:
    return TrainHyperparams(
        base_model=args.base_model,
        seed=args.seed,
        epochs=args.epochs,
        train_batch_size=args.train_batch_size,
        eval_batch_size=args.eval_batch_size,
        learning_rate=args.learning_rate,
        warmup_ratio=args.warmup_ratio,
        weight_decay=args.weight_decay,
        max_length=args.max_length,
        label_smoothing=args.label_smoothing,
        mixed_precision=args.mixed_precision,
    )


def require_training_deps() -> None:
    """Lazy-import the training stack; exit(2) with an install hint if missing.

    Heavy imports happen here, after argparse, so ``train.py --help`` works
    on a bare machine. A missing stack is a missing prerequisite, not a
    crash — exit code 2 distinguishes it from a normal run failure. v1 is a
    classification-head fine-tune (issue #1738): it needs the same encoder
    Trainer stack as the faithfulness gate, NOT trl/peft.
    """
    missing: list[str] = []
    for module in ("torch", "transformers", "datasets"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        print(
            "train.py requires the GPU training stack, which is not installed.\n"
            f"  missing: {', '.join(missing)}\n"
            "  install: pip install -r model-lab/requirements.txt\n"
            "  docs:    model-lab/README.md (hardware envelope + quickstart)\n"
            "v1 is a classification-head fine-tune (issue #1738): it shares the\n"
            "faithfulness-gate encoder stack, not the trl/peft causal-LM stack.\n"
            "This recipe never runs in CI — only the seeded data generator does.",
            file=sys.stderr,
        )
        raise SystemExit(2)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def turns_to_text(turns: list[dict[str, str]]) -> str:
    """Flatten a conversation window into one encoder sequence.

    The prior window + the turn under inspection are joined with `` [SEP] ``
    so a single RoBERTa sequence attends to all of them. The LAST turn is the
    one the classifier verdicts; the prior turns give disambiguating context
    (mirrors #1581's small prior-turn window). Only turn ``content`` is kept —
    every turn in the seed grammar is a ``user`` turn, so ``role`` carries no
    signal and would just waste token budget.
    """
    return " [SEP] ".join(str(turn.get("content", "")) for turn in turns)


def featurize(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project JSONL rows into the (text, label_id) shape the Trainer eats."""
    features: list[dict[str, Any]] = []
    for row in rows:
        label = row["label"]
        if label not in LABEL_TO_ID:
            raise ValueError(f"row has unknown label {label!r}")
        features.append({
            "text": turns_to_text(row["turns"]),
            # HF Trainer forwards dataset columns matching the model's forward
            # signature; AutoModelForSequenceClassification expects "labels".
            "labels": LABEL_TO_ID[label],
        })
    return features


def compute_metrics(eval_pred: tuple[Any, Any]) -> dict[str, float]:
    """Macro-F1 over the two detection labels — backs ``metric_for_best_model='f1'``.

    The metric math is the shared ``common.eval_runner.detection_metrics`` so
    the number that selects the best checkpoint is computed by the same code
    as ``eval.py`` and the CI probe (the gate is detection F1; the tiebreaker
    span metric is computed by eval.py over the held-out, not per-epoch).
    numpy ships transitively with the torch install.
    """
    import numpy as np  # noqa: E402  (lazy; not a CI dep)

    logits, label_ids = eval_pred
    pred_ids = np.argmax(logits, axis=-1).tolist()
    gold = [ID_TO_LABEL[index] for index in label_ids]
    pred = [ID_TO_LABEL[index] for index in pred_ids]
    metrics = detection_metrics(gold, pred)
    return {"f1": round(sum(metrics[label]["f1"] for label in metrics) / len(metrics), 6)}


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    require_training_deps()  # lazy; raises SystemExit with an install hint.

    # Heavy imports happen only after the dependency gate so --help never
    # needs them.
    import torch  # type: ignore  # noqa: E402
    from datasets import Dataset  # type: ignore  # noqa: E402
    from transformers import (  # type: ignore  # noqa: E402
        AutoModelForSequenceClassification,
        AutoTokenizer,
        DataCollatorWithPadding,
        Trainer,
        TrainingArguments,
    )

    hyperparams = hyperparams_from_args(args)
    data_path = args.data_dir / "train.jsonl"
    if not data_path.exists():
        raise SystemExit(
            f"training data not found at {data_path}.\n"
            f"  generate it with: python model-lab/correction-intent/generate-data.py "
            f"--seed {hyperparams.seed} --out {args.data_dir} --yes"
        )

    rows = load_jsonl(data_path)
    # Split the *raw* rows first so the held-out gold keeps the original
    # (turns, label, corrections) shape eval.py scores against (the span
    # overlap metric reads gold corrections[]). The Trainer's train/eval
    # datasets are featurized + tokenized views below.
    raw_dataset = Dataset.from_list(rows)
    split = raw_dataset.train_test_split(test_size=0.1, seed=hyperparams.seed)

    tokenizer = AutoTokenizer.from_pretrained(hyperparams.base_model)

    def tokenize(batch: dict[str, Any]) -> dict[str, Any]:
        return tokenizer(batch["text"], truncation=True, max_length=hyperparams.max_length)

    train_tokenized = Dataset.from_list(featurize(list(split["train"]))).map(tokenize, batched=True)
    test_tokenized = Dataset.from_list(featurize(list(split["test"]))).map(tokenize, batched=True)
    # ``ignore_mismatched_sizes=True``: roberta-large-mnli ships a 3-way NLI
    # head; we want a 2-way detection head, so the classifier.out_proj is
    # shape-mismatched and must be reinitialized (the encoder weights transfer
    # unchanged). transformers 5.x raises on a mismatch unless this is set.
    model = AutoModelForSequenceClassification.from_pretrained(
        hyperparams.base_model,
        num_labels=len(morphology.LABELS),
        id2label=ID_TO_LABEL,
        label2id=LABEL_TO_ID,
        ignore_mismatched_sizes=True,
    )

    out_dir = args.runs_dir / args.version_tag
    out_dir.mkdir(parents=True, exist_ok=True)
    # bf16 is the operator-controlled escape hatch (--mixed-precision). It must
    # drive the Trainer's ``bf16`` flag (NOT ``fp16``): setting fp16=True would
    # run FP16 mixed precision, a different numerical mode than the documented
    # bf16 Ampere escape hatch, changing convergence + making the run
    # unreproducible from its manifest. fp32 (default) leaves both flags False
    # and mirrors the faithfulness-gate v1 run: RoBERTa is fp32-stable and the
    # freshly-initialized 2-way head needs fp32 gradients on small data.
    bf16 = hyperparams.mixed_precision == "bf16"
    training_args = TrainingArguments(
        output_dir=str(out_dir),
        num_train_epochs=hyperparams.epochs,
        per_device_train_batch_size=hyperparams.train_batch_size,
        per_device_eval_batch_size=hyperparams.eval_batch_size,
        learning_rate=hyperparams.learning_rate,
        warmup_ratio=hyperparams.warmup_ratio,
        weight_decay=hyperparams.weight_decay,
        label_smoothing_factor=hyperparams.label_smoothing,
        bf16=bf16,
        # transformers 5.x API: ``eval_strategy`` (``evaluation_strategy`` was
        # removed in 5.0). Reproducibility comes from ``seed`` + ``data_seed``;
        # ``deterministic``/``full_determinism`` is omitted to avoid torch
        # deterministic-algorithm errors on some CUDA ops (the manifest
        # captures exact versions for full reproduction).
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        seed=hyperparams.seed,
        data_seed=hyperparams.seed,
        use_cpu=not torch.cuda.is_available(),
    )
    # Persist the held-out gold next to the checkpoint (version-scoped) so
    # eval.py defaults to <checkpoint>/correction-heldout.jsonl and an older
    # checkpoint is never scored against a newer run's split. The full record
    # (turns + corrections[]) is kept so eval.py can compute the span-overlap
    # tiebreaker against gold correctedAssertions.
    heldout_path = out_dir / "correction-heldout.jsonl"
    with heldout_path.open("w", encoding="utf-8") as handle:
        for example in split["test"]:
            handle.write(json.dumps({
                "turns": example["turns"],
                "label": example["label"],
                "corrections": example.get("corrections", []),
                "morphology": example.get("morphology", ""),
                "sourceId": example.get("sourceId", ""),
            }, sort_keys=True, ensure_ascii=False) + "\n")

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_tokenized,
        eval_dataset=test_tokenized,
        # transformers 5.x API: ``processing_class`` (``tokenizer`` was removed
        # in 5.0). compute_metrics backs ``metric_for_best_model='f1'``.
        # DataCollatorWithPadding pads per-batch (tokenize uses truncation
        # only) so variable-length input_ids stack into a batch tensor.
        processing_class=tokenizer,
        compute_metrics=compute_metrics,
        data_collator=DataCollatorWithPadding(tokenizer=tokenizer),
    )
    trainer.train()

    # Persist a from_pretrained()-loadable model + tokenizer at the version root
    # so eval.py's ``from_pretrained(str(checkpoint))`` resolves (Trainer only
    # writes epoch checkpoints under <output_dir>/checkpoint-*, not the root).
    trainer.save_model(str(out_dir))
    tokenizer.save_pretrained(str(out_dir))

    print(json.dumps({
        "status": "trained",
        "runsDir": str(out_dir),
        "hyperparams": hyperparams.to_dict(),
        "labelSet": list(morphology.LABELS),
        "heldOut": str(heldout_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
