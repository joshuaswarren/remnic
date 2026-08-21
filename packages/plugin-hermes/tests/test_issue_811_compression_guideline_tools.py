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
async def test_issue_811_client_methods_call_daemon_mcp_tools(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.compression_guidelines_optimize(dryRun=True, eventLimit=25)
    await client.compression_guidelines_activate(
        expectedContentHash="sha256:abc",
        expectedGuidelineVersion=3,
    )

    calls = client._http.post.await_args_list
    tool_names = [call.kwargs["json"]["params"]["name"] for call in calls]
    assert tool_names == [
        "engram.compression_guidelines_optimize",
        "engram.compression_guidelines_activate",
    ]
    assert calls[0].kwargs["json"]["params"]["arguments"] == {
        "dryRun": True,
        "eventLimit": 25,
    }
    assert calls[1].kwargs["json"]["params"]["arguments"] == {
        "expectedContentHash": "sha256:abc",
        "expectedGuidelineVersion": 3,
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


def test_issue_811_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_compression_guidelines_optimize",
        "remnic_compression_guidelines_activate",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert "dryRun" in ctx.tools["remnic_compression_guidelines_optimize"]["schema"]["parameters"]["properties"]
    assert "eventLimit" in ctx.tools["remnic_compression_guidelines_optimize"]["schema"]["parameters"]["properties"]
    assert "expectedContentHash" in (
        ctx.tools["remnic_compression_guidelines_activate"]["schema"]["parameters"]["properties"]
    )
    assert ctx.tools["engram_compression_guidelines_activate"]["schema"]["name"] == (
        "engram_compression_guidelines_activate"
    )


@pytest.mark.asyncio
async def test_issue_811_provider_handlers_return_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.compression_guidelines_optimize() == {"error": "Not connected to Remnic"}
    assert await provider.compression_guidelines_activate() == {"error": "Not connected to Remnic"}
