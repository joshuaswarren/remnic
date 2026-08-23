"""Behavioral tests for the opt-in Hermes provider bridge."""

from __future__ import annotations

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


def test_readiness_endpoint_requires_the_supervisor_secret(tmp_path):
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

        request = Request(url, headers={"X-Remnic-Bridge-Ready": "expected-readiness-token"})
        with urlopen(request, timeout=2) as response:  # noqa: S310 -- test server is loopback-only
            assert response.status == 204
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
