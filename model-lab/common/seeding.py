"""Seeding + deterministic serialization helpers (issue #1585 PR1).

These helpers guarantee the reproducibility contract: *same seed → same
dataset bytes → same sha256*, across machines and Python builds. The rules
that make this hold:

* a dedicated ``random.Random(seed)`` instance (never the global module
  RNG), so call sites don't steal each other's streams;
* JSONL rows serialized with ``sort_keys=True`` and ``ensure_ascii=False``
  for byte-stable output;
* the sha256 is taken over the exact bytes written to disk.
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path
from typing import Any, Sequence


def deterministic_rng(seed: int) -> random.Random:
    """Return a fresh, independent RNG seeded from ``seed``.

    Always construct a new ``random.Random`` — never call the module-level
    ``random.seed`` — so concurrent generators (e.g. one per data stream)
    cannot perturb each other's streams and break reproducibility.
    """
    if not isinstance(seed, int):
        raise TypeError(f"seed must be int, got {type(seed).__name__}")
    return random.Random(seed)


def sha256_bytes(data: bytes) -> str:
    """Hex sha256 digest of ``data``."""
    return hashlib.sha256(data).hexdigest()


def jsonl_bytes(rows: Sequence[dict[str, Any]]) -> bytes:
    """Deterministic JSONL encoding: sort-keyed, no ensure_ascii, trailing newline.

    The trailing newline makes the file diff-clean and means the sha256 is
    over a well-formed document regardless of row count.
    """
    encoded = [json.dumps(row, sort_keys=True, ensure_ascii=False) for row in rows]
    return ("\n".join(encoded) + "\n").encode("utf-8")


def write_jsonl(rows: Sequence[dict[str, Any]], path: Path) -> str:
    """Write ``rows`` to ``path`` as deterministic JSONL; return sha256 hex.

    The parent directory is created if missing. The returned hash is over the
    exact bytes on disk, so a reader that re-hashes the file gets the same
    value — that is the reproducibility check the manifest records.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = jsonl_bytes(rows)
    path.write_bytes(payload)
    return sha256_bytes(payload)
