"""Tests for Hermes client JSON -> Remnic backgroundGeneration translation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from remnic_hermes.background_generation import (
    load_background_generation,
    translate_background_generation,
)


def test_translate_maps_hermes_client_shape() -> None:
    translated = translate_background_generation(
        {
            "endpoint": "http://127.0.0.1:8765/v1/chat/completions",
            "health_endpoint": "http://127.0.0.1:8765/healthz",
            "bind": "127.0.0.1",
            "model_policy": "server-owned",
            "max_body_bytes": 524288,
            "timeout_seconds": 45,
            "token": "bridge-token-fixture",
        }
    )
    assert translated == {
        "endpoint": "http://127.0.0.1:8765/v1/chat/completions",
        "token": "bridge-token-fixture",
        "timeoutSeconds": 45,
    }


def test_translate_prefers_timeout_seconds_camel_case() -> None:
    translated = translate_background_generation(
        {
            "endpoint": "http://127.0.0.1:8765/v1/chat/completions",
            "token": "bridge-token-fixture",
            "timeoutSeconds": 30,
            "timeout_seconds": 45,
        }
    )
    assert translated["timeoutSeconds"] == 30


def test_load_reads_hermes_client_file(tmp_path: Path) -> None:
    path = tmp_path / "client.json"
    path.write_text(
        json.dumps(
            {
                "endpoint": "http://127.0.0.1:8765/v1/chat/completions",
                "token": "bridge-token-fixture",
                "timeout_seconds": 120,
            }
        ),
        encoding="utf-8",
    )
    assert load_background_generation(path) == {
        "endpoint": "http://127.0.0.1:8765/v1/chat/completions",
        "token": "bridge-token-fixture",
        "timeoutSeconds": 120,
    }


@pytest.mark.parametrize(
    ("payload", "match"),
    [
        ({"token": "bridge-token-fixture"}, "endpoint"),
        ({"endpoint": "http://127.0.0.1:8765/v1/chat/completions"}, "token"),
        (
            {
                "endpoint": "http://127.0.0.1:8765/v1/chat/completions",
                "token": "bridge-token-fixture",
                "timeout_seconds": "fast",
            },
            "timeoutSeconds",
        ),
    ],
)
def test_translate_rejects_invalid_client_objects(payload: dict[str, Any], match: str) -> None:
    with pytest.raises(ValueError, match=match):
        translate_background_generation(payload)


def test_load_rejects_unreadable_path(tmp_path: Path) -> None:
    missing = tmp_path / "missing-client.json"
    with pytest.raises(ValueError, match="could not be read"):
        load_background_generation(missing)
