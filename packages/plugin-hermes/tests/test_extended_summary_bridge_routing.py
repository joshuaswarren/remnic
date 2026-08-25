"""Regression: extended hourly summaries must reach the Hermes bridge (issue #2955)."""

from __future__ import annotations

from pathlib import Path


_SUMMARIZER = Path(__file__).resolve().parents[2] / "remnic-core" / "src" / "summarizer.ts"


def test_generate_extended_routes_through_background_generation() -> None:
    """generateExtended used to return before the backgroundGeneration block."""
    source = _SUMMARIZER.read_text(encoding="utf-8")
    start = source.index("private async generateExtended(")
    end = source.index("private async generateWithLocalLlm(")
    body = source[start:end]
    assert "completeBackgroundGeneration" in body
    assert body.index("completeBackgroundGeneration") < body.index("this.shouldUseLocalLlm")
    assert "HourlySummaryExtendedSchema" in body
