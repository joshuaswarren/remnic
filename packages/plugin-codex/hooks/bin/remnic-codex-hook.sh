#!/usr/bin/env sh
# Thin POSIX launcher for the unified Remnic Codex hook runner (issue #1440).
# All logic lives in remnic-codex-hook.cjs; this just resolves the runner
# relative to its own location and execs node with the event name + stdin.
set -eu
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/remnic-codex-hook.cjs" "$@"
