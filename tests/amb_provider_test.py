from __future__ import annotations

import importlib.util
import hashlib
import os
import sys
import tempfile
import types
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import patch


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
    module_keys = [
        "memory_bench",
        "memory_bench.memory",
        "memory_bench.models",
        "memory_bench.memory.base",
        "memory_bench.memory.remnic",
    ]
    missing = object()
    previous_modules = {key: sys.modules.get(key, missing) for key in module_keys}
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
    try:
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
    finally:
        for key, value in previous_modules.items():
            if value is missing:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value


class FakeProc:
    def poll(self) -> None:
        return None


class FakeStdin:
    def write(self, _text: str) -> None:
        return None

    def flush(self) -> None:
        return None


class FakeStdout:
    def __init__(self, line: str) -> None:
        self._line = line

    def readline(self) -> str:
        return self._line


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

            unit_one = resolved_base / "amb-units" / provider._sanitize_unit_id("unit/one")
            unit_two = resolved_base / "amb-units" / provider._sanitize_unit_id("unit two")
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

    def test_isolated_unit_store_dirs_are_collision_resistant(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            resolved_base = base.expanduser().resolve()
            provider = self.provider_class()
            provider.prepare(base, {"team/a", "team a"}, reset=True)

            provider.ingest([Document(id="slash-doc", content="slash", user_id="team/a")])
            provider.ingest([Document(id="space-doc", content="space", user_id="team a")])

            unit_root = resolved_base / "amb-units"
            slash = unit_root / provider._sanitize_unit_id("team/a")
            space = unit_root / provider._sanitize_unit_id("team a")
            reset_stores = [
                store
                for method, _params, store in provider.requests
                if method == "reset"
            ]

            self.assertNotEqual(slash, space)
            self.assertRegex(slash.name, r"^team-a-[a-f0-9]{12}$")
            self.assertRegex(space.name, r"^team-a-[a-f0-9]{12}$")
            self.assertEqual(reset_stores, [slash, space])

    def test_unit_store_sanitizer_matches_bridge_ascii_collapsing(self) -> None:
        provider = self.provider_class()

        team_hash = hashlib.sha256("team//a".encode("utf-8")).hexdigest()[:12]
        accent_hash = hashlib.sha256("é".encode("utf-8")).hexdigest()[:12]
        dot_hash = hashlib.sha256(".".encode("utf-8")).hexdigest()[:12]
        dot_dot_hash = hashlib.sha256("..".encode("utf-8")).hexdigest()[:12]

        self.assertEqual(provider._sanitize_unit_id("team//a"), f"team-a-{team_hash}")
        self.assertEqual(provider._sanitize_unit_id("é"), f"unknown-{accent_hash}")
        self.assertEqual(provider._sanitize_unit_id("."), f"dot-{dot_hash}")
        self.assertEqual(provider._sanitize_unit_id(".."), f"dot-dot-{dot_dot_hash}")
        self.assertNotEqual(provider._sanitize_unit_id("."), provider._sanitize_unit_id("dot"))
        self.assertNotEqual(provider._sanitize_unit_id(".."), provider._sanitize_unit_id("dot-dot"))

    def test_dot_segment_unit_ids_stay_under_unit_store_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            resolved_base = base.expanduser().resolve()
            provider = self.provider_class()
            provider.prepare(base, {".", ".."}, reset=True)

            provider.ingest([Document(id="dot-doc", content="dot", user_id=".")])
            provider.ingest([Document(id="parent-doc", content="parent", user_id="..")])

            unit_root = resolved_base / "amb-units"
            dot = unit_root / provider._sanitize_unit_id(".")
            dot_dot = unit_root / provider._sanitize_unit_id("..")
            reset_stores = [
                store
                for method, _params, store in provider.requests
                if method == "reset"
            ]

            self.assertEqual(reset_stores, [dot, dot_dot])
            self.assertTrue(all(store is not None and unit_root in store.parents for store in reset_stores))
            self.assertNotIn(resolved_base, reset_stores)

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

    def test_isolated_retrieve_rejects_unknown_unit_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            provider = self.provider_class()
            provider.prepare(Path(tmp), {"alpha"}, reset=False)

            with self.assertRaisesRegex(RuntimeError, "unknown AMB unit id"):
                provider.retrieve("who owned it?", user_id="missing")

            self.assertEqual(provider.requests, [])

    def test_isolated_ingest_requires_one_unit_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            provider = self.provider_class()
            provider.prepare(Path(tmp), {"a", "b"}, reset=True)

            with self.assertRaisesRegex(RuntimeError, "expected exactly one AMB unit id"):
                provider.ingest([
                    Document(id="a-doc", content="a", user_id="a"),
                    Document(id="b-doc", content="b", user_id="b"),
                ])

    def test_bridge_response_must_be_json_object(self) -> None:
        provider = self.provider_class()
        provider._proc = FakeProc()
        provider._proc.stdin = FakeStdin()
        provider._proc.stdout = FakeStdout("null\n")

        base_request = provider.__class__.__mro__[1]._request
        with self.assertRaisesRegex(RuntimeError, "non-object response"):
            base_request(provider, "retrieve", {"query": "who owned it?"}, ensure_running=False)

    def test_repo_root_expands_shell_style_env_paths(self) -> None:
        module = load_provider_module()
        provider = module.RemnicMemoryProvider()

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            repo = home / "remnic"
            repo.mkdir()

            with patch.dict(
                os.environ,
                {"HOME": str(home), "REMNIC_REPO_PATH": "~/remnic"},
                clear=False,
            ):
                self.assertEqual(provider._repo_root(), str(repo.resolve()))

    def test_load_provider_module_restores_existing_module_stubs(self) -> None:
        sentinel_modules = {
            key: types.ModuleType(f"sentinel.{key}")
            for key in [
                "memory_bench",
                "memory_bench.memory",
                "memory_bench.models",
                "memory_bench.memory.base",
            ]
        }

        with patch.dict(sys.modules, sentinel_modules, clear=False):
            sys.modules.pop("memory_bench.memory.remnic", None)

            module = load_provider_module()

            self.assertTrue(hasattr(module, "RemnicMemoryProvider"))
            for key, sentinel in sentinel_modules.items():
                self.assertIs(sys.modules.get(key), sentinel)
            self.assertNotIn("memory_bench.memory.remnic", sys.modules)


if __name__ == "__main__":
    unittest.main()
