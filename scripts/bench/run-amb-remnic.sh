#!/usr/bin/env bash
# Install Remnic into a local Agent Memory Benchmark checkout and run the
# official AMB harness with the Remnic memory provider.

set -euo pipefail

AMB_DIR=""
DATASET="personamem"
SPLIT="128k"
MODE="rag"
QUERY_LIMIT=""
OUTPUT_DIR="outputs"
RUN_NAME="remnic"
REMNIC_NODE="${REMNIC_AMB_NODE:-}"
AMB_CLI="${REMNIC_AMB_CLI:-}"
VERIFY_SOTA=0
MIN_QUERIES=""
INSTALL_ONLY=0
AMB_EXTRA_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  scripts/bench/run-amb-remnic.sh --amb <agent-memory-benchmark> [options]

Required:
  --amb <dir>             Path to a vectorize-io/agent-memory-benchmark checkout.

Options:
  --dataset <name>        AMB dataset name. Default: personamem
  --split <name>          AMB split/domain name. Default: 128k
  --mode <name>           AMB response mode. Default: rag
  --query-limit <n>       Limit queries for a smoke run. Omit for full runs.
  --output-dir <dir>      AMB output directory. Default: outputs
  --name <name>           AMB run name. Default: remnic
  --amb-cli <name>        AMB CLI command name. Auto-detects amb or omb.
  --remnic-node <path>    Node binary for Remnic helper. Also honors REMNIC_AMB_NODE.
  --verify-sota           Verify the produced AMB result beats current external best.
  --min-queries <n>       Minimum evaluated queries for --verify-sota.
  --install-only          Install/register provider and list providers, but do not run.
  --                      Pass remaining arguments through to "omb run".
  -h, --help              Show this help.

Environment:
  All AMB answer and judge LLM calls are routed through Codex CLI as
  gpt-5.5 with xhigh reasoning and fast service tier.
  REMNIC_AMB_CODEX_BIN may point at a specific Codex CLI binary.
  REMNIC_AMB_CLI may force the AMB CLI command name.
  REMNIC_REPO defaults to this checkout.

Examples:
  scripts/bench/run-amb-remnic.sh --amb ../agent-memory-benchmark --install-only
  scripts/bench/run-amb-remnic.sh --amb ../agent-memory-benchmark --split 128k --query-limit 20
  scripts/bench/run-amb-remnic.sh --amb ../agent-memory-benchmark --split 128k
  scripts/bench/run-amb-remnic.sh --amb ../agent-memory-benchmark --split 128k -- --skip-ingestion
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      AMB_EXTRA_ARGS=("$@")
      break
      ;;
    --amb)
      AMB_DIR="${2:-}"
      shift 2
      ;;
    --amb=*)
      AMB_DIR="${1#--amb=}"
      shift
      ;;
    --dataset)
      DATASET="${2:-}"
      shift 2
      ;;
    --dataset=*)
      DATASET="${1#--dataset=}"
      shift
      ;;
    --split | --domain)
      SPLIT="${2:-}"
      shift 2
      ;;
    --split=* | --domain=*)
      SPLIT="${1#*=}"
      shift
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      shift
      ;;
    --query-limit)
      QUERY_LIMIT="${2:-}"
      shift 2
      ;;
    --query-limit=*)
      QUERY_LIMIT="${1#--query-limit=}"
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --output-dir=*)
      OUTPUT_DIR="${1#--output-dir=}"
      shift
      ;;
    --name)
      RUN_NAME="${2:-}"
      shift 2
      ;;
    --name=*)
      RUN_NAME="${1#--name=}"
      shift
      ;;
    --remnic-node)
      REMNIC_NODE="${2:-}"
      shift 2
      ;;
    --remnic-node=*)
      REMNIC_NODE="${1#--remnic-node=}"
      shift
      ;;
    --amb-cli)
      AMB_CLI="${2:-}"
      shift 2
      ;;
    --amb-cli=*)
      AMB_CLI="${1#--amb-cli=}"
      shift
      ;;
    --verify-sota)
      VERIFY_SOTA=1
      shift
      ;;
    --min-queries)
      MIN_QUERIES="${2:-}"
      shift 2
      ;;
    --min-queries=*)
      MIN_QUERIES="${1#--min-queries=}"
      shift
      ;;
    --install-only)
      INSTALL_ONLY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$AMB_DIR" ]]; then
  echo "error: --amb is required" >&2
  usage >&2
  exit 2
fi
if [[ -z "$DATASET" ]]; then
  echo "error: --dataset must not be empty" >&2
  exit 2
fi
if [[ -z "$SPLIT" ]]; then
  echo "error: --split must not be empty" >&2
  exit 2
fi
if [[ -z "$MODE" ]]; then
  echo "error: --mode must not be empty" >&2
  exit 2
fi
if [[ -n "$AMB_CLI" && ! "$AMB_CLI" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
  echo "error: --amb-cli must be a simple command name" >&2
  exit 2
fi
if [[ -n "$QUERY_LIMIT" && ! "$QUERY_LIMIT" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: --query-limit must be a positive integer" >&2
  exit 2
fi
if [[ -n "$MIN_QUERIES" && ! "$MIN_QUERIES" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: --min-queries must be a positive integer" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REMNIC_REPO_DEFAULT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
AMB_DIR="$(cd -- "$AMB_DIR" && pwd)"

if [[ ! -f "${AMB_DIR}/pyproject.toml" || ! -d "${AMB_DIR}/src/memory_bench/memory" ]]; then
  echo "error: --amb must point to an Agent Memory Benchmark checkout" >&2
  exit 2
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required to run the AMB harness" >&2
  exit 2
fi
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"

export REMNIC_REPO="${REMNIC_REPO:-$REMNIC_REPO_DEFAULT}"
if [[ -n "$REMNIC_NODE" ]]; then
  export REMNIC_AMB_NODE="$REMNIC_NODE"
fi
CODEX_BIN="${REMNIC_AMB_CODEX_BIN:-codex}"
export REMNIC_AMB_CODEX_BIN="$CODEX_BIN"
export OMB_ANSWER_LLM="codex"
export OMB_JUDGE_LLM="codex"
export OMB_ANSWER_MODEL="gpt-5.5"
export OMB_JUDGE_MODEL="gpt-5.5"
export REMNIC_AMB_FORCE_CODEX_LLM="1"
unset GEMINI_API_KEY
unset GOOGLE_API_KEY

if [[ ! -f "${REMNIC_REPO}/packages/remnic-core/dist/index.js" ]]; then
  echo "error: @remnic/core is not built. Run: pnpm --filter @remnic/core build" >&2
  exit 2
fi

python3 "${REMNIC_REPO}/integrations/amb/install.py" --amb "$AMB_DIR"

if [[ -z "$AMB_CLI" ]]; then
  if [[ -x "${AMB_DIR}/.venv/bin/amb" ]]; then
    AMB_CLI="amb"
  elif [[ -x "${AMB_DIR}/.venv/bin/omb" ]]; then
    AMB_CLI="omb"
  else
    (
      cd "$AMB_DIR"
      if [[ -f uv.lock ]]; then
        uv sync --frozen
      else
        uv sync
      fi
    )
    if [[ -x "${AMB_DIR}/.venv/bin/amb" ]]; then
      AMB_CLI="amb"
    elif [[ -x "${AMB_DIR}/.venv/bin/omb" ]]; then
      AMB_CLI="omb"
    else
      echo "error: could not detect AMB CLI command name (tried amb and omb)" >&2
      exit 2
    fi
  fi
else
  if [[ ! -x "${AMB_DIR}/.venv/bin/${AMB_CLI}" ]]; then
    (
      cd "$AMB_DIR"
      if [[ -f uv.lock ]]; then
        uv sync --frozen
      else
        uv sync
      fi
    )
  fi
  if [[ ! -x "${AMB_DIR}/.venv/bin/${AMB_CLI}" ]]; then
    echo "error: AMB CLI is not executable: ${AMB_DIR}/.venv/bin/${AMB_CLI}" >&2
    exit 2
  fi
fi
AMB_BIN="${AMB_DIR}/.venv/bin/${AMB_CLI}"

(
  cd "$AMB_DIR"
  "$AMB_BIN" providers
)

if [[ "$INSTALL_ONLY" -eq 1 ]]; then
  exit 0
fi

if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "error: Codex CLI is required for AMB generation/judging: $CODEX_BIN" >&2
  exit 2
fi

split_flag="--split"
if (
  cd "$AMB_DIR"
  "$AMB_BIN" run --help 2>/dev/null | grep -q -- "--domain"
); then
  split_flag="--domain"
fi

cmd=(
  "$AMB_BIN" run
  --dataset "$DATASET"
  "$split_flag" "$SPLIT"
  --memory remnic
  --mode "$MODE"
  --llm codex
  --output-dir "$OUTPUT_DIR"
  --name "$RUN_NAME"
  --description "Remnic full-stack AMB run from ${REMNIC_REPO}"
)
if [[ -n "$QUERY_LIMIT" ]]; then
  cmd+=(--query-limit "$QUERY_LIMIT")
fi
if [[ "${#AMB_EXTRA_ARGS[@]}" -gt 0 ]]; then
  cmd+=("${AMB_EXTRA_ARGS[@]}")
fi

(
  cd "$AMB_DIR"
  "${cmd[@]}"
)

if [[ "$VERIFY_SOTA" -eq 1 ]]; then
  result_path="${AMB_DIR}/${OUTPUT_DIR}/${DATASET}/${RUN_NAME}/${MODE}/${SPLIT}.json"
  if [[ ! -f "$result_path" ]]; then
    echo "error: expected AMB result not found: $result_path" >&2
    exit 1
  fi
  verify_cmd=(
    node "${REMNIC_REPO}/scripts/bench/verify-amb-sota.mjs"
    --result "$result_path"
    --manifest-out "${result_path%.json}.sota-manifest.json"
    --command "${cmd[*]}"
    --amb-dir "$AMB_DIR"
  )
  if [[ -n "$MIN_QUERIES" ]]; then
    verify_cmd+=(--min-queries "$MIN_QUERIES")
  fi
  "${verify_cmd[@]}"
fi
