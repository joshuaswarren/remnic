"""Packaging tests for the Hermes LLM bridge commands."""

from __future__ import annotations

from pathlib import Path
import tomllib


def test_plugin_exports_loopback_bridge_and_lifecycle_supervisor_commands():
    """Operators can start the reviewed bridge without importing a private module path."""
    project = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    assert project["project"]["scripts"] == {
        "remnic-hermes-bridge": "remnic_hermes.hermes_llm_bridge:main",
        "remnic-hermes-supervisor": "remnic_hermes.hermes_llm_supervisor:main",
    }
