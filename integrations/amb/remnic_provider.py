"""AMB MemoryProvider adapter for Remnic.

Copy or symlink this file into `agent-memory-benchmark/src/memory_bench/memory/`
and register `RemnicMemoryProvider` in that repository's memory registry.
The provider delegates to Remnic through `packages/bench/scripts/amb-remnic-bridge.mjs`
so AMB still owns the official ingest/retrieve/generate/judge loop.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any

from ..models import Document
from .base import MemoryProvider


class RemnicMemoryProvider(MemoryProvider):
    name = "remnic"
    description = (
        "Remnic full-stack recall via the @remnic/bench adapter. "
        "AMB handles generation and judging."
    )
    kind = "local"
    link = "https://github.com/joshuaswarren/remnic"
    concurrency = 1

    def __init__(self) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._store_dir: Path | None = None

    def initialize(self) -> None:
        self._bridge_path()

    def prepare(
        self,
        store_dir: Path,
        unit_ids: set[str] | None = None,
        reset: bool = True,
    ) -> None:
        del unit_ids
        next_store_dir = store_dir / "remnic"
        if self._store_dir != next_store_dir and self._proc is not None:
            self.cleanup()
        self._store_dir = next_store_dir
        if reset:
            if self._proc is None:
                shutil.rmtree(next_store_dir, ignore_errors=True)
            else:
                self._request({"command": "reset"})
        next_store_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_process()

    def ingest(self, documents: list[Document]) -> None:
        self._request({
            "command": "ingest",
            "documents": [self._document_payload(doc) for doc in documents],
        })

    def retrieve(
        self,
        query: str,
        k: int = 10,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[list[Document], dict | None]:
        del k, query_timestamp
        response = self._request({
            "command": "retrieve",
            "query": query,
            "user_id": user_id,
        })
        docs = [
            Document(
                id=str(item.get("id", f"remnic-{index}")),
                content=str(item.get("content", "")),
                user_id=item.get("user_id") or user_id,
            )
            for index, item in enumerate(response.get("documents", []))
            if str(item.get("content", "")).strip()
        ]
        return docs, response

    def cleanup(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        try:
            if proc.poll() is None:
                self._send(proc, {"command": "cleanup"})
                proc.wait(timeout=10)
        except Exception:
            proc.kill()

    def _ensure_process(self) -> subprocess.Popen[str]:
        if self._proc is not None and self._proc.poll() is None:
            return self._proc

        bridge = self._bridge_path()
        env = os.environ.copy()
        if self._store_dir is not None:
            env["REMNIC_AMB_MEMORY_DIR"] = str(self._store_dir)
        env["REMNIC_AMB_SESSION_PREFIX"] = self._session_prefix()
        proc = subprocess.Popen(
            ["node", str(bridge)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            bufsize=1,
            cwd=str(bridge.parents[3]),
            env=env,
        )
        self._proc = proc
        atexit.register(self.cleanup)
        return proc

    def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            proc = self._ensure_process()
            return self._send(proc, payload)

    def _send(
        self,
        proc: subprocess.Popen[str],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if proc.stdin is None or proc.stdout is None:
            raise RuntimeError("Remnic bridge process is missing stdio pipes")
        proc.stdin.write(json.dumps(payload) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("Remnic bridge exited without a response")
        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(response.get("error", "Remnic bridge request failed"))
        return response

    def _bridge_path(self) -> Path:
        configured = os.environ.get("REMNIC_AMB_BRIDGE_PATH")
        if configured:
            path = Path(configured).expanduser().resolve()
        else:
            remnic_root = os.environ.get("REMNIC_REPO_ROOT")
            if not remnic_root:
                raise RuntimeError(
                    "Set REMNIC_REPO_ROOT or REMNIC_AMB_BRIDGE_PATH before using "
                    "the Remnic AMB provider."
                )
            path = (
                Path(remnic_root).expanduser().resolve()
                / "packages"
                / "bench"
                / "scripts"
                / "amb-remnic-bridge.mjs"
            )
        if not path.exists():
            raise RuntimeError(f"Remnic AMB bridge not found: {path}")
        return path

    def _session_prefix(self) -> str:
        if configured := os.environ.get("REMNIC_AMB_SESSION_PREFIX"):
            return configured
        if self._store_dir is None:
            return "amb"
        parts = self._store_dir.parts
        try:
            store_index = parts.index("_store")
        except ValueError:
            return "amb"
        if store_index < 2:
            return "amb"
        return parts[store_index - 2]

    @staticmethod
    def _document_payload(doc: Document) -> dict[str, Any]:
        return {
            "id": doc.id,
            "content": doc.content,
            "user_id": doc.user_id,
            "timestamp": doc.timestamp,
            "context": doc.context,
        }
