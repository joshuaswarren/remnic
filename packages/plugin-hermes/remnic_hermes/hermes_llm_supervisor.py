"""Run a Remnic daemon and its Hermes LLM bridge as one lifecycle unit."""

from __future__ import annotations

import argparse
import os
import secrets
import signal
import subprocess
import time
from urllib.request import Request, urlopen


_REQUEST_TOKEN_ENV = "REMNIC_HERMES_BRIDGE_TOKEN"


def build_child_commands(
    *,
    python: str,
    policy: str,
    remnic_bin: str,
    port: int,
    ready_token: str,
) -> tuple[list[str], list[str]]:
    """Build argv-only child commands for a loopback bridge and Remnic daemon."""
    if not python or not policy or not remnic_bin or not ready_token:
        raise ValueError("python, policy, remnic_bin, and ready_token are required")
    if not 1 <= port <= 65535:
        raise ValueError("bridge port out of range")
    return (
        [
            python,
            "-m",
            "remnic_hermes.hermes_llm_bridge",
            "--policy",
            policy,
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--request-token-env",
            _REQUEST_TOKEN_ENV,
            "--ready-token",
            ready_token,
        ],
        [remnic_bin],
    )


def _wait_for_bridge(port: int, ready_token: str, seconds: float = 10) -> bool:
    """Require a nonce-authenticated readiness response from this bridge instance."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        request = Request(
            f"http://127.0.0.1:{port}/healthz",
            headers={"X-Remnic-Bridge-Ready": ready_token},
        )
        try:
            with urlopen(request, timeout=0.25) as response:  # noqa: S310 -- fixed loopback URL
                if response.status == 204:
                    return True
        except OSError:
            pass
        time.sleep(0.1)
    return False


def _stop(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=4)


def run_supervised(*, python: str, policy: str, remnic_bin: str, port: int) -> int:
    """Start the bridge before the daemon and stop both on all exit paths."""
    ready_token = secrets.token_urlsafe(32)
    request_token = secrets.token_urlsafe(32)
    child_env = os.environ.copy()
    child_env[_REQUEST_TOKEN_ENV] = request_token
    bridge_cmd, remnic_cmd = build_child_commands(
        python=python,
        policy=policy,
        remnic_bin=remnic_bin,
        port=port,
        ready_token=ready_token,
    )
    bridge: subprocess.Popen[str] | None = None
    daemon: subprocess.Popen[str] | None = None
    stopping = False

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True
        _stop(daemon)
        _stop(bridge)

    old_term = signal.signal(signal.SIGTERM, request_stop)
    old_int = signal.signal(signal.SIGINT, request_stop)
    try:
        bridge = subprocess.Popen(bridge_cmd, text=True, env=child_env)
        if not _wait_for_bridge(port, ready_token):
            return 70
        daemon = subprocess.Popen(remnic_cmd, text=True, env=child_env)
        assert daemon is not None
        status = daemon.wait()
        return 0 if stopping else status
    finally:
        _stop(daemon)
        _stop(bridge)
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGINT, old_int)


def main() -> None:
    parser = argparse.ArgumentParser(description="Supervise Remnic and its loopback Hermes LLM bridge")
    parser.add_argument("--python", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--remnic-bin", required=True)
    parser.add_argument("--port", type=int, default=4329)
    args = parser.parse_args()
    raise SystemExit(
        run_supervised(
            python=args.python,
            policy=args.policy,
            remnic_bin=args.remnic_bin,
            port=args.port,
        )
    )


if __name__ == "__main__":
    main()
