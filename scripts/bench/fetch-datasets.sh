#!/usr/bin/env bash
# fetch-datasets.sh — Documentation + optional helpers for downloading the
# LongMemEval-S, LoCoMo-10, and BEAM datasets used by the published-benchmark
# runners in `@remnic/bench`.
#
# This script does NOT auto-download by default. It prints the exact
# commands you would run so operators understand what the runners will see,
# and so we never silently fetch data on CI or dev machines.
#
# Usage:
#   scripts/bench/fetch-datasets.sh [--help]
#   scripts/bench/fetch-datasets.sh --target <dir>   # prints commands scoped to <dir>
#
# Default target:
#   ./bench-datasets/       (gitignored — see .gitignore)
#
# After downloading, point the runners at the directory with the current
# `remnic bench run` CLI surface (a dedicated `remnic bench published`
# subcommand is planned for a later slice of issue #566):
#   pnpm exec remnic bench run longmemeval --dataset-dir ./bench-datasets/longmemeval
#   pnpm exec remnic bench run locomo      --dataset-dir ./bench-datasets/locomo
#
# Expected layout:
#   bench-datasets/
#     longmemeval/
#       longmemeval_oracle.json            # preferred
#       longmemeval_s_cleaned.json         # optional alternate
#       longmemeval_s.json                 # optional alternate
#     locomo/
#       locomo10.json                      # preferred
#       locomo.json                        # optional alternate
#     beam/
#       data/
#         100K-00000-of-00001.parquet      # official Hugging Face file
#         500K-00000-of-00001.parquet      # official Hugging Face file
#         1M-00000-of-00001.parquet        # official Hugging Face file
#         10M-00000-of-00002.parquet       # official Hugging Face file
#         10M-00001-of-00002.parquet       # official Hugging Face file

set -euo pipefail

TARGET_DIR="./bench-datasets"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      if [[ $# -lt 2 ]]; then
        echo "error: --target requires a directory path" >&2
        exit 2
      fi
      TARGET_DIR="$2"
      shift 2
      ;;
    --target=*)
      TARGET_DIR="${1#--target=}"
      shift
      ;;
    -h | --help)
      # Print the top-of-file help block.
      # Print the top-of-file help block. Uses a marker-based range
      # (`^#`-prefix only, stop at the first non-`#` line) so future
      # additions to the header stay in sync without hand-counting.
      sed -n '2,/^[^#]/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo "run 'scripts/bench/fetch-datasets.sh --help' for usage" >&2
      exit 2
      ;;
  esac
done

LONG_MEM_EVAL_DIR="${TARGET_DIR}/longmemeval"
LOCOMO_DIR="${TARGET_DIR}/locomo"
BEAM_DIR="${TARGET_DIR}/beam"

cat <<EOF
# Remnic published-benchmark datasets — download instructions
#
# These commands are PRINTED, not executed. Copy-paste the ones you need.
# Both datasets live on HuggingFace. The huggingface-cli option is preferred
# because it handles auth + resumable downloads; wget is shown as a fallback.

# 1. Create the target directories
mkdir -p "${LONG_MEM_EVAL_DIR}"
mkdir -p "${LOCOMO_DIR}"
mkdir -p "${BEAM_DIR}"

# 2. LongMemEval-S  (https://huggingface.co/datasets/xiaowu0162/LongMemEval)
#    Prefer the huggingface-cli path. Install via:  pipx install "huggingface_hub[cli]"
huggingface-cli download xiaowu0162/LongMemEval \\
  --repo-type dataset \\
  --local-dir "${LONG_MEM_EVAL_DIR}" \\
  --include "longmemeval_oracle.json" \\
           "longmemeval_s_cleaned.json" \\
           "longmemeval_s.json"

# Fallback: direct file download (update commit hash if the upstream moves)
# wget -P "${LONG_MEM_EVAL_DIR}" \\
#   "https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/longmemeval_oracle.json"

# 3. LoCoMo-10  (https://huggingface.co/datasets/snap-research/locomo10)
huggingface-cli download snap-research/locomo10 \\
  --repo-type dataset \\
  --local-dir "${LOCOMO_DIR}" \\
  --include "locomo10.json" "locomo.json"

# Fallback direct download
# wget -P "${LOCOMO_DIR}" \\
#   "https://huggingface.co/datasets/snap-research/locomo10/resolve/main/locomo10.json"

# 4. BEAM 100K/500K/1M  (https://huggingface.co/datasets/Mohammadta/BEAM)
huggingface-cli download Mohammadta/BEAM \\
  --repo-type dataset \\
  --local-dir "${BEAM_DIR}" \\
  --include "data/100K-00000-of-00001.parquet" \\
            "data/500K-00000-of-00001.parquet" \\
            "data/1M-00000-of-00001.parquet"

# BEAM 10M  (https://huggingface.co/datasets/Mohammadta/BEAM-10M)
huggingface-cli download Mohammadta/BEAM-10M \\
  --repo-type dataset \\
  --local-dir "${BEAM_DIR}" \\
  --include "data/10M-00000-of-00002.parquet" \\
            "data/10M-00001-of-00002.parquet"

# 5. Smoke-check that the runner sees your files (quick-mode, no model calls):
#    pnpm exec remnic bench run --quick longmemeval --dataset-dir "${LONG_MEM_EVAL_DIR}"
#    pnpm exec remnic bench run --quick locomo      --dataset-dir "${LOCOMO_DIR}"
#    pnpm exec remnic bench published --name beam --dataset "${BEAM_DIR}/data" --model gpt-5.5 --dry-run --limit 1
#
# The 'bench published --dry-run' command validates dataset loading without model calls.

EOF

exit 0
