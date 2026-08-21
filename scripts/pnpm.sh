#!/usr/bin/env bash
set -Eeuo pipefail

PINNED_PNPM="pnpm@10.32.1"
PINNED_VERSION="${PINNED_PNPM#pnpm@}"

# Prefer a pnpm already on PATH whose version matches the pin.
#
# CI installs exactly this version via pnpm/action-setup before every job, so
# the `npm exec` fallback below is a pure npm-registry round trip on each
# invocation — and the root `check-types` script invokes this wrapper three
# times. A transient registry failure there (observed: ETIMEDOUT resolving
# https://registry.npmjs.org/pnpm) fails the `checks` job, which cascades into
# the required `quality` gate and blocks merge on a PR whose code is clean.
#
# Resolving from PATH removes the network dependency entirely on any machine
# that already has the pinned version. The version equality check keeps the pin
# authoritative: a different local pnpm still routes through `npm exec`.
if command -v pnpm >/dev/null 2>&1 &&
  [ "$(pnpm --version 2>/dev/null || true)" = "$PINNED_VERSION" ]; then
  exec pnpm "$@"
fi

exec npm exec --yes "$PINNED_PNPM" -- "$@"
