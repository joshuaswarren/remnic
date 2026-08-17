#!/usr/bin/env bash
set -euo pipefail

# Staggered `gh pr create` (parallel-run defect, 2026-08).
#
# Opening several PRs at once reliably trips GitHub 429/502/503. This wrapper
# serializes creates behind a lock and enforces a 65s gap (override with
# REMNIC_PR_CREATE_GAP_SEC) between consecutive creates, system-wide, via a
# stamp file under TMPDIR. The wait math lives in scripts/pr-create-stagger.mjs
# and is unit-tested there.
#
# Usage: scripts/gh-pr-create-stagger.sh <normal gh pr create args...>

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stagger_dir="${TMPDIR:-/tmp}/remnic-pr-create-stagger"
lock_file="$stagger_dir/lock"
stamp_file="$stagger_dir/stamp"

# Predictable path under a shared TMPDIR: keep the dir private and refuse one
# we do not own, a symlinked dir, or symlinked lock/stamp — otherwise a local
# attacker can bypass the serialization or redirect the stamp write.
# ponytail: check-then-open TOCTOU remains; O_NOFOLLOW would need a helper binary.
mkdir -p "$stagger_dir" 2>/dev/null || {
  echo "gh-pr-create-stagger: cannot create stagger dir: $stagger_dir" >&2
  exit 2
}
if [[ -L "$stagger_dir" || ! -d "$stagger_dir" || ! -O "$stagger_dir" ]]; then
  echo "gh-pr-create-stagger: refusing unsafe stagger dir: $stagger_dir" >&2
  exit 2
fi
chmod 0700 "$stagger_dir"
for state_file in "$lock_file" "$stamp_file"; do
  if [[ -L "$state_file" ]]; then
    echo "gh-pr-create-stagger: refusing symlinked state file: $state_file" >&2
    exit 2
  fi
done

# Hold the lock across wait + create so concurrent creators serialize with the
# full gap between them, then release on exit.
exec 9>"$lock_file"
flock 9

if [[ -f "$stamp_file" ]]; then
  last="$(cat "$stamp_file" 2>/dev/null || true)"
  if [[ -n "$last" ]]; then
    wait_seconds="$(node "$script_dir/pr-create-stagger.mjs" --wait-seconds "$last")"
    if [[ "$wait_seconds" =~ ^[0-9]+$ ]] && (( wait_seconds > 0 )); then
      echo "gh-pr-create-stagger: waiting ${wait_seconds}s (gap since last create)" >&2
      sleep "$wait_seconds"
    fi
  fi
fi

# A create rejected by rate limiting still consumed quota window time, so the
# stamp is written on failure too — never hammer through a 429.
set +e
gh pr create "$@"
rc=$?
set -e

date +%s > "$stamp_file"
exit "$rc"
