"""Tests for the Remnic daemon and Hermes bridge lifecycle supervisor."""

from __future__ import annotations

import os
import signal
from unittest.mock import patch

import pytest


_REQUEST_TOKEN_ENV = "REMNIC_HERMES_BRIDGE_TOKEN"
_READY_TOKEN_ENV = "REMNIC_HERMES_BRIDGE_READY_TOKEN"


class Process:
    def __init__(self, *, returncode: int | None = None) -> None:
        self.returncode = returncode
        self.terminate_calls = 0
        self.received_signals: list[int] = []
        self.wait_timeouts: list[float | None] = []

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        self.wait_timeouts.append(timeout)
        self.returncode = 0
        return 0

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = 0

    def send_signal(self, signum: int) -> None:
        self.received_signals.append(signum)


class ReadinessResponse:
    def __init__(self, proof: str = "") -> None:
        self.status = 204
        self.headers = {"X-Remnic-Bridge-Proof": proof}

    def __enter__(self) -> "ReadinessResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


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
        "--readiness-token-env",
        _READY_TOKEN_ENV,
    ]
    assert popen.call_args_list[1].args[0] == ["/opt/remnic-server"]
    bridge_env = popen.call_args_list[0].kwargs["env"]
    daemon_env = popen.call_args_list[1].kwargs["env"]
    assert bridge_env[_REQUEST_TOKEN_ENV] == "first-request-token"
    assert bridge_env[_READY_TOKEN_ENV] == "first-ready-token"
    assert daemon_env[_REQUEST_TOKEN_ENV] == "first-request-token"
    assert bridge_env["OPENAI_API_KEY"] == "provider-key-must-not-reach-daemon"
    assert "OPENAI_API_KEY" not in daemon_env
    assert "XAI_API_KEY" not in daemon_env
    assert daemon_env["PATH"] == "/usr/bin:/bin"
    assert daemon_env["HOME"] == "/tmp/hermes-home"
    assert "first-request-token" not in popen.call_args_list[0].args[0]
    assert "first-ready-token" not in popen.call_args_list[0].args[0]
    assert _READY_TOKEN_ENV not in daemon_env
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
    assert popen.call_args_list[0].args[0][-2:] == ["--readiness-token-env", _READY_TOKEN_ENV]
    assert popen.call_args_list[0].kwargs["env"][_REQUEST_TOKEN_ENV] == "unique-request-token"
    assert popen.call_args_list[0].kwargs["env"][_READY_TOKEN_ENV] == "unique-ready-token"


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
    assert daemon.terminate_calls == 0
    assert bridge.terminate_calls == 0


def test_supervisor_does_not_start_the_daemon_if_shutdown_arrives_after_readiness():
    """A shutdown signal in the bridge-to-daemon gap cannot launch a new child."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    handlers: dict[int, object] = {}

    def register(received_signum: int, handler: object) -> object:
        handlers[received_signum] = handler
        return signal.SIG_DFL

    def ready_then_shutdown(*_args: object, **_kwargs: object) -> bool:
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


def test_supervisor_rechecks_shutdown_after_marking_daemon_start():
    """A signal in the daemon-start transition cannot launch an unsignaled daemon."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    handlers: dict[int, object] = {}

    def register(received_signum: int, handler: object) -> object:
        handlers[received_signum] = handler
        return signal.SIG_DFL

    class SignalOnSet:
        def __init__(self) -> None:
            self.active = False
            self.clear_calls = 0

        def set(self) -> None:
            self.active = True
            handler = handlers[signal.SIGTERM]
            assert callable(handler)
            handler(signal.SIGTERM, None)

        def is_set(self) -> bool:
            return self.active

        def clear(self) -> None:
            self.active = False
            self.clear_calls += 1

    daemon_start = SignalOnSet()
    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["ready-token", "request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor.signal.signal", side_effect=register):
            with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True):
                with patch("remnic_hermes.hermes_llm_supervisor.threading.Event", return_value=daemon_start):
                    with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", return_value=bridge) as popen:
                        assert run_supervised(
                            python="/opt/hermes-python",
                            policy="/tmp/policy.json",
                            remnic_bin="/opt/remnic-server",
                            port=4329,
                        ) == 0

    assert popen.call_count == 1
    assert bridge.received_signals == [signal.SIGTERM]
    assert daemon_start.clear_calls == 1


def test_supervisor_interrupts_readiness_when_shutdown_arrives():
    """A shutdown during bridge startup does not wait out the full readiness timeout."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    handlers: dict[int, object] = {}

    def register(received_signum: int, handler: object) -> object:
        handlers[received_signum] = handler
        return signal.SIG_DFL

    def stop_aware_readiness(
        _port: int,
        _ready_token: str,
        _seconds: float = 10,
        *,
        is_stopping: object,
    ) -> bool:
        handler = handlers[signal.SIGTERM]
        assert callable(handler)
        handler(signal.SIGTERM, None)
        assert callable(is_stopping)
        return not is_stopping()

    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["ready-token", "request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor.signal.signal", side_effect=register):
            with patch(
                "remnic_hermes.hermes_llm_supervisor._wait_for_bridge",
                side_effect=stop_aware_readiness,
            ):
                with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", return_value=bridge) as popen:
                    assert run_supervised(
                        python="/opt/hermes-python",
                        policy="/tmp/policy.json",
                        remnic_bin="/opt/remnic-server",
                        port=4329,
                    ) == 0

    assert popen.call_count == 1
    assert bridge.received_signals == [signal.SIGTERM]
    assert bridge.terminate_calls == 0


@pytest.mark.parametrize("signum", [signal.SIGINT, signal.SIGTERM])
def test_supervisor_replays_a_shutdown_signal_received_while_starting_the_bridge(signum: int):
    """A bridge created during Popen still receives the shutdown signal that raced it."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    handlers: dict[int, object] = {}

    def register(received_signum: int, handler: object) -> object:
        handlers[received_signum] = handler
        return signal.SIG_DFL

    def bridge_start_with_shutdown(*_args: object, **_kwargs: object) -> Process:
        handler = handlers[signum]
        assert callable(handler)
        handler(signum, None)
        return bridge

    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["ready-token", "request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor.signal.signal", side_effect=register):
            with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True):
                with patch(
                    "remnic_hermes.hermes_llm_supervisor.subprocess.Popen",
                    side_effect=bridge_start_with_shutdown,
                ) as popen:
                    assert run_supervised(
                        python="/opt/hermes-python",
                        policy="/tmp/policy.json",
                        remnic_bin="/opt/remnic-server",
                        port=4329,
                    ) == 0

    assert popen.call_count == 1
    assert bridge.received_signals == [signum]


@pytest.mark.parametrize("signum", [signal.SIGINT, signal.SIGTERM])
def test_supervisor_replays_a_shutdown_signal_received_while_starting_the_daemon(signum: int):
    """A daemon created during Popen still receives the shutdown signal that raced it."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    bridge = Process()
    daemon = Process()
    handlers: dict[int, object] = {}
    launches = 0

    def register(received_signum: int, handler: object) -> object:
        handlers[received_signum] = handler
        return signal.SIG_DFL

    def launch_child(*_args: object, **_kwargs: object) -> Process:
        nonlocal launches
        launches += 1
        if launches == 1:
            return bridge
        handler = handlers[signum]
        assert callable(handler)
        handler(signum, None)
        return daemon

    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["ready-token", "request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor.signal.signal", side_effect=register):
            with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True):
                with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", side_effect=launch_child) as popen:
                    assert run_supervised(
                        python="/opt/hermes-python",
                        policy="/tmp/policy.json",
                        remnic_bin="/opt/remnic-server",
                        port=4329,
                    ) == 0

    assert popen.call_count == 2
    assert bridge.received_signals == [signum]
    assert daemon.received_signals == [signum]


def test_daemon_environment_preserves_documented_remnic_runtime_settings_without_provider_env():
    """Daemon routing and storage settings survive credential isolation unchanged."""
    from remnic_hermes.hermes_llm_supervisor import _daemon_environment

    parent_env = {
        "HOME": "/tmp/remnic-home",
        "PATH": "/usr/bin:/bin",
        "REMNIC_CONFIG_PATH": "/tmp/remnic.json",
        "ENGRAM_CONFIG_PATH": "/tmp/engram.json",
        "REMNIC_MEMORY_DIR": "/tmp/remnic-memory",
        "ENGRAM_MEMORY_DIR": "/tmp/engram-memory",
        "REMNIC_AUTH_TOKEN": "remnic-daemon-token",
        "ENGRAM_AUTH_TOKEN": "engram-daemon-token",
        "REMNIC_HOST": "127.0.0.1",
        "ENGRAM_HOST": "127.0.0.1",
        "REMNIC_PORT": "4318",
        "ENGRAM_PORT": "4319",
        "REMNIC_OAUTH_CLIENT_SECRET": "oauth-client-secret",
        "ENGRAM_ADMIN_CONSOLE_ENABLED": "true",
        "REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS": "1800",
        "REMNIC_HERMES_BRIDGE_READY_TOKEN": "ready-secret-must-not-reach-daemon",
        "OPENAI_API_KEY": "provider-key-must-not-reach-daemon",
        "XAI_API_KEY": "other-provider-key-must-not-reach-daemon",
    }

    daemon_env = _daemon_environment(parent_env, "bridge-request-token")

    for key in (
        "REMNIC_CONFIG_PATH",
        "ENGRAM_CONFIG_PATH",
        "REMNIC_MEMORY_DIR",
        "ENGRAM_MEMORY_DIR",
        "REMNIC_AUTH_TOKEN",
        "ENGRAM_AUTH_TOKEN",
        "REMNIC_HOST",
        "ENGRAM_HOST",
        "REMNIC_PORT",
        "ENGRAM_PORT",
        "REMNIC_OAUTH_CLIENT_SECRET",
        "ENGRAM_ADMIN_CONSOLE_ENABLED",
        "REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS",
    ):
        assert daemon_env[key] == parent_env[key]
    assert daemon_env[_REQUEST_TOKEN_ENV] == "bridge-request-token"
    assert _READY_TOKEN_ENV not in daemon_env
    assert "OPENAI_API_KEY" not in daemon_env
    assert "XAI_API_KEY" not in daemon_env


def test_readiness_probe_rejects_a_port_squatter_that_returns_only_204():
    """A bridge is ready only when its response proves knowledge of the launch secret."""
    from remnic_hermes.hermes_llm_supervisor import _wait_for_bridge

    with patch("remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe", return_value="challenge"):
        with patch("remnic_hermes.hermes_llm_supervisor.urlopen", return_value=ReadinessResponse()) as open_url:
            with patch("remnic_hermes.hermes_llm_supervisor.time.monotonic", side_effect=[0.0, 0.0, 11.0]):
                with patch("remnic_hermes.hermes_llm_supervisor.time.sleep"):
                    assert not _wait_for_bridge(4329, "readiness-secret", is_stopping=lambda: False)

    request = open_url.call_args.args[0]
    assert request.headers["X-remnic-bridge-challenge"] == "challenge"
    assert "readiness-secret" not in request.headers.values()
