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
async def test_issue_806_client_methods_call_daemon_mcp_tools(client: RemnicClient) -> None:
    response = MagicMock()
    response.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    client._http = MagicMock()
    client._http.post = AsyncMock(return_value=response)

    await client.continuity_audit_generate(period="weekly", key="2026-W18")
    await client.continuity_incident_open(
        "identity drift",
        namespace="project",
        triggerWindow="today",
        suspectedCause="stale context",
    )
    await client.continuity_incident_close(
        "incident-1",
        fix_applied="refreshed anchor",
        verification_result="manual check passed",
        preventiveRule="review weekly",
    )
    await client.continuity_incident_list(state="all", limit=10)
    await client.continuity_loop_add_or_update(
        "loop-1",
        cadence="weekly",
        purpose="Review continuity drift",
        status="active",
        kill_condition="No incidents for 90 days",
        notes="Initial loop",
    )
    await client.continuity_loop_review("loop-1", status="paused", reviewedAt="2026-04-30T00:00:00Z")
    await client.identity_anchor_get(namespace="project")
    await client.identity_anchor_update(
        identityTraits="Direct and pragmatic.",
        communicationPreferences="Prefer concise updates.",
    )

    calls = client._http.post.await_args_list
    tool_names = [call.kwargs["json"]["params"]["name"] for call in calls]
    assert tool_names == [
        "engram.continuity_audit_generate",
        "engram.continuity_incident_open",
        "engram.continuity_incident_close",
        "engram.continuity_incident_list",
        "engram.continuity_loop_add_or_update",
        "engram.continuity_loop_review",
        "engram.identity_anchor_get",
        "engram.identity_anchor_update",
    ]
    assert calls[1].kwargs["json"]["params"]["arguments"] == {
        "symptom": "identity drift",
        "namespace": "project",
        "triggerWindow": "today",
        "suspectedCause": "stale context",
    }
    assert calls[2].kwargs["json"]["params"]["arguments"] == {
        "id": "incident-1",
        "fixApplied": "refreshed anchor",
        "verificationResult": "manual check passed",
        "preventiveRule": "review weekly",
    }
    assert calls[4].kwargs["json"]["params"]["arguments"] == {
        "id": "loop-1",
        "cadence": "weekly",
        "purpose": "Review continuity drift",
        "status": "active",
        "killCondition": "No incidents for 90 days",
        "notes": "Initial loop",
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


def test_issue_806_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_continuity_audit_generate",
        "remnic_continuity_incident_open",
        "remnic_continuity_incident_close",
        "remnic_continuity_incident_list",
        "remnic_continuity_loop_add_or_update",
        "remnic_continuity_loop_review",
        "remnic_identity_anchor_get",
        "remnic_identity_anchor_update",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert ctx.tools["remnic_continuity_incident_open"]["schema"]["parameters"]["required"] == ["symptom"]
    assert ctx.tools["remnic_continuity_incident_close"]["schema"]["parameters"]["required"] == [
        "id",
        "fixApplied",
        "verificationResult",
    ]
    assert ctx.tools["remnic_continuity_loop_add_or_update"]["schema"]["parameters"]["required"] == [
        "id",
        "cadence",
        "purpose",
        "status",
        "killCondition",
    ]
    assert ctx.tools["remnic_continuity_incident_list"]["schema"]["parameters"]["properties"]["state"]["enum"] == [
        "open",
        "closed",
        "all",
    ]
    assert ctx.tools["remnic_continuity_loop_review"]["schema"]["parameters"]["properties"]["status"]["enum"] == [
        "active",
        "paused",
        "retired",
    ]
    assert ctx.tools["engram_identity_anchor_update"]["schema"]["name"] == "engram_identity_anchor_update"


@pytest.mark.asyncio
async def test_issue_806_provider_handlers_return_not_connected_before_initialize() -> None:
    provider = RemnicMemoryProvider({})

    assert await provider.continuity_audit_generate() == {"error": "Not connected to Remnic"}
    assert await provider.continuity_incident_open("drift") == {"error": "Not connected to Remnic"}
    assert await provider.identity_anchor_get() == {"error": "Not connected to Remnic"}
