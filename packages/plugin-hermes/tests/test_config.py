"""Tests for remnic_hermes config module."""

import json

from remnic_hermes import EngramHermesConfig
from remnic_hermes.config import RemnicHermesConfig, _load_token_from_file


def test_default_config():
    """RemnicHermesConfig has sensible defaults."""
    config = RemnicHermesConfig()
    assert config.host == "127.0.0.1"
    assert config.port == 4318
    assert config.token == ""
    assert config.timeout == 30.0


def test_custom_config():
    """RemnicHermesConfig accepts custom host/port."""
    config = RemnicHermesConfig(host="192.168.1.1", port=9999)
    assert config.host == "192.168.1.1"
    assert config.port == 9999


def test_from_hermes_config_empty():
    """from_hermes_config handles empty config dict."""
    config = RemnicHermesConfig.from_hermes_config({})
    assert config.host == "127.0.0.1"
    assert config.port == 4318


def test_from_hermes_config_prefers_remnic_section():
    """Remnic-keyed Hermes config blocks are unwrapped before legacy fallbacks."""
    config = RemnicHermesConfig.from_hermes_config(
        {
            "remnic": {
                "host": "10.0.0.5",
                "port": 9001,
                "token": "remnic-token",
                "session_key": "sess-123",
                "timeout": 12.5,
            }
        }
    )
    assert config.host == "10.0.0.5"
    assert config.port == 9001
    assert config.token == "remnic-token"
    assert config.session_key == "sess-123"
    assert config.timeout == 12.5


def test_from_hermes_config_falls_back_to_engram_section():
    """Legacy engram-keyed Hermes config blocks still unwrap when remnic key is absent."""
    config = RemnicHermesConfig.from_hermes_config(
        {
            "engram": {
                "host": "10.0.0.9",
                "port": 9002,
                "token": "engram-token",
            }
        }
    )
    assert config.host == "10.0.0.9"
    assert config.port == 9002
    assert config.token == "engram-token"


def test_load_token_prefers_remnic_store(monkeypatch, tmp_path):
    """Fresh Remnic installs read ~/.remnic/tokens.json before legacy fallback."""
    monkeypatch.setenv("HOME", str(tmp_path))
    remnic_dir = tmp_path / ".remnic"
    remnic_dir.mkdir()
    engram_dir = tmp_path / ".engram"
    engram_dir.mkdir()

    (remnic_dir / "tokens.json").write_text(
        json.dumps({"tokens": [{"connector": "hermes", "token": "remnic-token"}]}),
        encoding="utf-8",
    )
    (engram_dir / "tokens.json").write_text(
        json.dumps({"tokens": [{"connector": "hermes", "token": "engram-token"}]}),
        encoding="utf-8",
    )

    assert _load_token_from_file() == "remnic-token"


def test_load_token_falls_back_to_legacy_store(monkeypatch, tmp_path):
    """Legacy token store still works when the Remnic path does not exist yet."""
    monkeypatch.setenv("HOME", str(tmp_path))
    engram_dir = tmp_path / ".engram"
    engram_dir.mkdir()
    (engram_dir / "tokens.json").write_text(
        json.dumps({"tokens": [{"connector": "hermes", "token": "engram-token"}]}),
        encoding="utf-8",
    )

    assert _load_token_from_file() == "engram-token"


def test_load_token_treats_malformed_entries_as_absent(monkeypatch, tmp_path):
    """Malformed token stores and entries do not crash or stringify null tokens."""
    monkeypatch.setenv("HOME", str(tmp_path))
    remnic_dir = tmp_path / ".remnic"
    remnic_dir.mkdir()
    engram_dir = tmp_path / ".engram"
    engram_dir.mkdir()

    (remnic_dir / "tokens.json").write_text(
        json.dumps(
            {
                "tokens": [
                    None,
                    "bad-entry",
                    {"connector": "hermes", "token": None},
                    {"connector": "openclaw", "token": 123},
                ]
            }
        ),
        encoding="utf-8",
    )
    (engram_dir / "tokens.json").write_text(json.dumps(None), encoding="utf-8")

    assert _load_token_from_file() == ""


def test_engram_hermes_config_is_alias():
    """The legacy EngramHermesConfig name resolves to RemnicHermesConfig."""
    assert EngramHermesConfig is RemnicHermesConfig
