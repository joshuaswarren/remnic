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
import os
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
        help="Held-out JSONL (gold labels). Required to score.",
    )
    parser.add_argument(
        "--predictions",
        type=Path,
        help=(
            "Model-inference output JSONL (one row per held-out turn, with a "
            "'label' and optional 'corrections[]'). REQUIRED: scoring gold "
            "labels against themselves is refused (no fabricated evals, rule 55)."
        ),
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
    if len(rows) != len(pred_rows):
        raise ValueError(
            f"length mismatch: gold={len(rows)} pred={len(pred_rows)} "
            "(--held-out and --predictions must have one row per turn)"
        )
    overlaps: list[float] = []
    for gold, pred in zip(rows, pred_rows):
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


def _held_out_is_predictions(held_out: Path, predictions: Path) -> bool:
    """True when --predictions resolves to the same file as --held-out.

    Pure (no torch) so the guard is unit-testable; ``main`` calls this before
    loading rows. ``resolve()`` catches same-path and symlink circular eval;
    a HARD LINK (different path, same inode) is caught via ``os.path.samefile``
    which compares ``(st_dev, st_ino)`` (issue #1700 nit #4). Without it a hard
    link to the held-out file scores gold against itself and fabricates a
    perfect eval that could be copied into the manifest (codex P1, rule 55).
    """
    try:
        if held_out.resolve() == predictions.resolve():
            return True
    except OSError:
        # A broken symlink should not crash eval; the is_file() checks above
        # already rejected a missing predictions file.
        return False
    # Hard link: different path, same inode. resolve() misses it because the
    # two paths differ; os.path.samefile stats both and compares the inode
    # pair so it bites. (samefile follows symlinks, so a symlinked pair is
    # already handled by the resolve() check above.)
    try:
        if os.path.samefile(held_out, predictions):
            return True
    except OSError:
        pass
    return False

def _score_offline(args: argparse.Namespace) -> int:
    """Offline scoring: --predictions are pre-computed model-inference JSONL.

    Pure JSONL + stdlib metrics — no GPU stack needed (issue #1700 nit #1). The
    inference path (no --predictions) is gated separately in ``main``.
    """
    # Refuse the held-out file (or a symlink/hardlink to it) as --predictions:
    # scoring gold against itself emits perfect detection/span metrics with no
    # inference — a fabrication that could be copied into the manifest (codex
    # P1). _held_out_is_predictions compares RESOLVED paths AND inode equality
    # so a symlink, a relative/absolute alias, or a hard link cannot bypass it.
    if _held_out_is_predictions(args.held_out, args.predictions):
        print(
            "eval.py: --predictions resolves to the same file as --held-out.\n"
            "  Scoring gold labels against themselves is refused (no fabricated "
            "evals, rule 55). Point --predictions at model-inference output.",
            file=sys.stderr,
        )
        return 2

    gold_rows = load_jsonl(args.held_out)
    pred_rows = load_jsonl(args.predictions)
    block = correction_held_out_block(
        _gold_labels(gold_rows),
        _gold_labels(pred_rows),
        span_overlaps=_span_overlaps(gold_rows, pred_rows),
    )

    out: dict[str, Any] = {"heldOut": block}
    if args.latency_samples and args.latency_samples.is_file():
        samples = [float(x) for x in args.latency_samples.read_text().splitlines() if x.strip()]
        if samples:
            out["heldOutLatencyMs"] = summarize(samples)
        else:
            print("eval.py: --latency-samples file has no non-blank lines; skipping latency block.", file=sys.stderr)

    print(json.dumps({"task": "correction-intent", "eval": out}, indent=2))
    print(
        "\nNOTE: downstream number (MemCorrect #1584 false_apply / uptake@next) "
        "comes from the #1574 bench ablation, not this script. See docs/model-lab.md.",
        file=sys.stderr,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if not args.held_out or not args.held_out.is_file():
        print(
            "eval.py: --held-out <gold.jsonl> is required to score the model.\n"
            "  No manifest eval block is written without a real run (rule 55).",
            file=sys.stderr,
        )
        return 2

    # Offline-scoring path (issue #1700 nit #1): pre-computed model-inference
    # predictions are supplied. The scoring math is JSONL + stdlib only, so it
    # runs on a CPU-only host WITHOUT the GPU stack — require_eval_deps() is
    # NOT called here. The inference path below is the one that loads the
    # trained checkpoint and runs forward passes, which is what actually needs
    # torch/transformers; the gate is scoped to that path.
    if args.predictions is not None:
        # predictions was SUPPLIED. The offline-scoring path does not need the
        # GPU stack, so a missing/not-a-file path must surface as a bad-path
        # error -- not a missing-torch error on a CPU-only host (codex P2
        # PRRT_kwDORJXyws6O6gBM: a typoed --predictions path used to fall through
        # to the inference branch and gate the GPU stack first).
        if not args.predictions.is_file():
            print(
                "eval.py: --predictions <model-output.jsonl> is not a readable file.\n"
                f"  supplied path: {args.predictions}\n"
                "  Check the path and re-run; offline scoring needs pre-computed predictions.",
                file=sys.stderr,
            )
            return 2
        return _score_offline(args)

    # Inference path (no --predictions): generate predictions by running the
    # trained checkpoint over the held-out split. This is the GPU-gated path —
    # require_eval_deps() fires here so the stack is checked before any model
    # load. The inline inference loop lands in the #1585 GPU-run follow-up;
    # until then, refuse with a clear pointer so a half-wired inference cannot
    # be scored as a real eval (rule 55). An operator with a served model passes
    # its JSONL output via --predictions (the offline path above).
    require_eval_deps()
    print(
        "eval.py: --predictions <model-output.jsonl> is required to score.\n"
        "  Offline scoring needs pre-computed predictions; the inline inference\n"
        "  loop (trained checkpoint -> held-out predictions) lands in the #1585\n"
        "  GPU-run follow-up. Run inference first and pass its JSONL here.",
        file=sys.stderr,
    )
    return 2

if __name__ == "__main__":
    sys.exit(main())
