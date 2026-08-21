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
async def test_issue_812_client_methods_call_daemon_mcp_tools(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.memory_governance_run(namespace="project", mode="shadow", maxMemories=5)
    await client.procedure_mining_run(namespace="project")
    await client.procedural_stats(namespace="project")
    await client.contradiction_scan_run(namespace="project")
    await client.memory_summarize_hourly()
    await client.conversation_index_update(sessionKey="session-1", hours=12, embed=True)

    calls = client._http.post.await_args_list
    tool_names = [call.kwargs["json"]["params"]["name"] for call in calls]
    assert tool_names == [
        "engram.memory_governance_run",
        "engram.procedure_mining_run",
        "engram.procedural_stats",
        "engram.contradiction_scan_run",
        "engram.memory_summarize_hourly",
        "engram.conversation_index_update",
    ]
    assert calls[0].kwargs["json"]["params"]["arguments"] == {
        "namespace": "project",
        "mode": "shadow",
        "maxMemories": 5,
    }
    assert calls[4].kwargs["json"]["params"]["arguments"] == {}
    assert calls[5].kwargs["json"]["params"]["arguments"] == {
        "sessionKey": "session-1",
        "hours": 12,
        "embed": True,
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


def test_issue_812_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_memory_governance_run",
        "remnic_procedure_mining_run",
        "remnic_procedural_stats",
        "remnic_contradiction_scan_run",
        "remnic_memory_summarize_hourly",
        "remnic_conversation_index_update",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert ctx.tools["remnic_memory_governance_run"]["schema"]["parameters"]["properties"]["mode"]["enum"] == [
        "shadow",
        "apply",
    ]
    assert ctx.tools["remnic_memory_summarize_hourly"]["schema"]["parameters"]["properties"] == {}
    assert "embed" in ctx.tools["remnic_conversation_index_update"]["schema"]["parameters"]["properties"]
    assert ctx.tools["engram_conversation_index_update"]["schema"]["name"] == "engram_conversation_index_update"


@pytest.mark.asyncio
async def test_issue_812_provider_handlers_return_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.memory_governance_run() == {"error": "Not connected to Remnic"}
    assert await provider.procedure_mining_run() == {"error": "Not connected to Remnic"}
    assert await provider.procedural_stats() == {"error": "Not connected to Remnic"}
    assert await provider.contradiction_scan_run() == {"error": "Not connected to Remnic"}
    assert await provider.memory_summarize_hourly(framework_metadata=True) == {"error": "Not connected to Remnic"}
    assert await provider.conversation_index_update() == {"error": "Not connected to Remnic"}
