#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BENCHMARK="${1:-amemgym}"
RESULTS_ROOT="${RESULTS_ROOT:-${HOME}/.remnic/bench/results}"
. "${SCRIPT_DIR}/memoryarena-run-id.sh"

LEGACY_MEMORYARENA_RUN_ID="public-matrix-codex-bf9b2643-20260515T052919Z"
if [[ -n "${RESULTS_DIR:-}" && -z "${RUN_ID:-}" ]]; then
  RUN_ID="$(basename "${RESULTS_DIR%/}")"
else
  RUN_ID="${RUN_ID:-$(latest_memoryarena_run_id)}"
  RUN_ID="${RUN_ID:-${LEGACY_MEMORYARENA_RUN_ID}}"
fi
RESULTS_DIR="${RESULTS_DIR:-${RESULTS_ROOT}/${RUN_ID}}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-1800}"
LOG_FILE="${LOG_FILE:-${RESULTS_DIR}/next-after-memoryarena-watcher.log}"
LOCK_DIR="${LOCK_DIR:-/tmp/remnic-next-after-memoryarena-watcher.lock}"

mkdir -p "$(dirname "${LOG_FILE}")"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "watcher already running: ${LOCK_DIR}" >&2
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_FILE}"
}

while :; do
  set +e
  output="$(RUN_ID="${RUN_ID}" RESULTS_ROOT="${RESULTS_ROOT}" bash "${SCRIPT_DIR}/launch-next-after-memoryarena.sh" "${BENCHMARK}" 2>&1)"
  rc=$?
  set -e

  if [[ -n "${output}" ]]; then
    while IFS= read -r line; do
      log "${line}"
    done <<< "${output}"
  fi

  if [[ "${rc}" -ne 0 ]]; then
    log "stopping: guarded transition helper exited ${rc}"
    exit "${rc}"
  fi

  if grep -q '^launched=' <<< "${output}"; then
    log "done: ${BENCHMARK} launch detected"
    exit 0
  fi

  sleep "${INTERVAL_SECONDS}"
done
