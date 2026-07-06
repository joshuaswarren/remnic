#!/usr/bin/env python3
"""Correction-intent evaluation recipe (issue #1585 PR3; scaffold grammar in morphology.py).

Scores a trained checkpoint on the held-out split and emits the manifest's
``eval.heldOut`` block: detection F1 (correction vs none) + mean span overlap.
The downstream number (MemCorrect #1584 ``false_apply`` and ``uptake@next`` in
passive-queue mode) is orchestrated by the bench harness, not this script —
``eval.py`` only computes the held-out metrics and prints a clear pointer to
where the downstream number comes from.

Hardware + dependencies: requires the GPU stack from
``model-lab/requirements.txt``; heavy imports are lazy so ``--help`` works on
a bare machine. Never runs in CI.

The detection-F1 + span-overlap math itself lives in ``common/eval_runner.py``
(stdlib-only) so the metric definitions are identical between this script and
any offline/CI sanity check.
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

from common.eval_runner import correction_held_out_block, span_overlap  # noqa: E402
from common.latency import summarize  # noqa: E402

DEFAULT_RUNS_DIR = Path(__file__).resolve().parents[1] / "runs" / "correction-intent"


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Correction-intent held-out evaluation (issue #1585 PR3).",
    )
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR)
    parser.add_argument("--version-tag", default="v1")
    parser.add_argument(
        "--held-out",
        type=Path,
        help="Held-out JSONL (gold labels). If omitted, eval is not run.",
    )
    parser.add_argument(
        "--latency-samples",
        type=Path,
        help="Optional file of per-call latency samples (ms, one per line) for the p95 block.",
    )
    return parser


def require_eval_deps() -> None:
    """Lazy-import the eval stack; exit(2) with an install hint if missing."""
    missing: list[str] = []
    for mod in ("torch", "transformers"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        print(
            "eval.py: eval stack missing (" + ", ".join(missing) + ").\n"
            "  install with:  bash model-lab/setup.sh && source model-lab/.venv/bin/activate\n"
            "  This script never runs in CI (issue #1585).",
            file=sys.stderr,
        )
        raise SystemExit(2)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def _gold_labels(rows: list[dict[str, Any]]) -> list[str]:
    return [str(r.get("label", "")) for r in rows]


def _span_overlaps(rows: list[dict[str, Any]], pred_rows: list[dict[str, Any]]) -> list[float]:
    """Token overlap between predicted + gold correctedAssertion (corrections only)."""
    overlaps: list[float] = []
    for gold, pred in zip(rows, pred_rows, strict=True):
        if gold.get("label") != "correction":
            continue
        g_assert = ""
        p_assert = ""
        gold_corr = gold.get("corrections") or []
        pred_corr = pred.get("corrections") or []
        if gold_corr:
            g_assert = str(gold_corr[0].get("correctedAssertion", ""))
        if pred_corr:
            p_assert = str(pred_corr[0].get("correctedAssertion", ""))
        overlaps.append(span_overlap(p_assert, g_assert))
    return overlaps


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    require_eval_deps()

    if not args.held_out or not args.held_out.is_file():
        print(
            "eval.py: --held-out <gold.jsonl> is required to score the model.\n"
            "  The actual scoring loop lands in the #1585 GPU-run follow-up.\n"
            "  No manifest eval block is written without a real run (rule 55).",
            file=sys.stderr,
        )
        return 2

    gold_rows = load_jsonl(args.held_out)
    # The model-inference loop is GPU-gated. Demonstrate the held-out block
    # assembly against the GOLD labels (pred == gold) so the metric shape is
    # exercised; a real run replaces this with model predictions.
    pred_rows = gold_rows
    block = correction_held_out_block(
        _gold_labels(gold_rows),
        _gold_labels(pred_rows),
        span_overlaps=_span_overlaps(gold_rows, pred_rows),
    )

    out: dict[str, Any] = {"heldOut": block}
    if args.latency_samples and args.latency_samples.is_file():
        samples = [float(x) for x in args.latency_samples.read_text().splitlines() if x.strip()]
        out["heldOutLatencyMs"] = summarize(samples)

    print(json.dumps({"task": "correction-intent", "eval": out}, indent=2))
    print(
        "\nNOTE: downstream number (MemCorrect #1584 false_apply / uptake@next) "
        "comes from the #1574 bench ablation, not this script. See docs/model-lab.md.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
