"""Opt-in policy-bound loopback LLM bridge for Hermes (issue #2834).

Serves a single OpenAI-compatible chat-completion endpoint on loopback so a
local Remnic daemon can use the host's provider policies for OPTIONAL
background generation without ever seeing a provider credential:

- Loopback-only listener (IPv4/IPv6), shared classifier with the daemon
  client. Wildcard and non-loopback binds are rejected at construction.
- The provider/model policy is server-owned. Caller-supplied ``model`` /
  ``provider`` / routing fields in the request body are ignored and never
  forwarded; the delegate receives the messages and nothing else.
- Completion is delegated to the existing Hermes runtime resolver
  (Hermes ``PluginLlm.complete`` — host-owned routing, auth, and fallback). No new
  provider client or dependency is introduced: the server is stdlib-only.
- The generated client config contains only the endpoint description and
  limits — by construction it has no field that can carry a token or key.
- Requests are body-bounded and deadline-bounded; nothing about the request
  body is ever logged, and error responses are fixed strings (no exception
  text, no echoes).

Background-only: this bridge is not on the recall path. Recall keeps going
directly from the provider to the Remnic daemon; if the bridge is down,
memory recall and observation are unaffected.
"""

from __future__ import annotations

import functools
import inspect
import ipaddress
import itertools
import json
import logging
import math
import multiprocessing
import os
import pickle
import socket
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol, cast

from remnic_hermes.client import is_loopback_host
from remnic_hermes.config import _parse_bool

_log = logging.getLogger("remnic_hermes.llm_bridge")

_ENDPOINT_PATH = "/v1/chat/completions"
_HEALTH_PATH = "/healthz"
_DEFAULT_MAX_BODY_BYTES = 524_288
_DEFAULT_TIMEOUT_SECONDS = 120.0
_WORKERS = 2
_ALLOWED_POLICY_KEYS = {
    "enabled",
    "host",
    "port",
    "max_body_bytes",
    "timeout_seconds",
    "client_config_path",
}
_CREDENTIAL_KEY_MARKERS = ("token", "api_key", "apikey", "secret", "authorization", "password")

_request_counter = itertools.count(1)


class BridgeUsage(Protocol):
    """Token usage of a delegated completion (matches Hermes PluginLlmUsage)."""

    input_tokens: int
    output_tokens: int
    total_tokens: int


class BridgeCompletionResult(Protocol):
    """What the delegate must return (matches Hermes PluginLlmCompleteResult)."""

    text: str
    model: str
    usage: BridgeUsage


# The delegate is the host's runtime resolver call: it receives the validated
# message list and NOTHING else — model/provider routing cannot be forwarded.
CompletionDelegate = Callable[[list[dict[str, str]]], BridgeCompletionResult]


@dataclass(frozen=True)
class BridgePolicy:
    """Server-owned bridge policy.

    There is deliberately no model/provider field here: the route is whatever
    the host resolver's active model is, and no request or config value can
    change it.
    """

    enabled: bool = False
    host: str = "127.0.0.1"
    port: int = 0
    max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS
    client_config_path: str = ""

    @classmethod
    def from_config(cls, section: object) -> BridgePolicy:
        """Parse the ``remnic.llm_bridge`` config section.

        Raises TypeError/ValueError on invalid values or unknown keys — an
        unknown key (e.g. a stray ``model``) is rejected loudly instead of
        being silently ignored, because the policy must stay server-owned.
        """
        if section is None:
            return cls()
        if not isinstance(section, dict):
            raise TypeError(f"remnic llm_bridge must be a mapping, got {section!r}")
        unknown = sorted(set(section) - _ALLOWED_POLICY_KEYS)
        if unknown:
            raise ValueError(
                f"remnic llm_bridge has unknown field(s) {unknown}; allowed: "
                f"{sorted(_ALLOWED_POLICY_KEYS)} (the model/provider policy is "
                "server-owned and not configurable)"
            )
        host = section.get("host", "127.0.0.1")
        if not isinstance(host, str):
            raise TypeError(f"remnic llm_bridge host must be a string, got {host!r}")
        if not host.strip():
            raise ValueError("remnic llm_bridge host must not be blank")
        port = _parse_int_field("port", section.get("port", 0), minimum=0, maximum=65535)
        max_body_bytes = _parse_int_field(
            "max_body_bytes", section.get("max_body_bytes", _DEFAULT_MAX_BODY_BYTES), minimum=1024
        )
        timeout_raw = section.get("timeout_seconds", _DEFAULT_TIMEOUT_SECONDS)
        if isinstance(timeout_raw, bool) or not isinstance(timeout_raw, (int, float)):
            raise TypeError(
                f"remnic llm_bridge timeout_seconds must be a number, got {timeout_raw!r}"
            )
        timeout_seconds = float(timeout_raw)
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError(
                f"remnic llm_bridge timeout_seconds must be a finite number > 0, got {timeout_raw!r}"
            )
        client_config_path = section.get("client_config_path", "")
        if not isinstance(client_config_path, str):
            raise TypeError(
                f"remnic llm_bridge client_config_path must be a string, got {client_config_path!r}"
            )
        return cls(
            enabled=_parse_bool("llm_bridge.enabled", section.get("enabled", False)),
            host=host.strip(),
            port=port,
            max_body_bytes=max_body_bytes,
            timeout_seconds=timeout_seconds,
            client_config_path=client_config_path.strip(),
        )


def _parse_int_field(name: str, raw: object, *, minimum: int, maximum: int | None = None) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise TypeError(f"remnic llm_bridge {name} must be an integer, got {raw!r}")
    if raw < minimum or (maximum is not None and raw > maximum):
        upper = f" and <= {maximum}" if maximum is not None else ""
        raise ValueError(f"remnic llm_bridge {name} must be >= {minimum}{upper}, got {raw!r}")
    return raw


def _bind_address(host: str) -> str:
    """Return the canonical socket bind address, rejecting non-loopback hosts.

    Wildcards (``0.0.0.0``, ``::``) are not loopback, so they are rejected by
    the same classifier; there is no separate wildcard escape hatch.
    """
    if not is_loopback_host(host):
        raise ValueError(f"remnic llm_bridge host must be loopback-only, got {host!r}")
    stripped = host.rstrip(".").removeprefix("[").removesuffix("]")
    try:
        address = ipaddress.ip_address(stripped)
    except ValueError:
        return stripped.lower()
    return address.compressed



def _accepts_timeout(complete: Callable[..., Any]) -> bool:
    """True only when ``timeout`` is an explicit parameter, not a bare ``**kwargs``."""
    try:
        parameters = inspect.signature(complete).parameters
    except (TypeError, ValueError):
        return False
    return "timeout" in parameters


def _plugin_id_of(complete: Callable[..., Any]) -> str | None:
    owner = getattr(complete, "__self__", None)
    if owner is None:
        return None
    plugin_id = getattr(owner, "plugin_id", None) or getattr(owner, "_plugin_id", None)
    if type(owner).__name__ == "PluginLlm" or plugin_id or callable(
        getattr(owner, "complete_structured", None)
    ):
        return str(plugin_id or "remnic")
    return None


def _plugin_llm_child_complete(
    messages: list[dict[str, str]], plugin_id: str = "remnic"
) -> Any:
    """Reconstruct Hermes PluginLlm inside a killable worker (never pickle the live facade)."""
    from remnic_hermes.llm_runtime import _discover_plugin_llm_class, _instantiate_plugin_llm

    plugin_cls = _discover_plugin_llm_class()
    if plugin_cls is None:
        raise RuntimeError("PluginLlm is not importable in the llm_bridge worker")
    instance = _instantiate_plugin_llm(plugin_cls, plugin_id)
    if instance is None:
        raise RuntimeError("PluginLlm could not be constructed in the llm_bridge worker")
    complete = instance.complete
    try:
        return complete(messages, purpose="remnic-llm-bridge")
    except TypeError:
        return complete(messages)


@dataclass(frozen=True)
class _FrozenUsage:
    input_tokens: int
    output_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class _FrozenResult:
    text: str
    model: str
    usage: _FrozenUsage


def _isolated_worker(
    complete: Callable[..., Any],
    messages: list[dict[str, str]],
    conn: Any,
) -> None:
    try:
        result = complete(messages)
        usage = getattr(result, "usage", None)
        conn.send(
            (
                "ok",
                (
                    str(getattr(result, "text", "")),
                    str(getattr(result, "model", "")),
                    int(getattr(usage, "input_tokens", 0) or 0),
                    int(getattr(usage, "output_tokens", 0) or 0),
                    int(getattr(usage, "total_tokens", 0) or 0),
                ),
            )
        )
    except Exception as exc:
        conn.send(("err", type(exc).__name__))
    finally:
        conn.close()


class HermesLlmBridge:
    """Loopback-only OpenAI-compatible completion bridge (opt-in)."""

    def __init__(self, policy: BridgePolicy, complete: CompletionDelegate) -> None:
        self._bind = _bind_address(policy.host)  # rejects before any socket exists
        self.policy = policy
        self._complete = complete
        self._server: _BridgeServer | None = None
        self._thread: threading.Thread | None = None
        self._slots = threading.BoundedSemaphore(_WORKERS)
        self._inflight = 0
        self._inflight_lock = threading.Lock()
        self._live_procs: set[Any] = set()
        self._use_timeout_kwarg = _accepts_timeout(complete)
        self._use_process = False
        if self._use_timeout_kwarg:
            self._complete = complete
        else:
            plugin_id = _plugin_id_of(complete)
            if plugin_id is not None:
                self._complete = functools.partial(_plugin_llm_child_complete, plugin_id=plugin_id)
                self._use_process = True
            else:
                try:
                    pickle.dumps(complete)
                except Exception:
                    self._complete = complete
                else:
                    self._complete = complete
                    self._use_process = True

    @property
    def bound_port(self) -> int:
        if self._server is None:
            raise RuntimeError("llm_bridge not started")
        return int(self._server.server_address[1])

    def start(self) -> None:
        """Bind and serve on a daemon thread. Idempotent no-op when running."""
        if self._server is not None:
            return
        server = _BridgeServer((self._bind, self.policy.port), _BridgeHandler, self)
        self._server = server
        self._thread = threading.Thread(
            target=server.serve_forever,
            name="remnic-llm-bridge-server",
            daemon=True,
        )
        self._thread.start()
        _log.info(
            "llm_bridge listening on %s:%d (policy-bound, loopback-only)",
            self._bind,
            self.bound_port,
        )

    def stop(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.shutdown()
            server.server_close()
        with self._inflight_lock:
            procs = list(self._live_procs)
            self._live_procs.clear()
        for proc in procs:
            if proc.is_alive():
                proc.terminate()
            proc.join(0.5)
            if proc.is_alive():
                proc.kill()
                proc.join(0.5)

    @property
    def active_work(self) -> int:
        with self._inflight_lock:
            return self._inflight

    def complete_with_deadline(self, messages: list[dict[str, str]]) -> BridgeCompletionResult:
        """Delegate to the host resolver under the policy deadline.

        The delegate receives only ``messages`` — the fixed policy means
        there is no code path that could forward a caller's model or
        provider choice even if the host config would allow the override.

        Hosts that expose an explicit ``timeout=`` parameter are invoked
        in-process so the runtime can abort the call. PluginLlm-shaped
        facades are reconstructed in a killable child; other pickleable
        callables run in a child too. Future.cancel is never the stop
        mechanism. Unpickleable non-PluginLlm callables run in-process so
        production start is never refused.
        """
        if not self._slots.acquire(timeout=self.policy.timeout_seconds):
            raise TimeoutError("bridge completion deadline exceeded")
        with self._inflight_lock:
            self._inflight += 1
        try:
            if self._use_timeout_kwarg:
                return self._complete(messages, timeout=self.policy.timeout_seconds)
            if self._use_process:
                return self._run_in_killable_process(messages)
            try:
                return self._complete(messages, purpose="remnic-llm-bridge")
            except TypeError:
                return self._complete(messages)
        finally:
            with self._inflight_lock:
                self._inflight -= 1
            self._slots.release()

    def _run_in_killable_process(
        self, messages: list[dict[str, str]]
    ) -> BridgeCompletionResult:
        ctx = multiprocessing.get_context("spawn")
        parent, child = ctx.Pipe(duplex=False)
        proc = ctx.Process(
            target=_isolated_worker,
            args=(self._complete, messages, child),
            daemon=True,
        )
        with self._inflight_lock:
            self._live_procs.add(proc)
        proc.start()
        child.close()
        try:
            if parent.poll(self.policy.timeout_seconds):
                status, payload = parent.recv()
                if status == "ok":
                    text, model, inp, out, tot = payload
                    return _FrozenResult(text, model, _FrozenUsage(inp, out, tot))
                raise RuntimeError(payload)
            proc.terminate()
            proc.join(0.5)
            if proc.is_alive():
                proc.kill()
                proc.join(0.5)
            raise TimeoutError("bridge completion deadline exceeded")
        finally:
            parent.close()
            with self._inflight_lock:
                self._live_procs.discard(proc)
            if proc.is_alive():
                proc.terminate()
                proc.join(0.2)

    def client_config(self) -> dict[str, object]:
        """Credential-free connection description for downstream consumers.

        Built from a fixed literal: it has no field that can carry a token,
        key, or credential, and contains no model/provider routing either.
        """
        if self._server is None:
            raise RuntimeError("llm_bridge not started")
        host = f"[{self._bind}]" if ":" in self._bind else self._bind
        base = f"http://{host}:{self.bound_port}"
        return {
            "endpoint": f"{base}{_ENDPOINT_PATH}",
            "health_endpoint": f"{base}{_HEALTH_PATH}",
            "bind": self.policy.host,
            "model_policy": "server-owned",
            "max_body_bytes": self.policy.max_body_bytes,
            "timeout_seconds": self.policy.timeout_seconds,
        }

    def write_client_config(self, path: str) -> dict[str, object]:
        """Write :meth:`client_config` to ``path`` with owner-only permissions."""
        config = self.client_config()
        for key in config:
            lowered = str(key).lower()
            if any(marker in lowered for marker in _CREDENTIAL_KEY_MARKERS):
                raise AssertionError(  # pragma: no cover - guards future field additions
                    f"llm_bridge client config field {key!r} looks like a credential"
                )
        serialized = json.dumps(config, indent=2, sort_keys=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized + "\n")
        return config


class _BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        bridge: HermesLlmBridge,
    ) -> None:
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        self.bridge = bridge
        super().__init__(address, handler)


class _BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "remnic-llm-bridge"
    sys_version = ""
    timeout = 30  # drop dead connections instead of pinning handler threads

    def version_string(self) -> str:
        return self.server_version

    def log_message(self, format: str, *args: Any) -> None:
        # Method/path/status only. The request body is never logged.
        _log.debug("llm_bridge %s", format % args)

    def do_GET(self) -> None:
        if self.path == _HEALTH_PATH:
            self._send_json(200, {"status": "ok"})
            return
        self._send_error(404, "not found", "not_found")

    def do_POST(self) -> None:
        if self.path != _ENDPOINT_PATH:
            self._send_error(404, "not found", "not_found")
            return
        bridge = cast(_BridgeServer, self.server).bridge
        length_raw = self.headers.get("Content-Length")
        if length_raw is None:
            self._send_error(411, "content-length required", "length_required")
            return
        try:
            length = int(length_raw)
        except ValueError:
            self._send_error(400, "invalid content-length", "invalid_request")
            return
        if length < 0 or length > bridge.policy.max_body_bytes:
            self._send_error(413, "request body too large", "request_too_large")
            return
        try:
            body = self.rfile.read(length)
        except (ConnectionError, TimeoutError, OSError):
            return  # client aborted; nothing to answer
        if len(body) != length:
            return  # truncated body / client abort
        try:
            payload = json.loads(body)
        except ValueError:
            self._send_error(400, "invalid json body", "invalid_request")
            return
        messages = _validated_messages(payload)
        if messages is None:
            self._send_error(400, "invalid request body", "invalid_request")
            return
        try:
            result = bridge.complete_with_deadline(messages)
        except TimeoutError:
            self._send_error(504, "completion timed out", "timeout")
            return
        except Exception as err:
            _log.warning("llm_bridge completion failed (%s)", type(err).__name__)
            self._send_error(502, "completion failed", "completion_failed")
            return
        self._send_json(200, _openai_completion(result))

    def _send_json(self, code: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ConnectionError, BrokenPipeError, OSError):
            pass  # client went away; request is fully handled server-side

    def _send_error(self, code: int, message: str, err_type: str) -> None:
        self._send_json(
            code,
            {"error": {"message": message, "type": err_type, "param": None, "code": err_type}},
        )


def _validated_messages(payload: object) -> list[dict[str, str]] | None:
    """Extract the OpenAI ``messages`` list; everything else in the body —
    including ``model`` and any provider/routing field — is discarded."""
    if not isinstance(payload, dict):
        return None
    raw_messages = payload.get("messages")
    if not isinstance(raw_messages, list) or not raw_messages:
        return None
    messages: list[dict[str, str]] = []
    for item in raw_messages:
        if not isinstance(item, dict):
            return None
        role = item.get("role")
        content = item.get("content")
        if not isinstance(role, str) or not role.strip() or not isinstance(content, str):
            return None
        messages.append({"role": role, "content": content})
    return messages


def _openai_completion(result: BridgeCompletionResult) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-bridge-{next(_request_counter)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": result.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": result.text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": result.usage.input_tokens,
            "completion_tokens": result.usage.output_tokens,
            "total_tokens": result.usage.total_tokens,
        },
    }


def start_bridge_from_config(
    section: object, llm_complete: Callable[..., Any] | None
) -> HermesLlmBridge | None:
    """Wire :class:`HermesLlmBridge` from the config section and host resolver.

    ``llm_complete`` is a Hermes ``PluginLlm.complete`` bound method (or None
    when no runtime facade is available). Returns the started bridge, or None
    when the bridge is not enabled or the host facade is missing. Invalid
    config or a failed bind is reported to the log and swallowed — the bridge
    is background-only and must never take plugin registration down.
    """
    try:
        policy = BridgePolicy.from_config(section)
    except (TypeError, ValueError) as err:
        _log.warning("llm_bridge disabled by invalid config: %s", err)
        return None
    if not policy.enabled:
        return None
    if llm_complete is None:
        _log.warning(
            "llm_bridge enabled but no Hermes PluginLlm completion delegate is available; bridge not started"
        )
        return None

    try:
        bridge = HermesLlmBridge(policy, llm_complete)
        bridge.start()
    except (OSError, ValueError) as err:
        _log.warning("llm_bridge failed to start (%s)", type(err).__name__)
        return None
    if policy.client_config_path:
        try:
            bridge.write_client_config(policy.client_config_path)
        except OSError as err:
            _log.warning("llm_bridge could not write client config (%s)", type(err).__name__)
    return bridge
