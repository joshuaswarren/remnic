"""Codex CLI LLM provider for vectorize-io/agent-memory-benchmark.

Install this file into the public AMB checkout as:

    src/memory_bench/llm/codex_cli.py

This provider is intended for local iteration runs where AMB answer generation
and judging should go through the operator's configured Codex CLI auth instead
of a direct API key.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from .base import LLM, Schema


_DEFAULT_MODEL = "gpt-5.5"
_DEFAULT_REASONING_EFFORT = "xhigh"
_DEFAULT_TIMEOUT_SECONDS = 900
_MAX_RETRIES = 3
_RETRY_BASE_DELAY_SECONDS = 5


class CodexCliLLM(LLM):
    def __init__(self, model: str = _DEFAULT_MODEL):
        self._model = model or _DEFAULT_MODEL
        self._reasoning_effort = os.environ.get(
            "OMB_CODEX_REASONING_EFFORT",
            _DEFAULT_REASONING_EFFORT,
        )
        self._timeout_seconds = _parse_positive_float(
            os.environ.get("OMB_CODEX_TIMEOUT_SECONDS"),
            _DEFAULT_TIMEOUT_SECONDS,
            "OMB_CODEX_TIMEOUT_SECONDS",
        )
        self._executable = (
            os.environ.get("OMB_CODEX_EXECUTABLE")
            or os.environ.get("REMNIC_BENCH_CODEX_CLI_EXECUTABLE")
            or "codex"
        )
        self._cwd = os.environ.get("OMB_CODEX_CWD") or os.environ.get("REMNIC_REPO_PATH")

    @property
    def model_id(self) -> str:
        return f"codex_cli:{self._model}:{self._reasoning_effort}"

    def generate(self, prompt: str, schema: Schema) -> dict:
        schema_json = _json_schema_from_amb_schema(schema)
        wrapped_prompt = _wrap_prompt(prompt, schema_json)
        delay = _RETRY_BASE_DELAY_SECONDS
        last_exc: Exception | None = None

        for attempt in range(_MAX_RETRIES):
            try:
                return self._generate_once(wrapped_prompt, schema_json)
            except Exception as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES - 1 and _is_retryable(exc):
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise

        raise RuntimeError(f"Codex CLI request failed after {_MAX_RETRIES} retries: {last_exc}")

    def _generate_once(self, prompt: str, schema_json: dict[str, Any]) -> dict:
        with tempfile.TemporaryDirectory(prefix="amb-codex-cli-") as tmp:
            tmp_dir = Path(tmp)
            schema_path = tmp_dir / "schema.json"
            output_path = tmp_dir / "last-message.json"
            schema_path.write_text(json.dumps(schema_json), encoding="utf-8")

            cmd = [
                self._executable,
                "exec",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "-m",
                self._model,
                "--config",
                f'model_reasoning_effort="{self._reasoning_effort}"',
                "--output-schema",
                str(schema_path),
                "--output-last-message",
                str(output_path),
            ]
            if self._cwd:
                cmd.extend(["--cd", self._cwd])
            cmd.append("-")

            result = subprocess.run(
                cmd,
                input=prompt,
                text=True,
                capture_output=True,
                timeout=self._timeout_seconds,
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    "Codex CLI completion failed "
                    f"(exit {result.returncode}): {_summarize_output(result.stderr, result.stdout)}"
                )

            text = output_path.read_text(encoding="utf-8").strip()
            if not text:
                raise RuntimeError(
                    "Codex CLI completion returned no final message: "
                    f"{_summarize_output(result.stderr, result.stdout)}"
                )
            return _parse_json_object(text)


def _parse_positive_float(value: str | None, default: float, label: str) -> float:
    if value is None or value == "":
        return default
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise ValueError(f"{label} must be a finite positive number; received {value!r}")
    return parsed


def _json_schema_from_amb_schema(schema: Schema) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": schema.properties,
        "required": schema.required,
        "additionalProperties": False,
    }


def _wrap_prompt(prompt: str, schema_json: dict[str, Any]) -> str:
    return (
        "Return only a JSON object that validates against this JSON Schema. "
        "Do not include Markdown, code fences, or extra commentary.\n\n"
        f"JSON Schema:\n{json.dumps(schema_json, sort_keys=True)}\n\n"
        f"Task:\n{prompt}"
    )


def _parse_json_object(text: str) -> dict:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end < start:
            raise
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("Codex CLI completion did not return a JSON object.")
    return parsed


def _is_retryable(exc: Exception) -> bool:
    message = str(exc).lower()
    return "429" in message or "rate" in message or "timeout" in message or "temporarily" in message


def _summarize_output(stderr: str, stdout: str) -> str:
    combined = f"{stderr}\n{stdout}".strip()
    if len(combined) > 4000:
        return combined[-4000:]
    return combined or "no process output"
