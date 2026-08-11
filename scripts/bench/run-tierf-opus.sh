#!/usr/bin/env bash
# Tier-F run via Opus 4.8 / Claude Code (`claude -p`) — issue #1728.
#
# Responder: claude-cli / opus (Claude Max entitlement; the claude-cli bench
# provider runs from an isolated empty temp workspace with tools disabled).
# Judge: local RTX 3090 ollama qwen2.5-7b-32k:latest — the Tier-L judge role
# pinned in docs/benchmarks/configs/local-lab-3090.json, calibrated against
# an Opus-judged slice (Cohen's kappa) BEFORE the full runs so every stored
# result carries `judgeCalibration` (PR #1709 gap).
#
# Prerequisites (operator):
#   1. `claude /login` completed on this host (Claude Max).
#   2. Datasets under ./bench-datasets/{locomo,longmemeval}.
#   3. Ollama serving qwen2.5-7b-32k:latest on 127.0.0.1:11434.
#
# Order matters: judge-calibrate persists the kappa state that
# attachPersistedJudgeCalibration stamps into subsequent run results at
# write time — calibrate first, then run. LongMemEval (500 tasks, ~1.3 h of
# responder time) runs before LoCoMo (1986 tasks, ~4 h) so a Claude Max
# window cap hits the smaller run last. The claude-cli provider serializes
# to concurrency 1 and backs off on usage-limit responses; if the weekly
# quota trips mid-run, rerun this script after the window resets — the
# judge cache makes re-judging cached answers free, but responder calls for
# incomplete tasks are re-paid (no per-task checkpoint exists yet).
set -euo pipefail

cd "$(dirname "$0")/../.."
LOG_DIR="${TIERF_LOG_DIR:-$HOME/tierf-logs}"
mkdir -p "$LOG_DIR"
MANIFEST="docs/benchmarks/configs/local-lab-3090.json"
# The bench ollama provider appends /generate and /tags directly to baseUrl —
# it needs the /api form (the local-lab manifest path normalizes this, the raw
# CLI flag does not).
JUDGE_ARGS=(--judge-provider ollama --judge-model "qwen2.5-7b-32k:latest" --judge-base-url "http://127.0.0.1:11434/api")
CALIBRATION_DIR="${TIERF_CALIBRATION_DIR:-$HOME/.remnic/bench/build-week-2026/calibration}"
SEED=1

# judge-calibrate does NOT generate answers — it re-judges a benchmark's
# CACHED answers from an existing FULL stored result in ~/.remnic/bench/results
# (the Tier-L pass produced these on the lab host). Fail up front with a clear
# message instead of erroring mid-script on a clean runner (codex P2).
preflight_calibration_inputs() {
  local benchmark="$1"
  if ! ls "$HOME/.remnic/bench/results/${benchmark}-v"*.json >/dev/null 2>&1; then
    echo "BLOCKED: judge-calibrate needs an existing FULL stored ${benchmark} result (cached answers) in ~/.remnic/bench/results — run the Tier-L pass first (see docs/benchmarks.md)." >&2
    exit 3
  fi
}

step() { printf '\n=== %s — %s ===\n' "$(date -u +%FT%TZ)" "$1"; }

step "preflight: claude auth"
AUTH_OUT="$(cd /tmp && timeout 180 claude -p "Reply with exactly: pong" --max-turns 1 2>&1 | tail -1)"
printf 'claude probe: %s\n' "$AUTH_OUT"
if [[ "$AUTH_OUT" != *pong* ]]; then
  echo "BLOCKED: claude CLI is not authenticated on this host. Run: claude /login" >&2
  exit 2
fi

step "preflight: cached answers for calibration"
preflight_calibration_inputs locomo
preflight_calibration_inputs longmemeval

step "judge calibration (Cohen's kappa) — locomo"
node scripts/run-bench-cli.mjs judge-calibrate --benchmark locomo \
  --local-lab-manifest "$MANIFEST" \
  --judge-provider claude-cli --judge-model opus \
  --source-result-id 6e499698-6eaf-4a06-8a81-3d90dd867e57 \
  --expected-answer-set-sha256 a360907a60753d56bd066de88eb903464f1cb4f8fef89a930dd6a5f728f3ad81 \
  --expected-question-id-list-sha256 9a603e17ed3c0eae426243364e6a98b5b4932bfe723ed3332408b825b9860869 \
  --calibration-dir "$CALIBRATION_DIR" \
  --local-judge-request-timeout 180000 --frontier-judge-request-timeout 600000 \
  2>&1 | tee "$LOG_DIR/judge-calibrate-locomo.log"

step "judge calibration (Cohen's kappa) — longmemeval"
node scripts/run-bench-cli.mjs judge-calibrate --benchmark longmemeval \
  --local-lab-manifest "$MANIFEST" \
  --judge-provider claude-cli --judge-model opus \
  --source-result-id a7ab6f70-5661-499e-b4b2-99bf0830368c \
  --expected-answer-set-sha256 009e69a367b0d048f7db18bf51cde91b690a7520ce7246cee6f35ab9c5ca02e4 \
  --expected-question-id-list-sha256 9778429495a91bb01db6899743d4476c0a4f1848789fce175ef2df90d100e3f5 \
  --calibration-dir "$CALIBRATION_DIR" \
  --local-judge-request-timeout 180000 --frontier-judge-request-timeout 600000 \
  2>&1 | tee "$LOG_DIR/judge-calibrate-longmemeval.log"

step "full LongMemEval (500 tasks) — Opus responder, local judge"
LONGMEM_LOCAL_HASH="$(node -p "require(process.argv[1]).localJudgeConfigHash" "$CALIBRATION_DIR/longmemeval.json")"
LONGMEM_FRONTIER_HASH="$(node -p "require(process.argv[1]).frontierJudgeConfigHash" "$CALIBRATION_DIR/longmemeval.json")"
node scripts/run-bench-cli.mjs run longmemeval \
  --runtime-profile baseline \
  --system-provider claude-cli --system-model opus \
  "${JUDGE_ARGS[@]}" \
  --local-lab-manifest "$MANIFEST" \
  --request-timeout 180000 \
  --dataset-dir bench-datasets/longmemeval \
  --calibration-dir "$CALIBRATION_DIR" \
  --calibration-local-config-sha256 "$LONGMEM_LOCAL_HASH" \
  --calibration-frontier-config-sha256 "$LONGMEM_FRONTIER_HASH" \
  --seed "$SEED" \
  2>&1 | tee "$LOG_DIR/longmemeval-full.log"

step "full LoCoMo (1986 tasks) — Opus responder, local judge"
LOCOMO_LOCAL_HASH="$(node -p "require(process.argv[1]).localJudgeConfigHash" "$CALIBRATION_DIR/locomo.json")"
LOCOMO_FRONTIER_HASH="$(node -p "require(process.argv[1]).frontierJudgeConfigHash" "$CALIBRATION_DIR/locomo.json")"
node scripts/run-bench-cli.mjs run locomo \
  --runtime-profile baseline \
  --system-provider claude-cli --system-model opus \
  "${JUDGE_ARGS[@]}" \
  --local-lab-manifest "$MANIFEST" \
  --request-timeout 180000 \
  --dataset-dir bench-datasets/locomo \
  --calibration-dir "$CALIBRATION_DIR" \
  --calibration-local-config-sha256 "$LOCOMO_LOCAL_HASH" \
  --calibration-frontier-config-sha256 "$LOCOMO_FRONTIER_HASH" \
  --seed "$SEED" \
  2>&1 | tee "$LOG_DIR/locomo-full.log"

step "done — results in ~/.remnic/bench/results/"
ls -t "$HOME/.remnic/bench/results/" | head -6
