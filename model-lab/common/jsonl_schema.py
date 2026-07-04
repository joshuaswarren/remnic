"""JSONL record schema for faithfulness-gate training data (issue #1585 PR1).

The record mirrors the :class:`FaithfulnessCheckInput` contract from issue
#1576 — ``(factText, quote, context)`` triple — plus the entailment verdict
and a ``perturbation`` provenance tag so a reviewer can see *why* a label is
trustworthy (perturbations are code, so labels are derivable, not annotated).

Pure stdlib; imported by ``faithfulness-gate/generate-data.py`` (writer),
``train.py`` / ``eval.py`` (readers), and the CI determinism probe.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Sequence

# Three-way entailment verdict — exactly the ``FaithfulnessVerdict`` type
# from issue #1576. Order is fixed for deterministic enumeration/encoding.
LABELS: tuple[str, ...] = ("entailed", "contradicted", "unsupported")

#: Map label -> integer class id (stable across train/eval; do not reorder).
LABEL_TO_ID: dict[str, int] = {label: index for index, label in enumerate(LABELS)}


@dataclass(frozen=True)
class FaithfulnessRecord:
    """One labeled (fact, quote, context) triple.

    Attributes:
        factText: The candidate fact to verify (the memory-extraction output).
        quote: The verified source span from provenance (issue #1575).
        context: Surrounding turn text (≤ ``faithfulnessContextChars``);
            empty string when no context was captured.
        label: One of :data:`LABELS`.
        perturbation: Provenance tag naming the transform that produced this
            record (``identity`` / ``paraphrase`` / ``entity_swap`` /
            ``negation_flip`` / ``date_shift`` / ``quantity_change`` /
            ``unrelated_quote``). Lets reviewers audit label provenance.
        sourceId: Stable id of the seed fixture this record derives from.
    """

    factText: str
    quote: str
    context: str
    label: str
    perturbation: str
    sourceId: str

    def to_jsonl_dict(self) -> dict[str, Any]:
        """Deterministic, sort-keyed dict for byte-stable JSONL output."""
        payload = asdict(self)
        return {key: payload[key] for key in (
            "factText", "quote", "context", "label", "perturbation", "sourceId",
        )}


def validate_record(record: FaithfulnessRecord) -> list[str]:
    """Return a list of human-readable validation errors (empty == valid)."""
    errors: list[str] = []
    if not isinstance(record.factText, str) or not record.factText.strip():
        errors.append("factText must be a non-empty string")
    if not isinstance(record.quote, str) or not record.quote.strip():
        errors.append("quote must be a non-empty string")
    if not isinstance(record.context, str):
        errors.append("context must be a string (empty allowed)")
    if record.label not in LABELS:
        errors.append(f"label must be one of {LABELS!r}, got {record.label!r}")
    if not record.perturbation:
        errors.append("perturbation tag is required for label provenance")
    if not record.sourceId:
        errors.append("sourceId is required")
    return errors


def assert_dataset(records: Sequence[FaithfulnessRecord]) -> None:
    """Validate every record; raise ``ValueError`` listing all errors at once."""
    all_errors: list[str] = []
    for index, record in enumerate(records):
        for error in validate_record(record):
            all_errors.append(f"record[{index}] ({record.sourceId}): {error}")
    if all_errors:
        raise ValueError("invalid dataset records:\n  " + "\n  ".join(all_errors))
