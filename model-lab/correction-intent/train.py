#!/usr/bin/env python3
"""Correction-intent training recipe (issue #1585 PR3; scaffold grammar in morphology.py).

Fine-tunes a ≤4B instruct causal LM to emit the #1581 ``corrections[]`` block
as JSON-schema output. Per issue #1585's policy table, this task is structured
extraction (an encoder can't emit the spans), so a small instruct LM is the
right shape — target ≤4B, with an 8B LoRA escape hatch if evals demand it.

Heavy imports (torch / transformers / trl / peft) are LAZY so ``--help`` works
on a bare machine and the recipe never runs in CI. The entry point exits with
code 2 + an install hint if the training stack is missing.

NEVER runs in CI (issue #1585 pitfall). The only CI hooks are the seeded
generator's determinism + morphology selftest (pure CPU, small N).
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

from common.training_stack import (  # noqa: E402
    capture_training_stack,
    requirements_versions,
)

#: First-choice base (issue #1585): a ≤4B instruct LM with reliable JSON output.
#: Qwen2.5-3B-Instruct is the canonical pick; operators may swap for any ≤4B
#: instruct model the policy table permits.
DEFAULT_BASE_MODEL = "Qwen/Qwen2.5-3B-Instruct"
DEFAULT_DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_RUNS_DIR = Path(__file__).resolve().parents[1] / "runs" / "correction-intent"


@dataclass(frozen=True)
class TrainHyperparams:
    """Hyperparameters mirrored into ``manifest.json`` ``hyperparams``."""
    base_model: str
    method: str  # "full" | "lora"
    epochs: float
    learning_rate: float
    batch_size: int
    grad_accum_steps: int
    max_seq_len: int
    lora_rank: int | None
    warmup_ratio: float
    weight_decay: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Correction-intent training recipe (issue #1585 PR3).",
    )
    parser.add_argument("--base-model", default=DEFAULT_BASE_MODEL, help="HF base model id.")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR)
    parser.add_argument("--version-tag", default="v1", help="Output subdir under runs/.")
    parser.add_argument("--method", choices=("full", "lora"), default="lora",
                        help="full fine-tune or LoRA (default — policy-table ≤8B).")
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--grad-accum-steps", type=int, default=4)
    parser.add_argument("--max-seq-len", type=int, default=2048)
    parser.add_argument("--lora-rank", type=int, default=16)
    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    return parser


def hyperparams_from_args(args: argparse.Namespace) -> TrainHyperparams:
    return TrainHyperparams(
        base_model=args.base_model,
        method=args.method,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        batch_size=args.batch_size,
        grad_accum_steps=args.grad_accum_steps,
        max_seq_len=args.max_seq_len,
        lora_rank=args.lora_rank if args.method == "lora" else None,
        warmup_ratio=args.warmup_ratio,
        weight_decay=args.weight_decay,
    )


def require_training_deps() -> None:
    """Lazy-import the training stack; exit(2) with an install hint if missing."""
    missing: list[str] = []
    for mod in ("torch", "transformers", "trl", "peft", "datasets"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        print(
            "train.py: training stack missing (" + ", ".join(missing) + ").\n"
            "  install with:  bash model-lab/setup.sh && source model-lab/.venv/bin/activate\n"
            "  (the correction-intent recipe needs the trl/peft causal-LM stack)\n"
            "  This script never runs in CI (issue #1585).",
            file=sys.stderr,
        )
        raise SystemExit(2)


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    if args.version_tag != "v1":
        print(f"[train] version-tag {args.version_tag} — policy allows ≤4B; LoRA ≤8B only", file=sys.stderr)

    # Fail fast on a missing data dir before touching the GPU stack.
    train_path = args.data_dir / "train.jsonl"
    if not train_path.is_file():
        print(f"train.py: {train_path} not found. run generate-data.py first.", file=sys.stderr)
        return 2

    require_training_deps()
    hp = hyperparams_from_args(args)

    # The actual fine-tune is GPU-gated (issue #1585 follow-up). This recipe
    # captures the reproducibility contract (pinned stack + hyperparams) and
    # exits with a clear pointer to where the trained weights land. The train
    # loop itself is implemented in the #1585 GPU-run follow-up.
    req_versions = requirements_versions(_MODEL_LAB_ROOT / "requirements.txt")
    stack = capture_training_stack()
    print(json.dumps({
        "task": "correction-intent",
        "status": "recipe-ready-not-run",
        "hyperparams": hp.to_dict(),
        "trainingStack": stack,
        "requirementsPin": req_versions,
        "$comment": (
            "Reproducibility contract captured. The fine-tune loop lands in the "
            "#1585 GPU-run follow-up when the lab frees. Weights publish to the "
            "operator's HF account (common/hf_push.py); git carries recipes + "
            "hashes, never blobs."
        ),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
