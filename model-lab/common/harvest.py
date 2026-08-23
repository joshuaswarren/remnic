"""Consent-gated shadow-telemetry label harvester (issues #1576 / #1581 / #2852).

Turns persisted shadow telemetry into labeled training records for the two
model-lab tasks:

* ``faithfulness-gate`` — memory markdown with a ``faithfulness:`` frontmatter
  verdict (#1576) plus every verified ``sources[].quote`` span (#1575),
  joined with a newline in persisted order (same as the gate). ``factText``
  is the pre-persist gated body: the ``[Attributes: …]`` suffix and default
  inline citation are stripped from the already-bounded source bytes.
  Child files with persisted ``parentId`` and ``chunkIndex`` inherit the
  whole-fact verdict; they are skipped so a chunk body is not labeled as
  the gated fact. A whole fact, or a file judged on its own body without
  those chunk fields, still emits.
* ``correction-intent`` — persisted correction-plan JSON (#1581 durable output).
  ``confidence`` must be finite and in ``[0, 1]``. Every action is validated
  against the product kind/field contract. Polarity and assertion come from
  the action, never from request-text heuristics.

Contract (issue #2852):

* Opt-in, local-only, consent-gated. The CLI requires ``--consent`` plus
  explicit local ``--input`` / ``--out`` paths. Nothing here runs from the
  daemon, the build, or CI.
* Walks exactly the named directory. No vault scan, no home-dir discovery.
* The input root is lstat'd and refused when it is a symlink. Descendant
  symlinks are skipped. Any path that escapes the root refuses the run.
* Privacy by projection: records are built field-by-field from an allowlist.
  Session keys, principals, namespaces, memory ids, model ids, and timestamps
  stay behind. ``sourceId`` is a hash of sanitized approved fields plus a
  task salt — never a frontmatter id, plan id, or filename. Redacted (#1678)
  and never-store plans are skipped. Unknown classification, status,
  schema version, action kind/fields, or a confidence outside ``[0, 1]``
  count as malformed, never as a positive label. A body that still carries
  unstrippable inline attribution is skipped as private.
* Deterministic and idempotent: same input tree → byte-identical dataset AND
  manifest (no clocks, no absolute paths). Rows dedup on the training payload
  and emit in canonical-JSON order.
* Bounded: ``max_records`` caps the dataset. ``max_text_bytes`` is checked
  with fstat plus a bounded stream *before* a full read or fingerprint.
  Oversized files are counted and skipped without allocating their bytes.
  Oversize text fields are skipped, never truncated. Fact reconstruction
  uses only the already-bounded payload and linear string scans.

Pure stdlib. The correction-intent schema is imported lazily so ``common/``
keeps no static dependency on a task directory.
"""

from __future__ import annotations

import json
import math
import os
import stat
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

#: Exact #1581 product enum. Unknown values (e.g. ``banana``) are malformed.
CORRECTION_CLASSIFICATIONS: frozenset[str] = frozenset(
    {"wrong", "outdated", "incomplete", "wrong_scope", "never_store"}
)
CORRECTION_PLAN_STATUSES: frozenset[str] = frozenset(
    {"pending", "applying", "applied", "discarded", "partial"}
)
HARVESTABLE_PLAN_STATUSES: frozenset[str] = frozenset(
    {"pending", "applying", "applied", "partial"}
)
#: Exact #1580 action kinds. Unknown kinds (e.g. ``banana``) are malformed.
CORRECTION_ACTION_KINDS: frozenset[str] = frozenset(
    {"supersede", "edit", "retract", "rescope", "redaction_rule"}
)
CORRECTION_POLARITIES: frozenset[str] = frozenset(
    {"update", "retract", "stop_storing"}
)
SUPPORTED_PLAN_SCHEMA_VERSIONS: frozenset[int] = frozenset({1})
DEFAULT_PLAN_SCHEMA_VERSION = 1
SOURCE_ID_SALT = "remnic-harvest-v1"
ATTRIBUTES_MARKER = "\n[Attributes: "
DEFAULT_CITATION_OPEN = "[Source:"
MAX_CITATION_INNER = 1024


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
    bytes_read: int


def _canonical(row: dict[str, Any]) -> str:
    return json.dumps(row, sort_keys=True, ensure_ascii=False)


def _payload_key(row: dict[str, Any]) -> str:
    return _canonical({k: v for k, v in row.items() if k != "sourceId"})


def require_input_dir(input_dir: Path) -> Path:
    """lstat the harvest root. Refuse a symlink or a non-directory."""
    try:
        info = input_dir.lstat()
    except OSError as err:
        raise NotADirectoryError(
            f"input must be an existing directory: {input_dir}"
        ) from err
    if stat.S_ISLNK(info.st_mode):
        raise ValueError(f"refusing symlinked input root: {input_dir}")
    if not stat.S_ISDIR(info.st_mode):
        raise NotADirectoryError(
            f"input must be an existing directory: {input_dir}"
        )
    return input_dir


def _is_contained(root: Path, candidate: Path) -> bool:
    try:
        rel = os.path.relpath(os.fspath(candidate), os.fspath(root))
    except ValueError:
        return False
    return rel != ".." and not rel.startswith(f"..{os.sep}") and not os.path.isabs(rel)


def _unlinkable_source_id(task: str, approved: dict[str, Any]) -> str:
    payload = {"salt": SOURCE_ID_SALT, "task": task, "fields": approved}
    return sha256_bytes(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )


def _plan_schema_version(plan: dict[str, Any]) -> Any:
    if "schemaVersion" in plan:
        return plan["schemaVersion"]
    if "version" in plan:
        return plan["version"]
    return DEFAULT_PLAN_SCHEMA_VERSION


def _iter_input_files(input_dir: Path, suffix: str) -> list[Path]:
    found: list[Path] = []
    for root, dirnames, filenames in os.walk(input_dir, followlinks=False):
        root_path = Path(root)
        if not _is_contained(input_dir, root_path):
            raise ValueError(f"input walk escaped harvest root: {root_path}")
        kept: list[str] = []
        for name in sorted(dirnames):
            child = root_path / name
            if child.is_symlink():
                continue
            if not _is_contained(input_dir, child):
                raise ValueError(f"input walk escaped harvest root: {child}")
            kept.append(name)
        dirnames[:] = kept
        for name in sorted(filenames):
            path = root_path / name
            if path.suffix != suffix or path.is_symlink():
                continue
            if not _is_contained(input_dir, path):
                raise ValueError(f"input walk escaped harvest root: {path}")
            found.append(path)
    found.sort(key=lambda p: p.relative_to(input_dir).as_posix())
    return found


def _open_nofollow(path: Path) -> int:
    flags = os.O_RDONLY
    flags |= int(getattr(os, "O_NOFOLLOW", 0))
    flags |= int(getattr(os, "O_CLOEXEC", 0))
    return os.open(path, flags)


def _read_bounded(path: Path, max_bytes: int) -> tuple[bytes | None, str | None]:
    """Load at most ``max_bytes``. fstat first; never slurp an oversized file."""
    try:
        fd = _open_nofollow(path)
    except OSError:
        return None, "malformed"
    try:
        info = os.fstat(fd)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            return None, "malformed"
        if info.st_size > max_bytes:
            return None, "oversize"
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, min(65_536, max_bytes - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                return None, "oversize"
            chunks.append(chunk)
        raced = os.fstat(fd)
        if raced.st_size > max_bytes:
            return None, "oversize"
        if raced.st_size != info.st_size or raced.st_size != total:
            return None, "malformed"
        return b"".join(chunks), None
    finally:
        os.close(fd)


def _fingerprint_payloads(payloads: list[bytes]) -> str:
    parts = sorted(sha256_bytes(payload) for payload in payloads)
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


def _joined_verified_quotes(raw_sources: str | None) -> str:
    """Join every approved source quote, same order as the faithfulness gate."""
    if not raw_sources:
        return ""
    try:
        sources = json.loads(raw_sources)
    except (json.JSONDecodeError, ValueError):
        return ""
    if not isinstance(sources, list):
        return ""
    quotes: list[str] = []
    for source in sources:
        if not isinstance(source, dict):
            continue
        quote = source.get("quote")
        if isinstance(quote, str) and quote.strip():
            quotes.append(quote.strip())
    return "\n".join(quotes)


def _strip_attributes_suffix(content: str) -> str:
    """Drop the persist-time ``[Attributes: …]`` suffix. String scan only."""
    trimmed = content.rstrip()
    if not trimmed.endswith("]"):
        return content.strip()
    marker_index = trimmed.rfind(ATTRIBUTES_MARKER)
    if marker_index == -1:
        return content.strip()
    inner = trimmed[marker_index + len(ATTRIBUTES_MARKER) : -1]
    if "]" in inner or "\n" in inner:
        return content.strip()
    return trimmed[:marker_index].strip()


def _strip_default_citations(text: str) -> str:
    """Remove default ``[Source: …]`` markers from already-bounded text."""
    pieces: list[str] = []
    cursor = 0
    length = len(text)
    while cursor < length:
        start = text.find(DEFAULT_CITATION_OPEN, cursor)
        if start == -1:
            pieces.append(text[cursor:])
            break
        search_from = start + len(DEFAULT_CITATION_OPEN)
        window = text[search_from : search_from + MAX_CITATION_INNER + 1]
        close = window.find("]")
        newline = window.find("\n")
        if close == -1 or (newline != -1 and newline < close):
            pieces.append(text[cursor:search_from])
            cursor = search_from
            continue
        pieces.append(text[cursor:start].rstrip(" \t"))
        cursor = search_from + close + 1
    return "".join(pieces).strip()


def _has_unstrippable_attribution(text: str) -> bool:
    if DEFAULT_CITATION_OPEN in text:
        return True
    trimmed = text.rstrip()
    if not trimmed.endswith("]"):
        return False
    open_at = trimmed.rfind("[")
    if open_at == -1:
        return False
    inner = trimmed[open_at + 1 : -1]
    if "\n" in inner or len(inner) > MAX_CITATION_INNER:
        return False
    return any(token in inner for token in ("=", "/", "@"))


def _inherited_whole_fact_chunk(scalars: dict[str, str]) -> bool:
    """True when persist copied a parent faithfulness verdict onto a child."""
    parent_id = scalars.get("parentId", "").strip()
    if not parent_id:
        return False
    raw_index = scalars.get("chunkIndex", "").strip()
    if not raw_index:
        return False
    try:
        index = int(raw_index, 10)
    except ValueError:
        return False
    return index >= 0


def _reconstruct_gated_fact(body: str) -> tuple[str | None, str | None]:
    """Recover the fact text the gate evaluated, or skip the row."""
    without_attributes = _strip_attributes_suffix(body)
    fact_text = _strip_default_citations(without_attributes)
    if not fact_text:
        return None, "malformed"
    if _has_unstrippable_attribution(fact_text):
        return None, "private"
    return fact_text, None


def _target_hint(turn: str) -> str:
    cleaned = " ".join(turn.split())
    return cleaned[:80] if len(cleaned) <= 80 else cleaned[:77] + "..."


def _validate_correction_action(action: Any) -> dict[str, Any] | None:
    """Return a sanitized action payload, or None when the contract fails."""
    if not isinstance(action, dict):
        return None
    kind = action.get("kind")
    if kind not in CORRECTION_ACTION_KINDS:
        return None
    if kind == "supersede":
        loser_id = action.get("loserId")
        if not isinstance(loser_id, str) or not loser_id:
            return None
        replacement = action.get("replacement")
        if replacement is None:
            return {"kind": kind}
        if not isinstance(replacement, dict):
            return None
        content = replacement.get("content")
        if not isinstance(content, str) or not content.strip():
            return None
        return {"kind": kind, "assertion": content.strip()}
    if kind == "edit":
        memory_id = action.get("memoryId")
        patch = action.get("patch")
        if not isinstance(memory_id, str) or not memory_id:
            return None
        if not isinstance(patch, str) or len(patch) == 0:
            return None
        return {"kind": kind, "assertion": patch}
    if kind == "retract":
        memory_id = action.get("memoryId")
        if not isinstance(memory_id, str) or not memory_id:
            return None
        return {"kind": kind}
    if kind == "rescope":
        memory_id = action.get("memoryId")
        namespace = action.get("toNamespace")
        if not isinstance(memory_id, str) or not memory_id:
            return None
        if not isinstance(namespace, str) or not namespace.strip():
            return None
        return {"kind": kind}
    pattern = action.get("pattern")
    if not isinstance(pattern, str) or not pattern.strip():
        return None
    return {"kind": kind}


def _corrections_from_actions(
    actions: list[dict[str, Any]],
    confidence: float,
    target_hint: str,
) -> list[dict[str, Any]] | None:
    """Map validated actions to #1581 correction blocks. No invented polarity."""
    blocks: list[dict[str, Any]] = []
    for action in actions:
        kind = action["kind"]
        if kind == "retract" or (kind == "supersede" and "assertion" not in action):
            polarity = "retract"
            assertion = ""
        elif kind in {"edit", "supersede"}:
            polarity = "update"
            assertion = action["assertion"][:200]
        else:
            continue
        if polarity not in CORRECTION_POLARITIES:
            return None
        blocks.append(
            {
                "targetHint": target_hint,
                "correctedAssertion": assertion,
                "polarity": polarity,
                "confidence": confidence,
            }
        )
    if not blocks:
        return None
    return blocks



def build_faithfulness_record(
    markdown_text: str,
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
    if _inherited_whole_fact_chunk(scalars):
        return None, "inherited_chunk"

    quote = _joined_verified_quotes(scalars.get("sources"))
    if not quote:
        return None, "no_quote"
    fact_text, fact_reason = _reconstruct_gated_fact(body)
    if fact_reason is not None:
        return None, fact_reason
    approved = {
        "factText": fact_text,
        "quote": quote,
        "context": "",
        "label": label,
        "perturbation": PROVENANCE_TAG,
    }
    record = FaithfulnessRecord(
        factText=fact_text,
        quote=quote,
        context="",
        label=label,
        perturbation=PROVENANCE_TAG,
        sourceId=_unlinkable_source_id("faithfulness-gate", approved),
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
    plan: Any,
) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(plan, dict):
        return None, "malformed"
    if _plan_schema_version(plan) not in SUPPORTED_PLAN_SCHEMA_VERSIONS:
        return None, "malformed"
    status = plan.get("status")
    if status not in CORRECTION_PLAN_STATUSES:
        return None, "malformed"
    if status == "discarded":
        return None, "discarded"
    if status not in HARVESTABLE_PLAN_STATUSES:
        return None, "malformed"
    classification = plan.get("classification")
    actions = plan.get("actions")
    if classification not in CORRECTION_CLASSIFICATIONS or not isinstance(actions, list):
        return None, "malformed"
    validated: list[dict[str, Any]] = []
    for action in actions:
        cleaned_action = _validate_correction_action(action)
        if cleaned_action is None:
            return None, "malformed"
        validated.append(cleaned_action)
    if classification in SENSITIVE_CLASSIFICATIONS:
        return None, "sensitive"
    if any(action["kind"] in SENSITIVE_ACTION_KINDS for action in validated):
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
        or confidence < 0
        or confidence > 1
    ):
        return None, "malformed"
    cleaned = text.strip()
    corrections = _corrections_from_actions(
        validated, float(confidence), _target_hint(cleaned)
    )
    if corrections is None:
        return None, "malformed"
    turns = [{"role": "user", "content": cleaned}]
    approved = {
        "turns": turns,
        "label": "correction",
        "corrections": corrections,
        "morphology": PROVENANCE_TAG,
    }
    morphology = _load_morphology_module()
    record = morphology.ConversationRecord(
        turns=turns,
        label="correction",
        corrections=corrections,
        morphology=PROVENANCE_TAG,
        sourceId=_unlinkable_source_id("correction-intent", approved),
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
    require_input_dir(input_dir)
    if max_records < 0:
        raise ValueError("max_records must be >= 0")
    if max_text_bytes < 1:
        raise ValueError("max_text_bytes must be >= 1")

    files = _iter_input_files(input_dir, TASK_INPUT_SUFFIX[task])

    skips: Counter[str] = Counter()
    payloads: list[bytes] = []
    bytes_read = 0
    for path in files:
        data, reason = _read_bounded(path, max_text_bytes)
        if reason is not None:
            skips[reason] += 1
            continue
        assert data is not None
        bytes_read += len(data)
        payloads.append(data)
    fingerprint = _fingerprint_payloads(payloads)

    rows: list[dict[str, Any]] = []
    for data in payloads:
        text = data.decode("utf-8", errors="replace")
        if task == "faithfulness-gate":
            row, reason = build_faithfulness_record(text)
        else:
            try:
                plan = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                row, reason = None, "malformed"
            else:
                row, reason = build_correction_record(plan)
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
        bytes_read=bytes_read,
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
