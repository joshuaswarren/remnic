"""Configuration loading for the Remnic Hermes plugin."""

from __future__ import annotations

import json
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

        return cls(
            host=str(section.get("host", _read_compat_env("REMNIC_HOST", "ENGRAM_HOST", "127.0.0.1"))),
            port=int(section.get("port", _read_compat_env("REMNIC_PORT", "ENGRAM_PORT", "4318"))),
            token=token,
            session_key=str(section.get("session_key", "")),
            timeout=float(section.get("timeout", 30.0)),
        )


# Legacy class alias — import path compat for pre-rename consumers.
EngramHermesConfig = RemnicHermesConfig


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
