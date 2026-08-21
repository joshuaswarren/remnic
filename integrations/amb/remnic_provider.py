"""Remnic provider for vectorize-io/agent-memory-benchmark.

Install this file into the public AMB checkout as:

    src/memory_bench/memory/remnic.py

The provider starts the Remnic JSONL bridge from this repository and keeps AMB
responsible for datasets, answer generation, judging, scoring, and result files.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shlex
import shutil
import subprocess
import threading
from collections import deque
from pathlib import Path
from typing import Any

from ..models import Document
from .base import MemoryProvider


UNIT_ID_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9._:-]+")
BRIDGE_CLEANUP_TIMEOUT_SECONDS = 2.0


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
        self._unit_ids: set[str] = set()
        self._base_store_dir: Path | None = None
        self._store_dir: Path | None = None
        self._active_store_dir: Path | None = None
        self._stderr_tail: deque[str] = deque(maxlen=200)
        self._stderr_thread: threading.Thread | None = None
        self._cleanup_timeout_seconds = BRIDGE_CLEANUP_TIMEOUT_SECONDS

    def initialize(self) -> None:
        self._ensure_proc()

    def cleanup(self) -> None:
        self._stop_proc(send_cleanup=True)

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        self._per_unit = unit_ids is not None
        self._unit_ids = {str(unit_id) for unit_id in unit_ids or set()}
        resolved_store_dir = store_dir.expanduser().resolve()
        self._base_store_dir = resolved_store_dir
        if self._per_unit:
            if reset:
                shutil.rmtree(self._unit_store_root(), ignore_errors=True)
            if self._proc is not None and self._proc.poll() is None:
                self._stop_proc(send_cleanup=True)
            self._store_dir = None
            return

        self._activate_store_dir(resolved_store_dir)
        if reset:
            self._request("reset", {})

    def ingest(self, documents: list[Document]) -> None:
        if self._per_unit:
            self._activate_store_dir(self._unit_store_dir(self._unit_id_from_documents(documents)))
            self._request("reset", {})
        payload = {
            "documents": [
                self._serialize_document(doc)
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
        if self._per_unit:
            self._activate_store_dir(self._unit_store_dir(self._unit_id_from_query(user_id)))
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

    def _activate_store_dir(self, store_dir: Path) -> None:
        resolved_store_dir = store_dir.expanduser().resolve()
        if (
            self._proc is not None
            and self._proc.poll() is None
            and self._active_store_dir != resolved_store_dir
        ):
            self._stop_proc(send_cleanup=True)
        self._store_dir = resolved_store_dir
        self._ensure_proc()

    def _unit_store_root(self) -> Path:
        if self._base_store_dir is None:
            raise RuntimeError("prepare() must be called before per-unit AMB operations.")
        return self._base_store_dir / "amb-units"

    def _unit_store_dir(self, unit_id: str) -> Path:
        return self._unit_store_root() / self._sanitize_unit_id(unit_id)

    def _unit_id_from_documents(self, documents: list[Document]) -> str:
        candidates = {
            str(doc.user_id).strip()
            for doc in documents
            if getattr(doc, "user_id", None) is not None and str(doc.user_id).strip()
        }
        return self._select_unit_id(candidates, "ingest documents")

    def _unit_id_from_query(self, user_id: str | None) -> str:
        candidates = {user_id.strip()} if isinstance(user_id, str) and user_id.strip() else set()
        return self._select_unit_id(candidates, "retrieve query")

    def _select_unit_id(self, candidates: set[str], label: str) -> str:
        supplied_candidates = set(candidates)
        if self._unit_ids:
            candidates = {candidate for candidate in candidates if candidate in self._unit_ids}
        if len(candidates) == 1:
            return next(iter(candidates))
        if not candidates and not supplied_candidates and len(self._unit_ids) == 1:
            return next(iter(self._unit_ids))
        if not candidates and supplied_candidates:
            raise RuntimeError(
                f"unknown AMB unit id for {label}; received {sorted(supplied_candidates)}"
            )
        if not candidates:
            raise RuntimeError(f"unable to determine AMB unit id for {label}.")
        raise RuntimeError(
            f"expected exactly one AMB unit id for {label}; received {sorted(candidates)}"
        )

    def _sanitize_unit_id(self, unit_id: str) -> str:
        raw = str(unit_id).strip()
        safe = UNIT_ID_UNSAFE_RE.sub("-", raw)[:120] or "unknown"
        if safe == ".":
            safe = "dot"
        if safe == "..":
            safe = "dot-dot"
        if safe != raw:
            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
            prefix = safe[:107].rstrip("-") or "unknown"
            return f"{prefix}-{digest}"
        return safe or "unknown"

    def _ensure_proc(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return

        cmd = self._bridge_command()
        env = os.environ.copy()
        cwd = self._repo_root()
        if cwd:
            env.setdefault("REMNIC_REPO_PATH", cwd)
            env.setdefault("REMNIC_REPO_ROOT", cwd)
        if self._store_dir is not None:
            env["REMNIC_AMB_STORE_DIR"] = str(self._store_dir)
        self._stderr_tail.clear()
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
        self._active_store_dir = self._store_dir
        self._start_stderr_drain(self._proc)

    def _bridge_command(self) -> list[str]:
        explicit = os.environ.get("REMNIC_AMB_BRIDGE_CMD")
        if explicit:
            return shlex.split(explicit)

        repo = self._repo_root()
        if not repo:
            raise RuntimeError(
                "REMNIC_REPO_PATH or REMNIC_REPO_ROOT is required unless "
                "REMNIC_AMB_BRIDGE_CMD is set. "
                "Point it at a Remnic checkout."
            )
        bridge = Path(repo) / "integrations" / "amb" / "remnic-bridge.mjs"
        return ["pnpm", "exec", "tsx", str(bridge)]

    def _repo_root(self) -> str | None:
        repo_root = os.environ.get("REMNIC_REPO_PATH") or os.environ.get("REMNIC_REPO_ROOT")
        if not repo_root:
            return None
        return str(Path(repo_root).expanduser().resolve())

    def _request(
        self,
        method: str,
        params: dict[str, Any],
        ensure_running: bool = True,
    ) -> dict[str, Any]:
        if ensure_running:
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
        if not isinstance(response, dict):
            raise RuntimeError("Remnic AMB bridge returned a non-object response.")
        if not response.get("ok"):
            raise RuntimeError(str(response.get("error") or "unknown Remnic AMB bridge error"))
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    def _read_stderr_tail(self) -> str:
        if not self._stderr_tail:
            return ""
        tail = "\n".join(self._stderr_tail)
        if len(tail) > 4000:
            tail = tail[-4000:]
        return f"stderr tail:\n{tail}"

    def _start_stderr_drain(self, proc: subprocess.Popen[str]) -> None:
        if proc.stderr is None:
            return

        def drain() -> None:
            assert proc.stderr is not None
            try:
                for line in proc.stderr:
                    self._stderr_tail.append(line.rstrip())
            except Exception:
                return

        self._stderr_thread = threading.Thread(
            target=drain,
            name="remnic-amb-bridge-stderr",
            daemon=True,
        )
        self._stderr_thread.start()

    def _stop_proc(self, send_cleanup: bool) -> None:
        proc = self._proc
        if proc is None:
            return
        try:
            if send_cleanup and proc.poll() is None:
                self._request_cleanup_best_effort(proc)
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)
        finally:
            if self._proc is proc:
                self._proc = None
                self._active_store_dir = None

    def _request_cleanup_best_effort(self, proc: subprocess.Popen[str]) -> None:
        if proc.stdin is None or proc.stdout is None:
            return

        def cleanup() -> None:
            try:
                with self._lock:
                    if proc.poll() is not None:
                        return
                    request_id = self._next_id
                    self._next_id += 1
                    proc.stdin.write(
                        json.dumps({"id": request_id, "method": "cleanup", "params": {}})
                        + "\n"
                    )
                    proc.stdin.flush()
                    stdout = proc.stdout
                stdout.readline()
            except Exception:
                return

        thread = threading.Thread(
            target=cleanup,
            name="remnic-amb-bridge-cleanup",
            daemon=True,
        )
        thread.start()
        thread.join(timeout=self._cleanup_timeout_seconds)

    def _serialize_document(self, doc: Document) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": doc.id,
            "content": doc.content,
            "user_id": doc.user_id,
            "timestamp": doc.timestamp,
            "context": doc.context,
        }
        messages = getattr(doc, "messages", None)
        if messages is not None:
            serialized_messages = []
            for message in messages:
                serialized = self._jsonable_message(message)
                if serialized:
                    serialized_messages.append(serialized)
            payload["messages"] = serialized_messages
        return payload

    def _jsonable_message(self, message: Any) -> dict[str, Any]:
        if isinstance(message, dict):
            raw = message
        elif hasattr(message, "model_dump"):
            raw = message.model_dump()
        elif hasattr(message, "dict"):
            raw = message.dict()
        else:
            raw = {
                key: getattr(message, key)
                for key in ("id", "turn_id", "turnId", "role", "timestamp", "content")
                if hasattr(message, key)
            }
        jsonable = self._jsonable(raw)
        return jsonable if isinstance(jsonable, dict) else {}

    def _jsonable(self, value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, dict):
            result: dict[str, Any] = {}
            for key, entry in value.items():
                jsonable_entry = self._jsonable(entry)
                if jsonable_entry is not None:
                    result[str(key)] = jsonable_entry
            return result
        if isinstance(value, (list, tuple)):
            return [self._jsonable(entry) for entry in value]
        return str(value)
