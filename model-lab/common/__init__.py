"""Model-lab shared helpers (issue #1585).

Not an npm workspace package — pure-Python utilities shared by the
``faithfulness-gate`` and (future) ``correction-intent`` recipes. Kept
stdlib-only where possible so the seeded data generator runs in CI without
``pip install``; only the training stack (``model-lab/requirements.txt``)
needs third-party packages.
"""

from .jsonl_schema import LABELS, FaithfulnessRecord, validate_record
from .seeding import deterministic_rng, sha256_bytes, write_jsonl

__all__ = [
    "LABELS",
    "FaithfulnessRecord",
    "validate_record",
    "deterministic_rng",
    "sha256_bytes",
    "write_jsonl",
]
