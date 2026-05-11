from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class Document:
    id: str
    content: str
    user_id: str | None = None
    timestamp: str | None = None
    context: str | None = None


class MemoryProvider:
    pass


def load_provider_module() -> Any:
    repo_root = Path(__file__).resolve().parents[1]
    memory_bench = types.ModuleType("memory_bench")
    memory_bench.__path__ = []
    memory = types.ModuleType("memory_bench.memory")
    memory.__path__ = []
    models = types.ModuleType("memory_bench.models")
    models.Document = Document
    base = types.ModuleType("memory_bench.memory.base")
    base.MemoryProvider = MemoryProvider
    sys.modules["memory_bench"] = memory_bench
    sys.modules["memory_bench.memory"] = memory
    sys.modules["memory_bench.models"] = models
    sys.modules["memory_bench.memory.base"] = base

    spec = importlib.util.spec_from_file_location(
        "memory_bench.memory.remnic",
        repo_root / "integrations" / "amb" / "remnic_provider.py",
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["memory_bench.memory.remnic"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeProc:
    def poll(self) -> None:
        return None


class RemnicProviderPerUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        module = load_provider_module()

        class FakeProvider(module.RemnicMemoryProvider):
            def __init__(self) -> None:
                super().__init__()
                self.requests: list[tuple[str, dict[str, Any], Path | None]] = []
                self.ensured: list[Path | None] = []
                self.stopped: list[Path | None] = []

            def _ensure_proc(self) -> None:
                self.ensured.append(self._store_dir)
                self._proc = FakeProc()
                self._active_store_dir = self._store_dir

            def _stop_proc(self, send_cleanup: bool) -> None:
                self.stopped.append(self._active_store_dir)
                self._proc = None
                self._active_store_dir = None

            def _request(
                self,
                method: str,
                params: dict[str, Any],
                ensure_running: bool = True,
            ) -> dict[str, Any]:
                self.requests.append((method, params, self._store_dir))
                if method == "retrieve":
                    return {
                        "documents": [
                            {
                                "id": "doc",
                                "content": "Marisol owned it.",
                                "user_id": params.get("user_id"),
                            }
                        ],
                        "raw_response": {"store": str(self._store_dir)},
                    }
                return {}

        self.provider_class = FakeProvider

    def test_isolated_units_use_distinct_persistent_store_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            resolved_base = base.expanduser().resolve()
            provider = self.provider_class()
            provider.prepare(base, {"unit/one", "unit two"}, reset=True)

            provider.ingest([Document(id="d1", content="one", user_id="unit/one")])
            provider.ingest([Document(id="d2", content="two", user_id="unit two")])
            docs, raw = provider.retrieve("who owned it?", user_id="unit/one")

            unit_one = resolved_base / "amb-units" / "unit-one"
            unit_two = resolved_base / "amb-units" / "unit-two"
            reset_stores = [
                store
                for method, _params, store in provider.requests
                if method == "reset"
            ]
            ingest_stores = [
                store
                for method, _params, store in provider.requests
                if method == "ingest"
            ]
            retrieve_stores = [
                store
                for method, _params, store in provider.requests
                if method == "retrieve"
            ]

            self.assertEqual(reset_stores, [unit_one, unit_two])
            self.assertEqual(ingest_stores, [unit_one, unit_two])
            self.assertEqual(retrieve_stores, [unit_one])
            self.assertEqual(docs[0].content, "Marisol owned it.")
            self.assertEqual(raw, {"store": str(unit_one)})

    def test_skip_ingestion_prepare_preserves_unit_stores_until_retrieve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            resolved_base = base.expanduser().resolve()
            provider = self.provider_class()
            provider.prepare(base, {"alpha"}, reset=False)

            docs, raw = provider.retrieve("who owned it?", user_id="alpha")

            alpha = resolved_base / "amb-units" / "alpha"
            self.assertEqual(provider.requests[0][0], "retrieve")
            self.assertEqual(provider.requests[0][2], alpha)
            self.assertEqual(docs[0].user_id, "alpha")
            self.assertEqual(raw, {"store": str(alpha)})

    def test_isolated_ingest_requires_one_unit_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            provider = self.provider_class()
            provider.prepare(Path(tmp), {"a", "b"}, reset=True)

            with self.assertRaisesRegex(RuntimeError, "expected exactly one AMB unit id"):
                provider.ingest([
                    Document(id="a-doc", content="a", user_id="a"),
                    Document(id="b-doc", content="b", user_id="b"),
                ])


if __name__ == "__main__":
    unittest.main()
