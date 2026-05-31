#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"

DEFAULT_RUN_ID="public-matrix-codex-bf9b2643-20260515T052919Z"
if [[ -n "${RESULTS_DIR:-}" && -z "${RUN_ID:-}" ]]; then
  RUN_ID="$(basename "${RESULTS_DIR%/}")"
else
  RUN_ID="${RUN_ID:-${DEFAULT_RUN_ID}}"
fi
RESULTS_DIR="${RESULTS_DIR:-${HOME}/.remnic/bench/results/${RUN_ID}}"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-${TMP_ROOT}/remnic-memoryarena-evidence}"
SESSION="${SESSION:-${RUN_ID}}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-1800}"
LOG_FILE="${LOG_FILE:-${RESULTS_DIR}/memoryarena-publish-watcher.log}"
LOCK_DIR="${LOCK_DIR:-/tmp/remnic-memoryarena-publish-watcher.lock}"

mkdir -p "$(dirname "${LOG_FILE}")"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "watcher already running: ${LOCK_DIR}" >&2
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_FILE}"
}

result_file() {
  if [[ ! -d "${RESULTS_DIR}" ]]; then
    return 0
  fi
  find "${RESULTS_DIR}" -maxdepth 1 -type f \
    -name 'memory-arena-*.json' \
    ! -name 'memory-arena-sota-comparison.json' \
    ! -name 'memory-arena-diagnostics-summary.json' \
    -print 2>/dev/null | sort | tail -1 || true
}

while :; do
  result="$(result_file)"

  if [[ -z "${result}" ]]; then
    if tmux has-session -t "${SESSION}" 2>/dev/null; then
      log "waiting: no MemoryArena result file yet; session ${SESSION} still running"
      sleep "${INTERVAL_SECONDS}"
      continue
    fi

    log "error: no MemoryArena result file and session ${SESSION} is not running"
    exit 2
  fi

  log "result detected: ${result}"

  set +e
  complete_output="$(RUN_ID="${RUN_ID}" RESULTS_DIR="${RESULTS_DIR}" SESSION="${SESSION}" OUT_ROOT="${EVIDENCE_ROOT}" bash "${SCRIPT_DIR}/complete-memoryarena-if-ready.sh" 2>&1)"
  complete_status=$?
  set -e
  if [[ -n "${complete_output}" ]]; then
    while IFS= read -r line; do log "${line}"; done <<< "${complete_output}"
  fi
  if [[ "${complete_status}" -ne 0 ]]; then
    if [[ "${complete_status}" -eq 4 ]]; then
      remediation_file="${RESULTS_DIR}/memory-arena-remediation-required.md"
      remediation_reason="$(grep -E '^(not-sota:|remediation-required:)' <<< "${complete_output}" | tail -1 || true)"
      if [[ -z "${remediation_reason}" ]]; then
        remediation_reason="completion helper exited ${complete_status}"
      fi
      cat > "${remediation_file}" <<EOF
# MemoryArena Remediation Required

Detected: $(date -u +%Y-%m-%dT%H:%M:%SZ)

The MemoryArena run completed, but the public SOTA completion helper reported
a remediation-required condition.

Reason: ${remediation_reason}

Next required action:

1. If the reason is \`not-sota\`, inspect the comparison output under
   \`${EVIDENCE_ROOT}/${RUN_ID}/memory-arena-sota-comparison.raw.json\`.
2. If the reason mentions evidence verification, inspect the packaged evidence
   under \`${EVIDENCE_ROOT}/${RUN_ID}\` and fix the evidence or verifier path
   before rerunning the benchmark.
3. Identify whether the issue is due to a benchmark harness issue or Remnic
   behavior.
4. Make only changes that preserve real-world user behavior.
5. Run focused tests for the changed behavior.
6. Rerun MemoryArena with Codex CLI \`gpt-5.5\`, reasoning effort \`xhigh\`,
   and service tier \`fast\` when the raw benchmark result itself must change.
7. Re-run this watcher or the completion/stage/publish helpers after rerun.
EOF
      log "remediation-required: wrote ${remediation_file}"
      log "stopping: MemoryArena completion helper exited ${complete_status}"
      exit "${complete_status}"
    fi
    log "waiting: MemoryArena completion helper exited ${complete_status}; will retry"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi
  if ! grep -q '^ready: verified ' <<< "${complete_output}"; then
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  set +e
  stage_output="$(RUN_ID="${RUN_ID}" EVIDENCE_ROOT="${EVIDENCE_ROOT}" bash "${SCRIPT_DIR}/stage-memoryarena-evidence-pr.sh" 2>&1)"
  stage_status=$?
  set -e
  if [[ -n "${stage_output}" ]]; then
    while IFS= read -r line; do log "${line}"; done <<< "${stage_output}"
  fi
  if [[ "${stage_status}" -ne 0 ]]; then
    log "stopping: MemoryArena staging helper exited ${stage_status}"
    exit "${stage_status}"
  fi
  if grep -q '^done:' <<< "${stage_output}"; then
    exit 0
  fi
  if ! grep -q '^ready: MemoryArena evidence PR worktree staged ' <<< "${stage_output}"; then
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  set +e
  publish_output="$(RUN_ID="${RUN_ID}" bash "${SCRIPT_DIR}/publish-memoryarena-evidence-pr.sh" 2>&1)"
  publish_status=$?
  set -e
  if [[ -n "${publish_output}" ]]; then
    while IFS= read -r line; do log "${line}"; done <<< "${publish_output}"
  fi
  if [[ "${publish_status}" -ne 0 ]]; then
    log "waiting: MemoryArena publish helper exited ${publish_status}; will retry"
    sleep "${INTERVAL_SECONDS}"
    continue
  fi
  if grep -q '^waiting:' <<< "${publish_output}"; then
    sleep "${INTERVAL_SECONDS}"
    continue
  fi

  log "done: MemoryArena evidence publish helper completed"
  exit 0
done
