"""Tests for the RemnicMemoryProvider lifecycle and methods."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from remnic_hermes import EngramMemoryProvider
from remnic_hermes.provider import RemnicMemoryProvider


def _wait_for_await(mock: AsyncMock, timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while mock.await_count == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert mock.await_count > 0


@pytest.fixture
def provider():
    """Create a provider with test config."""
    return RemnicMemoryProvider({"host": "127.0.0.1", "port": 4318, "token": "test-token"})


class TestProviderLifecycle:
    def test_current_hermes_memory_provider_shape(self, provider):
        """Provider exposes Hermes Agent's current sync MemoryProvider surface."""
        assert provider.name == "remnic"
        assert provider.is_available() is True
        assert callable(provider.initialize)
        assert callable(provider.prefetch)
        assert callable(provider.sync_turn)
        assert callable(provider.get_tool_schemas)
        assert callable(provider.handle_tool_call)

    def test_initialize_creates_client(self, provider):
        """initialize() should create a RemnicClient."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            provider.initialize("test-session")
            MockClient.assert_called_once()
            instance.health.assert_awaited_once()

    def test_initialize_forwards_timeout(self):
        """initialize() must pass the configured timeout to RemnicClient."""
        provider = RemnicMemoryProvider(
            {"host": "127.0.0.1", "port": 4318, "token": "test-token", "timeout": 60.0}
        )
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            provider.initialize("test-session")
            _, kwargs = MockClient.call_args
            assert kwargs.get("timeout") == 60.0, (
                "timeout from config must be forwarded to RemnicClient"
            )

    def test_initialize_uses_default_timeout(self, provider):
        """initialize() passes the default timeout (30.0) when not configured."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            provider.initialize("test-session")
            _, kwargs = MockClient.call_args
            assert kwargs.get("timeout") == 30.0

    def test_initialize_uses_hermes_session_id_when_not_pinned(self, provider):
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            provider.initialize("hermes-session-123")
            assert provider._session_key == "hermes-session-123"

    def test_initialize_ignores_legacy_config_dict_argument(self, provider):
        """Mixed-version callers may still pass initialize(config); it must not become the session key."""
        original_session_key = provider._session_key
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            provider.initialize({"session_key": "legacy-config-session"})
            assert provider._session_key == original_session_key

    def test_shutdown_closes_client(self, provider):
        """shutdown() should close the HTTP client."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.close = AsyncMock()
            provider.initialize("test-session")
            provider.shutdown()
            instance.close.assert_awaited_once()


class TestPreLlmCall:
    @pytest.mark.asyncio
    async def test_returns_empty_without_client(self, provider):
        """pre_llm_call returns empty string when not initialized."""
        result = await provider.pre_llm_call([{"role": "user", "content": "test query here"}])
        assert result == ""

    @pytest.mark.asyncio
    async def test_skips_short_queries(self, provider):
        """pre_llm_call skips queries shorter than 3 words."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.recall = AsyncMock()
            provider.initialize("test-session")
            result = await provider.pre_llm_call([{"role": "user", "content": "hi"}])
            assert result == ""
            instance.recall.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_injects_remnic_memory_block(self, provider):
        """pre_llm_call wraps recalled context in a <remnic-memory> block."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.recall = AsyncMock(return_value={"context": "prior memories", "count": 3})
            provider.initialize("test-session")
            result = await provider.pre_llm_call(
                [{"role": "user", "content": "what did we decide last week"}]
            )
            assert result.startswith('<remnic-memory count="3">')
            assert "prior memories" in result
            assert result.endswith("</remnic-memory>")


    @pytest.mark.asyncio
    async def test_default_recall_does_not_force_minimal_mode(self, provider):
        """pre_llm_call should let daemon recall defaults include LCM sections."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.recall = AsyncMock(return_value={"context": "prior", "count": 1})

            provider.initialize("test-session")
            await provider.pre_llm_call(
                [{"role": "user", "content": "what did we decide last week"}]
            )

            _, kwargs = instance.recall.call_args
            assert "mode" not in kwargs

    @pytest.mark.asyncio
    async def test_real_client_recall_stays_on_provider_loop_from_caller_loop(self):
        """A client initialized by initialize() must not be awaited on the caller's event loop."""
        caller_loop_id = id(asyncio.get_running_loop())
        request_loop_ids: list[int] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            request_loop_ids.append(id(asyncio.get_running_loop()))
            if request.url.path.endswith("/health"):
                return httpx.Response(200, json={"ok": True})
            if request.url.path.endswith("/recall"):
                return httpx.Response(200, json={"context": "prior memories", "count": 1})
            return httpx.Response(404, json={"error": "not found"})

        transport = httpx.MockTransport(handler)
        real_async_client = httpx.AsyncClient

        with patch("remnic_hermes.client.httpx.AsyncClient") as MockAsyncClient:
            MockAsyncClient.side_effect = lambda **kwargs: real_async_client(
                **kwargs,
                transport=transport,
            )
            provider = RemnicMemoryProvider({"host": "127.0.0.1", "port": 4318, "token": "test-token"})
            provider.initialize("test-session")

            result = await provider.pre_llm_call(
                [{"role": "user", "content": "what did we decide last week"}]
            )
            provider.shutdown()

        assert "prior memories" in result
        assert len(request_loop_ids) == 2
        assert set(request_loop_ids) != {caller_loop_id}
        assert len(set(request_loop_ids)) == 1


class TestPrefetch:
    def test_prefetch_returns_fast_first_fetch_and_caches_memory(self, provider):
        client = AsyncMock()
        client.recall = AsyncMock(return_value={"context": "cached prior", "count": 1})
        provider._client = client

        first = provider.prefetch("what did we decide last week", session_id="prefetch-session")
        assert first.startswith('<remnic-memory count="1">')
        assert "cached prior" in first

        second = provider.prefetch("what did we decide last week", session_id="prefetch-session")
        assert second.startswith('<remnic-memory count="1">')
        assert "cached prior" in second
        client.recall.assert_awaited_once_with(
            query="what did we decide last week",
            session_key="prefetch-session",
            top_k=8,
        )

    def test_prefetch_does_not_block_on_slow_daemon_recall(self, provider):
        client = AsyncMock()

        async def slow_recall(**kwargs):
            await asyncio.sleep(0.25)
            return {"context": "late prior", "count": 1}

        client.recall = AsyncMock(side_effect=slow_recall)
        provider._client = client

        started = time.monotonic()
        result = provider.prefetch("what did we decide last week")
        elapsed = time.monotonic() - started

        assert result == ""
        assert elapsed < 0.15
        _wait_for_await(client.recall)

    def test_prefetch_does_not_cache_transient_failures_as_empty(self, provider):
        client = AsyncMock()
        calls = 0

        async def flaky_recall(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("daemon warming up")
            return {"context": "recovered prior", "count": 1}

        client.recall = AsyncMock(side_effect=flaky_recall)
        provider._client = client

        first = provider.prefetch("what did we decide last week")
        second = provider.prefetch("what did we decide last week")

        assert first == ""
        assert second.startswith('<remnic-memory count="1">')
        assert "recovered prior" in second
        assert client.recall.await_count == 2

    def test_queue_prefetch_warms_cache_for_later_prefetch(self, provider):
        client = AsyncMock()
        client.recall = AsyncMock(return_value={"context": "queued prior", "count": 1})
        provider._client = client

        provider.queue_prefetch("what did we decide last week", session_id="prefetch-session")
        _wait_for_await(client.recall)

        result = provider.prefetch("what did we decide last week", session_id="prefetch-session")
        assert "queued prior" in result
        client.recall.assert_awaited_once()

    def test_sync_turn_invalidates_cached_prefetch_for_session(self, provider):
        client = AsyncMock()
        client.observe = AsyncMock(return_value={})
        recalls = [
            {"context": "before update", "count": 1},
            {"context": "after update", "count": 1},
        ]
        client.recall = AsyncMock(side_effect=recalls)
        provider._client = client

        first = provider.prefetch("what did we decide last week", session_id="prefetch-session")
        assert "before update" in first

        provider.sync_turn("new fact", "got it", session_id="prefetch-session")
        _wait_for_await(client.observe)

        second = provider.prefetch("what did we decide last week", session_id="prefetch-session")
        assert "after update" in second
        assert client.recall.await_count == 2

    def test_prefetch_cache_evicts_old_entries(self, provider):
        client = AsyncMock()

        async def recall(**kwargs):
            return {"context": f"memory for {kwargs['query']}", "count": 1}

        client.recall = AsyncMock(side_effect=recall)
        provider._client = client
        provider._prefetch_cache_max_entries = 2

        provider.prefetch("what did we decide first", session_id="prefetch-session")
        provider.prefetch("what did we decide second", session_id="prefetch-session")
        provider.prefetch("what did we decide third", session_id="prefetch-session")

        assert len(provider._prefetch_cache) == 2
        assert "prefetch-session\0what did we decide first" not in provider._prefetch_cache


class TestSyncTurn:
    def test_no_op_without_client(self, provider):
        """sync_turn is a no-op before initialize."""
        provider.sync_turn("test", "reply")

    def test_sends_recent_messages_from_legacy_transcript_shape(self, provider):
        """sync_turn sends last 2 messages to observe endpoint."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.observe = AsyncMock(return_value={})
            provider.initialize("test-session")
            messages = [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "reply1"},
                {"role": "user", "content": "second"},
                {"role": "assistant", "content": "reply2"},
            ]
            provider.sync_turn(messages)
            _wait_for_await(instance.observe)
            instance.observe.assert_awaited_once()
            call_args = instance.observe.call_args
            assert len(call_args.kwargs["messages"]) == 2

    def test_sends_completed_turn_from_current_hermes_signature(self, provider):
        """sync_turn(user, assistant, session_id=...) matches Hermes' current ABC."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.observe = AsyncMock(return_value={})
            provider.initialize("initial-session")

            provider.sync_turn("hello", "hi there", session_id="turn-session")

            _wait_for_await(instance.observe)
            instance.observe.assert_awaited_once_with(
                session_key="turn-session",
                messages=[
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi there"},
                ],
            )

    def test_sync_turn_does_not_block_on_slow_daemon_observe(self, provider):
        """Hermes calls sync_turn in the turn path, so daemon latency must stay backgrounded."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()

            async def slow_observe(**kwargs):
                await asyncio.sleep(0.25)
                return {}

            instance.observe = AsyncMock(side_effect=slow_observe)
            provider.initialize("initial-session")

            started = time.monotonic()
            provider.sync_turn("hello", "hi there", session_id="turn-session")
            elapsed = time.monotonic() - started

            assert elapsed < 0.1
            _wait_for_await(instance.observe)


class TestAsyncLegacyHooks:
    @pytest.mark.asyncio
    async def test_extract_memories_awaits_client_without_sync_wrapper(self, provider):
        client = AsyncMock()
        client.observe = AsyncMock(return_value={})
        provider._client = client

        await provider.extract_memories({"messages": [{"role": "user", "content": "remember this"}]})

        client.observe.assert_awaited_once_with(
            session_key=provider._session_key,
            messages=[{"role": "user", "content": "remember this"}],
        )


class TestCurrentHermesToolSurface:
    def test_get_tool_schemas_exposes_remnic_and_legacy_tools(self, provider):
        names = {schema["name"] for schema in provider.get_tool_schemas()}

        assert "remnic_recall" in names
        assert "remnic_memory_store" in names
        assert "remnic_profiling_report" in names
        assert "engram_recall" in names
        assert "engram_memory_store" in names

    def test_handle_tool_call_dispatches_sync_result_json(self, provider):
        client = AsyncMock()
        client.recall = AsyncMock(return_value={"context": "prior", "count": 1})
        provider._client = client

        result = provider.handle_tool_call("remnic_recall", {"query": "what did we decide"})

        assert json.loads(result) == {"context": "prior", "count": 1}
        client.recall.assert_awaited_once_with(
            query="what did we decide",
            session_key=provider._session_key,
        )

    def test_handle_tool_call_reports_unknown_tools(self, provider):
        result = provider.handle_tool_call("remnic_missing", {})

        assert "Unknown Remnic memory tool" in json.loads(result)["error"]

    def test_handle_tool_call_cancels_timed_out_mutating_tools(self, provider):
        client = AsyncMock()
        committed = False

        async def slow_memory_store(**kwargs):
            nonlocal committed
            await asyncio.sleep(0.2)
            committed = True
            return {"stored": True}

        client.memory_store = AsyncMock(side_effect=slow_memory_store)
        provider._client = client
        provider._timeout = 0.01

        result = provider.handle_tool_call("remnic_memory_store", {"content": "remember this"})

        assert json.loads(result) == {"error": "Remnic operation timed out"}
        time.sleep(0.25)
        assert committed is False


class TestLcmSearchTool:
    def test_lcm_schema_matches_daemon_surface(self, provider):
        schema = provider.lcm_search_schema["parameters"]

        assert provider.lcm_search_schema["name"] == "remnic_lcm_search"
        assert schema["required"] == ["query"]
        assert schema["additionalProperties"] is False
        assert set(schema["properties"]) == {"query", "sessionKey", "namespace", "limit"}
        assert schema["properties"]["limit"]["type"] == "integer"
        assert schema["properties"]["limit"]["minimum"] == 1
        assert schema["properties"]["limit"]["maximum"] == 100

    @pytest.mark.asyncio
    async def test_lcm_search_handler_uses_client(self, provider):
        client = AsyncMock()
        client.lcm_search = AsyncMock(return_value={"count": 1, "results": []})
        provider._client = client

        result = await provider.lcm_search(
            "archive",
            sessionKey="explicit-session",
            namespace="research",
            limit=3,
        )

        assert result == {"count": 1, "results": []}
        client.lcm_search.assert_awaited_once_with(
            query="archive",
            session_key="explicit-session",
            namespace="research",
            limit=3,
        )

    @pytest.mark.asyncio
    async def test_lcm_search_handler_preserves_unscoped_calls(self, provider):
        client = AsyncMock()
        client.lcm_search = AsyncMock(return_value={"count": 2, "results": []})
        provider._client = client

        await provider.lcm_search("archive")

        client.lcm_search.assert_awaited_once_with(
            query="archive",
            session_key="",
            namespace=None,
            limit=None,
        )


class TestLegacyAlias:
    def test_engram_memory_provider_is_alias(self):
        """The legacy EngramMemoryProvider name resolves to RemnicMemoryProvider."""
        assert EngramMemoryProvider is RemnicMemoryProvider
