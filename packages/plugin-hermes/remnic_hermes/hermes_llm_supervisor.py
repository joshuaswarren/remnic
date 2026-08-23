"""Run a Remnic daemon and its Hermes LLM bridge as one lifecycle unit."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping
import hashlib
import hmac
import os
import secrets
import signal
import subprocess
import time
from urllib.request import Request, urlopen


_REQUEST_TOKEN_ENV = "REMNIC_HERMES_BRIDGE_TOKEN"
_READY_TOKEN_ENV = "REMNIC_HERMES_BRIDGE_READY_TOKEN"
_DAEMON_ENV_KEYS = frozenset(
    {
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "PATH",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    }
)
_DAEMON_ENV_PREFIXES = ("REMNIC_", "ENGRAM_")
_DAEMON_EXCLUDED_ENV_KEYS = frozenset({_READY_TOKEN_ENV})


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
            "--readiness-token-env",
            _READY_TOKEN_ENV,
        ],
        [remnic_bin],
    )


def _daemon_environment(parent: Mapping[str, str], request_token: str) -> dict[str, str]:
    """Give Remnic runtime basics and supported Remnic/Engram settings, never provider env."""
    if not request_token:
        raise ValueError("bridge request token is required")
    environment = {
        key: value
        for key, value in parent.items()
        if (
            key in _DAEMON_ENV_KEYS
            or (key.startswith(_DAEMON_ENV_PREFIXES) and key not in _DAEMON_EXCLUDED_ENV_KEYS)
        )
        and value
    }
    environment[_REQUEST_TOKEN_ENV] = request_token
    return environment


def _wait_for_bridge(
    port: int,
    ready_token: str,
    seconds: float = 10,
    *,
    is_stopping: Callable[[], bool],
) -> bool:
    """Require a nonce-authenticated readiness response from this bridge instance."""
    deadline = time.monotonic() + seconds
    challenge = secrets.token_urlsafe(32)
    expected_proof = hmac.new(
        ready_token.encode("utf-8"),
        challenge.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    while time.monotonic() < deadline:
        if is_stopping():
            return False
        request = Request(
            f"http://127.0.0.1:{port}/healthz",
            headers={"X-Remnic-Bridge-Challenge": challenge},
        )
        try:
            with urlopen(request, timeout=0.25) as response:  # noqa: S310 -- fixed loopback URL
                proof = response.headers.get("X-Remnic-Bridge-Proof", "")
                if response.status == 204 and hmac.compare_digest(proof, expected_proof):
                    return True
        except OSError:
            pass
        if is_stopping():
            return False
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


def _forward_signal(process: subprocess.Popen[str] | None, signum: int) -> None:
    """Forward a supervisor signal while preserving its meaning for the child."""
    if process is None or process.poll() is not None:
        return
    process.send_signal(signum)


def _wait_for_graceful_exit(
    processes: tuple[subprocess.Popen[str] | None, ...],
    *,
    seconds: float = 8,
) -> None:
    """Allow concurrently signaled children one shared grace window before fallback stop."""
    deadline = time.monotonic() + seconds
    for process in processes:
        if process is None or process.poll() is not None:
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        try:
            process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            continue


def _wait_for_children(
    bridge: subprocess.Popen[str],
    daemon: subprocess.Popen[str],
    *,
    is_stopping: Callable[[], bool],
) -> int:
    """Treat an unexpected child exit as a failed lifecycle unit and stop its peer."""
    while True:
        if is_stopping():
            return 0
        if bridge.poll() is not None:
            _stop(daemon)
            return 70
        if daemon.poll() is not None:
            _stop(bridge)
            return 70
        time.sleep(0.1)


def run_supervised(*, python: str, policy: str, remnic_bin: str, port: int) -> int:
    """Start the bridge before the daemon and stop both on all exit paths."""
    ready_token = secrets.token_urlsafe(32)
    request_token = secrets.token_urlsafe(32)
    bridge_env = os.environ.copy()
    bridge_env[_REQUEST_TOKEN_ENV] = request_token
    bridge_env[_READY_TOKEN_ENV] = ready_token
    daemon_env = _daemon_environment(os.environ, request_token)
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
    starting_bridge = False
    starting_daemon = False
    bridge_start_signals: list[int] = []
    daemon_start_signals: list[int] = []

    def request_stop(signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True
        if starting_daemon:
            daemon_start_signals.append(signum)
        else:
            _forward_signal(daemon, signum)
        if starting_bridge:
            bridge_start_signals.append(signum)
        else:
            _forward_signal(bridge, signum)

    old_term = signal.signal(signal.SIGTERM, request_stop)
    old_int = signal.signal(signal.SIGINT, request_stop)
    try:
        starting_bridge = True
        try:
            bridge = subprocess.Popen(bridge_cmd, text=True, env=bridge_env)
        finally:
            starting_bridge = False
        for signum in bridge_start_signals:
            _forward_signal(bridge, signum)
        if not _wait_for_bridge(port, ready_token, is_stopping=lambda: stopping):
            return 0 if stopping else 70
        if stopping:
            return 0
        starting_daemon = True
        try:
            daemon = subprocess.Popen(remnic_cmd, text=True, env=daemon_env)
        finally:
            starting_daemon = False
        for signum in daemon_start_signals:
            _forward_signal(daemon, signum)
        if stopping:
            return 0
        return _wait_for_children(bridge, daemon, is_stopping=lambda: stopping)
    finally:
        if stopping:
            _wait_for_graceful_exit((daemon, bridge))
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
