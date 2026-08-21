from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from remnic_hermes import register
from remnic_hermes.client import RemnicClient
from remnic_hermes.provider import RemnicMemoryProvider


@pytest.fixture
def client() -> RemnicClient:
    return RemnicClient(host="127.0.0.1", port=4318, token="test-token")


@pytest.mark.asyncio
async def test_issue_814_client_method_calls_daemon_mcp_tool(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"enabled": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.profiling_report(format="json", limit=3)

    call = client._http.post.await_args
    assert call.kwargs["json"]["params"]["name"] == "engram.profiling_report"
    assert call.kwargs["json"]["params"]["arguments"] == {
        "format": "json",
        "limit": 3,
    }


class FakeContext:
    def __init__(self) -> None:
        self.config: dict[str, Any] = {"remnic": {}}
        self.provider: RemnicMemoryProvider | None = None
        self.tools: dict[str, dict[str, Any]] = {}

    def register_memory_provider(self, provider: RemnicMemoryProvider) -> None:
        self.provider = provider

    def register_tool(self, name: str, schema: dict[str, Any], handler: Any) -> None:
        self.tools[name] = {"schema": schema, "handler": handler}


def test_issue_814_tool_is_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    assert "remnic_profiling_report" in ctx.tools
    assert "engram_profiling_report" in ctx.tools
    assert ctx.tools["remnic_profiling_report"]["schema"]["parameters"]["properties"]["format"]["enum"] == [
        "ascii",
        "json",
    ]
    assert ctx.tools["remnic_profiling_report"]["schema"]["parameters"]["properties"]["limit"]["maximum"] == 20
    assert ctx.tools["engram_profiling_report"]["schema"]["name"] == "engram_profiling_report"


@pytest.mark.asyncio
async def test_issue_814_provider_handler_returns_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.profiling_report(format="ascii") == {"error": "Not connected to Remnic"}
