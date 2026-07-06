"""Reproducibility manifest schema + validator (issue #1585).

The manifest is the ONLY committed artifact for a trained model — git carries
recipes + hashes, never blobs (datasets, weights, LLM traces are gitignored).
This module is the single source of truth for what a manifest MUST contain so
that a future operator can reproduce a model's eval numbers from the pinned
training stack (issue #1585 pitfall: "a manifest that can't reproduce its own
eval numbers is a bug").

Pure stdlib. Consumed by the CI manifest-schema probe (no GPU) and by the
train/eval recipes (which call ``validate_manifest(..., allow_pending=False)``
before committing a real run's manifest).

Two states are first-class:

* ``allow_pending=True``  — the committed SCHEMA EXAMPLE. Every eval/weight/
  training-stack field is ``null``/``"pending-*"`` because no model has been
  trained yet (rule 55: no fabricated numbers). This is what lives in git now.
* ``allow_pending=False`` — a manifest produced by a real GPU run. Every field
  must carry a concrete value; a missing/null value is a validation error so a
  half-recorded run can't be published as complete.
"""

from __future__ import annotations

import hashlib
from typing import Any, Mapping

#: Bumped when the required-field set changes. Old manifests fail loudly on a
#: mismatch instead of silently passing a shape they don't satisfy.
SCHEMA_VERSION: int = 1

#: Top-level keys every manifest MUST carry (order-independent).
REQUIRED_KEYS: tuple[str, ...] = (
    "task",
    "schemaVersion",
    "status",
    "contract",
    "baseModel",
    "dataRecipe",
    "trainingStack",
    "hyperparams",
    "trainedAt",
    "hardware",
    "eval",
    "artifact",
    "policyCompliance",
)

#: Statuses a manifest may carry. ``pending-training`` is the committed
#: scaffold; ``trained`` is a real run; ``stale`` marks a superseded model.
VALID_STATUSES: tuple[str, ...] = ("pending-training", "trained", "stale")

#: The two tasks this lab trains. The validator is task-agnostic about the
#: inner contract shape, but the ``task`` string must name a known task so a
#: mislabeled manifest fails.
KNOWN_TASKS: tuple[str, ...] = ("faithfulness-gate", "correction-intent")


def _is_pending(value: Any) -> bool:
    """True when a value is the PR-scaffold placeholder for 'not yet run'."""
    if value is None:
        return True
    if isinstance(value, str) and value.startswith("pending-"):
        return True
    return False


def validate_manifest(
    manifest: Mapping[str, Any],
    *,
    allow_pending: bool = True,
) -> list[str]:
    """Validate ``manifest`` against the schema; return human-readable errors.

    Empty list == valid. ``allow_pending`` toggles the scaffold-vs-run check
    (see module docstring). The validator checks STRUCTURE, not semantic
    correctness of metric values — a macro-F1 outside [0, 1] is a bug in the
    eval recipe, caught there, not here.
    """
    errors: list[str] = []

    if not isinstance(manifest, Mapping):
        return ["manifest must be a JSON object"]

    for key in REQUIRED_KEYS:
        if key not in manifest:
            errors.append(f"missing required key: {key!r}")

    if errors:
        return errors  # Don't cascade into the inner blocks of a half-shape.

    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(
            f"schemaVersion must be {SCHEMA_VERSION}, got {manifest.get('schemaVersion')!r}"
        )

    task = manifest.get("task")
    if task not in KNOWN_TASKS:
        errors.append(f"task must be one of {KNOWN_TASKS!r}, got {task!r}")

    status = manifest.get("status")
    if status not in VALID_STATUSES:
        errors.append(f"status must be one of {VALID_STATUSES!r}, got {status!r}")

    # The trainingStack block is the version-pin (issue #1585). When a run has
    # happened it MUST record the exact lib versions so the eval reproduces;
    # the scaffold leaves it null/pending.
    stack = manifest.get("trainingStack")
    if _is_pending(stack):
        if not allow_pending:
            errors.append("trainingStack is pending — a real run must pin exact lib versions")
    elif not isinstance(stack, Mapping):
        errors.append("trainingStack must be an object (or null when pending)")
    else:
        stack_errs = _validate_training_stack(stack, allow_pending=allow_pending)
        errors.extend(stack_errs)

    # eval + artifact blocks: structural presence only. allow_pending controls
    # whether the null/pending placeholder is accepted.
    for block_key in ("eval", "artifact"):
        block = manifest.get(block_key)
        if _is_pending(block):
            if not allow_pending:
                errors.append(f"{block_key} is pending — a real run must record it")
        elif not isinstance(block, Mapping):
            errors.append(f"{block_key} must be an object (or null when pending)")

    # Real-run top-level fields (issue #1585): baseModel / hyperparams /
    # trainedAt / hardware must be CONCRETE when allow_pending=False so a
    # reviewer can reproduce the eval. The scaffold leaves them null; a
    # half-recorded run (concrete trainingStack/eval/artifact but no base model
    # or hardware) must not validate as a complete run. baseModel/hyperparams/
    # hardware are objects; trainedAt is a string timestamp.
    _OBJECT_RUN_FIELDS = ("baseModel", "hyperparams", "hardware")
    for field_key in ("baseModel", "hyperparams", "trainedAt", "hardware"):
        value = manifest.get(field_key)
        if _is_pending(value):
            if not allow_pending:
                errors.append(
                    f"{field_key} is pending — a real run must record it for reproducibility"
                )
        elif field_key in _OBJECT_RUN_FIELDS and not isinstance(value, Mapping):
            errors.append(f"{field_key} must be an object (or null when pending)")

    # policyCompliance must always be concrete — even the scaffold states the
    # target ceiling, so a reviewer can see the model-size guardrail up front.
    policy = manifest.get("policyCompliance")
    if not isinstance(policy, Mapping):
        errors.append("policyCompliance must be an object")
    elif "targetMaxParamsB" not in policy:
        errors.append("policyCompliance.targetMaxParamsB is required (the size guardrail)")

    return errors


def _validate_training_stack(stack: Mapping[str, Any], *, allow_pending: bool) -> list[str]:
    """Validate the pinned training-stack block (exact lib versions)."""
    errors: list[str] = []
    required = ("python", "libs")
    for key in required:
        if key not in stack:
            errors.append(f"trainingStack.{key} is required")
    if errors:
        return errors

    if _is_pending(stack.get("python")) and not allow_pending:
        errors.append("trainingStack.python must record the exact interpreter version")

    libs = stack.get("libs")
    if not isinstance(libs, Mapping):
        errors.append("trainingStack.libs must be an object mapping lib → exact version")
    elif not allow_pending:
        # A real run must pin at least the load-bearing libs the recipes import.
        for lib in ("torch", "transformers"):
            ver = libs.get(lib)
            if _is_pending(ver) or not isinstance(ver, str):
                errors.append(f"trainingStack.libs.{lib} must pin an exact version for a real run")
    return errors


def stack_block_sha256(stack: Mapping[str, Any]) -> str:
    """Stable sha256 over the training-stack block.

    Recorded in the manifest so a reviewer can see the exact pinned set changed
    (or didn't) between runs. Deterministic encoding mirrors ``seeding.py``.
    """
    import json

    payload = json.dumps(stack, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()
