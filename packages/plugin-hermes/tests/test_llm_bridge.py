"""Tests for the opt-in policy-bound loopback LLM bridge (issue #2834)."""

from __future__ import annotations

import dataclasses
import functools
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


class FakePluginLlm:
    """Production-shaped Hermes PluginLlm stand-in for register wiring tests."""

    def __init__(self, plugin_id: str = "remnic") -> None:
        self.plugin_id = plugin_id

    def complete(self, messages: Any, *, purpose: str | None = None) -> Any:
        return _delegate_result()

    def complete_structured(self, *args: Any, **kwargs: Any) -> Any:
        return None


class UnpickleablePluginLlm:
    """Bound-method owner that cannot be pickled, like a live PluginLlm facade."""

    def __init__(self, plugin_id: str = "remnic") -> None:
        self.plugin_id = plugin_id

    def __getstate__(self) -> object:
        raise TypeError("live PluginLlm facades are not pickleable")

    def complete(self, messages: Any, *, purpose: str | None = None) -> Any:
        return _delegate_result()

    def complete_structured(self, *args: Any, **kwargs: Any) -> Any:
        return None


def _gated_complete(messages: list[dict[str, str]], gate_path: str | None = None) -> Any:
    """Pickleable delegate used to prove the deadline kills child work."""
    marker = gate_path or os.environ.get("REMNIC_LLM_BRIDGE_GATE")
    if marker:
        if os.path.exists(marker):
            return _delegate_result()
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write("started")
        time.sleep(60)
    return _delegate_result()


class RecordingDelegate:
    """Delegate that records exactly how it was invoked."""

    def __init__(self, result: Any = None, delay: float = 0.0, error: Exception | None = None):
        self.calls: list[dict[str, Any]] = []
        self._result = result if result is not None else _delegate_result()
        self._delay = delay
        self._error = error

    def __getstate__(self) -> object:
        raise TypeError("RecordingDelegate is local to the parent process")

    def __call__(self, messages: Any) -> Any:
        self.calls.append({"args": (messages,), "kwargs": {}})
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


def _authed_post(
    bridge: HermesLlmBridge,
    payload: bytes | str,
    **kwargs: Any,
) -> tuple[int, Any]:
    headers = dict(kwargs.pop("headers", None) or {})
    headers["Authorization"] = f"Bearer {bridge.auth_token}"
    return _post(bridge.bound_port, payload, headers=headers, **kwargs)


def _get(port: int, path: str, *, headers: dict[str, str] | None = None) -> tuple[int, Any]:
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request("GET", path, headers=headers or {})
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
        status, body = _authed_post(
            bridge,
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
        status, _ = _authed_post(
            bridge,
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
            status, _ = _authed_post(
                bridge,
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
            status, body = _authed_post(
                bridge,
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
            status, body = _get(
                bridge.bound_port,
                "/healthz",
                headers={"Authorization": f"Bearer {bridge.auth_token}"},
            )
        assert status == 200
        assert body == {"status": "ok"}

    def test_unknown_paths_are_404(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            status, _ = _authed_post(bridge, "{}", path="/v1/completions")
            assert status == 404
            status, _ = _get(
                bridge.bound_port,
                "/v1/models",
                headers={"Authorization": f"Bearer {bridge.auth_token}"},
            )
            assert status == 404

    def test_only_post_is_accepted_on_endpoint(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            status, _ = _get(
                bridge.bound_port,
                _ENDPOINT,
                headers={"Authorization": f"Bearer {bridge.auth_token}"},
            )
            assert status == 404


class TestCredentialsNeverWritten:
    def test_client_config_includes_generated_token_only(self, tmp_path: Any) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            config = bridge.write_client_config(str(tmp_path / "client.json"))
        assert set(config) == {
            "endpoint",
            "health_endpoint",
            "bind",
            "model_policy",
            "max_body_bytes",
            "timeout_seconds",
            "token",
        }
        token = config["token"]
        assert isinstance(token, str)
        assert len(token) >= 32
        without_token = {key: value for key, value in config.items() if key != "token"}
        serialized = json.dumps(without_token).lower()
        assert not any(marker in serialized for marker in _CREDENTIAL_MARKERS)

    def test_client_config_file_contains_no_runtime_secrets(self, tmp_path: Any) -> None:
        """Provider tokens visible to the process must not leak into the file."""
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
            payload = json.loads(text)
            assert "sk-live-leak-123" not in text
            assert "remnic-live-token-456" not in text
            assert payload["token"] == bridge.auth_token
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
            status, body = _authed_post(bridge, big)
        assert status == 413
        assert body["error"]["message"] == "request body too large"
        assert delegate.calls == []

    def test_missing_content_length_is_411(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            with socket.create_connection(("127.0.0.1", bridge.bound_port), timeout=5) as sock:
                sock.sendall(
                    (
                        f"POST {_ENDPOINT} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                        f"Authorization: Bearer {bridge.auth_token}\r\n"
                        "Connection: close\r\n\r\n"
                    ).encode("utf-8")
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
            status, body = _authed_post(bridge, payload)
        assert status == 400
        assert body["error"]["message"] == "invalid json body" or (
            body["error"]["message"] == "invalid request body"
        )
        assert delegate.calls == []

    def test_delegate_deadline_returns_504(self, tmp_path: Any) -> None:
        gate = tmp_path / "llm-bridge-gate"
        complete = functools.partial(_gated_complete, gate_path=str(gate))
        with running_bridge(
            BridgePolicy(enabled=True, timeout_seconds=2.0), complete
        ) as bridge:
            status, body = _authed_post(
                bridge,
                '{"messages": [{"role": "user", "content": "x"}]}',
                timeout=8.0,
            )
            assert status == 504
            assert body["error"]["message"] == "completion timed out"
            assert bridge.active_work == 0
            assert gate.is_file()
            status_next, body_next = _authed_post(
                bridge,
                '{"messages": [{"role": "user", "content": "y"}]}',
                timeout=8.0,
            )
            assert status_next == 200
            assert body_next["choices"][0]["message"]["content"] == "bridged answer"
            assert bridge.active_work == 0

    def test_delegate_failure_returns_fixed_502_without_error_detail(self) -> None:
        delegate = RecordingDelegate(error=RuntimeError("boom secret detail /sk-key/"))
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            status, body = _authed_post(
                bridge,
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
                    (
                        f"POST {_ENDPOINT} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                        f"Authorization: Bearer {bridge.auth_token}\r\n"
                        "Content-Length: 64\r\nConnection: close\r\n\r\npartial"
                    ).encode("utf-8")
                )
                sock.close()
            time.sleep(0.3)
        assert delegate.calls == []


class TestNoBodyLogging:
    def test_prompt_text_never_appears_in_logs(self, caplog: pytest.LogCaptureFixture) -> None:
        marker = "SECRET-PROMPT-MARKER-8321"
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            with caplog.at_level(logging.DEBUG, logger="remnic_hermes.llm_bridge"):
                status, _ = _authed_post(
                    bridge,
                    json.dumps({"messages": [{"role": "user", "content": marker}]}),
                )
                assert status == 200
        assert marker not in caplog.text
        assert bridge.auth_token not in caplog.text


class TestLoopbackAuth:
    def test_missing_bearer_is_401_and_does_not_delegate(self) -> None:
        delegate = RecordingDelegate()
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            status, body = _post(
                bridge.bound_port,
                json.dumps({"messages": [{"role": "user", "content": "x"}]}),
            )
            health_status, _ = _get(bridge.bound_port, "/healthz")
        assert status == 401
        assert body["error"]["message"] == "unauthorized"
        assert health_status == 401
        assert delegate.calls == []

    def test_wrong_bearer_is_401(self) -> None:
        delegate = RecordingDelegate()
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            status, body = _post(
                bridge.bound_port,
                json.dumps({"messages": [{"role": "user", "content": "x"}]}),
                headers={"Authorization": "Bearer not-the-token"},
            )
        assert status == 401
        assert body["error"]["message"] == "unauthorized"
        assert delegate.calls == []


class TestSingleDeadline:
    def test_queue_timeout_starts_no_delegate(self) -> None:
        delegate = RecordingDelegate()
        bridge = HermesLlmBridge(BridgePolicy(enabled=True, timeout_seconds=0.05), delegate)
        assert bridge._slots.acquire(blocking=False)
        assert bridge._slots.acquire(blocking=False)
        with pytest.raises(TimeoutError, match="deadline"):
            bridge.complete_with_deadline([{"role": "user", "content": "x"}])
        assert delegate.calls == []
        assert bridge.active_work == 0

    def test_delegate_receives_remaining_budget_only(self) -> None:
        seen: list[float] = []

        def complete(messages: list[dict[str, str]], timeout: float | None = None) -> Any:
            seen.append(float(timeout or 0))
            return _delegate_result()

        bridge = HermesLlmBridge(BridgePolicy(enabled=True, timeout_seconds=0.4), complete)
        original = bridge._slots.acquire

        def delayed_acquire(timeout: float | None = None) -> bool:
            time.sleep(0.15)
            return original(timeout=0)

        bridge._slots.acquire = delayed_acquire  # type: ignore[method-assign]
        bridge.complete_with_deadline([{"role": "user", "content": "x"}])
        assert len(seen) == 1
        assert 0 < seen[0] <= 0.3



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

    def test_register_stuffed_collector_llm_does_not_start_bridge(self) -> None:
        ctx = self._ctx({"remnic": {"token": "t", "llm_bridge": {"enabled": True}}})
        with (
            patch("remnic_hermes.llm_runtime._discover_plugin_llm_class", return_value=None),
            patch("remnic_hermes.start_bridge_from_config") as starter,
        ):
            self._register(ctx)
        starter.assert_not_called()

    def test_register_with_enabled_bridge_uses_discovered_plugin_llm(self) -> None:
        ctx = self._ctx(
            {"remnic": {"token": "t", "llm_bridge": {"enabled": True}}},
            with_llm=False,
        )
        with (
            patch(
                "remnic_hermes.llm_runtime._discover_plugin_llm_class",
                return_value=FakePluginLlm,
            ),
            patch("remnic_hermes.start_bridge_from_config") as starter,
        ):
            self._register(ctx)
        starter.assert_called_once()
        section, llm_complete = starter.call_args.args
        assert section == {"enabled": True}
        assert llm_complete.__self__.plugin_id == "remnic"

    def test_register_accepts_plugin_llm_shaped_runtime_facade(self) -> None:
        ctx = self._ctx(
            {"remnic": {"token": "t", "llm_bridge": {"enabled": True}}},
            with_llm=False,
        )
        ctx.llm = FakePluginLlm()
        with (
            patch("remnic_hermes.llm_runtime._discover_plugin_llm_class", return_value=None),
            patch("remnic_hermes.start_bridge_from_config") as starter,
        ):
            self._register(ctx)
        starter.assert_called_once()
        assert starter.call_args.args[1].__self__ is ctx.llm

    def test_register_defers_until_plugin_llm_runtime_appears(self) -> None:
        hooks: dict[str, list[Any]] = {}

        def register_hook(name: str, handler: Any) -> None:
            hooks.setdefault(name, []).append(handler)

        ctx = self._ctx(
            {"remnic": {"token": "t", "llm_bridge": {"enabled": True}}},
            with_llm=False,
        )
        ctx.register_hook = register_hook
        with (
            patch("remnic_hermes.llm_runtime._discover_plugin_llm_class", return_value=None),
            patch("remnic_hermes.start_bridge_from_config") as starter,
        ):
            self._register(ctx)
            starter.assert_not_called()
            assert "pre_llm_call" in hooks
            with patch(
                "remnic_hermes.llm_runtime._discover_plugin_llm_class",
                return_value=FakePluginLlm,
            ):
                hooks["pre_llm_call"][0]()
            starter.assert_called_once()
            assert starter.call_args.args[0] == {"enabled": True}

    def test_unpickleable_plugin_llm_complete_starts_bridge(self) -> None:
        complete = UnpickleablePluginLlm().complete
        with pytest.raises(Exception):
            __import__("pickle").dumps(complete)
        with running_bridge(BridgePolicy(enabled=True), complete) as bridge:
            assert bridge.bound_port > 0
            assert bridge.active_work == 0

    def test_register_swallows_bridge_setup_failures(self) -> None:
        ctx = self._ctx({"remnic": {"llm_bridge": {"enabled": True}}}, with_llm=False)
        with (
            patch(
                "remnic_hermes.resolve_completion_delegate",
                return_value=lambda *a, **k: _delegate_result(),
            ),
            patch(
                "remnic_hermes.start_bridge_from_config",
                side_effect=OSError("bind failed"),
            ),
        ):
            self._register(ctx)  # must not raise
