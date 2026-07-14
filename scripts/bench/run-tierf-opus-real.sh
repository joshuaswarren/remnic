#!/usr/bin/env bash
# Tier-F FULL-FEATURE pass — Opus 4.8 via `claude -p` responder, real profile.
#
# Sibling of run-tierf-opus.sh (the baseline-profile pass). Operator decision
# 2026-07-13: run BOTH — baseline stays anchor-comparable with the committed
# Tier-L artifacts; this pass measures Remnic's shipped defaults (QMD hybrid
# search, knowledge index, entity retrieval, verified recall, Memory Boxes,
# contradiction detection, ... — everything parseConfig enables by default),
# with only the local-LLM endpoint pinned via
# docs/benchmarks/configs/tierf-real-remnic-config.json.
#
# Judge: the same calibrated local 3090 judge as the baseline pass (kappa
# persisted per benchmark by `remnic bench judge-calibrate`; locomo carries
# its below-threshold warning honestly). Calibration is NOT re-run here —
# the judge pair is unchanged.
#
# Note: the published LoCoMo runner forces replayExtractionMode: "skip" by
# harness design (1986-task ingest extraction is deliberately not paid), so
# fact-pipeline features contribute mainly through LongMemEval and through
# LoCoMo's recall-side features (QMD, rerank, verified recall).
set -euo pipefail

cd "$(dirname "$0")/../.."
LOG_DIR="${TIERF_LOG_DIR:-$HOME/tierf-logs}"
mkdir -p "$LOG_DIR"
REMNIC_CONFIG="docs/benchmarks/configs/tierf-real-remnic-config.json"
# The bench ollama provider appends /generate and /tags directly to baseUrl —
# it needs the /api form (the local-lab manifest path normalizes this, the raw
# CLI flag does not).
JUDGE_ARGS=(--judge-provider ollama --judge-model "qwen2.5-7b-32k:latest" --judge-base-url "http://127.0.0.1:11434/api")
SEED=1

step() { printf '\n=== %s — %s ===\n' "$(date -u +%FT%TZ)" "$1"; }

step "preflight: claude auth (real-profile pass)"
AUTH_OUT="$(cd /tmp && timeout 180 claude -p "Reply with exactly: pong" --max-turns 1 2>&1 | tail -1)"
printf 'claude probe: %s\n' "$AUTH_OUT"
if [[ "$AUTH_OUT" != *pong* ]]; then
  echo "BLOCKED: claude CLI is not authenticated on this host. Run: claude /login" >&2
  exit 2
fi

# judge-calibrate is NOT re-run here (the judge pair is unchanged from the
# baseline pass); but the persisted calibration state MUST exist, or the
# real-profile artifacts carry no kappa and the publishability gate fails.
preflight_calibration_state() {
  local benchmark="$1"
  local file="$HOME/.remnic/bench/calibration/${benchmark}.json"
  if [ ! -f "$file" ] || ! python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get('localJudgeProvider') == 'ollama', f\"localJudgeProvider: {d.get('localJudgeProvider')}\"
assert d.get('localJudgeModel') == 'qwen2.5-7b-32k:latest', f\"localJudgeModel: {d.get('localJudgeModel')}\"
assert d.get('frontierJudgeProvider') == 'claude-cli', f\"frontierJudgeProvider: {d.get('frontierJudgeProvider')}\"
assert d.get('frontierJudgeModel') == 'opus', f\"frontierJudgeModel: {d.get('frontierJudgeModel')}\"
assert isinstance(d.get('kappa'), (int, float)), f\"kappa: {d.get('kappa')}\"
assert isinstance(d.get('sampleSize'), int), f\"sampleSize: {d.get('sampleSize')}\"
assert isinstance(d.get('threshold'), (int, float)), f\"threshold: {d.get('threshold')}\"
assert isinstance(d.get('warning'), bool), f\"warning: {d.get('warning')}\"
" "$file" 2>/dev/null; then
    echo "BLOCKED: calibration state for ${benchmark} is missing, corrupt, or scoped to a different judge pair - run the baseline pass first." >&2
    exit 3
  fi
}

step "preflight: calibration state (from baseline pass)"
preflight_calibration_state locomo
preflight_calibration_state longmemeval

step "full LongMemEval (500 tasks) — real profile, Opus responder, local judge"
node scripts/run-bench-cli.mjs run longmemeval \
  --runtime-profile real \
  --remnic-config "$REMNIC_CONFIG" \
  --system-provider claude-cli --system-model opus \
  "${JUDGE_ARGS[@]}" \
  --dataset-dir bench-datasets/longmemeval \
  --seed "$SEED" \
  2>&1 | tee "$LOG_DIR/longmemeval-full-real.log"

step "full LoCoMo (1986 tasks) — real profile, Opus responder, local judge"
node scripts/run-bench-cli.mjs run locomo \
  --runtime-profile real \
  --remnic-config "$REMNIC_CONFIG" \
  --system-provider claude-cli --system-model opus \
  "${JUDGE_ARGS[@]}" \
  --dataset-dir bench-datasets/locomo \
  --seed "$SEED" \
  2>&1 | tee "$LOG_DIR/locomo-full-real.log"

step "done — results in ~/.remnic/bench/results/"
ls -t "$HOME/.remnic/bench/results/" | head -6
