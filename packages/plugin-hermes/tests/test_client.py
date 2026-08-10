"""Tests for the RemnicClient HTTP methods."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from remnic_hermes import EngramClient
from remnic_hermes.client import RemnicClient


@pytest.fixture
def client():
    """Create a client with test config."""
    return RemnicClient(host="127.0.0.1", port=4318, token="test-token", client_id="hermes")


class TestClientInit:
    def test_base_url(self, client):
        # HTTP path still uses the legacy /engram/v1 prefix during the compat window.
        assert client.base_url == "http://127.0.0.1:4318/engram/v1"

    def test_token_set(self, client):
        assert client.token == "test-token"

    def test_client_id(self, client):
        assert client.client_id == "hermes"


class TestClientNamespace:
    @pytest.mark.asyncio
    async def test_namespace_header_and_rest_default(self):
        response = MagicMock()
        response.json.return_value = {"memory": {"id": "fact-1"}}

        with patch("remnic_hermes.client.httpx.AsyncClient") as MockAsyncClient:
            http = MockAsyncClient.return_value
            http.headers = {}
            http.get = AsyncMock(return_value=response)
            client = RemnicClient(
                host="127.0.0.1",
                port=4318,
                token="test-token",
                client_id="hermes",
                namespace="generalist",
                session_key="session-1",
            )
            await client.memory_get("fact-1")
            client.set_session_key("session-2")

        headers = MockAsyncClient.call_args.kwargs["headers"]
        assert headers["X-Engram-Client-Id"] == "hermes"
        assert headers["X-Engram-Namespace"] == "generalist"
        assert headers["X-Hermes-Session-Id"] == "session-1"
        assert http.headers["X-Hermes-Session-Id"] == "session-2"
        http.get.assert_awaited_once_with(
            "/memories/fact-1",
            params={"namespace": "generalist"},
        )

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("client_id", "généraliste"),
            ("namespace", "généraliste"),
            ("session_key", "séance-1"),
            ("client_id", "bad\nvalue"),
            ("namespace", "bad\rvalue"),
            ("session_key", "bad\x00value"),
            ("namespace", "bad\x7fvalue"),
        ],
    )
    def test_rejects_invalid_header_values(self, field, value):
        kwargs = {
            "host": "127.0.0.1",
            "port": 4318,
            "token": "test-token",
            "client_id": "hermes",
        }
        kwargs[field] = value

        with (
            patch("remnic_hermes.client.httpx.AsyncClient") as mock_async_client,
            pytest.raises(ValueError, match=f"{field} must contain only printable ASCII characters"),
        ):
            RemnicClient(**kwargs)

        mock_async_client.assert_not_called()

    def test_rejects_invalid_session_update_without_changing_header(self):
        with patch("remnic_hermes.client.httpx.AsyncClient") as mock_async_client:
            http = mock_async_client.return_value
            http.headers = {"X-Hermes-Session-Id": "session-1"}
            client = RemnicClient(
                host="127.0.0.1",
                port=4318,
                token="test-token",
                client_id="hermes",
                session_key="session-1",
            )

            with pytest.raises(
                ValueError,
                match="session_key must contain only printable ASCII characters",
            ):
                client.set_session_key("session-\n2")

        assert http.headers["X-Hermes-Session-Id"] == "session-1"


class TestClientClose:
    @pytest.mark.asyncio
    async def test_close_calls_aclose(self, client):
        client._http = MagicMock()
        client._http.aclose = AsyncMock()
        await client.close()
        client._http.aclose.assert_awaited_once()


class TestClientRecall:
    @pytest.mark.asyncio
    async def test_recall_omits_mode_by_default(self, client):
        response = MagicMock()
        response.json.return_value = {"context": "memory", "count": 1}
        client._http = MagicMock()
        client._http.post = AsyncMock(return_value=response)

        await client.recall("what did we decide", session_key="hermes-session")

        client._http.post.assert_awaited_once_with(
            "/recall",
            json={
                "query": "what did we decide",
                "sessionKey": "hermes-session",
                "topK": 8,
            },
        )


class TestClientLcmSearch:
    @pytest.mark.asyncio
    async def test_lcm_search_posts_to_lcm_endpoint(self, client):
        response = MagicMock()
        response.json.return_value = {"query": "archive", "results": [], "count": 0}
        client._http = MagicMock()
        client._http.post = AsyncMock(return_value=response)

        await client.lcm_search(
            "archive",
            session_key="hermes-session",
            namespace="research",
            limit=5,
        )

        client._http.post.assert_awaited_once_with(
            "/lcm/search",
            json={
                "query": "archive",
                "sessionKey": "hermes-session",
                "namespace": "research",
                "limit": 5,
            },
        )


class TestLegacyAlias:
    def test_engram_client_is_alias(self):
        """The legacy EngramClient name resolves to RemnicClient."""
        assert EngramClient is RemnicClient
