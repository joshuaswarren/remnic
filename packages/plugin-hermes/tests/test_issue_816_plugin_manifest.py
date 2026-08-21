from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from remnic_hermes import register
from remnic_hermes.provider import RemnicMemoryProvider


PLUGIN_MANIFEST = Path(__file__).resolve().parents[1] / "plugin.yaml"


class FakeContext:
    def __init__(self) -> None:
        self.config: dict[str, Any] = {"remnic": {}}
        self.provider: RemnicMemoryProvider | None = None
        self.tools: dict[str, dict[str, Any]] = {}
        self.hooks: dict[str, list[Callable[..., None]]] = {}

    def register_memory_provider(self, provider: RemnicMemoryProvider) -> None:
        self.provider = provider

    def register_tool(self, name: str, schema: dict[str, Any], handler: Any) -> None:
        self.tools[name] = {"schema": schema, "handler": handler}

    def register_hook(self, name: str, handler: Callable[..., None]) -> None:
        self.hooks.setdefault(name, []).append(handler)


def _manifest_scalar(text: str, key: str) -> str | None:
    prefix = f"{key}:"
    for line in text.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return None


def _manifest_list(text: str, key: str) -> list[str]:
    lines = text.splitlines()
    marker = f"{key}:"
    for index, line in enumerate(lines):
        if line.startswith(marker):
            values: list[str] = []
            for item in lines[index + 1 :]:
                if item.startswith("  - "):
                    values.append(item.removeprefix("  - ").strip())
                    continue
                if item and not item.startswith(" ") and not item.startswith("#"):
                    break
            return values
    return []


def test_issue_816_manifest_uses_hermes_supported_capability_fields() -> None:
    manifest = PLUGIN_MANIFEST.read_text()

    assert _manifest_scalar(manifest, "kind") == "exclusive"
    assert _manifest_scalar(manifest, "type") is None
    assert _manifest_list(manifest, "tools") == []
    assert "does not register as `context_engine`" in manifest
    assert "docs/plugins/hermes.md#which-hermes-plugin-slot-remnic-uses" in manifest


def test_issue_816_manifest_capabilities_match_registered_surfaces() -> None:
    manifest = PLUGIN_MANIFEST.read_text()
    ctx = FakeContext()

    register(ctx)

    assert set(_manifest_list(manifest, "provides_tools")) == set(ctx.tools)
    assert set(_manifest_list(manifest, "provides_hooks")) == set(ctx.hooks)
    assert "remnic_lcm_search" in _manifest_list(manifest, "provides_tools")
    assert "engram_lcm_search" in _manifest_list(manifest, "provides_tools")
    assert "on_session_reset" in _manifest_list(manifest, "provides_hooks")
