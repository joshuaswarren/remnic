"""Behavioral tests for the opt-in Hermes provider bridge."""

from __future__ import annotations

import hashlib
import hmac
import json
from http.server import ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest


BRIDGE_REQUEST_TOKEN = "bridge-request-token"


def _request(
    server: ThreadingHTTPServer,
    path: str,
    *,
    body: dict[str, object] | None = None,
    request_token: str | None = BRIDGE_REQUEST_TOKEN,
) -> dict[str, object]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    if request_token is not None:
        headers["Authorization"] = f"Bearer {request_token}"
    request = Request(
        f"http://127.0.0.1:{server.server_port}{path}",
        data=data,
        headers=headers,
        method="POST" if data else "GET",
    )
    with urlopen(request, timeout=2) as response:  # noqa: S310 -- test server is loopback-only
        assert response.status == 200
        return json.loads(response.read())


def _policy_path(tmp_path):
    policy_path = tmp_path / "policy.json"
    policy_path.write_text(
        json.dumps(
            {
                "provider": "openai-codex",
                "model": "gpt-5.6-terra",
                "timeout_seconds": 90,
            }
        ),
        encoding="utf-8",
    )
    return policy_path


def test_loopback_bridge_exposes_only_the_policy_model_and_routes_chat_completion(tmp_path):
    """The bridge is an OpenAI-compatible, policy-bound facade over Hermes routing."""
    from remnic_hermes.hermes_llm_bridge import make_handler

    policy_path = _policy_path(tmp_path)
    calls: list[dict[str, object]] = []

    def call_llm(**kwargs: object) -> object:
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="bridge response"))])

    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_handler(policy_path, call_llm=call_llm, request_token=BRIDGE_REQUEST_TOKEN),
    )
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        models = _request(server, "/v1/models")
        assert models == {
            "object": "list",
            "data": [{"id": "gpt-5.6-terra", "object": "model", "owned_by": "hermes"}],
        }

        completion = _request(
            server,
            "/v1/chat/completions",
            body={
                "model": "ignored-by-policy",
                "messages": [{"role": "user", "content": "extract durable facts"}],
                "temperature": 0.2,
                "max_tokens": 64,
            },
        )
        assert completion["model"] == "gpt-5.6-terra"
        assert completion["choices"] == [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "bridge response"},
                "finish_reason": "stop",
            }
        ]
        assert calls == [
            {
                "provider": "openai-codex",
                "model": "gpt-5.6-terra",
                "messages": [{"role": "user", "content": "extract durable facts"}],
                "temperature": 0.2,
                "max_tokens": 64,
                "timeout": 90,
            }
        ]
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_bridge_rejects_an_unauthenticated_or_wrong_token_without_provider_call(tmp_path):
    """Loopback callers must prove they are the supervised Remnic daemon."""
    from remnic_hermes.hermes_llm_bridge import make_handler

    calls: list[dict[str, object]] = []
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_handler(
            _policy_path(tmp_path),
            call_llm=lambda **kwargs: calls.append(kwargs),
            request_token=BRIDGE_REQUEST_TOKEN,
        ),
    )
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        for request_token in (None, "wrong-token"):
            with pytest.raises(HTTPError) as error:
                _request(server, "/v1/models", request_token=request_token)
            assert error.value.code == 401

        with pytest.raises(HTTPError) as error:
            _request(
                server,
                "/v1/chat/completions",
                request_token=None,
                body={"messages": [{"role": "user", "content": "should not route"}]},
            )
        assert error.value.code == 401
        assert calls == []
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_models_endpoint_returns_a_safe_client_error_when_policy_changes_to_include_a_credential(tmp_path):
    """A later bad policy file must not tear down the request handler or leak a value."""
    from remnic_hermes.hermes_llm_bridge import make_handler

    policy_path = _policy_path(tmp_path)
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_handler(policy_path, call_llm=lambda **_: None, request_token=BRIDGE_REQUEST_TOKEN),
    )
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        policy_path.write_text(
            json.dumps(
                {
                    "provider": "openai-codex",
                    "model": "gpt-5.6-terra",
                    "timeout_seconds": 90,
                    "api_key": "must-not-be-accepted",
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(HTTPError) as error:
            _request(server, "/v1/models")
        assert error.value.code == 400
        response_body = error.value.read().decode("utf-8")
        assert "api_key" in response_body
        assert "must-not-be-accepted" not in response_body
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_invoke_completion_accepts_remnic_max_output_budget(tmp_path):
    """The bridge accepts the full output budget emitted by Remnic's model registry."""
    from remnic_hermes.hermes_llm_bridge import invoke_completion, load_policy

    calls: list[dict[str, object]] = []

    def call_llm(**kwargs: object) -> object:
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="full budget response"))])

    result = invoke_completion(
        {"messages": [{"role": "user", "content": "extract"}], "max_tokens": 16_384},
        load_policy(_policy_path(tmp_path)),
        call_llm=call_llm,
    )

    assert result["choices"][0]["message"]["content"] == "full budget response"
    assert calls[0]["max_tokens"] == 16_384


def test_bridge_returns_gateway_error_for_malformed_provider_response(tmp_path):
    """Provider response corruption is retryable upstream failure, not a client 400."""
    from remnic_hermes.hermes_llm_bridge import make_handler

    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_handler(
            _policy_path(tmp_path),
            call_llm=lambda **_: SimpleNamespace(choices=[]),
            request_token=BRIDGE_REQUEST_TOKEN,
        ),
    )
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with pytest.raises(HTTPError) as error:
            _request(
                server,
                "/v1/chat/completions",
                body={"messages": [{"role": "user", "content": "extract"}]},
            )
        assert error.value.code == 502
        assert json.loads(error.value.read())["error"]["message"] == "Hermes provider call failed"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_invoke_completion_rejects_nonfinite_temperature(tmp_path):
    """JSON non-finite floats must not enter an upstream provider request."""
    from remnic_hermes.hermes_llm_bridge import PolicyError, invoke_completion, load_policy

    with pytest.raises(PolicyError, match="finite"):
        invoke_completion(
            {"messages": [{"role": "user", "content": "extract"}], "temperature": float("nan")},
            load_policy(_policy_path(tmp_path)),
            call_llm=lambda **_: None,
        )


def test_run_server_rejects_missing_request_token_and_non_ipv4_loopback_listener_values(tmp_path):
    """Manual bridge launches fail closed instead of exposing an unauthenticated endpoint."""
    from remnic_hermes.hermes_llm_bridge import make_handler, run_server

    policy_path = _policy_path(tmp_path)
    with pytest.raises(ValueError, match="request token"):
        run_server(policy_path, request_token="")
    with pytest.raises(ValueError, match="readiness token"):
        make_handler(policy_path, request_token=BRIDGE_REQUEST_TOKEN, readiness_token="")
    with pytest.raises(ValueError, match="loopback"):
        run_server(policy_path, host="::1", request_token=BRIDGE_REQUEST_TOKEN)


def test_readiness_endpoint_proves_knowledge_of_the_supervisor_secret(tmp_path):
    """A port listener is ready only when it proves it is this bridge instance."""
    from remnic_hermes.hermes_llm_bridge import make_handler

    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_handler(
            _policy_path(tmp_path),
            call_llm=lambda **_: None,
            request_token=BRIDGE_REQUEST_TOKEN,
            readiness_token="expected-readiness-token",
        ),
    )
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/healthz"
        with pytest.raises(HTTPError) as error:
            urlopen(url, timeout=2)  # noqa: S310 -- test server is loopback-only
        assert error.value.code == 404

        challenge = "supervisor-challenge"
        request = Request(url, headers={"X-Remnic-Bridge-Challenge": challenge})
        with urlopen(request, timeout=2) as response:  # noqa: S310 -- test server is loopback-only
            assert response.status == 204
            assert response.headers["X-Remnic-Bridge-Proof"] == hmac.new(
                b"expected-readiness-token",
                challenge.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_default_hermes_resolver_reports_a_missing_runtime_without_trying_a_completion():
    """A wrong Python environment fails with an actionable startup error."""
    from remnic_hermes.hermes_llm_bridge import PolicyError, _default_call_llm

    missing_runtime = ModuleNotFoundError("No module named 'agent'", name="agent")
    with patch("importlib.import_module", side_effect=missing_runtime):
        with pytest.raises(PolicyError, match="Hermes runtime is unavailable"):
            _default_call_llm()


def test_run_server_rejects_a_missing_hermes_runtime_before_opening_the_listener(tmp_path):
    """Readiness cannot succeed when the selected Python lacks the Hermes runtime."""
    from remnic_hermes.hermes_llm_bridge import PolicyError, run_server

    missing_runtime = PolicyError("Hermes runtime is unavailable")
    with patch(
        "remnic_hermes.hermes_llm_bridge._resolve_hermes_call_llm",
        side_effect=missing_runtime,
    ):
        with patch("remnic_hermes.hermes_llm_bridge.ThreadingHTTPServer") as server:
            with pytest.raises(PolicyError, match="Hermes runtime is unavailable"):
                run_server(_policy_path(tmp_path), request_token=BRIDGE_REQUEST_TOKEN)

    server.assert_not_called()


def test_active_hermes_policy_routes_to_the_persisted_claude_runtime(monkeypatch):
    """The stable public alias follows Hermes config, never a client model selector."""
    import importlib

    from remnic_hermes.hermes_llm_bridge import BridgePolicy, invoke_completion

    config_module = SimpleNamespace(
        load_config_readonly=lambda: {
            "model": {
                "provider": "anthropic",
                "default": "claude-sonnet-5",
                "base_url": "https://example.invalid/v1/",
            }
        }
    )
    original_import = importlib.import_module

    def import_module(name, package=None):
        if name == "hermes_cli.config":
            return config_module
        return original_import(name, package)

    monkeypatch.setattr(importlib, "import_module", import_module)
    calls: list[dict[str, object]] = []

    result = invoke_completion(
        {"model": "attacker-selected-model", "messages": [{"role": "user", "content": "extract"}], "max_tokens": 8},
        BridgePolicy(provider="active-hermes", model="hermes-active", timeout_seconds=90),
        call_llm=lambda **kwargs: calls.append(kwargs)
        or SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="dynamic response"))]),
    )

    assert calls[0]["provider"] == "anthropic"
    assert calls[0]["model"] == "claude-sonnet-5"
    assert calls[0]["base_url"] == "https://example.invalid/v1"
    assert result["model"] == "hermes-active"


def test_active_hermes_endpoint_advertises_a_stable_alias_across_runtime_changes(tmp_path, monkeypatch):
    """Remnic sees one model while each completion re-reads the persisted Hermes route."""
    import importlib

    from remnic_hermes.hermes_llm_bridge import make_handler

    policy_path = tmp_path / "policy.json"
    policy_path.write_text(
        json.dumps(
            {"provider": "active-hermes", "model": "hermes-active", "timeout_seconds": 90}
        ),
        encoding="utf-8",
    )
    runtime = {"model": {"provider": "anthropic", "default": "claude-sonnet-5"}}
    original_import = importlib.import_module
    monkeypatch.setattr(
        importlib,
        "import_module",
        lambda name, package=None: SimpleNamespace(load_config_readonly=lambda: runtime)
        if name == "hermes_cli.config"
        else original_import(name, package),
    )
    calls: list[dict[str, object]] = []
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_handler(
            policy_path,
            call_llm=lambda **kwargs: calls.append(kwargs)
            or SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="dynamic response"))]),
            request_token=BRIDGE_REQUEST_TOKEN,
        ),
    )
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        assert _request(server, "/v1/models")["data"] == [
            {"id": "hermes-active", "object": "model", "owned_by": "hermes"}
        ]
        first = _request(
            server,
            "/v1/chat/completions",
            body={"model": "client-selected", "messages": [{"role": "user", "content": "extract"}]},
        )
        runtime["model"] = {"provider": "openai-codex", "default": "gpt-5.6-terra-900k"}
        second = _request(
            server,
            "/v1/chat/completions",
            body={"model": "another-client-selection", "messages": [{"role": "user", "content": "extract"}]},
        )
        assert first["model"] == second["model"] == "hermes-active"
        assert [(call["provider"], call["model"]) for call in calls] == [
            ("anthropic", "claude-sonnet-5"),
            ("openai-codex", "gpt-5.6-terra-900k"),
        ]
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_active_hermes_runtime_misconfiguration_is_a_retryable_service_error(tmp_path, monkeypatch):
    """A bad persisted Hermes route is server state, not a caller-owned 400."""
    import importlib

    from remnic_hermes.hermes_llm_bridge import make_handler

    policy_path = tmp_path / "policy.json"
    policy_path.write_text(
        json.dumps(
            {"provider": "active-hermes", "model": "hermes-active", "timeout_seconds": 90}
        ),
        encoding="utf-8",
    )
    original_import = importlib.import_module
    monkeypatch.setattr(
        importlib,
        "import_module",
        lambda name, package=None: SimpleNamespace(load_config_readonly=lambda: {})
        if name == "hermes_cli.config"
        else original_import(name, package),
    )
    calls: list[dict[str, object]] = []
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_handler(
            policy_path,
            call_llm=lambda **kwargs: calls.append(kwargs),
            request_token=BRIDGE_REQUEST_TOKEN,
        ),
    )
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with pytest.raises(HTTPError) as error:
            _request(
                server,
                "/v1/chat/completions",
                body={"messages": [{"role": "user", "content": "extract"}]},
            )
        assert error.value.code == 503
        assert json.loads(error.value.read())["error"]["message"] == "active Hermes model configuration is unavailable"
        assert calls == []
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_active_hermes_policy_rejects_an_unstable_public_alias():
    """Dynamic routing has one explicit, stable OpenAI-compatible public model ID."""
    from remnic_hermes.hermes_llm_bridge import BridgePolicy, PolicyError

    with pytest.raises(PolicyError, match="hermes-active"):
        BridgePolicy.from_mapping(
            {
                "provider": "active-hermes",
                "model": "claude-sonnet-5",
                "timeout_seconds": 90,
            }
        )


@pytest.mark.parametrize(
    "base_url",
    [
        "https://",
        "http://",
        "https:///v1",
        "https://:8080/v1",
        "ftp://example.invalid/v1",
        "example.invalid/v1",
        "https://example.invalid:99999/v1",
        "https://example.invalid:notaport/v1",
        "https://example.invalid:0/v1",
    ],
)
def test_active_hermes_rejects_a_base_url_without_a_usable_http_authority(monkeypatch, base_url):
    """A prefix-shaped but hostless persisted route fails closed instead of reaching the provider."""
    import importlib

    from remnic_hermes.hermes_llm_bridge import BridgePolicy, RuntimeConfigurationError, invoke_completion

    config_module = SimpleNamespace(
        load_config_readonly=lambda: {
            "model": {
                "provider": "anthropic",
                "default": "claude-sonnet-5",
                "base_url": base_url,
            }
        }
    )
    original_import = importlib.import_module

    def import_module(name, package=None):
        if name == "hermes_cli.config":
            return config_module
        return original_import(name, package)

    monkeypatch.setattr(importlib, "import_module", import_module)
    calls: list[dict[str, object]] = []

    with pytest.raises(RuntimeConfigurationError, match="base URL is invalid"):
        invoke_completion(
            {"messages": [{"role": "user", "content": "extract"}], "max_tokens": 8},
            BridgePolicy(provider="active-hermes", model="hermes-active", timeout_seconds=90),
            call_llm=lambda **kwargs: calls.append(kwargs) or SimpleNamespace(choices=[]),
        )

    assert calls == []
