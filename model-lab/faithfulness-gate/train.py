#!/usr/bin/env python3
"""Faithfulness-gate training recipe (issue #1585 PR2; scaffold in PR1).

Trains the encoder baseline — DeBERTa-v3-large with a 3-way classification
head — on the synthetic dataset produced by ``generate-data.py``. The model
maps the :class:`FaithfulnessCheckInput` contract (``factText``, ``quote``,
``context`` → ``entailed`` / ``contradicted`` / ``unsupported``) so Remnic's
``extraction.faithfulnessModel`` config can point at the served checkpoint.

Hardware + dependencies
-----------------------
This recipe requires a CUDA GPU and the pinned stack in
``model-lab/requirements.txt``. **It does NOT run in CI** — CI only
exercises the seeded data generator's determinism. Heavy imports are lazy so
``python train.py --help`` works on a bare machine; the actual training entry
point raises a clear install hint if torch/transformers are missing.

Reproducibility
---------------
Every value that affects the resulting weights is captured by argparse and
mirrored into the manifest's ``hyperparams`` / ``hardware`` blocks in PR2, so
a manifest can reproduce its own eval numbers (issue #1585 pitfall: "a
manifest that can't reproduce its own eval numbers is a bug").
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

from common.jsonl_schema import LABEL_TO_ID, LABELS  # noqa: E402

#: First-choice base (issue #1585): cheap, deterministic, ~1.6 GB serving.
DEFAULT_BASE_MODEL = "microsoft/deberta-v3-large"
DEFAULT_DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_RUNS_DIR = Path(__file__).resolve().parents[1] / "runs" / "faithfulness-gate"


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

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="train.py",
        description="Train the faithfulness-gate encoder baseline (issue #1585 PR2).",
    )
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR,
                        help=f"training data directory (default: {DEFAULT_DATA_DIR})")
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR,
                        help=f"output runs directory (default: {DEFAULT_RUNS_DIR})")
    parser.add_argument("--base-model", type=str, default=DEFAULT_BASE_MODEL,
                        help=f"Hugging Face base model id (default: {DEFAULT_BASE_MODEL})")
    parser.add_argument("--seed", type=int, default=1337, help="training seed (default: 1337)")
    parser.add_argument("--epochs", type=int, default=3, help="epochs (default: 3)")
    parser.add_argument("--train-batch-size", type=int, default=16)
    parser.add_argument("--eval-batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--max-length", type=int, default=256,
                        help="max tokens for (factText [SEP] quote [SEP] context)")
    parser.add_argument("--label-smoothing", type=float, default=0.0)
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
    )


def require_training_deps() -> None:
    """Lazy-import the training stack; exit(2) with an install hint if missing.

    Heavy imports happen here, after argparse, so ``train.py --help`` works
    on a bare machine. A missing stack is a missing prerequisite, not a
    crash — exit code 2 distinguishes it from a normal run failure.
    """
    missing: list[str] = []
    for module in ("torch", "transformers", "datasets", "sklearn"):
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


def featurize(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project JSONL rows into the (text, label_id) shape the Trainer eats.

    The concatenated text is ``factText [SEP] quote [SEP] context`` so the
    encoder attends to all three contract fields with a single sequence.
    """
    features: list[dict[str, Any]] = []
    for row in rows:
        if row["label"] not in LABEL_TO_ID:
            raise ValueError(f"row has unknown label {row['label']!r}")
        features.append({
            "text": " [SEP] ".join([row["factText"], row["quote"], row.get("context", "")]),
            "label": LABEL_TO_ID[row["label"]],
        })
    return features


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
        Trainer,
        TrainingArguments,
    )

    hyperparams = hyperparams_from_args(args)
    data_path = args.data_dir / "faithfulness-train.jsonl"
    if not data_path.exists():
        raise SystemExit(
            f"training data not found at {data_path}.\n"
            f"  generate it with: python model-lab/faithfulness-gate/generate-data.py "
            f"--seed {hyperparams.seed} --out {args.data_dir} --yes"
        )

    rows = load_jsonl(data_path)
    features = featurize(rows)
    dataset = Dataset.from_list(features)

    tokenizer = AutoTokenizer.from_pretrained(hyperparams.base_model)

    def tokenize(batch: dict[str, Any]) -> dict[str, Any]:
        return tokenizer(batch["text"], truncation=True, max_length=hyperparams.max_length)

    tokenized = dataset.map(tokenize, batched=True)

    split = tokenized.train_test_split(test_size=0.1, seed=hyperparams.seed)
    model = AutoModelForSequenceClassification.from_pretrained(
        hyperparams.base_model,
        num_labels=len(LABELS),
        id2label={index: label for label, index in LABEL_TO_ID.items()},
        label2id=LABEL_TO_ID,
    )

    out_dir = args.runs_dir / args.version_tag
    out_dir.mkdir(parents=True, exist_ok=True)
    training_args = TrainingArguments(
        output_dir=str(out_dir),
        num_train_epochs=hyperparams.epochs,
        per_device_train_batch_size=hyperparams.train_batch_size,
        per_device_eval_batch_size=hyperparams.eval_batch_size,
        learning_rate=hyperparams.learning_rate,
        warmup_ratio=hyperparams.warmup_ratio,
        weight_decay=hyperparams.weight_decay,
        label_smoothing_factor=hyperparams.label_smoothing,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        seed=hyperparams.seed,
        deterministic=True,
        use_cpu=not torch.cuda.is_available(),
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=split["train"],
        eval_dataset=split["test"],
        processing_class=tokenizer,
    )
    trainer.train()

    # The manifest's hyperparams/hardware blocks are written here in PR2;
    # PR1 ships only the recipe + the pending manifest schema example.
    print(json.dumps({
        "status": "trained",
        "runsDir": str(out_dir),
        "hyperparams": hyperparams.to_dict(),
        "labelSet": list(LABELS),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
