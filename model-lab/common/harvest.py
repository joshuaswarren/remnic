"""Consent-gated shadow-telemetry label harvester (issues #1576 / #1581 / #2852).

Turns persisted shadow telemetry into labeled training records for the two
model-lab tasks:

* ``faithfulness-gate`` — memory markdown with a ``faithfulness:`` frontmatter
  verdict (#1576) plus a verified ``sources[].quote`` span (#1575).
* ``correction-intent`` — persisted correction-plan JSON (#1581 durable output).

Contract (issue #2852):

* Opt-in, local-only, consent-gated. The CLI requires ``--consent`` plus
  explicit local ``--input`` / ``--out`` paths. Nothing here runs from the
  daemon, the build, or CI.
* Walks exactly the named directory. No vault scan, no home-dir discovery,
  no symlink follow.
* Privacy by projection: records are built field-by-field from an allowlist.
  Session keys, principals, namespaces, memory ids, model ids, and timestamps
  stay behind. Redacted (#1678) and never-store plans are skipped.
* Deterministic and idempotent: same input tree → byte-identical dataset AND
  manifest (no clocks, no absolute paths). Rows dedup on the training payload
  and emit in canonical-JSON order.
* Bounded: ``max_records`` caps the dataset; oversize text is skipped, never
  truncated.

Pure stdlib. The correction-intent schema is imported lazily so ``common/``
keeps no static dependency on a task directory.
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import Counter
from dataclasses import dataclass
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

from common.jsonl_schema import (
    LABELS as FAITHFULNESS_LABELS,
    FaithfulnessRecord,
    validate_record as validate_faithfulness_record,
)
from common.seeding import sha256_bytes, write_jsonl

TASKS: tuple[str, ...] = ("faithfulness-gate", "correction-intent")

TASK_INPUT_SUFFIX: dict[str, str] = {
    "faithfulness-gate": ".md",
    "correction-intent": ".json",
}

# Product #1576 teacher verdicts → training labels in jsonl_schema.LABELS.
TEACHER_VERDICT_TO_LABEL: dict[str, str] = {
    "entailed": "entailed",
    "contradicted": "contradicted",
    "unsupported": "unsupported",
}

PROVENANCE_TAG = "harvest-shadow-telemetry"

DEFAULT_MAX_RECORDS = 10_000
DEFAULT_MAX_TEXT_BYTES = 20_000

REDACTED_TEXT_PREFIX = "[redacted"

SENSITIVE_CLASSIFICATIONS: frozenset[str] = frozenset({"never_store"})
SENSITIVE_ACTION_KINDS: frozenset[str] = frozenset({"redaction_rule"})

HARVESTABLE_PLAN_STATUSES: frozenset[str] = frozenset(
    {"pending", "applying", "applied", "applied", "partial"}
)


def dataset_filename(task: str) -> str:
    return f"harvest-{task}.jsonl"


def manifest_filename(task: str) -> str:
    return f"harvest-{task}.manifest.json"


@dataclass(frozen=True)
class HarvestResult:
    """Everything a harvest run produced, minus any file content."""

    task: str
    rows: list[dict[str, Any]]
    label_counts: dict[str, int]
    skips: dict[str, int]
    input_files: int
    input_fingerprint: str
    deduped: int
    truncated: bool


def _canonical(row: dict[str, Any]) -> str:
    return json.dumps(row, sort_keys=True, ensure_ascii=False)


def _payload_key(row: dict[str, Any]) -> str:
    return _canonical({k: v for k, v in row.items() if k != "sourceId"})


def _iter_input_files(input_dir: Path, suffix: str) -> list[Path]:
    found: list[Path] = []
    for root, dirnames, filenames in os.walk(input_dir, followlinks=False):
        dirnames[:] = sorted(
            d for d in dirnames if not (Path(root) / d).is_symlink()
        )
        for name in sorted(filenames):
            path = Path(root) / name
            if path.suffix != suffix or path.is_symlink():
                continue
            found.append(path)
    found.sort(key=lambda p: p.relative_to(input_dir).as_posix())
    return found


def _input_fingerprint(files: list[Path], input_dir: Path) -> str:
    parts = [
        f"{path.relative_to(input_dir).as_posix()}:{sha256_bytes(path.read_bytes())}"
        for path in files
    ]
    return sha256_bytes("\n".join(parts).encode("utf-8"))


def parse_frontmatter(text: str) -> tuple[dict[str, str], str] | None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for index in range(1, len(lines)):
        if lines[index].strip() != "---":
            continue
        scalars: dict[str, str] = {}
        for line in lines[1:index]:
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            scalars[key.strip()] = value.strip()
        return scalars, "\n".join(lines[index + 1 :])
    return None


def _first_verified_quote(raw_sources: str | None) -> str:
    if not raw_sources:
        return ""
    try:
        sources = json.loads(raw_sources)
    except (json.JSONDecodeError, ValueError):
        return ""
    if not isinstance(sources, list):
        return ""
    for source in sources:
        if not isinstance(source, dict):
            continue
        quote = source.get("quote")
        if isinstance(quote, str) and quote.strip():
            return quote.strip()
    return ""


def build_faithfulness_record(
    markdown_text: str, fallback_id: str
) -> tuple[dict[str, Any] | None, str | None]:
    parsed = parse_frontmatter(markdown_text)
    if parsed is None:
        return None, "malformed"
    scalars, body = parsed
    raw_faithfulness = scalars.get("faithfulness")
    if not raw_faithfulness:
        return None, "no_telemetry"
    try:
        faithfulness = json.loads(raw_faithfulness)
    except (json.JSONDecodeError, ValueError):
        return None, "malformed"
    if not isinstance(faithfulness, dict):
        return None, "malformed"
    verdict = faithfulness.get("verdict")
    label = TEACHER_VERDICT_TO_LABEL.get(str(verdict) if verdict is not None else "")
    if label is None:
        return None, "non_teacher_verdict"
    quote = _first_verified_quote(scalars.get("sources"))
    if not quote:
        return None, "no_quote"
    fact_text = body.strip()
    if not fact_text:
        return None, "malformed"
    record = FaithfulnessRecord(
        factText=fact_text,
        quote=quote,
        context="",
        label=label,
        perturbation=PROVENANCE_TAG,
        sourceId=scalars.get("id") or fallback_id,
    )
    if validate_faithfulness_record(record):
        return None, "malformed"
    return record.to_jsonl_dict(), None


_MORPHOLOGY_MODULE: Any = None


def _load_morphology_module() -> Any:
    global _MORPHOLOGY_MODULE
    if _MORPHOLOGY_MODULE is not None:
        return _MORPHOLOGY_MODULE
    module_path = (
        Path(__file__).resolve().parents[1] / "correction-intent" / "morphology.py"
    )
    spec = spec_from_file_location("model_lab_correction_morphology", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(
            f"cannot load correction-intent schema from {module_path.name}"
        )
    module = module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _MORPHOLOGY_MODULE = module
    return module


def build_correction_record(
    plan: Any, fallback_id: str
) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(plan, dict):
        return None, "malformed"
    status = plan.get("status")
    if status not in HARVESTABLE_PLAN_STATUSES:
        return None, "discarded" if status == "discarded" else "malformed"
    classification = plan.get("classification")
    actions = plan.get("actions")
    if not isinstance(classification, str) or not isinstance(actions, list):
        return None, "malformed"
    if classification in SENSITIVE_CLASSIFICATIONS:
        return None, "sensitive"
    if any(
        isinstance(action, dict) and action.get("kind") in SENSITIVE_ACTION_KINDS
        for action in actions
    ):
        return None, "sensitive"
    request = plan.get("request")
    if not isinstance(request, dict):
        return None, "malformed"
    text = request.get("text")
    if not isinstance(text, str) or not text.strip():
        return None, "malformed"
    if text.startswith(REDACTED_TEXT_PREFIX):
        return None, "redacted"
    confidence = plan.get("confidence")
    if (
        isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not math.isfinite(confidence)
    ):
        return None, "malformed"
    cleaned = text.strip()
    morphology = _load_morphology_module()
    record = morphology.ConversationRecord(
        turns=[{"role": "user", "content": cleaned}],
        label="correction",
        corrections=[
            {
                "targetHint": cleaned[:80],
                "correctedAssertion": cleaned[:200],
                "polarity": "update",
                "confidence": float(confidence),
            }
        ],
        morphology=PROVENANCE_TAG,
        sourceId=str(plan.get("planId") or fallback_id),
    )
    if morphology.validate_record(record):
        return None, "malformed"
    return record.to_jsonl_dict(), None


def _text_fields(task: str, row: dict[str, Any]) -> list[str]:
    if task == "faithfulness-gate":
        return [row["factText"], row["quote"]]
    return [turn["content"] for turn in row["turns"]] + [
        block.get("correctedAssertion", "")
        for block in row.get("corrections", [])
        if isinstance(block, dict)
    ]


def harvest(
    task: str,
    input_dir: Path,
    max_records: int = DEFAULT_MAX_RECORDS,
    max_text_bytes: int = DEFAULT_MAX_TEXT_BYTES,
) -> HarvestResult:
    if task not in TASKS:
        raise ValueError(f"unknown task {task!r}; expected one of {TASKS}")
    if not input_dir.is_dir():
        raise NotADirectoryError(f"input must be an existing directory: {input_dir}")
    if max_records < 0:
        raise ValueError("max_records must be >= 0")
    if max_text_bytes < 1:
        raise ValueError("max_text_bytes must be >= 1")

    files = _iter_input_files(input_dir, TASK_INPUT_SUFFIX[task])
    fingerprint = _input_fingerprint(files, input_dir)

    skips: Counter[str] = Counter()
    rows: list[dict[str, Any]] = []
    for path in files:
        if task == "faithfulness-gate":
            row, reason = build_faithfulness_record(
                path.read_text(encoding="utf-8", errors="replace"), path.stem
            )
        else:
            try:
                plan = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            except (json.JSONDecodeError, ValueError, OSError):
                row, reason = None, "malformed"
            else:
                row, reason = build_correction_record(plan, path.stem)
        if reason is not None:
            skips[reason] += 1
            continue
        assert row is not None
        if any(
            len(field.encode("utf-8")) > max_text_bytes
            for field in _text_fields(task, row)
        ):
            skips["oversize"] += 1
            continue
        rows.append(row)

    seen: set[str] = set()
    unique_rows: list[dict[str, Any]] = []
    for row in rows:
        key = _payload_key(row)
        if key in seen:
            continue
        seen.add(key)
        unique_rows.append(row)
    deduped = len(rows) - len(unique_rows)
    unique_rows.sort(key=_canonical)
    truncated = len(unique_rows) > max_records
    final_rows = unique_rows[:max_records]

    label_order = (
        FAITHFULNESS_LABELS
        if task == "faithfulness-gate"
        else _load_morphology_module().LABELS
    )
    counts = Counter(row["label"] for row in final_rows)
    return HarvestResult(
        task=task,
        rows=final_rows,
        label_counts={label: counts.get(label, 0) for label in label_order},
        skips={reason: skips[reason] for reason in sorted(skips)},
        input_files=len(files),
        input_fingerprint=fingerprint,
        deduped=deduped,
        truncated=truncated,
    )


def build_manifest(
    result: HarvestResult,
    dataset_sha256: str,
    dataset_name: str,
    max_records: int,
    max_text_bytes: int,
) -> dict[str, Any]:
    return {
        "task": result.task,
        "tool": "model-lab/harvest.py",
        "schemaVersion": 1,
        "source": "persisted-shadow-telemetry",
        "inputFingerprint": result.input_fingerprint,
        "inputFiles": result.input_files,
        "datasetPath": dataset_name,
        "datasetSha256": dataset_sha256,
        "emitted": len(result.rows),
        "deduped": result.deduped,
        "truncated": result.truncated,
        "labelCounts": result.label_counts,
        "skipped": result.skips,
        "limits": {"maxRecords": max_records, "maxTextBytes": max_text_bytes},
    }


def run_harvest(
    task: str,
    input_dir: Path,
    out_dir: Path,
    max_records: int = DEFAULT_MAX_RECORDS,
    max_text_bytes: int = DEFAULT_MAX_TEXT_BYTES,
) -> tuple[str, Path, HarvestResult]:
    result = harvest(task, input_dir, max_records, max_text_bytes)
    out_dir.mkdir(parents=True, exist_ok=True)
    dataset_path = out_dir / dataset_filename(task)
    if result.rows:
        digest = write_jsonl(result.rows, dataset_path)
    else:
        dataset_path.write_bytes(b"")
        digest = sha256_bytes(b"")
    manifest = build_manifest(
        result, digest, dataset_path.name, max_records, max_text_bytes
    )
    (out_dir / manifest_filename(task)).write_text(
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (out_dir / "dataset.sha256").write_text(digest + "\n", encoding="utf-8")
    return digest, dataset_path, result
