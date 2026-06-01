#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/gh/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(git -C "${SCRIPT_DIR}/../../.." rev-parse --show-toplevel 2>/dev/null || (cd "${SCRIPT_DIR}/../../.." && pwd))"
REPO_ROOT="${REPO_ROOT:-${REPO_ROOT_DEFAULT}}"
RESULTS_ROOT="${RESULTS_ROOT:-${HOME}/.remnic/bench/results}"
. "${SCRIPT_DIR}/memoryarena-run-id.sh"

LEGACY_MEMORYARENA_RUN_ID="public-matrix-codex-bf9b2643-20260515T052919Z"
LEGACY_MEMORYARENA_FALLBACK_SUFFIX="bf9b264"
LATEST_MEMORYARENA_RUN_ID="$(latest_memoryarena_run_id)"
REPO="${REPO:-$(git -C "${REPO_ROOT}" remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?$#\1#')}"
RUN_ID="${RUN_ID:-${ACTIVE_SESSION:-${LATEST_MEMORYARENA_RUN_ID:-${LEGACY_MEMORYARENA_RUN_ID}}}}"
ACTIVE_SESSION="${ACTIVE_SESSION:-${RUN_ID}}"
RUN_BRANCH_SUFFIX="$(printf '%s' "${RUN_ID}" | sed -E 's/^public-.*-codex-([[:alnum:]]+)-[0-9]{8}T[0-9]{6}Z$/\1/')"
if [[ "${RUN_BRANCH_SUFFIX}" == "${RUN_ID}" ]]; then
  RUN_BRANCH_SUFFIX="${LEGACY_MEMORYARENA_FALLBACK_SUFFIX}"
fi
WATCHER_SESSION="${WATCHER_SESSION:-remnic-memoryarena-publish-watcher-${RUN_BRANCH_SUFFIX}}"
MEMORYARENA_BRANCH="${MEMORYARENA_BRANCH:-codex/publish-memoryarena-sota-${RUN_BRANCH_SUFFIX}}"
BASE_BRANCH="${BASE_BRANCH:-bench/public-matrix-codex}"
BENCHMARK="${1:-amemgym}"

if tmux has-session -t "${ACTIVE_SESSION}" 2>/dev/null; then
  echo "waiting: MemoryArena scoring session ${ACTIVE_SESSION} is still running" >&2
  exit 0
fi

if tmux has-session -t "${WATCHER_SESSION}" 2>/dev/null; then
  echo "waiting: MemoryArena publish watcher ${WATCHER_SESSION} is still running" >&2
  exit 0
fi

pr_number="$(gh pr list \
  --repo "${REPO}" \
  --head "${MEMORYARENA_BRANCH}" \
  --base "${BASE_BRANCH}" \
  --state all \
  --json number,state \
  --jq 'map(select(.state == "OPEN" or .state == "MERGED")) | sort_by(.number) | reverse | .[0].number // empty')"

if [[ -z "${pr_number}" ]]; then
  echo "waiting: no MemoryArena evidence PR found for ${MEMORYARENA_BRANCH} -> ${BASE_BRANCH}" >&2
  exit 0
fi

set +e
clean_output="$(node "${SCRIPT_DIR}/verify-pr-clean.mjs" \
  --repo "${REPO}" \
  --pr "${pr_number}" \
  --wait-seconds 1800 2>&1)"
clean_status=$?
set -e
printf '%s\n' "${clean_output}"
if [[ "${clean_status}" -ne 0 ]]; then
  echo "waiting: MemoryArena evidence PR #${pr_number} is not clean yet" >&2
  exit 0
fi

set +e
launch_output="$(bash "${SCRIPT_DIR}/launch-next-public-benchmark.sh" "${BENCHMARK}" 2>&1)"
launch_status=$?
set -e
printf '%s\n' "${launch_output}"
if [[ "${launch_status}" -eq 3 ]]; then
  echo "waiting: active public benchmark scoring session blocked ${BENCHMARK} launch; retrying" >&2
  exit 0
fi
if [[ "${launch_status}" -ne 0 ]]; then
  exit "${launch_status}"
fi

results_dir="$(printf '%s\n' "${launch_output}" | awk -F= '$1 == "results_dir" { print $2 }')"
if [[ -z "${results_dir}" ]]; then
  echo "error: launch helper did not report results_dir" >&2
  exit 2
fi

bash "${SCRIPT_DIR}/start-run-monitor.sh" "${results_dir}"
