"""Loopback-only OpenAI-compatible bridge from Remnic to Hermes routing.

The bridge deliberately owns no provider credential.  It accepts a tiny
policy, then asks Hermes' auxiliary client to resolve and authenticate the
selected provider for each request.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import hmac
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
from typing import Any, Callable, Type, cast
from urllib.parse import urlsplit


class PolicyError(ValueError):
    """A bridge request or policy exceeds the documented contract."""


class RuntimeConfigurationError(PolicyError):
    """Persisted Hermes routing is unavailable or invalid for a dynamic policy."""


class ProviderResponseError(RuntimeError):
    """Hermes returned a response that cannot satisfy the OpenAI-compatible contract."""


_PROVIDER_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$")
_ALLOWED_POLICY_KEYS = frozenset({"provider", "model", "timeout_seconds"})
_ENV_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
_MAX_REQUEST_BYTES = 1_000_000
_MAX_COMPLETION_TOKENS = 16_384
_ACTIVE_HERMES_MODEL = "hermes-active"


@dataclass(frozen=True)
class BridgePolicy:
    """The complete credential-free contract exposed by one bridge instance."""

    provider: str
    model: str
    timeout_seconds: int

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> "BridgePolicy":
        extra = sorted(set(raw) - _ALLOWED_POLICY_KEYS)
        if extra:
            raise PolicyError(f"unsupported policy keys: {', '.join(extra)}")
        provider = raw.get("provider")
        model = raw.get("model")
        timeout = raw.get("timeout_seconds")
        if not isinstance(provider, str) or not _PROVIDER_RE.fullmatch(provider):
            raise PolicyError("provider must be a normalized provider identifier")
        if not isinstance(model, str) or not _MODEL_RE.fullmatch(model):
            raise PolicyError("model must be a normalized model identifier")
        if provider == "active-hermes" and model != _ACTIVE_HERMES_MODEL:
            raise PolicyError(f"active-hermes policy model must be {_ACTIVE_HERMES_MODEL}")
        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 5 <= timeout <= 300:
            raise PolicyError("timeout_seconds must be an integer from 5 through 300")
        return cls(provider=provider, model=model, timeout_seconds=timeout)


def load_policy(path: str | Path) -> BridgePolicy:
    """Read a closed-schema policy without exposing its raw contents."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError) as exc:
        raise PolicyError("policy is unreadable or invalid JSON") from exc
    if not isinstance(raw, dict):
        raise PolicyError("policy must be an object")
    return BridgePolicy.from_mapping(raw)


def _messages_from_request(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise PolicyError("messages must be a non-empty array")
    messages: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise PolicyError("messages entries must be objects")
        role = item.get("role")
        content = item.get("content")
        if role not in {"system", "user", "assistant"} or not isinstance(content, str):
            raise PolicyError("messages require text system, user, or assistant roles")
        messages.append({"role": role, "content": content})
    return messages


def _content_from_response(response: Any) -> str:
    try:
        content = response.choices[0].message.content
    except (AttributeError, IndexError, TypeError) as exc:
        raise ProviderResponseError("Hermes provider returned no completion content") from exc
    if isinstance(content, str) and content:
        return content
    raise ProviderResponseError("Hermes provider returned empty completion content")


def _resolve_runtime(policy: BridgePolicy) -> tuple[str, str, str | None]:
    """Resolve a fixed policy or the persisted main Hermes model safely."""
    if policy.provider != "active-hermes":
        return policy.provider, policy.model, None

    try:
        import importlib

        config_module = importlib.import_module("hermes_cli.config")
        loader = getattr(config_module, "load_config_readonly", None) or getattr(config_module, "load_config", None)
        if not callable(loader):
            raise TypeError("Hermes config loader is unavailable")
        config = loader()
        model_config = config.get("model") if isinstance(config, dict) else None
        if not isinstance(model_config, dict):
            raise TypeError("Hermes model configuration is unavailable")
        provider = model_config.get("provider")
        model = model_config.get("default")
        base_url = model_config.get("base_url")
    except Exception as exc:
        raise RuntimeConfigurationError("active Hermes model configuration is unavailable") from exc

    if not isinstance(provider, str) or not _PROVIDER_RE.fullmatch(provider):
        raise RuntimeConfigurationError("active Hermes model provider is invalid")
    if not isinstance(model, str) or not _MODEL_RE.fullmatch(model):
        raise RuntimeConfigurationError("active Hermes model identifier is invalid")
    if base_url in (None, ""):
        return provider, model, None
    if not isinstance(base_url, str) or not _is_absolute_http_url(base_url):
        raise RuntimeConfigurationError("active Hermes model base URL is invalid")
    return provider, model, base_url.rstrip("/")


def _is_absolute_http_url(value: str) -> bool:
    """Accept only an absolute http(s) URL that carries a non-empty authority.

    A prefix test alone admits values such as "https://", which carry no host and
    would otherwise reach the provider as a malformed endpoint instead of failing
    closed as invalid persisted routing.
    """
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.hostname)


def invoke_completion(
    body: dict[str, Any],
    policy: BridgePolicy,
    *,
    call_llm: Callable[..., Any],
) -> dict[str, Any]:
    """Invoke the policy-selected Hermes provider for one chat-completions body."""
    messages = _messages_from_request(body.get("messages"))
    temperature = body.get("temperature")
    if temperature is not None and (
        isinstance(temperature, bool)
        or not isinstance(temperature, (int, float))
        or (isinstance(temperature, float) and not math.isfinite(temperature))
    ):
        raise PolicyError("temperature must be a finite number")
    max_tokens = body.get("max_tokens", body.get("max_completion_tokens"))
    if max_tokens is not None and (
        isinstance(max_tokens, bool)
        or not isinstance(max_tokens, int)
        or not 1 <= max_tokens <= _MAX_COMPLETION_TOKENS
    ):
        raise PolicyError(f"max_tokens must be an integer from 1 through {_MAX_COMPLETION_TOKENS}")

    provider, model, base_url = _resolve_runtime(policy)
    call_kwargs: dict[str, object] = {
        "provider": provider,
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "timeout": policy.timeout_seconds,
    }
    if base_url is not None:
        call_kwargs["base_url"] = base_url
    response = call_llm(**call_kwargs)
    return {
        "id": "chatcmpl-remnic-hermes",
        "object": "chat.completion",
        "model": policy.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": _content_from_response(response)},
                "finish_reason": "stop",
            }
        ],
    }


def _resolve_hermes_call_llm() -> Callable[..., Any]:
    """Resolve Hermes' installed auxiliary client without importing it at package load."""
    from importlib import import_module

    try:
        candidate = getattr(import_module("agent.auxiliary_client"), "call_llm")
    except (AttributeError, ImportError) as exc:
        raise PolicyError(
            "Hermes runtime is unavailable; run the bridge with the Python environment that installs Hermes"
        ) from exc
    if not callable(candidate):
        raise PolicyError("Hermes runtime does not expose a callable auxiliary client")
    return cast(Callable[..., Any], candidate)


def _default_call_llm(**kwargs: Any) -> Any:
    """Delegate a request through the installed Hermes provider resolver."""
    return _resolve_hermes_call_llm()(**kwargs)


def make_handler(
    policy_path: str | Path,
    *,
    call_llm: Callable[..., Any] = _default_call_llm,
    request_token: str,
    readiness_token: str | None = None,
) -> Type[BaseHTTPRequestHandler]:
    """Build a handler bound to policy, Hermes routing, and a local caller token."""
    if not request_token:
        raise ValueError("bridge request token is required")
    if readiness_token == "":
        raise ValueError("bridge readiness token must not be empty")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *_args: Any) -> None:
            del format
            return

        def _send_json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _send_empty(self, status: HTTPStatus) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _authorized(self) -> bool:
            return hmac.compare_digest(
                self.headers.get("Authorization", ""),
                f"Bearer {request_token}",
            )

        def _require_authorized(self) -> bool:
            if self._authorized():
                return True
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": {"message": "unauthorized"}})
            return False

        def do_GET(self) -> None:  # noqa: N802
            requested_path = self.path.rstrip("/")
            if requested_path == "/healthz":
                challenge = self.headers.get("X-Remnic-Bridge-Challenge", "")
                if readiness_token is not None and challenge:
                    proof = hmac.new(
                        readiness_token.encode("utf-8"),
                        challenge.encode("utf-8"),
                        hashlib.sha256,
                    ).hexdigest()
                    self.send_response(HTTPStatus.NO_CONTENT)
                    self.send_header("X-Remnic-Bridge-Proof", proof)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "not found"}})
                return
            if not self._require_authorized():
                return
            if requested_path != "/v1/models":
                self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "not found"}})
                return
            try:
                policy = load_policy(policy_path)
            except PolicyError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": str(exc)}})
                return
            self._send_json(
                HTTPStatus.OK,
                {
                    "object": "list",
                    "data": [{"id": policy.model, "object": "model", "owned_by": "hermes"}],
                },
            )

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/v1/chat/completions":
                self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "not found"}})
                return
            if not self._require_authorized():
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= _MAX_REQUEST_BYTES:
                    raise PolicyError("invalid request body size")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise PolicyError("request body must be an object")
                self._send_json(HTTPStatus.OK, invoke_completion(body, load_policy(policy_path), call_llm=call_llm))
            except ProviderResponseError:
                self._send_json(HTTPStatus.BAD_GATEWAY, {"error": {"message": "Hermes provider call failed"}})
            except RuntimeConfigurationError as exc:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": {"message": str(exc)}})
            except (PolicyError, ValueError, json.JSONDecodeError) as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": str(exc)}})
            except Exception:
                self._send_json(HTTPStatus.BAD_GATEWAY, {"error": {"message": "Hermes provider call failed"}})

    return Handler


def run_server(
    policy_path: str | Path,
    *,
    host: str = "127.0.0.1",
    port: int = 4329,
    request_token: str,
    readiness_token: str | None = None,
) -> None:
    """Serve an authenticated bridge exclusively on IPv4 loopback."""
    if not request_token:
        raise ValueError("bridge request token is required")
    if host != "127.0.0.1":
        raise ValueError("bridge listener must use IPv4 loopback (127.0.0.1)")
    if not 1 <= port <= 65535:
        raise ValueError("bridge port out of range")
    load_policy(policy_path)
    _resolve_hermes_call_llm()
    ThreadingHTTPServer(
        (host, port),
        make_handler(
            policy_path,
            request_token=request_token,
            readiness_token=readiness_token,
        ),
    ).serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Loopback Remnic-to-Hermes LLM bridge")
    parser.add_argument("--policy", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4329)
    parser.add_argument("--request-token-env", required=True)
    parser.add_argument("--readiness-token-env", required=True)
    args = parser.parse_args()
    if not _ENV_NAME_RE.fullmatch(args.request_token_env):
        parser.error("--request-token-env must name a conventional environment variable")
    if not _ENV_NAME_RE.fullmatch(args.readiness_token_env):
        parser.error("--readiness-token-env must name a conventional environment variable")
    request_token = os.environ.get(args.request_token_env)
    if not request_token:
        parser.error(f"environment variable {args.request_token_env} is required")
    readiness_token = os.environ.get(args.readiness_token_env)
    if not readiness_token:
        parser.error(f"environment variable {args.readiness_token_env} is required")
    run_server(
        args.policy,
        host=args.host,
        port=args.port,
        request_token=request_token,
        readiness_token=readiness_token,
    )


if __name__ == "__main__":
    main()
