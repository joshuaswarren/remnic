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
MANIFEST="docs/benchmarks/configs/local-lab-3090.json"
CALIBRATION_DIR="${TIERF_CALIBRATION_DIR:-$HOME/.remnic/bench/build-week-2026/calibration}"
if [[ "$CALIBRATION_DIR" == \~ || "$CALIBRATION_DIR" == \~/* ]]; then
  CALIBRATION_DIR="${CALIBRATION_DIR/#\~/$HOME}"
fi
if [[ "$CALIBRATION_DIR" != /* ]]; then
  CALIBRATION_DIR="$PWD/$CALIBRATION_DIR"
fi
# The bench ollama provider appends /generate and /tags directly to baseUrl —
# it needs the /api form (the local-lab manifest path normalizes this, the raw
# CLI flag does not).
JUDGE_ARGS=(--judge-provider ollama --judge-model "qwen2.5-7b-32k:latest" --judge-base-url "http://127.0.0.1:11434/api")
SEED=1
CALIBRATION_SAMPLE_SIZE=200
# Canonical `claude-cli`/`opus` frontier config used by judge-calibrate:
# retryOptions.timeoutMs=600000, with no endpoint, key, 429, or thinking override.
EXPECTED_FRONTIER_JUDGE_CONFIG_HASH=522bad1f22f4e031f5ab96fb13050edde876e190a45dbaf812cd2b87084d1a60

step() { printf '\n=== %s — %s ===\n' "$(date -u +%FT%TZ)" "$1"; }

# judge-calibrate is NOT re-run here (the judge pair is unchanged from the
# baseline pass); but the persisted calibration state MUST exist, or the
# real-profile artifacts carry no kappa and the publishability gate fails.
preflight_calibration_state() {
  local benchmark="$1"
  local expected_source_result_id="$2"
  local expected_answer_set_hash="$3"
  local expected_ordered_question_ids_hash="$4"
  local file="$CALIBRATION_DIR/${benchmark}.json"
  if [ ! -f "$file" ] || ! python3 -c "
import json, math, sys
d = json.load(open(sys.argv[1]))
def is_finite_number(value):
  return type(value) in (int, float) and math.isfinite(value)
assert d.get('localJudgeProvider') == 'ollama', f\"localJudgeProvider: {d.get('localJudgeProvider')}\"
assert d.get('localJudgeModel') == 'qwen2.5-7b-32k:latest', f\"localJudgeModel: {d.get('localJudgeModel')}\"
assert d.get('frontierJudgeProvider') == 'claude-cli', f\"frontierJudgeProvider: {d.get('frontierJudgeProvider')}\"
assert d.get('frontierJudgeModel') == 'opus', f\"frontierJudgeModel: {d.get('frontierJudgeModel')}\"
assert is_finite_number(d.get('kappa')), f\"kappa: {d.get('kappa')}\"
expected_sample_size = int(sys.argv[2])
assert d.get('sampleSize') == expected_sample_size, f\"sampleSize: {d.get('sampleSize')} (expected {expected_sample_size})\"
assert is_finite_number(d.get('threshold')), f\"threshold: {d.get('threshold')}\"
assert isinstance(d.get('warning'), bool), f\"warning: {d.get('warning')}\"
expected_source_result_id = sys.argv[3]
assert d.get('sourceResultId') == expected_source_result_id, f\"sourceResultId: {d.get('sourceResultId')} (expected {expected_source_result_id})\"
expected_answer_set_hash = sys.argv[4]
assert d.get('answerSetHash') == expected_answer_set_hash, f\"answerSetHash: {d.get('answerSetHash')} (expected {expected_answer_set_hash})\"
expected_ordered_question_ids_hash = sys.argv[5]
assert d.get('orderedQuestionIdsHash') == expected_ordered_question_ids_hash, f\"orderedQuestionIdsHash: {d.get('orderedQuestionIdsHash')} (expected {expected_ordered_question_ids_hash})\"
assert isinstance(d.get('sliceQuestionIds'), list), 'missing sliceQuestionIds'
assert len(d['sliceQuestionIds']) == expected_sample_size, f\"sliceQuestionIds: {len(d['sliceQuestionIds'])}\"
assert all(isinstance(question_id, str) and question_id for question_id in d['sliceQuestionIds']), 'sliceQuestionIds contains invalid ids'
assert len(set(d['sliceQuestionIds'])) == expected_sample_size, 'sliceQuestionIds contains duplicates'
ci = d.get('confidenceInterval')
assert isinstance(ci, dict), 'missing confidenceInterval'
assert all(is_finite_number(ci.get(k)) for k in ('lower', 'upper', 'level')), f\"confidenceInterval: {ci}\"
assert type(d.get('bootstrapSamples')) is int and d['bootstrapSamples'] > 0, f\"bootstrapSamples: {d.get('bootstrapSamples')}\"
for key in ('localJudgeConfigHash', 'frontierJudgeConfigHash'):
  value = d.get(key)
  assert isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value), f\"missing or invalid {key}\"
expected_frontier_judge_config_hash = sys.argv[6]
assert d.get('frontierJudgeConfigHash') == expected_frontier_judge_config_hash, f\"frontierJudgeConfigHash: {d.get('frontierJudgeConfigHash')} (expected {expected_frontier_judge_config_hash})\"
" "$file" "$CALIBRATION_SAMPLE_SIZE" "$expected_source_result_id" "$expected_answer_set_hash" "$expected_ordered_question_ids_hash" "$EXPECTED_FRONTIER_JUDGE_CONFIG_HASH" 2>/dev/null; then
    echo "BLOCKED: calibration state for ${benchmark} is missing, corrupt, unpinned, below the ${CALIBRATION_SAMPLE_SIZE}-question contract, or scoped to a different judge pair - rerun judge-calibrate against the pinned answer source." >&2
    exit 3
  fi
}

step "preflight: calibration state (from baseline pass)"
preflight_calibration_state locomo \
  6e499698-6eaf-4a06-8a81-3d90dd867e57 \
  a360907a60753d56bd066de88eb903464f1cb4f8fef89a930dd6a5f728f3ad81 \
  9a603e17ed3c0eae426243364e6a98b5b4932bfe723ed3332408b825b9860869
preflight_calibration_state longmemeval \
  a7ab6f70-5661-499e-b4b2-99bf0830368c \
  009e69a367b0d048f7db18bf51cde91b690a7520ce7246cee6f35ab9c5ca02e4 \
  9778429495a91bb01db6899743d4476c0a4f1848789fce175ef2df90d100e3f5

LONGMEM_LOCAL_HASH="$(node -p "require(process.argv[1]).localJudgeConfigHash" "$CALIBRATION_DIR/longmemeval.json")"
LONGMEM_FRONTIER_HASH="$(node -p "require(process.argv[1]).frontierJudgeConfigHash" "$CALIBRATION_DIR/longmemeval.json")"
LOCOMO_LOCAL_HASH="$(node -p "require(process.argv[1]).localJudgeConfigHash" "$CALIBRATION_DIR/locomo.json")"
LOCOMO_FRONTIER_HASH="$(node -p "require(process.argv[1]).frontierJudgeConfigHash" "$CALIBRATION_DIR/locomo.json")"

step "preflight: claude auth (real-profile pass)"
AUTH_OUT="$(cd /tmp && timeout 180 claude -p "Reply with exactly: pong" --max-turns 1 2>&1 | tail -1)"
printf 'claude probe: %s\n' "$AUTH_OUT"
if [[ "$AUTH_OUT" != *pong* ]]; then
  echo "BLOCKED: claude CLI is not authenticated on this host. Run: claude /login" >&2
  exit 2
fi

step "full LongMemEval (500 tasks) — real profile, Opus responder, local judge"
node scripts/run-bench-cli.mjs run longmemeval \
  --runtime-profile real \
  --remnic-config "$REMNIC_CONFIG" \
  --system-provider claude-cli --system-model opus \
  "${JUDGE_ARGS[@]}" \
  --local-lab-manifest "$MANIFEST" \
  --request-timeout 180000 \
  --dataset-dir bench-datasets/longmemeval \
  --calibration-dir "$CALIBRATION_DIR" \
  --calibration-local-config-sha256 "$LONGMEM_LOCAL_HASH" \
  --calibration-frontier-config-sha256 "$LONGMEM_FRONTIER_HASH" \
  --seed "$SEED" \
  2>&1 | tee "$LOG_DIR/longmemeval-full-real.log"

step "full LoCoMo (1986 tasks) — real profile, Opus responder, local judge"
node scripts/run-bench-cli.mjs run locomo \
  --runtime-profile real \
  --remnic-config "$REMNIC_CONFIG" \
  --system-provider claude-cli --system-model opus \
  "${JUDGE_ARGS[@]}" \
  --local-lab-manifest "$MANIFEST" \
  --request-timeout 180000 \
  --dataset-dir bench-datasets/locomo \
  --calibration-dir "$CALIBRATION_DIR" \
  --calibration-local-config-sha256 "$LOCOMO_LOCAL_HASH" \
  --calibration-frontier-config-sha256 "$LOCOMO_FRONTIER_HASH" \
  --seed "$SEED" \
  2>&1 | tee "$LOG_DIR/locomo-full-real.log"

step "done — results in ~/.remnic/bench/results/"
ls -t "$HOME/.remnic/bench/results/" | head -6
