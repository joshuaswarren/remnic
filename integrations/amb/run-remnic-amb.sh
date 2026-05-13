#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  integrations/amb/run-remnic-amb.sh --amb-dir /path/to/agent-memory-benchmark [options]

Options:
  --amb-dir DIR       Required. Agent Memory Benchmark checkout.
  --split SPLIT       BEAM split: 100k, 500k, 1m, or 10m. Default: 100k.
  --mode MODE         AMB response mode: rag. Default: rag.
  --query-limit N     Optional AMB --query-limit for smoke runs.
  --name NAME         AMB run name. Default: remnic.
  --output-dir DIR    AMB output directory. Default: outputs.
  --skip-run          Install/register provider only.
  --verify            Install/register, then run a no-Gemini provider smoke.
  --retrieve-only     Run AMB BEAM ingestion/retrieval only; no answer/judge LLM.
  --retrieval-output FILE
                      Optional JSON file for --retrieve-only output.

Environment:
  GEMINI_API_KEY      Required by AMB for official answer/judge calls.
  REMNIC_REPO_ROOT    Optional. Defaults to this Remnic checkout.

This script registers Remnic as an AMB MemoryProvider, builds @remnic/bench,
and runs AMB with Gemini model defaults matching the published Hindsight BEAM
result artifacts:
  OMB_ANSWER_LLM=gemini
  OMB_ANSWER_MODEL=gemini-3.1-pro-preview
  OMB_JUDGE_LLM=gemini
  OMB_JUDGE_MODEL=gemini-2.5-flash-lite
EOF
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
remnic_root="$(cd -- "${script_dir}/../.." && pwd)"
amb_dir=""
split="100k"
mode="rag"
query_limit=""
run_name="remnic"
output_dir="outputs"
skip_run=0
verify=0
retrieve_only=0
retrieval_output=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --amb-dir)
      amb_dir="${2:-}"
      shift 2
      ;;
    --split)
      split="${2:-}"
      shift 2
      ;;
    --mode)
      mode="${2:-}"
      shift 2
      ;;
    --query-limit)
      query_limit="${2:-}"
      shift 2
      ;;
    --name)
      run_name="${2:-}"
      shift 2
      ;;
    --output-dir)
      output_dir="${2:-}"
      shift 2
      ;;
    --skip-run)
      skip_run=1
      shift
      ;;
    --verify)
      verify=1
      skip_run=1
      shift
      ;;
    --retrieve-only)
      retrieve_only=1
      shift
      ;;
    --retrieval-output)
      retrieval_output="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${amb_dir}" ]]; then
  echo "--amb-dir is required" >&2
  usage >&2
  exit 2
fi

amb_dir="$(cd -- "${amb_dir}" && pwd)"
if [[ ! -f "${amb_dir}/src/memory_bench/memory/__init__.py" ]]; then
  echo "AMB checkout not found at ${amb_dir}" >&2
  exit 1
fi

case "${split}" in
  100k|500k|1m|10m) ;;
  *)
    echo "Unsupported BEAM split: ${split}" >&2
    exit 2
    ;;
esac

if [[ -z "${mode}" ]]; then
  echo "--mode must not be empty" >&2
  exit 2
fi

case "${mode}" in
  rag) ;;
  *)
    echo "Unsupported AMB mode for Remnic: ${mode}. Use rag." >&2
    exit 2
    ;;
esac

if [[ "${skip_run}" -ne 1 && "${retrieve_only}" -ne 1 && -z "${GEMINI_API_KEY:-}" && -z "${GOOGLE_API_KEY:-}" ]]; then
  echo "GEMINI_API_KEY or GOOGLE_API_KEY is required for AMB answer/judge calls." >&2
  exit 1
fi

cp "${script_dir}/remnic_provider.py" "${amb_dir}/src/memory_bench/memory/remnic.py"
python - "${amb_dir}/src/memory_bench/memory/__init__.py" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
remnic_import = "from .remnic import RemnicMemoryProvider"
remnic_entry = '"remnic": RemnicMemoryProvider,'

if remnic_import not in text:
    imports = list(re.finditer(r"^from\s+\.[A-Za-z_][A-Za-z0-9_.]*\s+import\s+.+$", text, re.MULTILINE))
    if not imports:
        raise SystemExit("Could not find AMB memory import insertion point")
    insertion_point = next((match for match in imports if "SupermemoryMemoryProvider" in match.group(0)), imports[-1])
    text = f"{text[:insertion_point.end()]}\n{remnic_import}{text[insertion_point.end():]}"

if not re.search(r'["\']remnic["\']\s*:\s*RemnicMemoryProvider\b', text):
    registry_start = re.search(r"\b(?:MEMORY_)?REGISTRY\s*(?::\s*[^=]+)?=\s*\{", text)
    if not registry_start:
        raise SystemExit("Could not find AMB memory registry insertion point")
    text = f"{text[:registry_start.end()]}\n    {remnic_entry}{text[registry_start.end():]}"
path.write_text(text)
PY

pnpm --dir "${remnic_root}" --filter @remnic/bench build

export REMNIC_REPO_ROOT="${REMNIC_REPO_ROOT:-${remnic_root}}"
export OMB_ANSWER_LLM="${OMB_ANSWER_LLM:-gemini}"
export OMB_ANSWER_MODEL="${OMB_ANSWER_MODEL:-gemini-3.1-pro-preview}"
export OMB_JUDGE_LLM="${OMB_JUDGE_LLM:-gemini}"
export OMB_JUDGE_MODEL="${OMB_JUDGE_MODEL:-gemini-2.5-flash-lite}"

if [[ "${skip_run}" -eq 1 ]]; then
  if [[ "${verify}" -eq 1 ]]; then
    REMNIC_REPO_ROOT="${REMNIC_REPO_ROOT}" uv run --directory "${amb_dir}" python - <<'PY'
from pathlib import Path
from tempfile import TemporaryDirectory

from memory_bench.memory import get_memory_provider
from memory_bench.models import Document

provider = get_memory_provider("remnic")
provider.initialize()
try:
    with TemporaryDirectory() as tmp:
        provider.prepare(Path(tmp), unit_ids={"u1"}, reset=True)
        provider.ingest([
            Document(
                id="doc1",
                content="[Turn 1] User: I use Flask-Login for sessions.\n\n[Turn 2] Assistant: Noted.",
                user_id="u1",
                context="remnic AMB verification smoke",
            )
        ])
        docs, raw = provider.retrieve("What do I use for sessions?", user_id="u1")
        text = "\n".join(doc.content for doc in docs)
        if "Flask-Login" not in text:
            raise SystemExit(f"Remnic retrieval smoke failed; retrieved={text[:500]!r}")
        print(f"Verified Remnic AMB provider: {provider.name} {provider.kind}; docs={len(docs)}")
finally:
    provider.cleanup()
PY
  fi
  echo "Registered Remnic provider in ${amb_dir}"
  exit 0
fi

if [[ "${retrieve_only}" -eq 1 ]]; then
  cmd=(
    uv run --directory "${amb_dir}" python "${script_dir}/retrieve-remnic-contexts.py"
    --split "${split}"
    --memory remnic
    --run-name "${run_name}"
    --output-dir "${output_dir}"
  )
  if [[ -n "${query_limit}" ]]; then
    cmd+=(--query-limit "${query_limit}")
  fi
  if [[ -n "${retrieval_output}" ]]; then
    cmd+=(--output-file "${retrieval_output}")
  fi
  printf 'Running retrieval diagnostic:'
  printf ' %q' "${cmd[@]}"
  printf '\n'
  exec "${cmd[@]}"
fi

cmd=(
  uv run --directory "${amb_dir}" omb run
  --dataset beam
  --split "${split}"
  --memory remnic
  --mode "${mode}"
  --name "${run_name}"
  --output-dir "${output_dir}"
  --description "Remnic full-stack memory provider via integrations/amb"
)
if [[ -n "${query_limit}" ]]; then
  cmd+=(--query-limit "${query_limit}")
fi

printf 'Running:'
printf ' %q' "${cmd[@]}"
printf '\n'
exec "${cmd[@]}"
