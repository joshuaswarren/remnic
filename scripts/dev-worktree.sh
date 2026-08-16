#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s <worktree-path> <branch> [base]\n' "$(basename "$0")" >&2
  exit 2
}

if (( $# < 2 || $# > 3 )); then
  usage
fi

worktree_arg=$1
branch=$2
base=${3:-HEAD}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)

if [[ $worktree_arg = /* ]]; then
  worktree_path=$worktree_arg
else
  worktree_path=$PWD/$worktree_arg
fi
worktree_path=$(realpath -m -- "$worktree_path")

if [[ -e $worktree_path || -L $worktree_path ]]; then
  printf 'Refusing to clobber existing path: %s\n' "$worktree_path" >&2
  exit 1
fi

if [[ $branch == -* ]] || ! git -C "$repo_root" check-ref-format --branch "$branch" >/dev/null 2>&1; then
  printf 'Invalid branch name: %s\n' "$branch" >&2
  exit 1
fi

if [[ $base == -* ]] || ! git -C "$repo_root" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  printf 'Base ref not found: %s\n' "$base" >&2
  exit 1
fi
mkdir -p -- "$(dirname -- "$worktree_path")"
worktree_added=0
cleanup() {
  if (( worktree_added )); then
    git -C "$repo_root" worktree remove --force "$worktree_path" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

printf 'Creating worktree at %s from %s on branch %s\n' "$worktree_path" "$base" "$branch"
git -C "$repo_root" worktree add -b "$branch" "$worktree_path" "$base"
worktree_added=1

printf 'Installing packages with pnpm@10.32.1\n'
if ! (
  cd -- "$worktree_path"
  npm exec --yes pnpm@10.32.1 -- install --frozen-lockfile
); then
  printf 'Package install failed; removed worktree: %s\n' "$worktree_path" >&2
  exit 1
fi

printf 'Running core type-check smoke check\n'
if ! (
  cd -- "$worktree_path"
  npm exec --yes pnpm@10.32.1 -- --filter @remnic/core run check-types
); then
  printf 'Smoke check failed; removed worktree: %s\n' "$worktree_path" >&2
  exit 1
fi

trap - EXIT
printf '\nWorktree ready: %s\n' "$worktree_path"
printf 'Next steps:\n'
printf '  cd %q\n' "$worktree_path"
printf '  git status\n'
printf '  git push -u origin %q\n' "$branch"
