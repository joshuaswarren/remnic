"""Packaging tests for the Hermes LLM bridge commands."""

from __future__ import annotations

from pathlib import Path

try:  # Python 3.11+
    import tomllib
except ModuleNotFoundError:  # Python 3.10 package support
    import tomli as tomllib


def test_plugin_manifest_version_matches_python_package():
    package_root = Path(__file__).parents[1]
    manifest_version = next(
        line.partition(":")[2].strip()
        for line in (package_root / "plugin.yaml").read_text(encoding="utf-8").splitlines()
        if line.startswith("version:")
    )
    project = tomllib.loads((package_root / "pyproject.toml").read_text(encoding="utf-8"))

    assert manifest_version == project["project"]["version"]


def test_plugin_exports_loopback_bridge_and_lifecycle_supervisor_commands():
    """Operators can start the reviewed bridge without importing a private module path."""
    project = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    assert project["project"]["scripts"] == {
        "remnic-hermes-bridge": "remnic_hermes.hermes_llm_bridge:main",
        "remnic-hermes-supervisor": "remnic_hermes.hermes_llm_supervisor:main",
    }
