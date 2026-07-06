"""Training-stack capture (issue #1585 reproducibility).

A manifest that can't reproduce its own eval numbers is a bug (issue #1585
pitfall). The version-pin has two halves:

1. ``model-lab/requirements.txt`` is the PIN — the exact versions an operator
   installs. ``requirements_versions`` parses it stdlib-only.
2. ``capture_training_stack`` records what the interpreter ACTUALLY had
   installed at train time (``pip freeze``), so a silent drift between the pin
   and the run is visible. This runs only on the lab box (needs the installed
   GPU stack); ``pending_stack`` is the committed scaffold placeholder.

Pure stdlib. The CI probe exercises ``requirements_versions`` + the parser on
the committed ``requirements.txt``; ``capture_training_stack`` is GPU-gated.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Mapping

#: Libs whose exact versions a reproducible run MUST record. The load-bearing
#: training stack; anything else is ancillary. Keep in sync with requirements.txt.
PINNED_LIBS: tuple[str, ...] = (
    "torch",
    "transformers",
    "datasets",
    "huggingface-hub",
    "accelerate",
    "sentencepiece",
    # Correction-intent causal-LM stack (uncommented in requirements.txt for PR3):
    "trl",
    "peft",
    "bitsandbytes",
)


def requirements_versions(requirements_path: Path) -> dict[str, str]:
    """Parse a pip ``requirements.txt`` into ``{lib: version}``.

    Handles ``name==1.2.3`` and ``name==1.2.3+cu126`` (local-version tags).
    Lines without ``==`` (comments, ``--extra-index-url``, blank) are skipped.
    Raises ``FileNotFoundError`` if the file is missing — a missing pin file is
    a reproducibility bug, not a silent empty dict.
    """
    if not requirements_path.is_file():
        raise FileNotFoundError(f"requirements file not found: {requirements_path}")
    versions: dict[str, str] = {}
    for raw in requirements_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        if "==" not in line:
            continue
        name, _, version = line.partition("==")
        # ``name`` may carry extras (``torch[foo]==...``) — drop them.
        name = name.split("[", 1)[0].strip()
        version = version.split("#", 1)[0].strip()
        if name and version:
            versions[name] = version
    return versions


def pending_stack() -> dict[str, object]:
    """The committed scaffold placeholder for ``manifest.trainingStack``.

    Every field is ``None`` / ``"pending-*"`` because no GPU run has happened
    (rule 55). The real values are filled by ``capture_training_stack`` on the
    lab box; the pin source is ``requirements.txt`` today.
    """
    return {
        "python": None,
        "libs": {lib: None for lib in PINNED_LIBS},
        "pipFreezeSha256": None,
        "capturedAt": None,
        "$comment": (
            "SCHEMA EXAMPLE. The exact interpreter + lib versions a real run "
            "used; captured by capture_training_stack() at train time. The pin "
            "source is model-lab/requirements.txt. Filled in the #1585 GPU-run "
            "follow-up (rule 55: no fabricated versions)."
        ),
    }


def capture_training_stack() -> dict[str, object]:
    """Record the live interpreter + ``pip freeze`` of the current environment.

    GPU-gated: meaningful only inside the model-lab venv after
    ``setup.sh`` + a train run. Returns the ``trainingStack`` block a manifest
    commits for a real run. ``pip freeze`` is hashed so a reviewer can see the
    full environment changed (or didn't) without reading 100 lines.
    """
    import hashlib
    import subprocess

    freeze_text = subprocess.check_output(
        [sys.executable, "-m", "pip", "freeze"], text=True, stderr=subprocess.STDOUT
    )
    libs: dict[str, str] = {}
    for raw in freeze_text.splitlines():
        line = raw.strip()
        if "==" not in line:
            continue
        name, _, version = line.partition("==")
        name = name.split("[", 1)[0].strip().lower()
        if name in PINNED_LIBS:
            libs[name] = version
    return {
        "python": ".".join(map(str, sys.version_info[:3])),
        "libs": libs,
        "pipFreezeSha256": hashlib.sha256(freeze_text.encode("utf-8")).hexdigest(),
        "capturedAt": "train-run",  # eval.py stamps the ISO timestamp
    }


def assert_stack_matches_requirements(
    stack: Mapping[str, object],
    requirements_path: Path,
) -> list[str]:
    """Return errors where a captured stack's lib versions diverge from the pin.

    A real run's manifest should match ``requirements.txt``. Drift is a warning
    (the run is still reproducible from ``pipFreezeSha256``) but it means the
    pin file is stale — surface it so the operator updates the pin.
    """
    pinned = requirements_versions(requirements_path)
    errors: list[str] = []
    libs = stack.get("libs")
    if not isinstance(libs, Mapping):
        return ["stack.libs must be an object"]
    for lib, want in pinned.items():
        got = libs.get(lib)
        if got is None:
            errors.append(f"stack.libs.{lib} missing (pinned at {want})")
        elif got != want:
            errors.append(f"stack.libs.{lib}={got!r} diverges from pin {want!r}")
    return errors
