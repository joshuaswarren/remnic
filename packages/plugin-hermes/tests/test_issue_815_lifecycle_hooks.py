from __future__ import annotations

from typing import Any, Callable

from remnic_hermes import register
from remnic_hermes.provider import RemnicMemoryProvider


class FakeContext:
    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config: dict[str, Any] = config or {"remnic": {}}
        self.provider: RemnicMemoryProvider | None = None
        self.tools: dict[str, dict[str, Any]] = {}
        self.hooks: dict[str, list[Callable[..., None]]] = {}

    def register_memory_provider(self, provider: RemnicMemoryProvider) -> None:
        self.provider = provider

    def register_tool(self, name: str, schema: dict[str, Any], handler: Any) -> None:
        self.tools[name] = {"schema": schema, "handler": handler}

    def register_hook(self, name: str, handler: Callable[..., None]) -> None:
        self.hooks.setdefault(name, []).append(handler)


def test_issue_815_registers_session_reset_hook_when_supported() -> None:
    ctx = FakeContext()

    register(ctx)

    assert "on_session_reset" in ctx.hooks
    assert len(ctx.hooks["on_session_reset"]) == 1


def test_issue_815_session_reset_hook_updates_generated_session_key() -> None:
    ctx = FakeContext()

    register(ctx)
    assert ctx.provider is not None
    original_key = ctx.provider._session_key

    ctx.hooks["on_session_reset"][0](session_id="hermes-reset-session", platform="cli")

    assert original_key.startswith("hermes-")
    assert ctx.provider._session_key == "hermes-reset-session"


def test_issue_815_session_reset_hook_preserves_explicit_session_key() -> None:
    ctx = FakeContext({"remnic": {"session_key": "configured-session"}})

    register(ctx)
    assert ctx.provider is not None

    ctx.hooks["on_session_reset"][0](session_id="hermes-reset-session", platform="cli")

    assert ctx.provider._session_key == "configured-session"
