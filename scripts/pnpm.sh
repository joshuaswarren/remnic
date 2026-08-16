#!/usr/bin/env bash
set -Eeuo pipefail

exec npm exec --yes pnpm@10.32.1 -- "$@"
