from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from remnic_hermes import register
from remnic_hermes.client import RemnicClient
from remnic_hermes.provider import RemnicMemoryProvider


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class FakeAsyncClient:
    instances: list["FakeAsyncClient"] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.posts: list[tuple[str, dict[str, Any]]] = []
        self.gets: list[tuple[str, dict[str, Any] | None]] = []
        self.closed = False
        FakeAsyncClient.instances.append(self)

    async def post(self, path: str, *, json: dict[str, Any]) -> FakeResponse:
        self.posts.append((path, json))
        return FakeResponse({"ok": True, "path": path, "json": json})

    async def get(self, path: str, *, params: dict[str, Any] | None = None) -> FakeResponse:
        self.gets.append((path, params))
        return FakeResponse({"ok": True, "path": path, "params": params})

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def fake_httpx(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeAsyncClient.instances = []
    monkeypatch.setattr("remnic_hermes.client.httpx.AsyncClient", FakeAsyncClient)


@pytest.mark.asyncio
async def test_issue_805_client_methods_call_daemon_surfaces() -> None:
    client = RemnicClient(host="127.0.0.1", port=4318, token="token")
    http = FakeAsyncClient.instances[-1]

    await client.memory_get("fact 1", namespace="ns")
    await client.memory_store("remember this", category="fact", dryRun=True)
    await client.memory_timeline("fact 1", limit=10)
    await client.memory_entities(namespace="ns")
    await client.entity_get("Alice Example", namespace="ns")
    await client.memory_profile(namespace="ns")
    await client.memory_questions(namespace="ns")
    await client.memory_identity(namespace="ns")
    await client.memory_promote(memoryId="fact-1", sessionKey="hermes-session")
    await client.memory_outcome(memoryId="fact-1", outcome="success")
    await client.memory_capture("capture me", category="fact")
    await client.memory_action_apply("store_note", content="note")

    assert http.gets[:5] == [
        ("/memories/fact%201", {"namespace": "ns"}),
        ("/memories/fact%201/timeline", {"limit": 10}),
        ("/entities/Alice%20Example", {"namespace": "ns"}),
    ]

    assert http.posts[0] == (
        "/memories",
        {"content": "remember this", "category": "fact", "dryRun": True},
    )

    mcp_calls = [payload["params"] for path, payload in http.posts if path == "http://127.0.0.1:4318/mcp"]
    assert mcp_calls == [
        {"name": "engram.memory_entities_list", "arguments": {"namespace": "ns"}},
        {"name": "engram.memory_profile", "arguments": {"namespace": "ns"}},
        {"name": "engram.memory_questions", "arguments": {"namespace": "ns"}},
        {"name": "engram.memory_identity", "arguments": {"namespace": "ns"}},
        {"name": "engram.memory_promote", "arguments": {"memoryId": "fact-1", "sessionKey": "hermes-session"}},
        {"name": "engram.memory_outcome", "arguments": {"memoryId": "fact-1", "outcome": "success"}},
        {"name": "engram.memory_store", "arguments": {"content": "capture me", "category": "fact"}},
        {"name": "engram.memory_action_apply", "arguments": {"action": "store_note", "content": "note"}},
    ]


class FakeContext:
    def __init__(self) -> None:
        self.config: dict[str, Any] = {"remnic": {}}
        self.provider: RemnicMemoryProvider | None = None
        self.tools: dict[str, dict[str, Any]] = {}

    def register_memory_provider(self, provider: RemnicMemoryProvider) -> None:
        self.provider = provider

    def register_tool(self, name: str, schema: dict[str, Any], handler: Any) -> None:
        self.tools[name] = {"schema": schema, "handler": handler}


def _runtime_memory_store_categories() -> list[str]:
    tools_source = (
        Path(__file__).resolve().parents[3] / "src" / "tools.ts"
    ).read_text(encoding="utf-8")
    memory_store_source = tools_source.split('name: "memory_store"', 1)[1].split(
        'name: "memory_capture"', 1
    )[0]
    match = re.search(
        r"category:\s+Type\.Optional\(.*?enum:\s*\[(.*?)\]",
        memory_store_source,
        re.DOTALL,
    )
    assert match is not None
    return re.findall(r"""["']([^"']+)["']""", match.group(1))


def test_issue_805_tools_are_registered_with_primary_and_legacy_names() -> None:
    ctx = FakeContext()

    register(ctx)

    expected_primary = {
        "remnic_memory_get",
        "remnic_memory_store",
        "remnic_memory_timeline",
        "remnic_memory_profile",
        "remnic_memory_entities",
        "remnic_memory_questions",
        "remnic_memory_identity",
        "remnic_memory_promote",
        "remnic_memory_outcome",
        "remnic_entity_get",
        "remnic_memory_capture",
        "remnic_memory_action_apply",
    }
    expected_legacy = {name.replace("remnic_", "engram_") for name in expected_primary}

    assert {"remnic_store", "engram_store"}.issubset(ctx.tools)
    assert expected_primary.issubset(ctx.tools)
    assert expected_legacy.issubset(ctx.tools)
    assert ctx.tools["remnic_memory_store"]["schema"]["name"] == "remnic_memory_store"
    assert ctx.tools["engram_memory_store"]["schema"]["name"] == "engram_memory_store"
    assert ctx.tools["remnic_store"]["handler"] is not ctx.tools["remnic_memory_store"]["handler"]
    assert ctx.tools["remnic_memory_store"]["schema"]["parameters"]["properties"]["category"] == {
        "type": "string",
        "enum": [
            "fact",
            "preference",
            "correction",
            "entity",
            "decision",
            "relationship",
            "principle",
            "commitment",
            "moment",
            "skill",
            "rule",
            "procedure",
            "reasoning_trace",
        ],
    }
    assert ctx.tools["remnic_memory_promote"]["schema"]["parameters"]["required"] == ["memoryId"]
    assert ctx.tools["remnic_memory_outcome"]["schema"]["parameters"]["required"] == [
        "memoryId",
        "outcome",
    ]


def test_issue_2392_memory_store_category_schema_matches_runtime_enum() -> None:
    ctx = FakeContext()

    register(ctx)

    category_schema = ctx.tools["remnic_memory_store"]["schema"]["parameters"]["properties"]["category"]

    assert category_schema["enum"] == _runtime_memory_store_categories()
