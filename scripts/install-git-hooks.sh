#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push scripts/pr-preflight.sh scripts/cursor-prepush-review.sh

echo "Installed git hooks for $(pwd)"
echo "hooksPath=$(git config --get core.hooksPath)"
