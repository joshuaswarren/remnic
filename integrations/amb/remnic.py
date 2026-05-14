"""Remnic provider for Vectorize Agent Memory Benchmark (AMB).

Copy this file into an AMB checkout at:

    src/memory_bench/memory/remnic.py

Then register ``RemnicMemoryProvider`` in
``src/memory_bench/memory/__init__.py``. The companion installer in this
directory performs those edits automatically.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections import defaultdict
from hashlib import sha256
from pathlib import Path
from typing import Any

from ..models import Document
from .base import MemoryProvider


class RemnicMemoryProvider(MemoryProvider):
    name = "remnic"
    description = "Remnic core memory stack through the official AMB provider interface."
    kind = "local"
    provider = "Remnic"
    variant = "core"
    link = "https://github.com/joshuaswarren/remnic"
    logo = ""
    concurrency = 1

    def __init__(self) -> None:
        self.concurrency = _positive_int_env("REMNIC_AMB_CONCURRENCY", self.concurrency)
        self._store_dir: Path | None = None
        self._unit_ids: set[str] = set()
        self._node = _resolve_executable(os.environ.get("REMNIC_AMB_NODE", "node"))
        self._helper_timeout_seconds = _positive_int_env(
            "REMNIC_AMB_HELPER_TIMEOUT_SECONDS",
            3600,
        )
        self._repo = _resolve_repo()
        self._helper = _resolve_helper(self._repo)

    def prepare(
        self,
        store_dir: Path,
        unit_ids: set[str] | None = None,
        reset: bool = True,
    ) -> None:
        self._store_dir = Path(store_dir) / "remnic"
        self._unit_ids = {unit_id for unit_id in (unit_ids or set()) if unit_id}
        if reset and self._store_dir.exists():
            shutil.rmtree(self._store_dir)
        self._store_dir.mkdir(parents=True, exist_ok=True)
        if self._unit_ids:
            for unit_id in self._unit_ids:
                self._store_dir_for_user(unit_id).mkdir(parents=True, exist_ok=True)

    def ingest(self, documents: list[Document]) -> None:
        grouped: dict[Path, list[Document]] = defaultdict(list)
        for document in documents:
            grouped[self._store_dir_for_user(document.user_id)].append(document)
        for store_dir, group in grouped.items():
            payload = {
                "command": "ingest",
                "storeDir": str(store_dir),
                "documents": [_document_to_payload(document) for document in group],
            }
            self._run_helper(payload)

    def retrieve(
        self,
        query: str,
        k: int = 10,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[list[Document], dict | None]:
        payload = {
            "command": "retrieve",
            "storeDir": str(self._store_dir_for_user(user_id)),
            "query": query,
            "k": k,
            "userId": user_id,
            "queryTimestamp": query_timestamp,
        }
        result = self._run_helper(payload)
        documents = [
            Document(
                id=str(item.get("id", f"remnic-{index}")),
                content=str(item.get("content", "")),
                user_id=item.get("user_id") if isinstance(item.get("user_id"), str) else user_id,
                timestamp=item.get("timestamp") if isinstance(item.get("timestamp"), str) else None,
                context=item.get("context") if isinstance(item.get("context"), str) else None,
            )
            for index, item in enumerate(result.get("documents", []))
            if isinstance(item, dict) and str(item.get("content", "")).strip()
        ]
        raw_response = result.get("raw_response")
        return documents, raw_response if isinstance(raw_response, dict) else result

    def direct_answer(
        self,
        query: str,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[str, str, dict | None]:
        payload = {
            "command": "direct_answer",
            "storeDir": str(self._store_dir_for_user(user_id)),
            "query": query,
            "userId": user_id,
            "queryTimestamp": query_timestamp,
        }
        result = self._run_helper(payload)
        answer = str(result.get("answer", "")).strip()
        context = str(result.get("context", ""))
        raw_response = result.get("raw_response")
        return answer, context, raw_response if isinstance(raw_response, dict) else result

    def _require_store_dir(self) -> Path:
        if self._store_dir is None:
            self.prepare(Path(".amb-remnic-store"), reset=False)
        assert self._store_dir is not None
        return self._store_dir

    def _store_dir_for_user(self, user_id: str | None) -> Path:
        root = self._require_store_dir()
        if user_id and (not self._unit_ids or user_id in self._unit_ids):
            return root / "units" / _unit_dir_name(user_id)
        return root / "shared"

    def _run_helper(self, payload: dict[str, Any]) -> dict[str, Any]:
        command = [self._node, str(self._helper)]
        env = os.environ.copy()
        env["REMNIC_REPO"] = str(self._repo)
        try:
            completed = subprocess.run(
                command,
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                env=env,
                check=False,
                timeout=self._helper_timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"Remnic AMB helper timed out after {self._helper_timeout_seconds} seconds"
            ) from exc
        if completed.returncode != 0:
            message = completed.stderr.strip() or completed.stdout.strip()
            raise RuntimeError(f"Remnic AMB helper failed: {message}")
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Remnic AMB helper returned invalid JSON: {completed.stdout[:500]}"
            ) from exc
        if not isinstance(result, dict):
            raise RuntimeError("Remnic AMB helper returned a non-object JSON result")
        if result.get("ok") is False:
            raise RuntimeError(str(result.get("error", "unknown Remnic AMB helper error")))
        return result


def _resolve_repo() -> Path:
    repo = os.environ.get("REMNIC_REPO")
    if repo:
        return Path(repo).expanduser().resolve()

    helper = os.environ.get("REMNIC_AMB_HELPER")
    candidates: list[Path] = []
    if helper:
        candidates.extend(Path(helper).expanduser().resolve().parents)
    candidates.append(Path.cwd().resolve())
    candidates.extend(Path(__file__).resolve().parents)
    for candidate in candidates:
        if _looks_like_remnic_repo(candidate):
            return candidate

    raise RuntimeError(
        "Could not locate the Remnic checkout. Set REMNIC_REPO to the Remnic "
        "repository that contains packages/remnic-core/dist/index.js."
    )


def _resolve_executable(value: str) -> str:
    path = Path(value).expanduser()
    if path.is_absolute():
        return str(path)
    if "/" in value or (os.altsep and os.altsep in value):
        return str(path.resolve())
    return value


def _resolve_helper(repo: Path) -> Path:
    helper = os.environ.get("REMNIC_AMB_HELPER")
    if helper:
        path = Path(helper).expanduser().resolve()
    else:
        path = repo / "integrations" / "amb" / "remnic-amb-provider.mjs"
    if not path.exists():
        raise RuntimeError(
            "Remnic AMB helper not found. Set REMNIC_REPO to the Remnic checkout "
            "or REMNIC_AMB_HELPER to integrations/amb/remnic-amb-provider.mjs."
        )
    return path


def _looks_like_remnic_repo(path: Path) -> bool:
    return (path / "packages" / "remnic-core" / "dist" / "index.js").exists()


def _positive_int_env(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    if not raw.isdecimal() or int(raw) < 1:
        raise RuntimeError(f"{name} must be a positive integer")
    return int(raw)


def _unit_dir_name(unit_id: str) -> str:
    digest = sha256(unit_id.encode("utf-8")).hexdigest()[:16]
    return f"unit-{digest}"


def _document_to_payload(document: Document) -> dict[str, Any]:
    messages = document.messages if isinstance(document.messages, list) else None
    return {
        "id": document.id,
        "content": document.content,
        "user_id": document.user_id,
        "messages": messages,
        "timestamp": document.timestamp,
        "context": document.context,
    }
