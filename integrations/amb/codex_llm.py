"""Codex CLI LLM provider for Agent Memory Benchmark."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .base import LLM, Schema, ToolDef

_MODEL = "gpt-5.5"
_REASONING_EFFORT = "xhigh"
_SERVICE_TIER = "fast"
_DEFAULT_TIMEOUT_SECONDS = 300


class CodexLLM(LLM):
    """Run all AMB LLM calls through Codex CLI with GPT-5.5/xhigh/fast."""

    def __init__(self, model: str = _MODEL):
        if model != _MODEL:
            raise ValueError(f"CodexLLM is locked to {_MODEL}; got {model!r}")
        self._model = model
        self._codex_bin = _resolve_executable(os.environ.get("REMNIC_AMB_CODEX_BIN", "codex"))
        self._timeout_seconds = _positive_int_env(
            "REMNIC_AMB_CODEX_TIMEOUT_SECONDS",
            _DEFAULT_TIMEOUT_SECONDS,
        )

    @property
    def model_id(self) -> str:
        return f"codex:{self._model}:{_REASONING_EFFORT}:{_SERVICE_TIER}"

    def generate(self, prompt: str, schema: Schema) -> dict:
        output_schema = _schema_to_json_schema(schema)
        runner_prompt = "\n".join(
            [
                "You are answering inside Agent Memory Benchmark.",
                "Use only the information in the prompt. Do not run shell commands or use external tools.",
                "Return the final answer as JSON matching the requested schema.",
                "",
                prompt,
            ]
        )
        return self._run_codex(runner_prompt, output_schema)

    def tool_loop(self, prompt: str, tools: list[ToolDef], max_tool_calls: int = 10) -> str:
        observations: list[str] = []
        tool_names = {tool.name: tool for tool in tools}
        for _ in range(max_tool_calls):
            tool_prompt = _tool_prompt(prompt, tools, observations)
            data = self._run_codex(tool_prompt, _TOOL_SCHEMA)
            action = str(data.get("action", "")).strip().lower()
            if action == "final":
                return str(data.get("final_answer", "")).strip()
            if action != "tool":
                raise ValueError(f"Codex tool loop returned unsupported action: {action!r}")

            tool_name = str(data.get("tool_name", "")).strip()
            tool = tool_names.get(tool_name)
            if tool is None:
                raise ValueError(f"Codex tool loop requested unknown tool: {tool_name!r}")
            tool_args = data.get("tool_args")
            if not isinstance(tool_args, dict):
                raise ValueError("Codex tool loop returned non-object tool_args")
            allowed_args = set(tool.required)
            parameters = tool.parameters if isinstance(tool.parameters, dict) else {}
            properties = parameters.get("properties")
            if isinstance(properties, dict):
                allowed_args.update(str(key) for key in properties)
            selected_args = {key: tool_args[key] for key in allowed_args if key in tool_args}
            missing = [key for key in tool.required if key not in selected_args]
            if missing:
                raise ValueError(f"Codex tool loop omitted required tool args: {missing}")
            result = tool.fn(**selected_args)
            observations.append(
                json.dumps(
                    {
                        "tool": tool_name,
                        "args": selected_args,
                        "result": result,
                    },
                    ensure_ascii=False,
                )
            )
        raise RuntimeError(f"Codex tool loop exceeded {max_tool_calls} tool calls")

    def _run_codex(self, prompt: str, output_schema: dict[str, Any]) -> dict:
        with tempfile.TemporaryDirectory(prefix="remnic-amb-codex-") as tmp:
            tmp_dir = Path(tmp)
            schema_path = tmp_dir / "schema.json"
            output_path = tmp_dir / "last-message.json"
            schema_path.write_text(json.dumps(output_schema), encoding="utf-8")

            command = [
                self._codex_bin,
                "exec",
                "--ephemeral",
                "--skip-git-repo-check",
                "--ignore-rules",
                "--sandbox",
                "read-only",
                "--model",
                self._model,
                "-c",
                f'model_reasoning_effort="{_REASONING_EFFORT}"',
                "-c",
                f'service_tier="{_SERVICE_TIER}"',
                "--output-schema",
                str(schema_path),
                "--output-last-message",
                str(output_path),
                "-",
            ]
            result = subprocess.run(
                command,
                cwd=tmp_dir,
                input=prompt,
                text=True,
                capture_output=True,
                timeout=self._timeout_seconds,
                check=False,
            )
            if result.returncode != 0:
                stderr = _compact(result.stderr)
                stdout = _compact(result.stdout)
                detail = stderr or stdout or f"exit code {result.returncode}"
                raise RuntimeError(f"Codex CLI generation failed: {detail}")
            if not output_path.exists():
                raise RuntimeError("Codex CLI did not write --output-last-message")
            text = output_path.read_text(encoding="utf-8").strip()
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Codex CLI returned non-JSON output: {_compact(text)}") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("Codex CLI returned JSON that is not an object")
        return payload


def _schema_to_json_schema(schema: Schema) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": schema.properties,
        "required": schema.required,
        "additionalProperties": False,
    }


_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "description": "Use 'tool' to call a tool or 'final' to finish.",
        },
        "tool_name": {
            "type": "string",
            "description": "Tool name when action is 'tool'.",
        },
        "tool_args": {
            "type": "object",
            "description": "Arguments for the selected tool.",
        },
        "final_answer": {
            "type": "string",
            "description": "Final answer when action is 'final'.",
        },
    },
    "required": ["action"],
    "additionalProperties": False,
}


def _tool_prompt(prompt: str, tools: list[ToolDef], observations: list[str]) -> str:
    tool_specs = [
        {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
            "required": tool.required,
        }
        for tool in tools
    ]
    return "\n".join(
        [
            "You are answering inside Agent Memory Benchmark with access to tools.",
            "Use only the supplied tools and observations. Do not run shell commands or use external tools.",
            "Return JSON. For a tool call, set action='tool'. For a final answer, set action='final'.",
            "",
            "# Task",
            prompt,
            "",
            "# Tools",
            json.dumps(tool_specs, ensure_ascii=False),
            "",
            "# Observations",
            "\n".join(observations) if observations else "(none)",
        ]
    )


def _positive_int_env(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    if not raw.isdecimal() or int(raw) < 1:
        raise ValueError(f"{name} must be a positive integer")
    return int(raw)


def _resolve_executable(value: str) -> str:
    path = Path(value).expanduser()
    if path.is_absolute():
        return str(path)
    if "/" in value or (os.altsep and os.altsep in value):
        return str(path.resolve())
    return value


def _compact(value: str, limit: int = 500) -> str:
    return " ".join(value.split())[:limit]
