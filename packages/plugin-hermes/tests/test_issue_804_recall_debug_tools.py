from __future__ import annotations

import json
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
async def test_issue_804_client_methods_call_daemon_mcp_tools(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.recall_explain(sessionKey="hermes-session", namespace="project")
    await client.recall_tier_explain(namespace="project")
    await client.recall_xray("why this memory", budget=1200, disclosure="section")
    await client.memory_last_recall(sessionKey="hermes-session")
    await client.memory_intent_debug(namespace="project")
    await client.memory_qmd_debug(namespace="project")
    await client.memory_graph_explain(namespace="project")
    await client.memory_feedback_last_recall(memoryId="fact-1", vote="down", note="stale")
    await client.set_coding_context(
        "hermes-session",
        codingContext=None,
    )

    calls = client._http.post.await_args_list
    tool_names = [call.kwargs["json"]["params"]["name"] for call in calls]
    assert tool_names == [
        "engram.recall_explain",
        "engram.recall_tier_explain",
        "engram.recall_xray",
        "engram.memory_last_recall",
        "engram.memory_intent_debug",
        "engram.memory_qmd_debug",
        "engram.memory_graph_explain",
        "engram.memory_feedback",
        "engram.set_coding_context",
    ]
    assert calls[0].args == ("http://127.0.0.1:4318/mcp",)
    assert calls[2].kwargs["json"]["params"]["arguments"] == {
        "query": "why this memory",
        "budget": 1200,
        "disclosure": "section",
    }
    assert calls[7].kwargs["json"]["params"]["arguments"] == {
        "memoryId": "fact-1",
        "vote": "down",
        "note": "stale",
    }
    assert calls[8].kwargs["json"]["params"]["arguments"] == {
        "sessionKey": "hermes-session",
        "codingContext": None,
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


def test_issue_804_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_recall_explain",
        "remnic_recall_tier_explain",
        "remnic_recall_xray",
        "remnic_memory_last_recall",
        "remnic_memory_intent_debug",
        "remnic_memory_qmd_debug",
        "remnic_memory_graph_explain",
        "remnic_memory_feedback_last_recall",
        "remnic_set_coding_context",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert ctx.tools["remnic_recall_xray"]["schema"]["parameters"]["required"] == ["query"]
    assert ctx.tools["remnic_store"]["schema"]["parameters"]["additionalProperties"] is True
    assert ctx.tools["remnic_set_coding_context"]["schema"]["parameters"]["required"] == ["sessionKey"]
    assert ctx.tools["remnic_set_coding_context"]["schema"]["parameters"]["anyOf"] == [
        {"required": ["codingContext"]},
        {"required": ["projectTag"]},
    ]
    assert ctx.tools["engram_memory_feedback_last_recall"]["schema"]["name"] == "engram_memory_feedback_last_recall"


def test_issue_804_remnic_store_forwards_extensible_metadata() -> None:
    provider = RemnicMemoryProvider({})
    provider._client = MagicMock()
    provider._client.store = AsyncMock(return_value={"ok": True})  # type: ignore[union-attr]

    raw = provider.handle_tool_call(
        "remnic_store",
        {
            "content": "remember this",
            "category": "fact",
            "namespace": "project",
            "tags": ["remnic", "hermes"],
            "sessionKey": "tool-session",
        },
    )

    assert json.loads(raw) == {"ok": True}
    provider._client.store.assert_awaited_once_with(  # type: ignore[union-attr]
        content="remember this",
        category="fact",
        namespace="project",
        tags=["remnic", "hermes"],
        sessionKey="tool-session",
    )


@pytest.mark.asyncio
async def test_issue_804_provider_handlers_return_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.recall_explain() == {"error": "Not connected to Remnic"}
    assert await provider.recall_xray("why this memory") == {"error": "Not connected to Remnic"}
    assert await provider.set_coding_context("session") == {"error": "Not connected to Remnic"}
