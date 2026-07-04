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
