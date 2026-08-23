"""Tests for the opt-in policy-bound loopback LLM bridge (issue #2834)."""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import socket
import stat
import time
from contextlib import contextmanager
from http.client import HTTPConnection
from types import SimpleNamespace
from typing import Any, Callable, Iterator
from unittest.mock import patch

import pytest

from remnic_hermes import register
from remnic_hermes.llm_bridge import (
    BridgePolicy,
    HermesLlmBridge,
    start_bridge_from_config,
)

_ENDPOINT = "/v1/chat/completions"
_USAGE = SimpleNamespace(input_tokens=5, output_tokens=7, total_tokens=12)
_RESULT = SimpleNamespace(text="bridged answer", model="host-active-model", usage=_USAGE)
_CREDENTIAL_MARKERS = ("token", "api_key", "apikey", "secret", "authorization", "password")


def _delegate_result() -> Any:
    return SimpleNamespace(
        text="bridged answer",
        model="host-active-model",
        usage=SimpleNamespace(input_tokens=5, output_tokens=7, total_tokens=12),
    )


class RecordingDelegate:
    """Delegate that records exactly how it was invoked."""

    def __init__(self, result: Any = None, delay: float = 0.0, error: Exception | None = None):
        self.calls: list[dict[str, Any]] = []
        self._result = result if result is not None else _delegate_result()
        self._delay = delay
        self._error = error

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        self.calls.append({"args": args, "kwargs": kwargs})
        if self._delay:
            time.sleep(self._delay)
        if self._error is not None:
            raise self._error
        return self._result


@contextmanager
def running_bridge(
    policy: BridgePolicy, delegate: Callable[..., Any]
) -> Iterator[HermesLlmBridge]:
    bridge = HermesLlmBridge(policy, delegate)
    bridge.start()
    try:
        yield bridge
    finally:
        bridge.stop()


def _post(
    port: int,
    payload: bytes | str,
    *,
    path: str = _ENDPOINT,
    headers: dict[str, str] | None = None,
    timeout: float = 10.0,
) -> tuple[int, Any]:
    connection = HTTPConnection("127.0.0.1", port, timeout=timeout)
    body = payload.encode("utf-8") if isinstance(payload, str) else payload
    connection.request("POST", path, body=body, headers=headers or {})
    response = connection.getresponse()
    raw = response.read()
    connection.close()
    try:
        return response.status, json.loads(raw)
    except ValueError:
        return response.status, raw


class TestListenerGuard:
    @pytest.mark.parametrize(
        "host", ["0.0.0.0", "::", "[::]", "192.168.1.5", "10.0.0.7", "example.com", ""]
    )
    def test_rejects_non_loopback_and_wildcard_binds(self, host: str) -> None:
        with pytest.raises(ValueError, match="loopback"):
            HermesLlmBridge(BridgePolicy(host=host, enabled=True), RecordingDelegate())

    @pytest.mark.parametrize(
        ("host", "bind"),
        [
            ("127.0.0.1", "127.0.0.1"),
            ("::1", "::1"),
            ("[::1]", "::1"),
            ("::ffff:127.0.0.1", "::ffff:127.0.0.1"),
            ("localhost", "localhost"),
            ("LOCALHOST", "localhost"),
        ],
    )
    def test_accepts_loopback_binds(self, host: str, bind: str) -> None:
        bridge = HermesLlmBridge(BridgePolicy(host=host), RecordingDelegate())
        assert bridge._bind == bind

    def test_rejection_happens_before_any_socket_exists(self) -> None:
        """Constructing with a non-loopback host must fail before bind."""
        with patch("remnic_hermes.llm_bridge._BridgeServer") as server_cls:
            with pytest.raises(ValueError):
                HermesLlmBridge(BridgePolicy(host="0.0.0.0"), RecordingDelegate())
        server_cls.assert_not_called()


class TestPolicyParsing:
    def test_default_policy_is_disabled_and_loopback(self) -> None:
        policy = BridgePolicy.from_config(None)
        assert policy.enabled is False
        assert policy.host == "127.0.0.1"
        assert policy.max_body_bytes == 524_288

    def test_missing_section_means_disabled(self) -> None:
        assert BridgePolicy.from_config({}).enabled is False

    def test_string_false_disables(self) -> None:
        policy = BridgePolicy.from_config({"enabled": "false"})
        assert policy.enabled is False

    @pytest.mark.parametrize("field", ["model", "provider", "base_url", "routing"])
    def test_rejects_model_or_provider_keys(self, field: str) -> None:
        """The policy is server-owned: routing keys are refused, not stored."""
        with pytest.raises(ValueError, match="unknown field"):
            BridgePolicy.from_config({"enabled": True, field: "gpt-4o"})

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("port", "abc"),
            ("port", -1),
            ("port", 65536),
            ("port", True),
            ("max_body_bytes", 0),
            ("max_body_bytes", "big"),
            ("timeout_seconds", 0),
            ("timeout_seconds", -5),
            ("timeout_seconds", "soon"),
            ("host", 7),
        ],
    )
    def test_rejects_invalid_values(self, field: str, value: Any) -> None:
        with pytest.raises((TypeError, ValueError)):
            BridgePolicy.from_config({"enabled": True, field: value})

    def test_policy_dataclass_has_no_model_provider_or_credential_field(self) -> None:
        names = {field.name for field in dataclasses.fields(BridgePolicy)}
        assert not any(
            marker in name.lower()
            for name in names
            for marker in (*_CREDENTIAL_MARKERS, "model", "provider")
        )


class TestRoutingIsServerOwned:
    @pytest.fixture
    def started(self) -> Iterator[tuple[HermesLlmBridge, RecordingDelegate]]:
        delegate = RecordingDelegate()
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            yield bridge, delegate

    def test_request_model_and_provider_cannot_change_route(
        self, started: tuple[HermesLlmBridge, RecordingDelegate]
    ) -> None:
        bridge, delegate = started
        status, body = _post(
            bridge.bound_port,
            json.dumps(
                {
                    "model": "gpt-attacker-model",
                    "provider": "attacker-provider",
                    "messages": [{"role": "user", "content": "summarize"}],
                }
            ),
        )
        assert status == 200
        # Delegate got exactly one positional argument: the message list.
        assert len(delegate.calls) == 1
        assert len(delegate.calls[0]["args"]) == 1
        assert delegate.calls[0]["kwargs"] == {}
        # The answer reports the host's model, never the caller's.
        assert body["model"] == "host-active-model"
        assert "gpt-attacker-model" not in json.dumps(body)

    def test_extra_openai_fields_are_ignored_not_forwarded(
        self, started: tuple[HermesLlmBridge, RecordingDelegate]
    ) -> None:
        bridge, delegate = started
        status, _ = _post(
            bridge.bound_port,
            json.dumps(
                {
                    "model": "m",
                    "temperature": 2,
                    "stream": True,
                    "max_tokens": 999,
                    "messages": [{"role": "user", "content": "hi"}],
                }
            ),
        )
        assert status == 200
        assert delegate.calls[0]["args"] == ([{"role": "user", "content": "hi"}],)
        assert delegate.calls[0]["kwargs"] == {}

    def test_wiring_lambda_forwards_no_model_or_provider_to_host_resolver(self) -> None:
        """The register() wiring may only pass purpose/timeout to ctx.llm."""
        host_calls: list[dict[str, Any]] = []

        def llm_complete(*args: Any, **kwargs: Any) -> Any:
            host_calls.append({"args": args, "kwargs": kwargs})
            return _delegate_result()

        bridge = start_bridge_from_config(
            {"enabled": True, "timeout_seconds": 5}, llm_complete
        )
        assert bridge is not None
        try:
            status, _ = _post(
                bridge.bound_port,
                json.dumps(
                    {
                        "model": "gpt-attacker-model",
                        "provider": "attacker-provider",
                        "messages": [{"role": "user", "content": "x"}],
                    }
                ),
            )
            assert status == 200
            assert len(host_calls) == 1
            assert len(host_calls[0]["args"]) == 1
            assert set(host_calls[0]["kwargs"]) <= {"purpose", "timeout"}
            assert "model" not in host_calls[0]["kwargs"]
            assert "provider" not in host_calls[0]["kwargs"]
            assert host_calls[0]["kwargs"].get("purpose") == "remnic-llm-bridge"
        finally:
            bridge.stop()


class TestDelegation:
    def test_completes_through_delegate_with_openai_shape(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            status, body = _post(
                bridge.bound_port,
                json.dumps({"messages": [{"role": "user", "content": "summarize today"}]}),
            )
        assert status == 200
        assert body["object"] == "chat.completion"
        assert body["model"] == "host-active-model"
        assert body["choices"][0]["message"]["role"] == "assistant"
        assert body["choices"][0]["message"]["content"] == "bridged answer"
        assert body["choices"][0]["finish_reason"] == "stop"
        assert body["usage"] == {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12}
        assert body["id"].startswith("chatcmpl-bridge-")

    def test_health_endpoint(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            connection = HTTPConnection("127.0.0.1", bridge.bound_port, timeout=5)
            connection.request("GET", "/healthz")
            response = connection.getresponse()
            body = json.loads(response.read())
            connection.close()
        assert response.status == 200
        assert body == {"status": "ok"}

    def test_unknown_paths_are_404(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            status, _ = _post(bridge.bound_port, "{}", path="/v1/completions")
            assert status == 404
            connection = HTTPConnection("127.0.0.1", bridge.bound_port, timeout=5)
            connection.request("GET", "/v1/models")
            response = connection.getresponse()
            response.read()
            connection.close()
            assert response.status == 404

    def test_only_post_is_accepted_on_endpoint(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            connection = HTTPConnection("127.0.0.1", bridge.bound_port, timeout=5)
            connection.request("GET", _ENDPOINT)
            response = connection.getresponse()
            response.read()
            connection.close()
            assert response.status == 404


class TestCredentialsNeverWritten:
    def test_client_config_has_exact_credential_free_keyset(self, tmp_path: Any) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            config = bridge.write_client_config(str(tmp_path / "client.json"))
        assert set(config) == {
            "endpoint",
            "health_endpoint",
            "bind",
            "model_policy",
            "max_body_bytes",
            "timeout_seconds",
        }
        serialized = json.dumps(config).lower()
        assert not any(marker in serialized for marker in _CREDENTIAL_MARKERS)

    def test_client_config_file_contains_no_runtime_secrets(self, tmp_path: Any) -> None:
        """Tokens visible to the process must not leak into the file."""
        path = tmp_path / "client.json"
        section = {
            "enabled": True,
            "client_config_path": str(path),
            "port": 0,
        }
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "sk-live-leak-123",
                "REMNIC_TOKEN": "remnic-live-token-456",
            },
        ):
            bridge = start_bridge_from_config(section, lambda *a, **k: _delegate_result())
        assert bridge is not None
        try:
            text = path.read_text(encoding="utf-8")
            assert "sk-live-leak-123" not in text
            assert "remnic-live-token-456" not in text
            assert not any(marker in text.lower() for marker in _CREDENTIAL_MARKERS)
            # Owner-only permissions.
            mode = stat.S_IMODE(path.stat().st_mode)
            assert mode == 0o600
        finally:
            bridge.stop()

    def test_client_config_carries_no_model_routing(self, tmp_path: Any) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            config = bridge.client_config()
        assert config["model_policy"] == "server-owned"
        assert not any("model" in str(key).lower() for key in config if key != "model_policy")


class TestBodyBoundsAndAbort:
    def test_oversized_content_length_is_rejected_without_delegation(self) -> None:
        delegate = RecordingDelegate()
        with running_bridge(
            BridgePolicy(enabled=True, max_body_bytes=1024), delegate
        ) as bridge:
            big = json.dumps({"messages": [{"role": "user", "content": "x" * 4096}]})
            status, body = _post(bridge.bound_port, big)
        assert status == 413
        assert body["error"]["message"] == "request body too large"
        assert delegate.calls == []

    def test_missing_content_length_is_411(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            with socket.create_connection(("127.0.0.1", bridge.bound_port), timeout=5) as sock:
                sock.sendall(
                    f"POST {_ENDPOINT} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    "Connection: close\r\n\r\n".encode("utf-8")
                )
                data = sock.recv(4096)
        assert b"411" in data.split(b"\r\n", 1)[0]

    @pytest.mark.parametrize(
        "payload",
        [
            b"not json at all",
            json.dumps({"no_messages": True}).encode("utf-8"),
            json.dumps({"messages": []}).encode("utf-8"),
            json.dumps({"messages": "not-a-list"}).encode("utf-8"),
            json.dumps({"messages": ["not-a-dict"]}).encode("utf-8"),
            json.dumps({"messages": [{"role": "user", "content": 42}]}).encode("utf-8"),
            json.dumps({"messages": [{"role": "  ", "content": "hi"}]}).encode("utf-8"),
        ],
    )
    def test_invalid_bodies_are_rejected_400(self, payload: bytes) -> None:
        delegate = RecordingDelegate()
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            status, body = _post(bridge.bound_port, payload)
        assert status == 400
        assert body["error"]["message"] == "invalid json body" or (
            body["error"]["message"] == "invalid request body"
        )
        assert delegate.calls == []

    def test_delegate_deadline_returns_504(self) -> None:
        delegate = RecordingDelegate(delay=1.0)
        with running_bridge(
            BridgePolicy(enabled=True, timeout_seconds=0.15), delegate
        ) as bridge:
            status, body = _post(bridge.bound_port, '{"messages": [{"role": "user", "content": "x"}]}')
        assert status == 504
        assert body["error"]["message"] == "completion timed out"

    def test_delegate_failure_returns_fixed_502_without_error_detail(self) -> None:
        delegate = RecordingDelegate(error=RuntimeError("boom secret detail /sk-key/"))
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            status, body = _post(
                bridge.bound_port,
                json.dumps({"messages": [{"role": "user", "content": "x"}]}),
            )
        assert status == 502
        assert body["error"]["message"] == "completion failed"
        serialized = json.dumps(body)
        assert "boom" not in serialized
        assert "RuntimeError" not in serialized
        assert "sk-key" not in serialized

    def test_client_abort_mid_body_is_silent_and_never_delegates(self) -> None:
        delegate = RecordingDelegate()
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            with socket.create_connection(("127.0.0.1", bridge.bound_port), timeout=5) as sock:
                sock.sendall(
                    f"POST {_ENDPOINT} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    "Content-Length: 64\r\nConnection: close\r\n\r\npartial".encode("utf-8")
                )
                sock.close()
            time.sleep(0.3)
        assert delegate.calls == []


class TestNoBodyLogging:
    def test_prompt_text_never_appears_in_logs(self, caplog: pytest.LogCaptureFixture) -> None:
        marker = "SECRET-PROMPT-MARKER-8321"
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            with caplog.at_level(logging.DEBUG, logger="remnic_hermes.llm_bridge"):
                status, _ = _post(
                    bridge.bound_port,
                    json.dumps({"messages": [{"role": "user", "content": marker}]}),
                )
                assert status == 200
        assert marker not in caplog.text


class TestOptInDefaults:
    def test_no_section_starts_nothing(self) -> None:
        assert start_bridge_from_config(None, lambda *a, **k: _delegate_result()) is None

    def test_disabled_section_starts_nothing(self) -> None:
        assert start_bridge_from_config({"enabled": False}, lambda *a, **k: _delegate_result()) is None

    def test_enabled_without_host_facade_returns_none(self) -> None:
        assert start_bridge_from_config({"enabled": True}, None) is None

    def test_invalid_config_returns_none_instead_of_raising(self) -> None:
        assert start_bridge_from_config({"enabled": True, "port": "nope"}, lambda *a, **k: 1) is None

    def test_non_loopback_config_returns_none_instead_of_raising(self) -> None:
        assert (
            start_bridge_from_config(
                {"enabled": True, "host": "0.0.0.0"}, lambda *a, **k: _delegate_result()
            )
            is None
        )


class TestRegisterWiring:
    def _ctx(self, config: dict[str, Any], with_llm: bool = True) -> Any:
        def register_tool(name: str, schema: Any, handler: Any) -> None:
            return None

        ctx = SimpleNamespace(
            config=config,
            register_memory_provider=lambda provider: None,
            register_tool=register_tool,
        )
        if with_llm:
            ctx.llm = SimpleNamespace(complete=lambda *a, **k: _delegate_result())
        return ctx

    def _register(self, ctx: Any) -> None:
        with (
            patch("remnic_hermes.RemnicMemoryProvider") as mock_provider,
            patch("tests.test_register._populate_provider_mock", create=True),
        ):
            # Reuse the existing register-test scaffold for the provider mock.
            from tests.test_register import _populate_provider_mock

            _populate_provider_mock(mock_provider.return_value)
            register(ctx)

    def test_register_without_bridge_config_opens_no_listener(self) -> None:
        """Default config must leave the plugin byte-for-byte unchanged:
        no bridge object, no listening socket."""
        ctx = self._ctx({"remnic": {"token": "t"}})
        with patch("remnic_hermes.llm_bridge._BridgeServer") as server_cls:
            self._register(ctx)
        server_cls.assert_not_called()

    def test_register_with_enabled_bridge_uses_host_llm_facade(self) -> None:
        ctx = self._ctx({"remnic": {"token": "t", "llm_bridge": {"enabled": True}}})
        with patch("remnic_hermes.start_bridge_from_config") as starter:
            self._register(ctx)
        starter.assert_called_once()
        section, llm_complete = starter.call_args.args
        assert section == {"enabled": True}
        assert llm_complete is ctx.llm.complete

    def test_register_swallows_bridge_setup_failures(self) -> None:
        ctx = self._ctx({"remnic": {"llm_bridge": {"enabled": True}}})
        with patch(
            "remnic_hermes.start_bridge_from_config", side_effect=OSError("bind failed")
        ):
            self._register(ctx)  # must not raise
