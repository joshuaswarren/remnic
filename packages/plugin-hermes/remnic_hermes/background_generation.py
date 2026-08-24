"""Translate Hermes loopback client JSON into Remnic backgroundGeneration."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path


def translate_background_generation(client: Mapping[str, object]) -> dict[str, object]:
    """Map a Hermes client-config object to the Remnic backgroundGeneration contract."""
    endpoint = client.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise ValueError("client config must include an endpoint")
    token = client.get("token")
    if not isinstance(token, str) or not token:
        raise ValueError("client config must include a token")
    timeout_raw = client.get("timeoutSeconds", client.get("timeout_seconds", 120))
    if isinstance(timeout_raw, bool) or not isinstance(timeout_raw, (int, float)):
        raise ValueError("timeoutSeconds must be a finite number > 0")
    timeout = float(timeout_raw)
    if timeout != timeout or timeout <= 0:
        raise ValueError("timeoutSeconds must be a finite number > 0")
    return {
        "endpoint": endpoint.strip(),
        "token": token,
        "timeoutSeconds": int(timeout_raw) if isinstance(timeout_raw, int) else timeout,
    }


def load_background_generation(path: str | Path) -> dict[str, object]:
    """Read a Hermes client JSON file and return Remnic backgroundGeneration fields."""
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise ValueError(f"Hermes client config could not be read: {path}") from err
    if not isinstance(parsed, dict):
        raise ValueError("Hermes client config must be an object")
    return translate_background_generation(parsed)
