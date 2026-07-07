#!/usr/bin/env python3
"""Correction-intent evaluation recipe (issue #1585 PR3 / #1738; grammar in morphology.py).

Scores a trained checkpoint on the held-out split and emits the manifest's
``eval.heldOut`` block: detection F1 (correction vs none) + mean span overlap +
per-call p95 latency. The downstream number (MemCorrect #1584 ``false_apply``
and ``uptake@next`` in passive-queue mode) is orchestrated by the bench
harness, not this script — ``eval.py`` only computes the held-out metrics and
prints a clear pointer to where the downstream number comes from.

Two scoring paths:

* **Inline inference** (no ``--predictions``): loads the trained checkpoint,
  runs a forward pass per held-out turn, measures per-call GPU latency, and
  scores. This is the GPU-gated path used on the lab box (mirrors the
  faithfulness-gate v1 eval, #1737).
* **Offline scoring** (``--predictions <model-output.jsonl>``): scores
  pre-computed model-inference JSONL with pure stdlib metrics — no GPU stack
  needed, runs on a CPU-only host. The same-file guard (issue #1717) refuses
  to score the held-out file against itself so a perfect-but-fabricated eval
  cannot be copied into a manifest (rule 55).

v1 is DETECTION ONLY (issue #1738): the classifier predicts {correction,
none} and emits NO correctedAssertion span, so the predicted ``corrections[]``
is empty and mean span overlap is 0 by construction for gold-correction rows.
This is reported honestly — span extraction is the v2 causal-LM follow-up,
tracked in the manifest caveat. Detection F1 is the gate.

Hardware + dependencies: the inline path requires the GPU stack from
``model-lab/requirements.txt``; heavy imports are lazy so ``--help`` works on
a bare machine. The offline path is stdlib-only. Never runs in CI.

The detection-F1 + span-overlap math itself lives in ``common/eval_runner.py``
(stdlib-only) so the metric definitions are identical between this script and
any offline/CI sanity check.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Mapping

_MODEL_LAB_ROOT = Path(__file__).resolve().parents[1]
if str(_MODEL_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODEL_LAB_ROOT))
# morphology is a sibling module in this dir; add it to sys.path too so the
# import resolves both when run as a script AND when exec'd as a module by the
# eval-guard test (which only puts model-lab/ on the path).
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from common.eval_runner import correction_held_out_block, span_overlap  # noqa: E402
from common.latency import summarize  # noqa: E402

import morphology  # noqa: E402  (sibling module, same dir)

DEFAULT_RUNS_DIR = Path(__file__).resolve().parents[1] / "runs" / "correction-intent"

#: Stable label → integer class id; must match train.py's encoding.
LABEL_TO_ID: dict[str, int] = {label: index for index, label in enumerate(morphology.LABELS)}
ID_TO_LABEL: dict[int, str] = {index: label for label, index in LABEL_TO_ID.items()}


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="eval.py",
        description="Correction-intent held-out evaluation (issue #1585 PR3 / #1738).",
    )
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR)
    parser.add_argument("--version-tag", default="v1",
                        help="artifact version tag (selects the runs subdir + default held-out).")
    parser.add_argument(
        "--held-out",
        type=Path,
        help="Held-out JSONL (gold labels). Defaults to "
             "<runs-dir>/<version-tag>/correction-heldout.jsonl (written by train.py).",
    )
    parser.add_argument(
        "--predictions",
        type=Path,
        help=(
            "Offline-scoring path: pre-computed model-inference JSONL (one row per "
            "held-out turn, with a 'label' and optional 'corrections[]'). REQUIRED to "
            "score on a CPU-only host. When OMITTED, the inline path loads the trained "
            "checkpoint and runs inference (GPU-gated). Scoring gold labels against "
            "themselves is refused (no fabricated evals, rule 55)."
        ),
    )
    parser.add_argument(
        "--max-length", type=int, default=128,
        help="max tokens for the joined turn window (inline path; must match train.py).",
    )
    parser.add_argument(
        "--latency-samples", type=Path,
        help="Offline path only: file of per-call latency samples (ms, one per line) "
             "from a separately-run inference, for the held-out p95 latency block. "
             "The inline path measures latency itself and ignores this.",
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
            "eval.py: inline-inference stack missing (" + ", ".join(missing) + ").\n"
            "  install with:  bash model-lab/setup.sh && source model-lab/.venv/bin/activate\n"
            "  Or run the offline path: pass --predictions <model-output.jsonl> (stdlib-only).\n"
            "  This inline path never runs in CI (issue #1585).",
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


def turns_to_text(turns: list[dict[str, str]]) -> str:
    """Flatten a conversation window into one encoder sequence (mirrors train.py)."""
    return " [SEP] ".join(str(turn.get("content", "")) for turn in turns)


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
    # Offline path: an operator who ran inference separately (e.g. a served
    # model over the held-out) attaches the per-call latency samples here so
    # the emitted eval block carries the documented p95 latency without the
    # GPU stack (the inline path measures latency itself; this is the side
    # channel for the CPU-only/offline workflow — issue #1700 nit #1).
    if args.latency_samples and args.latency_samples.is_file():
        samples = [float(x) for x in args.latency_samples.read_text().splitlines() if x.strip()]
        if samples:
            out["heldOut"]["latencyMs"] = summarize(samples)
        else:
            print("eval.py: --latency-samples file has no non-blank lines; skipping latency block.",
                  file=sys.stderr)
    print(json.dumps({"task": "correction-intent", "eval": out}, indent=2))
    print(
        "\nNOTE: downstream number (MemCorrect #1584 false_apply / uptake@next) "
        "comes from the #1574 bench ablation, not this script. See docs/model-lab.md.",
        file=sys.stderr,
    )
    return 0


def _score_inline(args: argparse.Namespace, held_out_path: Path) -> int:
    """Inline inference: load the trained checkpoint, score the held-out on GPU.

    Mirrors the faithfulness-gate v1 eval (#1737): forward one held-out turn at
    a time, measure per-call latency, and assemble the manifest ``eval.heldOut``
    block with detection F1 + mean span overlap + p95 latency. v1 is
    detection-only, so predictions carry an empty ``corrections[]`` and mean
    span overlap is 0 by construction (reported honestly).
    """
    require_eval_deps()
    import torch  # type: ignore  # noqa: E402
    from transformers import (  # type: ignore  # noqa: E402
        AutoModelForSequenceClassification,
        AutoTokenizer,
    )

    checkpoint = args.runs_dir / args.version_tag
    if not checkpoint.exists():
        print(
            f"eval.py: checkpoint not found at {checkpoint}.\n"
            f"  train first: python model-lab/correction-intent/train.py "
            f"--version-tag {args.version_tag}",
            file=sys.stderr,
        )
        return 2

    rows = load_jsonl(held_out_path)
    gold = _gold_labels(rows)

    # Load the tokenizer from the checkpoint train.py saved (it writes both
    # model + tokenizer to the version root) so eval always scores with the
    # vocab the model was trained on.
    tokenizer = AutoTokenizer.from_pretrained(str(checkpoint))
    model = AutoModelForSequenceClassification.from_pretrained(str(checkpoint))
    model.eval()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    predictions: list[str] = []

    def _forward(row: Mapping[str, Any]) -> int:
        text = turns_to_text(row["turns"])
        inputs = tokenizer(text, truncation=True, max_length=args.max_length,
                           return_tensors="pt")
        inputs = {key: value.to(device) for key, value in inputs.items()}
        logits = model(**inputs).logits
        return int(torch.argmax(logits, dim=-1).item())

    # Warm the accelerator (CUDA kernel compile / lazy init) on the first
    # example so one-time setup is not charged to the first timed prediction —
    # the latency distribution describes steady-state serving, not a cold start.
    with torch.no_grad():
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
            predictions.append(ID_TO_LABEL[predicted_id])

    # v1 is detection-only: build pred_rows with the predicted label and an
    # EMPTY corrections[] so the span-overlap metric is computed honestly
    # (overlap is 0 for every gold-correction row because v1 emits no span).
    pred_rows = [{"label": label, "corrections": []} for label in predictions]
    block = correction_held_out_block(
        gold,
        predictions,
        span_overlaps=_span_overlaps(rows, pred_rows),
    )
    block["latencyMs"] = summarize(latencies_ms)
    block["spanExtraction"] = {
        "status": "not-applicable-v1",
        "$comment": (
            "v1 is a detection classifier (issue #1738); it predicts "
            "{correction, none} and emits NO correctedAssertion span, so "
            "meanSpanOverlap is 0 by construction. Span extraction is the v2 "
            "causal-LM follow-up (≤4B instruct LM emitting the corrections[] "
            "JSON block). Detection F1 is the eval gate."
        ),
    }
    print(json.dumps({
        "task": "correction-intent",
        "checkpoint": str(checkpoint),
        "eval": {
            "heldOut": block,
            "downstream": {
                "status": "external",
                "source": "bench harness (MemCorrect #1584 false_apply / uptake@next)",
            },
        },
    }, indent=2))
    print(
        "\nNOTE: downstream number (MemCorrect #1584 false_apply / uptake@next) "
        "comes from the #1574 bench ablation, not this script. See docs/model-lab.md.",
        file=sys.stderr,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    # Resolve the held-out gold path: explicit --held-out wins; otherwise
    # default to the version-scoped file train.py writes next to the checkpoint.
    held_out_path = args.held_out or (args.runs_dir / args.version_tag / "correction-heldout.jsonl")
    if not held_out_path.is_file():
        print(
            "eval.py: held-out gold file not found.\n"
            f"  looked at: {held_out_path}\n"
            "  train.py writes <runs-dir>/<version-tag>/correction-heldout.jsonl; "
            "run train first, or pass --held-out <gold.jsonl>.",
            file=sys.stderr,
        )
        return 2

    # Offline-scoring path (issue #1700 nit #1): pre-computed model-inference
    # predictions are supplied. The scoring math is JSONL + stdlib only, so it
    # runs on a CPU-only host WITHOUT the GPU stack — require_eval_deps() is
    # NOT called here. The inline path below is the one that loads the trained
    # checkpoint and runs forward passes, which is what actually needs
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
        args.held_out = held_out_path
        return _score_offline(args)

    # Inline-inference path (no --predictions): load the trained checkpoint and
    # run forward passes over the held-out split. This is the GPU-gated path
    # (mirrors the faithfulness-gate v1 eval, #1737).
    return _score_inline(args, held_out_path)


if __name__ == "__main__":
    sys.exit(main())
