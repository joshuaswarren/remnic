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
async def test_issue_813_client_methods_call_daemon_mcp_tools(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.day_summary(memories="fact A", sessionKey="session-1", namespace="project")
    await client.briefing(since="yesterday", focus="project:remnic", format="markdown", maxFollowups=1)
    await client.context_checkpoint("session-1", "Current task state", namespace="project")

    calls = client._http.post.await_args_list
    tool_names = [call.kwargs["json"]["params"]["name"] for call in calls]
    assert tool_names == [
        "engram.day_summary",
        "engram.briefing",
        "engram.context_checkpoint",
    ]
    assert calls[0].kwargs["json"]["params"]["arguments"] == {
        "memories": "fact A",
        "sessionKey": "session-1",
        "namespace": "project",
    }
    assert calls[1].kwargs["json"]["params"]["arguments"] == {
        "since": "yesterday",
        "focus": "project:remnic",
        "format": "markdown",
        "maxFollowups": 1,
    }
    assert calls[2].kwargs["json"]["params"]["arguments"] == {
        "sessionKey": "session-1",
        "context": "Current task state",
        "namespace": "project",
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


def test_issue_813_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_day_summary",
        "remnic_briefing",
        "remnic_context_checkpoint",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert ctx.tools["remnic_day_summary"]["schema"]["parameters"]["properties"]["namespace"]["type"] == "string"
    assert ctx.tools["remnic_briefing"]["schema"]["parameters"]["properties"]["format"]["enum"] == [
        "markdown",
        "json",
    ]
    assert ctx.tools["remnic_context_checkpoint"]["schema"]["parameters"]["required"] == [
        "sessionKey",
        "context",
    ]
    assert ctx.tools["engram_context_checkpoint"]["schema"]["name"] == "engram_context_checkpoint"


@pytest.mark.asyncio
async def test_issue_813_provider_handlers_return_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.day_summary() == {"error": "Not connected to Remnic"}
    assert await provider.briefing() == {"error": "Not connected to Remnic"}
    assert await provider.context_checkpoint("session-1", "context", framework_metadata=True) == {
        "error": "Not connected to Remnic",
    }
