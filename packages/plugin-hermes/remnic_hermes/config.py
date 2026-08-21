"""Configuration loading for the Remnic Hermes plugin."""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass


@dataclass
class RemnicHermesConfig:
    """Configuration for the Remnic Hermes MemoryProvider."""

    host: str = "127.0.0.1"
    port: int = 4318
    token: str = ""
    session_key: str = ""
    timeout: float = 30.0
    prefetch_wait_timeout: float = 2.0
    client_id: str = ""
    allow_insecure_http: bool = False

    @classmethod
    def from_hermes_config(cls, config: dict[str, object]) -> RemnicHermesConfig:
        """Load from the Remnic config section (already extracted by the register() caller).

        Accepts either the top-level Hermes config (with 'remnic' or legacy
        'engram' key) or the pre-extracted section directly.
        """
        # Support top-level config wrappers plus pre-extracted sections.
        remnic_candidate = config.get("remnic")
        engram_candidate = config.get("engram")
        if isinstance(remnic_candidate, dict):
            section = remnic_candidate
        elif isinstance(engram_candidate, dict):
            section = engram_candidate
        else:
            section = config

        token = str(section.get("token", ""))
        if not token:
            token = _load_token_from_file()

        client_id_value = section.get("client_id", "")
        namespace_value = section.get("namespace", "")
        if not isinstance(client_id_value, str):
            raise TypeError(f"remnic client_id must be a string, got {client_id_value!r}")
        if not isinstance(namespace_value, str):
            raise TypeError(f"remnic namespace must be a string, got {namespace_value!r}")
        client_id = client_id_value.strip() or namespace_value.strip()
        allow_insecure_http = _parse_bool(
            "allow_insecure_http",
            section.get("allow_insecure_http", False),
        )
        return cls(
            host=str(section.get("host", _read_compat_env("REMNIC_HOST", "ENGRAM_HOST", "127.0.0.1"))),
            port=int(section.get("port", _read_compat_env("REMNIC_PORT", "ENGRAM_PORT", "4318"))),
            token=token,
            session_key=str(section.get("session_key", "")).strip(),
            timeout=float(section.get("timeout", 30.0)),
            prefetch_wait_timeout=_parse_prefetch_wait_timeout(section.get("prefetch_wait_timeout", 2.0)),
            client_id=client_id,
            allow_insecure_http=allow_insecure_http,
        )


# Legacy class alias — import path compat for pre-rename consumers.
EngramHermesConfig = RemnicHermesConfig


def _parse_prefetch_wait_timeout(raw: object) -> float:
    """Parse and validate prefetch_wait_timeout: a finite float >= 0.

    0 disables synchronous waiting entirely (prefetch becomes fire-and-forget:
    it queues the recall and only ever returns cached results).
    """
    value = float(raw)  # type: ignore[arg-type]
    if not math.isfinite(value) or value < 0:
        raise ValueError(
            f"remnic prefetch_wait_timeout must be a finite number >= 0, got {raw!r}"
        )
    return value


def _parse_bool(field: str, raw: object) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        normalized = raw.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    raise ValueError(f"remnic {field} must be a boolean, got {raw!r}")


def _read_compat_env(primary: str, legacy: str, default: str) -> str:
    return os.environ.get(primary) or os.environ.get(legacy) or default


def _load_token_from_file() -> str:
    """Load the hermes token from the Remnic token store with Engram fallback.

    Token store format: {tokens: [{token, connector, createdAt}]}
    """
    for token_path in (
        os.path.expanduser("~/.remnic/tokens.json"),
        os.path.expanduser("~/.engram/tokens.json"),
    ):
        if not os.path.exists(token_path):
            continue
        try:
            with open(token_path) as f:
                store = json.load(f)
                if not isinstance(store, dict):
                    continue
                # New array format: {tokens: [{token, connector, createdAt}]}
                token_entries = store.get("tokens", [])
                if isinstance(token_entries, list):
                    for entry in token_entries:
                        if not isinstance(entry, dict):
                            continue
                        token = entry.get("token")
                        if entry.get("connector") == "hermes" and isinstance(token, str) and token:
                            return token
                    for entry in token_entries:
                        if not isinstance(entry, dict):
                            continue
                        token = entry.get("token")
                        if entry.get("connector") == "openclaw" and isinstance(token, str) and token:
                            return token
                # Legacy flat-map format: {"hermes": "token_value", "openclaw": "..."}
                for key in ("hermes", "openclaw"):
                    val = store.get(key, "")
                    if isinstance(val, str) and val:
                        return val
        except (json.JSONDecodeError, OSError, TypeError):
            continue
    return ""
