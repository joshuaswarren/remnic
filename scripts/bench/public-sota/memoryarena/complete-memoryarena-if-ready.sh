#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_SOTA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT_DEFAULT="$(git -C "${SCRIPT_DIR}/../../../.." rev-parse --show-toplevel 2>/dev/null || (cd "${SCRIPT_DIR}/../../../.." && pwd))"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"

RUN_ID="${RUN_ID:-public-matrix-codex-bf9b2643-20260515T052919Z}"
RESULTS_DIR="${RESULTS_DIR:-${HOME}/.remnic/bench/results/${RUN_ID}}"
REPO_ROOT="${REPO_ROOT:-${REPO_ROOT_DEFAULT}}"
DATASET_DIR="${DATASET_DIR:-${REPO_ROOT}/evals/datasets/memory-arena}"
OUT_ROOT="${OUT_ROOT:-${TMP_ROOT}/remnic-memoryarena-evidence}"
OUT_DIR="${OUT_DIR:-${OUT_ROOT}/${RUN_ID}}"
PACKAGED_TARGET_MAP="${OUT_DIR}/current-target-map.json"
TARGET_MAP="${TARGET_MAP:-${PACKAGED_TARGET_MAP}}"
SESSION="${SESSION:-${RUN_ID}}"

COMPARE_SCRIPT="${SCRIPT_DIR}/compare-memoryarena-sota.mjs"
PACKAGE_SCRIPT="${SCRIPT_DIR}/package-memoryarena-evidence.mjs"
VERIFY_SCRIPT="${SCRIPT_DIR}/verify-memoryarena-sota-evidence.mjs"

latest_result() {
  find "${RESULTS_DIR}" -maxdepth 1 -type f \
    -name 'memory-arena-*.json' \
    ! -name 'memory-arena-sota-comparison.json' \
    ! -name 'memory-arena-diagnostics-summary.json' \
    -print 2>/dev/null | sort | tail -1
}

result_path="$(latest_result)"

if [[ -z "${result_path}" ]]; then
  if tmux has-session -t "${SESSION}" 2>/dev/null; then
    echo "waiting: no MemoryArena result file yet; tmux session ${SESSION} is still running"
    exit 0
  fi
  echo "error: no MemoryArena result file and tmux session ${SESSION} is not running" >&2
  exit 2
fi

mkdir -p "${OUT_DIR}"

if [[ "${TARGET_MAP}" == "${PACKAGED_TARGET_MAP}" ]]; then
  node "${PUBLIC_SOTA_DIR}/build-target-map.mjs" "${PACKAGED_TARGET_MAP}"
else
  cp "${TARGET_MAP}" "${PACKAGED_TARGET_MAP}"
fi

comparison_path="${OUT_DIR}/memory-arena-sota-comparison.raw.json"
node "${COMPARE_SCRIPT}" "${result_path}" "${TARGET_MAP}" | tee "${comparison_path}"

if ! jq -e '.sotaAllCheckedMetrics == true' "${comparison_path}" >/dev/null; then
  echo "not-sota: comparison saved to ${comparison_path}" >&2
  exit 4
fi

node "${PACKAGE_SCRIPT}" \
  --result "${result_path}" \
  --results-dir "${RESULTS_DIR}" \
  --dataset-dir "${DATASET_DIR}" \
  --repo-root "${REPO_ROOT}" \
  --out-dir "${OUT_DIR}" \
  --target-map "${TARGET_MAP}"

if ! node "${VERIFY_SCRIPT}" "${OUT_DIR}" "${TARGET_MAP}"; then
  echo "remediation-required: MemoryArena evidence verification failed for ${OUT_DIR}" >&2
  exit 4
fi

echo "ready: verified MemoryArena evidence at ${OUT_DIR}"
