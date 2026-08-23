"""Tests for the Remnic daemon and Hermes bridge lifecycle supervisor."""

from __future__ import annotations

from unittest.mock import patch


_REQUEST_TOKEN_ENV = "REMNIC_HERMES_BRIDGE_TOKEN"


def test_supervisor_starts_the_daemon_after_the_loopback_bridge_and_stops_the_bridge():
    """A daemon never runs unless its authenticated loopback bridge is ready first."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    class Process:
        def __init__(self, wait_result: int = 0) -> None:
            self.returncode: int | None = None
            self.wait_result = wait_result
            self.terminate_calls = 0

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            self.returncode = self.wait_result
            return self.wait_result

        def terminate(self) -> None:
            self.terminate_calls += 1
            self.returncode = 0

        def kill(self) -> None:
            self.returncode = 0

    bridge = Process()
    daemon = Process(wait_result=0)
    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["first-ready-token", "first-request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor.subprocess.Popen", side_effect=[bridge, daemon]) as popen:
            with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True):
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
    assert "first-request-token" not in popen.call_args_list[0].args[0]
    assert bridge.terminate_calls == 1


def test_supervisor_passes_an_instance_secret_to_the_readiness_probe_before_daemon_start():
    """A different loopback listener cannot satisfy the bridge readiness check."""
    from remnic_hermes.hermes_llm_supervisor import run_supervised

    class Process:
        def __init__(self, wait_result: int = 0) -> None:
            self.returncode: int | None = None
            self.wait_result = wait_result

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            self.returncode = self.wait_result
            return self.wait_result

        def terminate(self) -> None:
            self.returncode = 0

        def kill(self) -> None:
            self.returncode = 0

    bridge = Process()
    daemon = Process()
    with patch(
        "remnic_hermes.hermes_llm_supervisor.secrets.token_urlsafe",
        side_effect=["unique-ready-token", "unique-request-token"],
    ):
        with patch("remnic_hermes.hermes_llm_supervisor._wait_for_bridge", return_value=True) as wait_for_bridge:
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

    class Process:
        returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            self.returncode = 0

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            return 0

        def kill(self) -> None:
            self.returncode = 0

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
