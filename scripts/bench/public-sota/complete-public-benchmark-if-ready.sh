#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(git -C "${SCRIPT_DIR}/../../.." rev-parse --show-toplevel 2>/dev/null || (cd "${SCRIPT_DIR}/../../.." && pwd))"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"

benchmark="${1:-}"
if [[ -z "${benchmark}" ]]; then
  echo "Usage: $0 <amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem> [run-id]" >&2
  exit 2
fi

case "${benchmark}" in
  amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem) ;;
  *)
    echo "Unsupported benchmark: ${benchmark}" >&2
    exit 2
    ;;
esac

run_id="${2:-}"
RESULTS_ROOT="${RESULTS_ROOT:-${HOME}/.remnic/bench/results}"
REPO_ROOT="${REPO_ROOT:-${REPO_ROOT_DEFAULT}}"
OUT_ROOT="${OUT_ROOT:-${TMP_ROOT}/remnic-public-benchmark-evidence}"

if [[ -z "${run_id}" ]]; then
  run_id="$(find "${RESULTS_ROOT}" -maxdepth 1 -type d -name "public-${benchmark}-codex-*" -print 2>/dev/null | sort | tail -1 | xargs basename 2>/dev/null || true)"
fi

if [[ -z "${run_id}" ]]; then
  echo "waiting: no run directory found for ${benchmark}" >&2
  exit 0
fi

RESULTS_DIR="${RESULTS_ROOT}/${run_id}"
OUT_DIR="${OUT_ROOT}/${run_id}"
PACKAGED_TARGET_MAP="${OUT_DIR}/current-target-map.json"
TARGET_MAP="${TARGET_MAP:-${PACKAGED_TARGET_MAP}}"
DATASET_DIR="${REPO_ROOT}/evals/datasets/${benchmark}"
SESSION="${SESSION:-${run_id}}"
COMPARE_SCRIPT="${SCRIPT_DIR}/compare-public-benchmark-sota.mjs"
PACKAGE_SCRIPT="${SCRIPT_DIR}/package-public-benchmark-evidence.mjs"
VERIFY_SCRIPT="${SCRIPT_DIR}/verify-public-benchmark-sota-evidence.mjs"

if [[ ! -d "${RESULTS_DIR}" ]]; then
  echo "waiting: results directory missing: ${RESULTS_DIR}" >&2
  exit 0
fi

result_path="$(find "${RESULTS_DIR}" -maxdepth 1 -type f -name "${benchmark}-*.json" ! -name "${benchmark}-sota-comparison.json" ! -name "${benchmark}-diagnostics-summary.json" -print 2>/dev/null | sort | tail -1)"

if [[ -z "${result_path}" ]]; then
  if tmux has-session -t "${SESSION}" 2>/dev/null; then
    echo "waiting: no ${benchmark} result file yet; tmux session ${SESSION} is still running"
    exit 0
  fi
  echo "error: no ${benchmark} result file and tmux session ${SESSION} is not running" >&2
  exit 2
fi

mkdir -p "${OUT_DIR}"
if [[ "${TARGET_MAP}" == "${PACKAGED_TARGET_MAP}" ]]; then
  node "${SCRIPT_DIR}/build-target-map.mjs" "${PACKAGED_TARGET_MAP}"
else
  cp "${TARGET_MAP}" "${PACKAGED_TARGET_MAP}"
fi

comparison_path="${OUT_DIR}/${benchmark}-sota-comparison.raw.json"
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

if ! node "${VERIFY_SCRIPT}" "${OUT_DIR}" "${TARGET_MAP}" "${benchmark}"; then
  echo "remediation-required: ${benchmark} evidence verification failed for ${OUT_DIR}" >&2
  exit 4
fi

echo "ready: verified ${benchmark} evidence at ${OUT_DIR}"
