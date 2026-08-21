"""Hugging Face Hub upload helper (issue #1585 PR1).

.. warning::

    **STUB — not wired in PR1.** This module documents the upload contract
    that PR2 will implement when the first faithfulness-gate weights are
    trained. It deliberately raises :class:`NotImplementedError` so no caller
    can silently no-op a publish step (checklist §4 — graceful degradation
    never means "pretend we published").

The contract (to be implemented in PR2):

* read the trained ``runs/<task>/<version>/`` artifact directory;
* upload merged fp16 weights + GGUF/AWQ quantizations to the operator's own
  HF repo (``hfRepo`` from the manifest), using ``huggingface_hub``;
* tag the upload with the manifest ``revision`` and return the commit sha;
* record nothing in this git repo except the manifest's ``artifact`` block
  (issue #1585: "git carries recipes and hashes, never blobs").

Weights never get committed (see ``.gitignore``: ``*.safetensors``,
``*.gguf``). The operator's HF account is the only weight store.
"""

from __future__ import annotations

from typing import Any


def upload_artifact(  # noqa: ARG001 — signature is the contract; body lands in PR2.
    *,
    runs_dir: str,
    hf_repo: str,
    revision: str,
    quantizations: tuple[str, ...] = ("fp16", "gguf-q4", "awq"),
) -> dict[str, Any]:
    """Upload a trained artifact to the Hugging Face Hub.

    Not implemented in PR1. PR2 wires this once the encoder baseline exists.

    Raises:
        NotImplementedError: always, in PR1. The message names the missing
            prerequisite so a caller sees exactly what is unfinished.
    """
    raise NotImplementedError(
        "hf_push.upload_artifact is a PR1 stub: weight upload lands in PR2 "
        "after the first faithfulness-gate model is trained (issue #1585). "
        "No manifest should reference a published artifact until then."
    )
