#!/usr/bin/env bash
# Non-interactive omp. Hub/pipe spawners hang in readPipedInput unless stdin
# is a real EOF. Always exec with </dev/null.
set -euo pipefail
exec omp --mode text --print --approval-mode yolo "$@" </dev/null
