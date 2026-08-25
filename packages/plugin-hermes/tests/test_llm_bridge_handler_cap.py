"""Regressions for the pre-auth handler cap (issue #2955)."""

from __future__ import annotations

import json
import socket
import threading
import time
from typing import Any

from remnic_hermes.llm_bridge import BridgePolicy, _MAX_HANDLERS

from tests.test_llm_bridge import (
    RecordingDelegate,
    _authed_post,
    _post,
    running_bridge,
)


def _hold_incomplete(port: int) -> socket.socket:
    sock = socket.create_connection(("127.0.0.1", port), timeout=2)
    sock.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n")
    return sock


def _wait_until(predicate: Any, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met before timeout")


class TestPreAuthHandlerCap:
    def test_unauthenticated_flood_does_not_spawn_unbounded_threads(self) -> None:
        """ThreadingHTTPServer must not start a thread per accept past the cap."""
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            before = threading.active_count()
            holders: list[socket.socket] = []
            try:
                for _ in range(_MAX_HANDLERS + 24):
                    holders.append(_hold_incomplete(bridge.bound_port))
                _wait_until(lambda: bridge.active_handlers == _MAX_HANDLERS)
                time.sleep(0.2)
                extra = threading.active_count() - before
                assert extra <= _MAX_HANDLERS + 4
                assert bridge.active_handlers == _MAX_HANDLERS
            finally:
                for sock in holders:
                    sock.close()

    def test_over_capacity_is_503_before_auth_or_delegation(self) -> None:
        delegate = RecordingDelegate()
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            bridge._handler_slots = threading.BoundedSemaphore(2)
            holders = [_hold_incomplete(bridge.bound_port), _hold_incomplete(bridge.bound_port)]
            try:
                _wait_until(lambda: bridge.active_handlers == 2)
                status, body = _authed_post(
                    bridge,
                    json.dumps({"messages": [{"role": "user", "content": "x"}]}),
                    timeout=2.0,
                )
                unauth_status, unauth_body = _post(
                    bridge.bound_port,
                    json.dumps({"messages": [{"role": "user", "content": "x"}]}),
                    timeout=2.0,
                )
            finally:
                for sock in holders:
                    sock.close()
            assert status == 503
            assert body["error"]["message"] == "too many connections"
            assert unauth_status == 503
            assert unauth_body["error"]["message"] == "too many connections"
            assert delegate.calls == []

    def test_missing_bearer_is_still_401_under_the_cap(self) -> None:
        delegate = RecordingDelegate()
        with running_bridge(BridgePolicy(enabled=True), delegate) as bridge:
            status, body = _post(
                bridge.bound_port,
                json.dumps({"messages": [{"role": "user", "content": "x"}]}),
            )
        assert status == 401
        assert body["error"]["message"] == "unauthorized"
        assert delegate.calls == []

    def test_authed_completion_resumes_after_cap_releases(self) -> None:
        with running_bridge(BridgePolicy(enabled=True), RecordingDelegate()) as bridge:
            bridge._handler_slots = threading.BoundedSemaphore(2)
            holders = [_hold_incomplete(bridge.bound_port), _hold_incomplete(bridge.bound_port)]
            try:
                _wait_until(lambda: bridge.active_handlers == 2)
            finally:
                for sock in holders:
                    sock.close()
            _wait_until(lambda: bridge.active_handlers == 0)
            status, body = _authed_post(
                bridge,
                json.dumps({"messages": [{"role": "user", "content": "x"}]}),
            )
            assert status == 200
            assert body["choices"][0]["message"]["content"] == "bridged answer"
            _wait_until(lambda: bridge.active_handlers == 0)
