#!/usr/bin/env python3
"""Faithfulness-gate evaluation recipe (issue #1585 PR2; scaffold in PR1).

Scores a trained checkpoint on the held-out split and emits the manifest's
``eval.heldOut`` block. The downstream ablation (plugging the served model
into ``extraction.faithfulnessModel`` and running the #1574 LoCoMo
adversarial-category protocol) is orchestrated by the bench harness, not
this script — ``eval.py`` only computes the held-out metrics and prints a
clear pointer to where the downstream number comes from.

Hardware + dependencies
-----------------------
Same as ``train.py``: requires the GPU stack from
``model-lab/requirements.txt``; heavy imports are lazy so ``--help`` works
on a bare machine. Never runs in CI.

The per-class F1 math itself lives in ``common/eval_runner.py`` (stdlib-only)
so the metric definitions are identical between this script and any
offline/CI sanity check — the numbers that land in a manifest are computable
from a hand-checked fixture.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_MODEL_LAB_ROOT = Path(__file__).resolve().parents[1]
if str(_MODEL_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODEL_LAB_ROOT))

from common.eval_runner import held_out_block  # noqa: E402
from common.jsonl_schema import LABELS  # noqa: E402

DEFAULT_RUNS_DIR = Path(__file__).resolve().parents[1] / "runs" / "faithfulness-gate"


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="eval.py",
        description="Score a trained faithfulness-gate checkpoint on the held-out split.",
    )
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR,
                        help=f"runs directory (default: {DEFAULT_RUNS_DIR})")
    parser.add_argument("--version-tag", type=str, default="v1",
                        help="artifact version tag (selects the runs subdir)")
    parser.add_argument("--data-dir", type=Path,
                        default=Path(__file__).resolve().parent / "data",
                        help="data directory holding the held-out gold JSONL")
    parser.add_argument("--held-out", type=Path,
                        help="held-out gold JSONL (default: <data-dir>/faithfulness-heldout.jsonl)")
    parser.add_argument("--base-model", type=str, default="microsoft/deberta-v3-large",
                        help="tokenizer/base id used at train time")
    parser.add_argument("--max-length", type=int, default=256)
    return parser


def require_eval_deps() -> None:
    """Lazy-import the eval stack; exit(2) with an install hint if missing."""
    missing: list[str] = []
    for module in ("torch", "transformers"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        print(
            "eval.py requires the GPU training stack, which is not installed.\n"
            f"  missing: {', '.join(missing)}\n"
            "  install: pip install -r model-lab/requirements.txt\n"
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


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    require_eval_deps()

    import torch  # type: ignore  # noqa: E402
    from transformers import AutoModelForSequenceClassification, AutoTokenizer  # type: ignore  # noqa: E402

    checkpoint = args.runs_dir / args.version_tag
    if not checkpoint.exists():
        raise SystemExit(
            f"checkpoint not found at {checkpoint}.\n"
            f"  train first: python model-lab/faithfulness-gate/train.py --version-tag {args.version_tag}"
        )

    held_out_path = args.held_out or (args.data_dir / "faithfulness-heldout.jsonl")
    if not held_out_path.exists():
        raise SystemExit(
            f"held-out gold file not found at {held_out_path}.\n"
            "  generate a held-out split with generate-data.py (different seed) "
            "or split it off at train time."
        )

    rows = load_jsonl(held_out_path)
    gold = [row["label"] for row in rows]

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    model = AutoModelForSequenceClassification.from_pretrained(str(checkpoint))
    model.eval()

    predictions: list[str] = []
    # Invert LABEL_TO_ID (label -> id) to (id -> label); matches the model's
    # trained id2label. enumerate(LABELS) gives the canonical id ordering.
    id_to_label = {label_id: label for label_id, label in enumerate(LABELS)}
    with torch.no_grad():
        for row in rows:
            text = " [SEP] ".join([row["factText"], row["quote"], row.get("context", "")])
            inputs = tokenizer(text, truncation=True, max_length=args.max_length,
                               return_tensors="pt")
            logits = model(**inputs).logits
            predicted_id = int(torch.argmax(logits, dim=-1).item())
            predictions.append(id_to_label[predicted_id])

    held_out = held_out_block(gold, predictions)
    print(json.dumps({
        "eval": {
            "heldOut": held_out,
            # The downstream number is produced by the #1574 bench protocol,
            # not this script — kept out of this block to avoid implying a
            # value eval.py does not measure (rule 55).
            "downstream": {
                "status": "external",
                "source": "bench harness (#1574 LoCoMo adversarial-category ablation)",
            },
        },
        "checkpoint": str(checkpoint),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
