#!/usr/bin/env bash
# Bootstrap a python venv for model-lab recipes (issue #1585 PR1).
#
# CI never runs this: the only CI-testable piece (the seeded data generator)
# is stdlib-only. This script is for an operator on the lab GPU box who wants
# to run train.py / eval.py.
#
# Usage:  bash model-lab/setup.sh   &&   source model-lab/.venv/bin/activate
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

python_bin="${PYTHON_BIN:-python3}"
if ! command -v "$python_bin" >/dev/null 2>&1; then
  echo "setup.sh: '$python_bin' not found on PATH." >&2
  echo "  set PYTHON_BIN to a Python 3.12+ interpreter." >&2
  exit 1
fi

# Python 3.12+ is the repo standard (global CLAUDE.md §3.1).
"$python_bin" - <<'PY'
import sys
if sys.version_info < (3, 12):
    sys.exit("setup.sh: Python 3.12+ required (repo standard), got " + sys.version)
PY

echo "[setup] creating venv with $($python_bin --version) ..."
"$python_bin" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip >/dev/null
pip install -r requirements.txt
echo
echo "[setup] model-lab venv ready."
echo "[setup] activate with:  source model-lab/.venv/bin/activate"
echo "[setup] generate data:  python model-lab/faithfulness-gate/generate-data.py --help"
