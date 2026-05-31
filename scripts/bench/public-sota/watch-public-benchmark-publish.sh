#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"

BENCHMARK="${1:-}"
if [[ -z "${BENCHMARK}" ]]; then
  echo "Usage: $0 <amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem> [run-id]" >&2
  exit 2
fi

case "${BENCHMARK}" in
  amemgym|longmemeval|locomo|beam|memoryagentbench|membench|personamem) ;;
  *)
    echo "Unsupported benchmark: ${BENCHMARK}" >&2
    exit 2
    ;;
esac

RUN_ID="${2:-}"
RESULTS_ROOT="${RESULTS_ROOT:-${HOME}/.remnic/bench/results}"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-${TMP_ROOT}/remnic-public-benchmark-evidence}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-1800}"
LOG_ROOT="${LOG_ROOT:-${RESULTS_ROOT}}"
LOG_FILE="${LOG_FILE:-${LOG_ROOT}/watch-${BENCHMARK}-publish.log}"
LOCK_DIR="${LOCK_DIR:-/tmp/remnic-${BENCHMARK}-publish-watcher.lock}"

mkdir -p "$(dirname "${LOG_FILE}")"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "watcher already running: ${LOCK_DIR}" >&2
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

stale_baseline_run() {
  local run_id="$1"
  if tmux has-session -t "${run_id}" 2>/dev/null; then
    return 1
  fi
  local status_file="${RESULTS_ROOT}/${run_id}/status.tsv"
  if [[ -f "${status_file}" ]] && awk -F '\t' -v benchmark="${BENCHMARK}" '$1 == benchmark && $2 == "success" { found = 1 } END { exit found ? 0 : 1 }' "${status_file}"; then
    return 1
  fi
  return 0
}

BASELINE_RUNS_FILE="$(mktemp "${TMP_ROOT}/remnic-${BENCHMARK}-publish-baseline.XXXXXX")"
if [[ -z "${RUN_ID}" ]]; then
  while IFS= read -r candidate; do
    run_basename="$(basename "${candidate}")"
    if stale_baseline_run "${run_basename}"; then
      printf '%s\n' "${run_basename}"
    fi
  done < <(find "${RESULTS_ROOT}" -maxdepth 1 -type d -name "public-${BENCHMARK}-codex-*" -print 2>/dev/null) \
    | sort > "${BASELINE_RUNS_FILE}"
fi
trap 'rm -f "${BASELINE_RUNS_FILE}"; rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_FILE}"
}

current_run_id() {
  if [[ -n "${RUN_ID}" ]]; then
    printf '%s\n' "${RUN_ID}"
    return
  fi
  local candidate
  local run_basename
  while IFS= read -r candidate; do
    run_basename="$(basename "${candidate}")"
    if ! grep -Fxq "${run_basename}" "${BASELINE_RUNS_FILE}"; then
      printf '%s\n' "${run_basename}"
      return
    fi
  done < <(find "${RESULTS_ROOT}" -maxdepth 1 -type d -name "public-${BENCHMARK}-codex-*" -print 2>/dev/null | sort -r)
  return 0
}

while :; do
  run_id="$(current_run_id)"
  if [[ -z "${run_id}" ]]; then
    log "waiting: no run directory found for ${BENCHMARK}"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  set +e
  complete_output="$(OUT_ROOT="${EVIDENCE_ROOT}" bash "${SCRIPT_DIR}/complete-public-benchmark-if-ready.sh" "${BENCHMARK}" "${run_id}" 2>&1)"
  complete_status=$?
  set -e
  if [[ -n "${complete_output}" ]]; then
    while IFS= read -r line; do log "${line}"; done <<< "${complete_output}"
  fi
  if [[ "${complete_status}" -ne 0 ]]; then
    if [[ "${complete_status}" -eq 4 ]]; then
      remediation_file="${RESULTS_ROOT}/${run_id}/${BENCHMARK}-remediation-required.md"
      remediation_reason="$(grep -E '^(not-sota:|remediation-required:)' <<< "${complete_output}" | tail -1 || true)"
      if [[ -z "${remediation_reason}" ]]; then
        remediation_reason="completion helper exited ${complete_status}"
      fi
      cat > "${remediation_file}" <<EOF
# ${BENCHMARK} Remediation Required

Detected: $(date -u +%Y-%m-%dT%H:%M:%SZ)

The ${BENCHMARK} run completed, but the public SOTA completion helper reported
a remediation-required condition.

Reason: ${remediation_reason}

Next required action:

1. If the reason is \`not-sota\`, inspect the comparison output under
   \`${EVIDENCE_ROOT}/${run_id}/${BENCHMARK}-sota-comparison.raw.json\`.
2. If the reason mentions evidence verification, inspect the packaged evidence
   under \`${EVIDENCE_ROOT}/${run_id}\` and fix the evidence or verifier path
   before rerunning the benchmark.
3. Identify whether the issue is due to a benchmark harness issue or Remnic
   behavior.
4. Make only changes that preserve real-world user behavior.
5. Run focused tests for the changed behavior.
6. Rerun ${BENCHMARK} with Codex CLI \`gpt-5.5\`, reasoning effort \`xhigh\`,
   and service tier \`fast\` when the raw benchmark result itself must change.
7. Re-run this watcher or the completion/stage/publish helpers after rerun.
EOF
      log "remediation-required: wrote ${remediation_file}"
      log "stopping: ${BENCHMARK} completion helper exited ${complete_status}"
      exit "${complete_status}"
    fi
    log "waiting: ${BENCHMARK} completion helper exited ${complete_status}; will retry"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi
  if ! grep -q '^ready: verified ' <<< "${complete_output}"; then
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  set +e
  stage_output="$(EVIDENCE_ROOT="${EVIDENCE_ROOT}" bash "${SCRIPT_DIR}/stage-public-benchmark-evidence-pr.sh" "${BENCHMARK}" "${run_id}" 2>&1)"
  stage_status=$?
  set -e
  if [[ -n "${stage_output}" ]]; then
    while IFS= read -r line; do log "${line}"; done <<< "${stage_output}"
  fi
  if [[ "${stage_status}" -ne 0 ]]; then
    log "stopping: ${BENCHMARK} staging helper exited ${stage_status}"
    exit "${stage_status}"
  fi
  if grep -q '^done:' <<< "${stage_output}"; then
    exit 0
  fi
  if ! grep -q '^ready: .* evidence PR worktree staged ' <<< "${stage_output}"; then
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  set +e
  publish_output="$(bash "${SCRIPT_DIR}/publish-public-benchmark-evidence-pr.sh" "${BENCHMARK}" "${run_id}" 2>&1)"
  publish_status=$?
  set -e
  if [[ -n "${publish_output}" ]]; then
    while IFS= read -r line; do log "${line}"; done <<< "${publish_output}"
  fi
  if [[ "${publish_status}" -ne 0 ]]; then
    log "waiting: ${BENCHMARK} publish helper exited ${publish_status}; will retry"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi
  if grep -q '^waiting:' <<< "${publish_output}"; then
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  log "done: ${BENCHMARK} evidence publish helper completed"
  exit 0
done
