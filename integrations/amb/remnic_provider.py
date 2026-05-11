"""Remnic provider for vectorize-io/agent-memory-benchmark.

Install this file into the public AMB checkout as:

    src/memory_bench/memory/remnic.py

The provider starts the Remnic JSONL bridge from this repository and keeps AMB
responsible for datasets, answer generation, judging, scoring, and result files.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import threading
from pathlib import Path
from typing import Any

from ..models import Document
from .base import MemoryProvider


class RemnicMemoryProvider(MemoryProvider):
    name = "remnic"
    description = (
        "Local Remnic memory provider. Uses the public AMB RAG pipeline while "
        "delegating ingest/retrieve to Remnic through a JSONL bridge."
    )
    kind = "local"
    provider = "remnic"
    variant = "local"
    link = "https://github.com/joshuaswarren/remnic"
    concurrency = 1

    def __init__(self) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._next_id = 1
        self._lock = threading.Lock()
        self._per_unit = False

    def initialize(self) -> None:
        self._ensure_proc()

    def cleanup(self) -> None:
        proc = self._proc
        if proc is None:
            return
        try:
            self._request("cleanup", {})
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        self._proc = None

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        self._per_unit = unit_ids is not None
        self._ensure_proc()
        if reset:
            self._request("reset", {})

    def ingest(self, documents: list[Document]) -> None:
        if self._per_unit:
            self._request("reset", {})
        payload = {
            "documents": [
                {
                    "id": doc.id,
                    "content": doc.content,
                    "user_id": doc.user_id,
                    "timestamp": doc.timestamp,
                    "context": doc.context,
                }
                for doc in documents
            ]
        }
        self._request("ingest", payload)

    def retrieve(
        self,
        query: str,
        k: int = 10,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[list[Document], dict | None]:
        result = self._request(
            "retrieve",
            {
                "query": query,
                "k": k,
                "user_id": user_id,
                "query_timestamp": query_timestamp,
            },
        )
        documents = [
            Document(
                id=str(item.get("id") or f"remnic-{idx}"),
                content=str(item.get("content") or ""),
                user_id=item.get("user_id"),
            )
            for idx, item in enumerate(result.get("documents", []))
            if str(item.get("content") or "").strip()
        ]
        return documents, result.get("raw_response")

    def _ensure_proc(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return

        cmd = self._bridge_command()
        env = os.environ.copy()
        cwd = env.get("REMNIC_REPO_PATH")
        self._proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def _bridge_command(self) -> list[str]:
        explicit = os.environ.get("REMNIC_AMB_BRIDGE_CMD")
        if explicit:
            return shlex.split(explicit)

        repo = os.environ.get("REMNIC_REPO_PATH")
        if not repo:
            raise RuntimeError(
                "REMNIC_REPO_PATH is required unless REMNIC_AMB_BRIDGE_CMD is set. "
                "Point it at a Remnic checkout."
            )
        bridge = Path(repo) / "integrations" / "amb" / "remnic-bridge.mjs"
        return ["pnpm", "exec", "tsx", str(bridge)]

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._ensure_proc()
        assert self._proc is not None
        assert self._proc.stdin is not None
        assert self._proc.stdout is not None

        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            self._proc.stdin.write(
                json.dumps({"id": request_id, "method": method, "params": params}) + "\n"
            )
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()

        if not line:
            stderr = self._read_stderr_tail()
            raise RuntimeError(f"Remnic AMB bridge exited without a response. {stderr}")

        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(str(response.get("error") or "unknown Remnic AMB bridge error"))
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    def _read_stderr_tail(self) -> str:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return ""
        try:
            return proc.stderr.read(4000)
        except Exception:
            return ""
