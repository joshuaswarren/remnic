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
async def test_issue_809_client_methods_call_daemon_mcp_tools(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.shared_context_write_output(
        agent_id="reviewer",
        title="API review",
        content="Looks good.",
    )
    await client.shared_feedback_record(
        agent="reviewer",
        decision="approved_with_feedback",
        reason="Accepted with one style note.",
        tags=["api", "review"],
    )
    await client.shared_priorities_append(
        agent_id="planner",
        text="- Ship Hermes parity",
    )
    await client.shared_context_cross_signals_run(date="2026-04-30")
    await client.shared_context_curate_daily(date="2026-04-30")

    calls = client._http.post.await_args_list
    tool_names = [call.kwargs["json"]["params"]["name"] for call in calls]
    assert tool_names == [
        "engram.shared_context_write_output",
        "engram.shared_feedback_record",
        "engram.shared_priorities_append",
        "engram.shared_context_cross_signals_run",
        "engram.shared_context_curate_daily",
    ]
    assert calls[0].kwargs["json"]["params"]["arguments"] == {
        "agentId": "reviewer",
        "title": "API review",
        "content": "Looks good.",
    }
    assert calls[1].kwargs["json"]["params"]["arguments"] == {
        "agent": "reviewer",
        "decision": "approved_with_feedback",
        "reason": "Accepted with one style note.",
        "tags": ["api", "review"],
    }
    assert calls[2].kwargs["json"]["params"]["arguments"] == {
        "agentId": "planner",
        "text": "- Ship Hermes parity",
    }
    assert calls[3].kwargs["json"]["params"]["arguments"] == {"date": "2026-04-30"}
    assert calls[4].kwargs["json"]["params"]["arguments"] == {"date": "2026-04-30"}


class FakeContext:
    def __init__(self) -> None:
        self.config: dict[str, Any] = {"remnic": {}}
        self.provider: RemnicMemoryProvider | None = None
        self.tools: dict[str, dict[str, Any]] = {}

    def register_memory_provider(self, provider: RemnicMemoryProvider) -> None:
        self.provider = provider

    def register_tool(self, name: str, schema: dict[str, Any], handler: Any) -> None:
        self.tools[name] = {"schema": schema, "handler": handler}


def test_issue_809_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_shared_context_write_output",
        "remnic_shared_feedback_record",
        "remnic_shared_priorities_append",
        "remnic_shared_context_cross_signals_run",
        "remnic_shared_context_curate_daily",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert ctx.tools["remnic_shared_context_write_output"]["schema"]["parameters"]["required"] == [
        "agentId",
        "title",
        "content",
    ]
    assert ctx.tools["remnic_shared_feedback_record"]["schema"]["parameters"]["required"] == [
        "agent",
        "decision",
        "reason",
    ]
    assert ctx.tools["remnic_shared_feedback_record"]["schema"]["parameters"]["properties"]["decision"]["enum"] == [
        "approved",
        "approved_with_feedback",
        "rejected",
    ]
    assert ctx.tools["remnic_shared_feedback_record"]["schema"]["parameters"]["properties"]["severity"]["enum"] == [
        "low",
        "medium",
        "high",
    ]
    assert ctx.tools["engram_shared_context_curate_daily"]["schema"]["name"] == (
        "engram_shared_context_curate_daily"
    )


@pytest.mark.asyncio
async def test_issue_809_provider_handlers_return_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.shared_context_write_output("agent", "title", "content") == {
        "error": "Not connected to Remnic"
    }
    assert await provider.shared_feedback_record("agent", "approved", "reason") == {
        "error": "Not connected to Remnic"
    }
    assert await provider.shared_priorities_append("agent", "notes") == {"error": "Not connected to Remnic"}
    assert await provider.shared_context_cross_signals_run() == {"error": "Not connected to Remnic"}
    assert await provider.shared_context_curate_daily() == {"error": "Not connected to Remnic"}
