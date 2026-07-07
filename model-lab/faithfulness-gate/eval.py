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
import time
from pathlib import Path
from typing import Any, Mapping

_MODEL_LAB_ROOT = Path(__file__).resolve().parents[1]
if str(_MODEL_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODEL_LAB_ROOT))

from common.eval_runner import held_out_block  # noqa: E402
from common.latency import summarize  # noqa: E402
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
    parser.add_argument("--base-model", type=str, default=None,
                        help="tokenizer fallback id; by default the tokenizer is "
                             "loaded from the checkpoint train.py saved (so the eval "
                             "vocab always matches the trained model)")
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

    held_out_path = args.held_out or (checkpoint / "faithfulness-heldout.jsonl")
    if not held_out_path.exists():
        raise SystemExit(
            f"held-out gold file not found at {held_out_path}.\n"
            "  train.py writes this file next to the checkpoint "
            "(<checkpoint>/faithfulness-heldout.jsonl, version-scoped so an "
            "older checkpoint is never scored against a newer run's split); "
            "run train first, or pass --held-out to point at a separate gold JSONL."
        )

    rows = load_jsonl(held_out_path)
    gold = [row["label"] for row in rows]

    # Load the tokenizer from the checkpoint train.py saved (it writes both
    # model + tokenizer to the version root) so eval always scores with the
    # vocab the model was trained on; --base-model is an explicit fallback.
    tokenizer_src = args.base_model if args.base_model else str(checkpoint)
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_src)
    model = AutoModelForSequenceClassification.from_pretrained(str(checkpoint))
    model.eval()

    # Place the model on the accelerator when present so the held-out latency
    # (summarized below) reflects the GPU serving path the gate runs in
    # production, not a CPU fallback. Inputs move to the same device.
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    predictions: list[str] = []
    # Invert LABEL_TO_ID (label -> id) to (id -> label); matches the model's
    # trained id2label. enumerate(LABELS) gives the canonical id ordering.
    id_to_label = {label_id: label for label_id, label in enumerate(LABELS)}

    def _forward(row: Mapping[str, Any]) -> int:
        text = " [SEP] ".join([row["factText"], row["quote"], row.get("context", "")])
        inputs = tokenizer(text, truncation=True, max_length=args.max_length,
                           return_tensors="pt")
        inputs = {key: value.to(device) for key, value in inputs.items()}
        logits = model(**inputs).logits
        return int(torch.argmax(logits, dim=-1).item())

    # Warm the accelerator (CUDA kernel compile / lazy init) on the first
    # example so one-time setup is not charged to the first timed prediction —
    # the latency distribution should describe steady-state serving, not a
    # cold start. Guard on a non-empty split: an empty/whitespace-only held-out
    # JSONL would otherwise IndexError here (rows[0]) before the scoring loop,
    # which itself handles zero rows, can report an empty result (cursor review:
    # empty held-out must not crash eval).
    with torch.no_grad():
        if rows:
            _forward(rows[0])
            if torch.cuda.is_available():
                torch.cuda.synchronize()

    latencies_ms: list[float] = []
    with torch.no_grad():
        for row in rows:
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            started = time.perf_counter()
            predicted_id = _forward(row)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            latencies_ms.append((time.perf_counter() - started) * 1000.0)
            predictions.append(id_to_label[predicted_id])

    held_out = held_out_block(gold, predictions)
    # Per-call wall-clock over the held-out set (issue #1585 eval contract:
    # held-out p95 latency alongside accuracy). summarize() is the shared
    # stdlib percentile math (common.latency), identical to the served-
    # endpoint harness, so this number is directly comparable to a deployed
    # gate run through measure_endpoint_latencies.
    held_out["latencyMs"] = summarize(latencies_ms)
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
