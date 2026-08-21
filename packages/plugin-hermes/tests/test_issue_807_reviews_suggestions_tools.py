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
async def test_issue_807_client_methods_call_daemon_mcp_tools(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.review_queue_list(runId="run-1", namespace="project")
    await client.review_list(filter="duplicates", namespace="project", limit=5)
    await client.review_resolve("pair-1", "merge", mergedMemoryId="mem-merged-003")
    await client.suggestion_submit("Remember this after review.", category="fact", dryRun=True)

    calls = client._http.post.await_args_list
    tool_names = [call.kwargs["json"]["params"]["name"] for call in calls]
    assert tool_names == [
        "engram.review_queue_list",
        "engram.review_list",
        "engram.review_resolve",
        "engram.suggestion_submit",
    ]
    assert calls[0].kwargs["json"]["params"]["arguments"] == {
        "runId": "run-1",
        "namespace": "project",
    }
    assert calls[1].kwargs["json"]["params"]["arguments"] == {
        "filter": "duplicates",
        "namespace": "project",
        "limit": 5,
    }
    assert calls[2].kwargs["json"]["params"]["arguments"] == {
        "pairId": "pair-1",
        "verb": "merge",
        "mergedMemoryId": "mem-merged-003",
    }
    assert calls[3].kwargs["json"]["params"]["arguments"] == {
        "content": "Remember this after review.",
        "category": "fact",
        "dryRun": True,
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


def test_issue_807_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_review_queue_list",
        "remnic_review_list",
        "remnic_review_resolve",
        "remnic_suggestion_submit",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert ctx.tools["remnic_review_resolve"]["schema"]["parameters"]["required"] == ["pairId", "verb"]
    assert ctx.tools["remnic_review_list"]["schema"]["parameters"]["properties"]["filter"]["enum"] == [
        "all",
        "unresolved",
        "contradicts",
        "independent",
        "duplicates",
        "needs-user",
    ]
    assert ctx.tools["remnic_review_resolve"]["schema"]["parameters"]["properties"]["verb"]["enum"] == [
        "keep-a",
        "keep-b",
        "merge",
        "both-valid",
        "needs-more-context",
    ]
    assert "mergedMemoryId" in ctx.tools["remnic_review_resolve"]["schema"]["parameters"]["properties"]
    assert "mergedContent" in ctx.tools["remnic_review_resolve"]["schema"]["parameters"]["properties"]
    assert ctx.tools["remnic_suggestion_submit"]["schema"]["parameters"]["required"] == ["content"]
    assert ctx.tools["engram_suggestion_submit"]["schema"]["name"] == "engram_suggestion_submit"


@pytest.mark.asyncio
async def test_issue_807_provider_handlers_return_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.review_queue_list() == {"error": "Not connected to Remnic"}
    assert await provider.review_resolve("pair-1", "merge") == {"error": "Not connected to Remnic"}
    assert await provider.suggestion_submit("remember this") == {"error": "Not connected to Remnic"}
