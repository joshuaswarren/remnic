"""Tests for the Remnic daemon and Hermes bridge lifecycle supervisor."""

from __future__ import annotations

import os
import signal
from unittest.mock import patch

import pytest


_REQUEST_TOKEN_ENV = "REMNIC_HERMES_BRIDGE_TOKEN"


class Process:
    def __init__(self, *, returncode: int | None = None) -> None:
        self.returncode = returncode
        self.terminate_calls = 0
        self.received_signals: list[int] = []

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        self.returncode = 0
        return 0

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = 0

    def send_signal(self, signum: int) -> None:
        self.received_signals.append(signum)
        self.returncode = 0


def test_supervisor_starts_the_daemon_after_the_loopback_bridge_and_stops_the_bridge():
    """A daemon never runs unless its authenticated loopback bridge is ready first."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    daemon = Process()
    parent_env = {
        "PATH": "/usr/bin:/bin",
        "HOME": "/tmp/hermes-home",
        "OPENAI_API_KEY": "provider-key-must-not-reach-daemon",
        "XAI_API_KEY": "other-provider-key-must-not-reach-daemon",
    }
    with patch.dict(os.environ, parent_env, clear=True):
        with patch(
            "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
            side_effect=["first-ready-token", "first-request-token"],
        ):
            with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", side_effect=[bridge, daemon]) as popen:
                with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True):
                    with patch("remnic_hermes.hermes_llm_supervisor._wait_for_children", return_value=0):
                        assert run_supervised(
                            python="/opt/hermes-python",
                            policy="/tmp/policy.json",
                            remnic_bin="/opt/remnic-server",
                            port=4329,
                        ) == 0

    assert popen.call_args_list[0].args[0] == [
        "/opt/hermes-python",
        "-m",
        "remnic_hermes.hermes_llm_bridge",
        "--policy",
        "/tmp/policy.json",
        "--host",
        "127.0.0.1",
        "--port",
        "4329",
        "--request-token-env",
        _REQUEST_TOKEN_ENV,
        "--ready-token",
        "first-ready-token",
    ]
    assert popen.call_args_list[1].args[0] == ["/opt/remnic-server"]
    bridge_env = popen.call_args_list[0].kwargs["env"]
    daemon_env = popen.call_args_list[1].kwargs["env"]
    assert bridge_env[_REQUEST_TOKEN_ENV] == "first-request-token"
    assert daemon_env[_REQUEST_TOKEN_ENV] == "first-request-token"
    assert bridge_env["OPENAI_API_KEY"] == "provider-key-must-not-reach-daemon"
    assert "OPENAI_API_KEY" not in daemon_env
    assert "XAI_API_KEY" not in daemon_env
    assert daemon_env["PATH"] == "/usr/bin:/bin"
    assert daemon_env["HOME"] == "/tmp/hermes-home"
    assert "first-request-token" not in popen.call_args_list[0].args[0]
    assert bridge.terminate_calls == 1


def test_supervisor_passes_an_instance_secret_to_the_readiness_probe_before_daemon_start():
    """A different loopback listener cannot satisfy the bridge readiness check."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    daemon = Process()
    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["unique-ready-token", "unique-request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True) as wait_for_bridge:
            with patch("remnic_hermes.hermes_llm_supervisor._wait_for_children", return_value=0):
                with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", side_effect=[bridge, daemon]) as popen:
                    assert run_supervised(
                        python="/opt/hermes-python",
                        policy="/tmp/policy.json",
                        remnic_bin="/opt/remnic-server",
                        port=4329,
                    ) == 0

    assert wait_for_bridge.call_args.args == (4329, "unique-ready-token")
    assert popen.call_args_list[0].args[0][-2:] == ["--ready-token", "unique-ready-token"]
    assert popen.call_args_list[0].kwargs["env"][_REQUEST_TOKEN_ENV] == "unique-request-token"


def test_supervisor_never_launches_the_daemon_when_instance_readiness_fails():
    """A port collision fails closed instead of sending requests to an unknown listener."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["unique-ready-token", "unique-request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=False):
            with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", return_value=bridge) as popen:
                assert run_supervised(
                    python="/opt/hermes-python",
                    policy="/tmp/policy.json",
                    remnic_bin="/opt/remnic-server",
                    port=4329,
                ) == 70

    assert popen.call_count == 1


def test_supervisor_stops_the_daemon_and_fails_closed_when_the_bridge_exits():
    """A dead bridge cannot leave deferred Remnic work running against a dead endpoint."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process(returncode=1)
    daemon = Process()
    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["ready-token", "request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True):
            with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", side_effect=[bridge, daemon]):
                assert run_supervised(
                    python="/opt/hermes-python",
                    policy="/tmp/policy.json",
                    remnic_bin="/opt/remnic-server",
                    port=4329,
                ) == 70

    assert daemon.terminate_calls == 1


@pytest.mark.parametrize("signum", [signal.SIGINT, signal.SIGTERM])
def test_supervisor_forwards_shutdown_signal_to_both_children(signum: int):
    """The supervisor preserves the received shutdown signal during lifecycle teardown."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    daemon = Process()
    handlers: dict[int, object] = {}

    def register(received_signum: int, handler: object) -> object:
        handlers[received_signum] = handler
        return signal.SIG_DFL

    def signal_shutdown(*_args: object, **_kwargs: object) -> int:
        handler = handlers[signum]
        assert callable(handler)
        handler(signum, None)
        return 0

    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["ready-token", "request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor.signal.signal", side_effect=register):
            with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True):
                with patch("remnic_hermes.hermes_llm_supervisor._wait_for_children", side_effect=signal_shutdown):
                    with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", side_effect=[bridge, daemon]):
                        assert run_supervised(
                            python="/opt/hermes-python",
                            policy="/tmp/policy.json",
                            remnic_bin="/opt/remnic-server",
                            port=4329,
                        ) == 0

    assert daemon.received_signals == [signum]
    assert bridge.received_signals == [signum]


def test_supervisor_does_not_start_the_daemon_if_shutdown_arrives_after_readiness():
    """A shutdown signal in the bridge-to-daemon gap cannot launch a new child."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    handlers: dict[int, object] = {}

    def register(received_signum: int, handler: object) -> object:
        handlers[received_signum] = handler
        return signal.SIG_DFL

    def ready_then_shutdown(*_args: object) -> bool:
        handler = handlers[signal.SIGTERM]
        assert callable(handler)
        handler(signal.SIGTERM, None)
        return True

    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["ready-token", "request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor.signal.signal", side_effect=register):
            with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", side_effect=ready_then_shutdown):
                with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", return_value=bridge) as popen:
                    assert run_supervised(
                        python="/opt/hermes-python",
                        policy="/tmp/policy.json",
                        remnic_bin="/opt/remnic-server",
                        port=4329,
                    ) == 0

    assert popen.call_count == 1
    assert bridge.received_signals == [signal.SIGTERM]
