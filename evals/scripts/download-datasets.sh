#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PACKAGE_SCRIPT="$REPO_ROOT/packages/remnic-cli/assets/download-datasets.sh"

if [[ ! -f "$PACKAGE_SCRIPT" ]]; then
  echo "Remnic dataset downloader not found at: $PACKAGE_SCRIPT" >&2
  exit 1
fi

export DATASETS_DIR="${DATASETS_DIR:-$REPO_ROOT/evals/datasets}"

exec bash "$PACKAGE_SCRIPT" "$@"
