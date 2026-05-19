#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Honor an explicit DATASETS_DIR from the environment so packaged CLI
# installs can route downloads to a user-writable location (e.g.
# ~/.remnic/bench/datasets) instead of a sibling of the script dir.
DATASETS_DIR="${DATASETS_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/datasets}"

usage() {
  echo "Usage: $0 [--benchmark <name>]"
  echo ""
  echo "Downloads benchmark datasets for the Remnic bench suite."
  echo ""
  echo "Benchmarks: ama-bench, longmemeval, amemgym, locomo, memory-arena, beam, personamem, membench, memoryagentbench, all"
  echo ""
  echo "Options:"
  echo "  --benchmark <name>   Download only the specified benchmark (default: all)"
  echo "  --help               Show this help"
  exit 0
}

BENCHMARK="all"
while [[ $# -gt 0 ]]; do
  case $1 in
    --benchmark) BENCHMARK="$2"; shift 2 ;;
    --help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

check_deps() {
  for cmd in git curl; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "ERROR: $cmd is required but not found"
      exit 1
    fi
  done
}

PYTHON_BIN=""

python_has_modules() {
  local python_bin="$1"
  shift

  "$python_bin" - "$@" <<'PY'
import sys

try:
    import importlib.util as importlib_util
except Exception:  # pragma: no cover - Python 2 fallback
    importlib_util = None
    import pkgutil


def has_module(name):
    if importlib_util is not None:
        return importlib_util.find_spec(name) is not None
    return pkgutil.find_loader(name) is not None


missing = [name for name in sys.argv[1:] if not has_module(name)]
if missing:
    names = ", ".join(missing)
    sys.stderr.write(
        "ERROR: missing required Python module(s): {}. Install them before downloading this dataset.\n".format(
            names
        )
    )
    sys.exit(1)
PY
}

resolve_python_bin() {
  if [[ -n "$PYTHON_BIN" ]]; then
    if [[ $# -eq 0 ]] || python_has_modules "$PYTHON_BIN" "$@" >/dev/null 2>&1; then
      printf '%s\n' "$PYTHON_BIN"
      return 0
    fi
  fi

  local candidate
  local found_any=0
  for candidate in python3 python; do
    if ! command -v "$candidate" &>/dev/null; then
      continue
    fi
    found_any=1
    if [[ $# -gt 0 ]] && ! python_has_modules "$candidate" "$@" >/dev/null 2>&1; then
      continue
    fi
    PYTHON_BIN="$candidate"
    printf '%s\n' "$PYTHON_BIN"
    return 0
  done

  if [[ $found_any -eq 1 && $# -gt 0 ]]; then
    local names
    names=$(printf '%s, ' "$@")
    names=${names%, }
    echo "ERROR: missing required Python module(s): $names. Install them before downloading this dataset."
    exit 1
  fi

  echo "ERROR: python or python3 is required but not found"
  exit 1
}

require_python_modules() {
  resolve_python_bin "$@" >/dev/null
}

download_ama_bench() {
  local dir="$DATASETS_DIR/ama-bench"
  if [[ -f "$dir/open_end_qa_set.jsonl" ]]; then
    echo "[ama-bench] Already downloaded at $dir"
    return
  fi
  echo "[ama-bench] Downloading from HuggingFace (AMA-bench/AMA-bench)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://huggingface.co/datasets/AMA-bench/AMA-bench "$tmpdir/repo" 2>/dev/null || {
    echo "[ama-bench] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://huggingface.co/datasets/AMA-bench/AMA-bench /tmp/amabench"
    echo "  cp /tmp/amabench/test/open_end_qa_set.jsonl $dir/"
    rm -rf "$tmpdir"
    return 1
  }
  cp "$tmpdir/repo/test/open_end_qa_set.jsonl" "$dir/" 2>/dev/null || true
  rm -rf "$tmpdir"
  echo "[ama-bench] Downloaded to $dir ($(wc -l < "$dir/open_end_qa_set.jsonl") episodes)"
}

download_longmemeval() {
  local dir="$DATASETS_DIR/longmemeval"
  if [[ -f "$dir/longmemeval_oracle.json" ]]; then
    echo "[longmemeval] Already downloaded at $dir"
    return
  fi
  echo "[longmemeval] Downloading from HuggingFace (xiaowu0162/longmemeval-cleaned)..."
  mkdir -p "$dir"
  curl -sL "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json" \
    -o "$dir/longmemeval_oracle.json"
  if [[ ! -s "$dir/longmemeval_oracle.json" ]]; then
    echo "[longmemeval] ERROR: Download failed. Try manually:"
    echo "  curl -sL https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json -o $dir/longmemeval_oracle.json"
    rm -f "$dir/longmemeval_oracle.json"
    return 1
  fi
  echo "[longmemeval] Downloaded to $dir ($(du -h "$dir/longmemeval_oracle.json" | cut -f1))"
}

download_amemgym() {
  local dir="$DATASETS_DIR/amemgym"
  if [[ -f "$dir/amemgym-v1-base.json" ]]; then
    echo "[amemgym] Already downloaded at $dir"
    return
  fi
  echo "[amemgym] Downloading from HuggingFace (AGI-Eval/AMemGym)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://huggingface.co/datasets/AGI-Eval/AMemGym "$tmpdir/repo" 2>/dev/null || {
    echo "[amemgym] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://huggingface.co/datasets/AGI-Eval/AMemGym /tmp/amemgym"
    echo "  cp /tmp/amemgym/v1.base/data.json $dir/amemgym-v1-base.json"
    rm -rf "$tmpdir"
    return 1
  }
  cp "$tmpdir/repo/v1.base/data.json" "$dir/amemgym-v1-base.json" 2>/dev/null || true
  rm -rf "$tmpdir"
  echo "[amemgym] Downloaded to $dir"
}

download_locomo() {
  local dir="$DATASETS_DIR/locomo"
  if [[ -f "$dir/locomo10.json" ]]; then
    echo "[locomo] Already downloaded at $dir"
    return
  fi
  echo "[locomo] Downloading from GitHub (snap-research/locomo)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://github.com/snap-research/locomo.git "$tmpdir/repo" 2>/dev/null || {
    echo "[locomo] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://github.com/snap-research/locomo.git /tmp/locomo"
    echo "  cp /tmp/locomo/data/locomo10.json $dir/"
    rm -rf "$tmpdir"
    return 1
  }
  cp "$tmpdir/repo/data/locomo10.json" "$dir/" 2>/dev/null || true
  rm -rf "$tmpdir"
  echo "[locomo] Downloaded to $dir ($(du -h "$dir/locomo10.json" | cut -f1))"
}

download_memory_arena() {
  local dir="$DATASETS_DIR/memory-arena"
  if [[ -d "$dir" ]] && ls "$dir"/*.jsonl &>/dev/null; then
    echo "[memory-arena] Already downloaded at $dir"
    return
  fi
  echo "[memory-arena] Downloading from HuggingFace (ZexueHe/memoryarena)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://huggingface.co/datasets/ZexueHe/memoryarena "$tmpdir/repo" 2>/dev/null || {
    echo "[memory-arena] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://huggingface.co/datasets/ZexueHe/memoryarena /tmp/memoryarena"
    echo "  for d in /tmp/memoryarena/*/; do cp \"\$d/data.jsonl\" \"$dir/\$(basename \$d).jsonl\"; done"
    rm -rf "$tmpdir"
    return 1
  }
  for d in "$tmpdir/repo"/*/; do
    local name
    name=$(basename "$d")
    if [[ -f "$d/data.jsonl" ]]; then
      cp "$d/data.jsonl" "$dir/${name}.jsonl"
    fi
  done
  rm -rf "$tmpdir"
  local count
  count=$(ls "$dir"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  echo "[memory-arena] Downloaded to $dir ($count domains)"
}

download_beam() {
  local dir="$DATASETS_DIR/beam"
  if [[ -f "$dir/beam_100k.json" && -f "$dir/beam_500k.json" && -f "$dir/beam_1m.json" && -f "$dir/beam_10m.json" ]]; then
    echo "[beam] Already downloaded at $dir"
    return
  fi
  echo "[beam] Downloading from Hugging Face parquet sources (Mohammadta/BEAM, Mohammadta/BEAM-10M)..."
  mkdir -p "$dir"
  require_python_modules huggingface_hub pyarrow
  local python_bin
  python_bin="$(resolve_python_bin)"
  "$python_bin" - "$dir" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

out_dir = Path(sys.argv[1])
out_dir.mkdir(parents=True, exist_ok=True)

targets = [
    ("Mohammadta/BEAM", ["data/100K-00000-of-00001.parquet"], "beam_100k.json"),
    ("Mohammadta/BEAM", ["data/500K-00000-of-00001.parquet"], "beam_500k.json"),
    ("Mohammadta/BEAM", ["data/1M-00000-of-00001.parquet"], "beam_1m.json"),
    (
        "Mohammadta/BEAM-10M",
        ["data/10M-00000-of-00002.parquet", "data/10M-00001-of-00002.parquet"],
        "beam_10m.json",
    ),
]

for repo_id, parquet_files, output_name in targets:
    output_path = out_dir / output_name
    if output_path.exists() and output_path.stat().st_size > 0:
        print(f"[beam] Reusing {output_name}")
        continue

    rows: list[dict] = []
    for parquet_file in parquet_files:
        parquet_path = hf_hub_download(
            repo_id=repo_id,
            repo_type="dataset",
            filename=parquet_file,
        )
        rows.extend(pq.read_table(parquet_path).to_pylist())

    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(rows, handle, ensure_ascii=False)
    print(f"[beam] Wrote {output_name} ({len(rows)} conversations)")
PY
  echo "[beam] Downloaded to $dir"
}

download_personamem() {
  local dir="$DATASETS_DIR/personamem"
  if [[ -f "$dir/benchmark/text/benchmark.csv" ]] \
    && [[ -f "$dir/data/chat_history_32k/.download-complete" ]]; then
    echo "[personamem] Already downloaded at $dir"
    return
  fi
  echo "[personamem] Downloading from Hugging Face (bowen-upenn/PersonaMem-v2)..."
  mkdir -p "$dir"
  require_python_modules huggingface_hub
  local python_bin
  python_bin="$(resolve_python_bin)"
  "$python_bin" - "$dir" <<'PY'
from __future__ import annotations

import csv
import os
import shutil
import sys
import time
from pathlib import Path, PurePosixPath

from huggingface_hub import hf_hub_download

REPO_ID = "bowen-upenn/PersonaMem-v2"
BENCHMARK_PATH = "benchmark/text/benchmark.csv"

out_dir = Path(sys.argv[1])
out_dir.mkdir(parents=True, exist_ok=True)
out_dir_root = out_dir.resolve()
token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def resolve_dataset_destination(relative_path: str) -> tuple[str, Path]:
    normalized = relative_path.strip().replace("\\", "/")
    if not normalized:
        raise ValueError("dataset path cannot be empty")

    posix_path = PurePosixPath(normalized)
    if posix_path.is_absolute():
        raise ValueError(
            f'PersonaMem dataset file reference "{relative_path}" must stay within dataset root.'
        )

    safe_parts = []
    for part in posix_path.parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise ValueError(
                f'PersonaMem dataset file reference "{relative_path}" must stay within dataset root.'
            )
        safe_parts.append(part)

    if not safe_parts:
        raise ValueError("dataset path cannot resolve to the dataset root")

    destination = (out_dir / Path(*safe_parts)).resolve()
    try:
        destination.relative_to(out_dir_root)
    except ValueError as exc:
        raise ValueError(
            f'PersonaMem dataset file reference "{relative_path}" must stay within dataset root.'
        ) from exc

    return PurePosixPath(*safe_parts).as_posix(), destination


def copy_dataset_file(relative_path: str) -> Path:
    safe_relative_path, destination = resolve_dataset_destination(relative_path)
    source = Path(
        hf_hub_download(
            repo_id=REPO_ID,
            repo_type="dataset",
            filename=safe_relative_path,
            token=token,
        )
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return destination


benchmark_destination = copy_dataset_file(BENCHMARK_PATH)

with benchmark_destination.open("r", encoding="utf8", newline="") as handle:
    reader = csv.DictReader(handle)
    history_paths = sorted(
        {
            (row.get("chat_history_32k_link") or "").strip()
            for row in reader
            if (row.get("chat_history_32k_link") or "").strip()
        }
    )

if not history_paths:
    raise SystemExit("PersonaMem benchmark.csv did not contain any chat_history_32k_link values")

completed = 0
for index, relative_path in enumerate(history_paths, start=1):
    _, destination = resolve_dataset_destination(relative_path)
    if destination.is_file():
        completed += 1
        continue

    for attempt in range(1, 6):
        try:
            copy_dataset_file(relative_path)
            completed += 1
            break
        except Exception as exc:  # noqa: BLE001
            if attempt == 5:
                raise SystemExit(
                    f"failed to download PersonaMem asset {relative_path}: {exc}"
                ) from exc
            delay_seconds = min(30, 2 ** attempt)
            print(
                f"[personamem] Retry {attempt}/5 for {relative_path} after error: {exc}. "
                f"Sleeping {delay_seconds}s..."
            )
            time.sleep(delay_seconds)

    if index % 100 == 0 or index == len(history_paths):
        print(f"[personamem] Downloaded {completed}/{len(history_paths)} chat histories")

print(
    f"[personamem] Mirrored benchmark.csv and {completed} chat histories into {out_dir}"
)
PY
  touch "$dir/data/chat_history_32k/.download-complete"
  echo "[personamem] Downloaded to $dir"
}

download_membench() {
  local dir="$DATASETS_DIR/membench"
  if [[ -f "$dir/membench.json" ]]; then
    echo "[membench] Already downloaded at $dir"
    return
  fi
  echo "[membench] Downloading and normalizing from GitHub (import-myself/Membench)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://github.com/import-myself/Membench.git "$tmpdir/repo" 2>/dev/null || {
    echo "[membench] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://github.com/import-myself/Membench.git /tmp/membench"
    rm -rf "$tmpdir"
    return 1
  }
  local python_bin
  python_bin="$(resolve_python_bin)"
  "$python_bin" - "$tmpdir/repo" "$dir/membench.json" <<'PY'
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

repo_root = Path(sys.argv[1])
output_path = Path(sys.argv[2])

def normalize_text(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        for item in value:
            text = normalize_text(item)
            if text:
                return text
        return ""
    if value is None:
        return ""
    return str(value).strip()

def sanitize_case_id(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")

def iter_qa_entries(value):
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return [entry for entry in value if isinstance(entry, dict)]
    return []

def build_turns(message_list):
    turns = []
    if not isinstance(message_list, list):
        return turns
    for session in message_list:
        if isinstance(session, dict):
            session = [session]
        if not isinstance(session, list):
            continue
        for step in session:
            if not isinstance(step, dict):
                continue
            user = normalize_text(step.get("user"))
            assistant = normalize_text(step.get("assistant"))
            if user:
                turns.append({"role": "user", "content": user})
            if assistant:
                turns.append({"role": "assistant", "content": assistant})
    return turns

cases = []
source_roots = [
    ("FirstAgent", "participant"),
    ("ThirdAgent", "observation"),
]

for source_root, scenario in source_roots:
    for dataset_path in sorted((repo_root / "MemData" / source_root).glob("*.json")):
        label = dataset_path.stem.lower()
        memory_type = "reflective" if "highlevel" in label else "factual"
        level = "high_level" if memory_type == "reflective" else "low_level"
        document = json.loads(dataset_path.read_text(encoding="utf-8"))

        if not isinstance(document, dict):
            continue

        for group_name, entries in document.items():
            if not isinstance(entries, list):
                continue
            for entry_index, entry in enumerate(entries):
                if not isinstance(entry, dict):
                    continue

                turns = build_turns(entry.get("message_list") or entry.get("messages"))
                if not turns:
                    continue

                qa_entries = iter_qa_entries(
                    entry.get("QA")
                    or entry.get("qa")
                    or entry.get("qas")
                    or entry.get("question_answers")
                )
                for qa_index, qa in enumerate(qa_entries):
                    question = normalize_text(qa.get("question") or qa.get("query"))
                    answer = normalize_text(qa.get("answer"))
                    if not question or not answer:
                        continue

                    qid = normalize_text(
                        qa.get("qid") or qa.get("id") or qa.get("question_id") or qa_index
                    )
                    raw_id = (
                        f"{source_root}-{dataset_path.stem}-{group_name}-"
                        f"{entry_index}-{qid}"
                    )
                    case_id = sanitize_case_id(raw_id)
                    cases.append(
                        {
                            "id": case_id,
                            "memoryType": memory_type,
                            "scenario": scenario,
                            "level": level,
                            "turns": turns,
                            "question": question,
                            "answer": answer,
                        }
                    )

if not cases:
    raise SystemExit("MemBench normalization produced no runnable cases.")

output_path.parent.mkdir(parents=True, exist_ok=True)
with output_path.open("w", encoding="utf-8") as handle:
    json.dump(cases, handle, ensure_ascii=False)

print(f"[membench] Wrote {output_path.name} ({len(cases)} cases)")
PY
  rm -rf "$tmpdir"
  echo "[membench] Downloaded to $dir"
}

download_memoryagentbench() {
  local dir="$DATASETS_DIR/memoryagentbench"
  if [[ -f "$dir/Accurate_Retrieval.json" && -f "$dir/Test_Time_Learning.json" && -f "$dir/Long_Range_Understanding.json" && -f "$dir/Conflict_Resolution.json" && -f "$dir/entity2id.json" ]]; then
    echo "[memoryagentbench] Already downloaded at $dir"
    return
  fi
  echo "[memoryagentbench] Downloading from Hugging Face sources (ai-hyz/MemoryAgentBench)..."
  mkdir -p "$dir"
  require_python_modules huggingface_hub pyarrow
  local python_bin
  python_bin="$(resolve_python_bin)"
  "$python_bin" - "$dir" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

out_dir = Path(sys.argv[1])
out_dir.mkdir(parents=True, exist_ok=True)

targets = [
    ("data/Accurate_Retrieval-00000-of-00001.parquet", "Accurate_Retrieval.json"),
    ("data/Test_Time_Learning-00000-of-00001.parquet", "Test_Time_Learning.json"),
    ("data/Long_Range_Understanding-00000-of-00001.parquet", "Long_Range_Understanding.json"),
    ("data/Conflict_Resolution-00000-of-00001.parquet", "Conflict_Resolution.json"),
]

for parquet_file, output_name in targets:
    output_path = out_dir / output_name
    if output_path.exists() and output_path.stat().st_size > 0:
        print(f"[memoryagentbench] Reusing {output_name}")
        continue

    parquet_path = hf_hub_download(
        repo_id="ai-hyz/MemoryAgentBench",
        repo_type="dataset",
        filename=parquet_file,
    )
    rows = pq.read_table(parquet_path).to_pylist()
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(rows, handle, ensure_ascii=False)
    print(f"[memoryagentbench] Wrote {output_name} ({len(rows)} samples)")

entity_output_path = out_dir / "entity2id.json"
if entity_output_path.exists() and entity_output_path.stat().st_size > 0:
    print("[memoryagentbench] Reusing entity2id.json")
else:
    entity_path = hf_hub_download(
        repo_id="ai-hyz/MemoryAgentBench",
        repo_type="dataset",
        filename="entity2id.json",
    )
    with open(entity_path, "r", encoding="utf-8") as source:
        entity_mapping = json.load(source)
    with entity_output_path.open("w", encoding="utf-8") as handle:
        json.dump(entity_mapping, handle, ensure_ascii=False)
    print(f"[memoryagentbench] Wrote entity2id.json ({len(entity_mapping)} mappings)")
PY
  echo "[memoryagentbench] Downloaded to $dir"
}

# ── Main ──

check_deps
mkdir -p "$DATASETS_DIR"

case "$BENCHMARK" in
  ama-bench)      download_ama_bench ;;
  longmemeval)    download_longmemeval ;;
  amemgym)        download_amemgym ;;
  locomo)         download_locomo ;;
  memory-arena)   download_memory_arena ;;
  beam)           download_beam ;;
  personamem)     download_personamem ;;
  membench)       download_membench ;;
  memoryagentbench) download_memoryagentbench ;;
  all)
    download_ama_bench
    download_longmemeval
    download_amemgym
    download_locomo
    download_memory_arena
    download_beam
    download_personamem
    download_membench
    download_memoryagentbench
    ;;
  *)
    echo "Unknown benchmark: $BENCHMARK"
    echo "Available: ama-bench, longmemeval, amemgym, locomo, memory-arena, beam, personamem, membench, memoryagentbench, all"
    exit 1
    ;;
esac

echo ""
echo "Done. Datasets at: $DATASETS_DIR"
