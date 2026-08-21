"""Held-out evaluation runner (issue #1585 PR1).

Pure-stdlib metric helpers consumed by ``faithfulness-gate/eval.py`` (and,
later, ``correction-intent``). Kept dependency-free so the metric math is
unit-testable without torch/transformers and identical between the CI probe
and the GPU eval script — the same numbers that land in a manifest are
computable from a hand-checked fixture.
"""

from __future__ import annotations

from typing import Iterable, Mapping

from .jsonl_schema import LABELS


def _confusion(gold: Iterable[str], pred: Iterable[str]) -> Mapping[str, Mapping[str, int]]:
    """Nested map ``gold -> pred -> count`` over the three labels."""
    matrix: dict[str, dict[str, int]] = {label: {other: 0 for other in LABELS} for label in LABELS}
    for gold_label, pred_label in zip(gold, pred, strict=True):
        if gold_label not in matrix:
            raise ValueError(f"unknown gold label {gold_label!r}")
        if pred_label not in matrix[gold_label]:
            raise ValueError(f"unknown pred label {pred_label!r}")
        matrix[gold_label][pred_label] += 1
    return matrix


def per_class_metrics(gold: list[str], pred: list[str]) -> dict[str, dict[str, float]]:
    """Per-class precision / recall / f1 for the three entailment labels.

    Returns ``{label: {precision, recall, f1, support}}``. A class with no
    gold and no predicted examples scores 0.0 (defined behaviour, not a
    division by zero) and ``support`` reports the gold count.
    """
    if len(gold) != len(pred):
        raise ValueError(f"length mismatch: gold={len(gold)} pred={len(pred)}")
    matrix = _confusion(gold, pred)
    metrics: dict[str, dict[str, float]] = {}
    for label in LABELS:
        true_positive = matrix[label][label]
        predicted_total = sum(matrix[g][label] for g in LABELS)
        gold_total = sum(matrix[label][p] for p in LABELS)
        precision = true_positive / predicted_total if predicted_total else 0.0
        recall = true_positive / gold_total if gold_total else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        metrics[label] = {
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
            "support": float(gold_total),
        }
    return metrics


def macro_f1(per_class: Mapping[str, Mapping[str, float]]) -> float:
    """Macro-averaged F1 across the three labels (the PR2 held-out target)."""
    return round(sum(per_class[label]["f1"] for label in LABELS) / len(LABELS), 6)


def held_out_block(gold: list[str], pred: list[str]) -> dict[str, object]:
    """Assemble the manifest ``eval.heldOut`` block from gold/pred labels.

    This is the exact shape ``eval.py`` writes into ``manifest.json`` once a
    real model has scored the held-out split. PR1 only exercises the math;
    no manifest carries these numbers until PR2 trains (rule 55).
    """
    per_class = per_class_metrics(gold, pred)
    return {
        "macroF1": macro_f1(per_class),
        "perClass": per_class,
        "examples": len(gold),
    }


# ---------------------------------------------------------------------------
# Correction-intent metrics (issue #1581 / #1585 PR3)
# ---------------------------------------------------------------------------
#
# The correction-intent task is a detection problem at heart: given a turn
# (with a small prior-turn window), does it express a correction? The label
# space the model emits is the #1581 ``corrections[]`` block (or none), so the
# held-out metric is binary-detection F1 over {correction, none} PLUS span
# quality (does the model's correctedAssertion/targetHint overlap the gold
# span?). Detection F1 is the gate; span quality is the tiebreaker.


def detection_metrics(
    gold: list[str],
    pred: list[str],
    *,
    positive: str = "correction",
    negative: str = "none",
) -> dict[str, dict[str, float]]:
    """Binary detection precision/recall/F1 for {correction, none}.

    ``gold`` / ``pred`` are label sequences over {``positive``, ``negative``}.
    Returns ``{positive: {precision, recall, f1, support}, negative: {...}}``.
    A label not in the two-value set raises so a malformed dataset fails
    loudly rather than scoring as a silent third class.
    """
    if len(gold) != len(pred):
        raise ValueError(f"length mismatch: gold={len(gold)} pred={len(pred)}")
    valid = {positive, negative}
    tp = fp = fn = tn = 0
    for g, p in zip(gold, pred, strict=True):
        if g not in valid:
            raise ValueError(f"unknown gold label {g!r}; expected one of {valid!r}")
        if p not in valid:
            raise ValueError(f"unknown pred label {p!r}; expected one of {valid!r}")
        if p == positive and g == positive:
            tp += 1
        elif p == positive and g == negative:
            fp += 1
        elif p == negative and g == positive:
            fn += 1
        else:
            tn += 1

    def prf(tp_: int, fp_: int, fn_: int) -> dict[str, float]:
        precision = tp_ / (tp_ + fp_) if (tp_ + fp_) else 0.0
        recall = tp_ / (tp_ + fn_) if (tp_ + fn_) else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        return {
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
        }

    return {
        positive: {**prf(tp, fp, fn), "support": float(tp + fn)},
        negative: {**prf(tn, fn, fp), "support": float(fp + tn)},
    }


def span_overlap(pred: str, gold: str) -> float:
    """Token-overlap ratio (Jaccard) between a predicted span and the gold span.

    Correction-intent extraction emits ``correctedAssertion`` + ``targetHint``
    spans; a faithful model reproduces the gold span's tokens. Returns 1.0 on
    exact match, 0.0 on disjoint token sets. Case-insensitive, whitespace-split.
    """
    pt = set(pred.lower().split())
    gt = set(gold.lower().split())
    if not pt and not gt:
        return 1.0
    if not pt or not gt:
        return 0.0
    return round(len(pt & gt) / len(pt | gt), 6)


def correction_held_out_block(
    gold_labels: list[str],
    pred_labels: list[str],
    *,
    span_overlaps: list[float] | None = None,
) -> dict[str, object]:
    """Assemble the manifest ``eval.heldOut`` block for correction-intent.

    Detection F1 (the gate) + optional mean span-overlap (the tiebreaker).
    The downstream number (MemCorrect false_apply / uptake@next) comes from
    the #1584 ablation, not this function — ``eval.py`` only computes the
    held-out block and points at where the downstream number comes from.
    """
    metrics = detection_metrics(gold_labels, pred_labels)
    block: dict[str, object] = {
        "detection": metrics,
        "macroF1": round(
            sum(metrics[label]["f1"] for label in metrics) / len(metrics), 6
        ),
        "examples": len(gold_labels),
    }
    if span_overlaps:
        block["meanSpanOverlap"] = round(sum(span_overlaps) / len(span_overlaps), 6)
    return block
