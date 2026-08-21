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
async def test_issue_808_client_methods_call_daemon_mcp_tools(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.work_task(
        "create",
        title="Draft launch plan",
        status="todo",
        priority="high",
        tags=["launch", "docs"],
    )
    await client.work_project(
        "link_task",
        taskId="task-1",
        projectId="project-1",
    )
    await client.work_board(
        "export_snapshot",
        projectId="project-1",
        linkToMemory=True,
    )

    calls = client._http.post.await_args_list
    tool_names = [call.kwargs["json"]["params"]["name"] for call in calls]
    assert tool_names == [
        "engram.work_task",
        "engram.work_project",
        "engram.work_board",
    ]
    assert calls[0].kwargs["json"]["params"]["arguments"] == {
        "action": "create",
        "title": "Draft launch plan",
        "status": "todo",
        "priority": "high",
        "tags": ["launch", "docs"],
    }
    assert calls[1].kwargs["json"]["params"]["arguments"] == {
        "action": "link_task",
        "taskId": "task-1",
        "projectId": "project-1",
    }
    assert calls[2].kwargs["json"]["params"]["arguments"] == {
        "action": "export_snapshot",
        "projectId": "project-1",
        "linkToMemory": True,
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


def test_issue_808_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_work_task",
        "remnic_work_project",
        "remnic_work_board",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert ctx.tools["remnic_work_task"]["schema"]["parameters"]["required"] == ["action"]
    assert ctx.tools["remnic_work_task"]["schema"]["parameters"]["properties"]["action"]["enum"] == [
        "create",
        "get",
        "list",
        "update",
        "transition",
        "delete",
    ]
    assert ctx.tools["remnic_work_project"]["schema"]["parameters"]["properties"]["action"]["enum"] == [
        "create",
        "get",
        "list",
        "update",
        "delete",
        "link_task",
    ]
    assert ctx.tools["remnic_work_board"]["schema"]["parameters"]["properties"]["action"]["enum"] == [
        "export_markdown",
        "export_snapshot",
        "import_snapshot",
    ]
    assert ctx.tools["engram_work_board"]["schema"]["name"] == "engram_work_board"


@pytest.mark.asyncio
async def test_issue_808_provider_handlers_return_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.work_task("list") == {"error": "Not connected to Remnic"}
    assert await provider.work_project("list") == {"error": "Not connected to Remnic"}
    assert await provider.work_board("export_markdown") == {"error": "Not connected to Remnic"}
